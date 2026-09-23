'use strict';

/**
 * Secrets at rest (AES-256-GCM, Node crypto only).
 *
 * Key material comes from DATA_ENCRYPTION_KEY or DATA_ENCRYPTION_KEY_FILE:
 *   - 64 hex chars or base64/base64url of exactly 32 bytes -> used directly
 *   - anything else -> derived with scrypt (fixed, versioned salt)
 * DATA_ENCRYPTION_KEY_PREVIOUS (or DATA_ENCRYPTION_KEY_PREVIOUS_FILE) is accepted
 * for decryption only, so a key can be rotated: on startup every blob made with
 * the previous key is re-encrypted with the current one.
 *
 * Blob format: tvenc:v1:<keyId>:<iv b64url>:<tag b64url>:<ciphertext b64url>
 *   keyId = first 8 hex chars of sha256(key)
 */
const crypto = require('crypto');
const fs = require('fs');
const { createLogger } = require('./logger');
const log = createLogger('secret-box');

const PREFIX = 'tvenc:v1:';
const SCRYPT_SALT = 'tunnelvault/secretBox/v1';
const SCRYPT_OPTS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const IV_BYTES = 12;
const TAG_BYTES = 16;

class SecretBoxConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretBoxConfigError';
    this.code = 'CONFIG';
  }
}

/** Turn operator-supplied key text into 32 key bytes. */
function deriveKey(text) {
  const s = String(text).trim();
  if (!s) throw new SecretBoxConfigError('Encryption key is empty');
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(s)) {
    const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (buf.length === 32) return buf;
  }
  // Passphrase-style key: stretch it. Deterministic (no per-install salt is
  // stored), so the same passphrase always yields the same key.
  return crypto.scryptSync(s, SCRYPT_SALT, 32, SCRYPT_OPTS);
}

function keyIdOf(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function isPlaintextPem(value) {
  return typeof value === 'string' && value.trimStart().startsWith('-----BEGIN');
}

/** Parse a blob into its parts, or null if it is not a well-formed v1 blob. */
function parseBlob(blob) {
  if (!isEncrypted(blob)) return null;
  const parts = blob.slice(PREFIX.length).split(':');
  if (parts.length !== 4) return null;
  const [keyId, iv, tag, ct] = parts;
  if (!/^[0-9a-f]{8}$/.test(keyId)) return null;
  if (![iv, tag, ct].every((p) => /^[A-Za-z0-9_-]*$/.test(p))) return null;
  return {
    keyId,
    iv: Buffer.from(iv, 'base64url'),
    tag: Buffer.from(tag, 'base64url'),
    ct: Buffer.from(ct, 'base64url'),
  };
}

/**
 * @param {object} [opts]
 * @param {string|Buffer} [opts.key] - current key (text as documented above, or 32 raw bytes)
 * @param {string|Buffer} [opts.previousKey] - optional previous key (decrypt only)
 */
function createSecretBox({ key, previousKey } = {}) {
  const toKey = (k) => (Buffer.isBuffer(k) && k.length === 32 ? Buffer.from(k) : deriveKey(k));
  const current = key ? toKey(key) : null;
  const keys = new Map(); // keyId -> key
  let currentId = null;
  if (current) {
    currentId = keyIdOf(current);
    keys.set(currentId, current);
  }
  let previousId = null;
  if (current && previousKey) {
    const prev = toKey(previousKey);
    previousId = keyIdOf(prev);
    if (!keys.has(previousId)) keys.set(previousId, prev);
  }

  function aadFor(keyId) {
    return Buffer.from(`${PREFIX}${keyId}`);
  }

  return {
    enabled: !!current,
    keyId: currentId,
    previousKeyId: previousId && previousId !== currentId ? previousId : null,

    /** Encrypt a UTF-8 string. Throws if no key is configured. */
    encrypt(plaintext) {
      if (!current) throw new SecretBoxConfigError('Encryption is not configured (DATA_ENCRYPTION_KEY)');
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', current, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aadFor(currentId));
      const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${PREFIX}${currentId}:${b64u(iv)}:${b64u(tag)}:${b64u(ct)}`;
    },

    /** Decrypt a blob. Throws on unknown key, malformed input or tampering. */
    decrypt(blob) {
      const parsed = parseBlob(blob);
      if (!parsed) throw new Error('Not a valid encrypted value');
      const k = keys.get(parsed.keyId);
      if (!k) throw new Error(`Encrypted with an unknown key (key id ${parsed.keyId})`);
      if (parsed.iv.length !== IV_BYTES || parsed.tag.length !== TAG_BYTES) {
        throw new Error('Not a valid encrypted value');
      }
      const decipher = crypto.createDecipheriv('aes-256-gcm', k, parsed.iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aadFor(parsed.keyId));
      decipher.setAuthTag(parsed.tag);
      try {
        return Buffer.concat([decipher.update(parsed.ct), decipher.final()]).toString('utf8');
      } catch {
        throw new Error('Decryption failed (wrong key or tampered data)');
      }
    },

    /** True if the blob was made with a key other than the current one. */
    needsReencrypt(blob) {
      const parsed = parseBlob(blob);
      return !!parsed && !!currentId && parsed.keyId !== currentId;
    },

    canDecrypt(blob) {
      const parsed = parseBlob(blob);
      return !!parsed && keys.has(parsed.keyId);
    },
  };
}

function readKeyFile(file, varName) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    throw new SecretBoxConfigError(
      `Cannot read ${varName}=${file} (${err.code || err.message}). `
      + 'Make sure the file exists and is readable by the TunnelVault service user.'
    );
  }
}

/**
 * Build the secret box from the environment. Returns a disabled box when no
 * key is configured. Throws SecretBoxConfigError for unreadable key files.
 */
function loadSecretBoxFromEnv(env = process.env) {
  let key = (env.DATA_ENCRYPTION_KEY || '').trim();
  if (!key && env.DATA_ENCRYPTION_KEY_FILE) key = readKeyFile(env.DATA_ENCRYPTION_KEY_FILE, 'DATA_ENCRYPTION_KEY_FILE');
  let previousKey = (env.DATA_ENCRYPTION_KEY_PREVIOUS || '').trim();
  if (!previousKey && env.DATA_ENCRYPTION_KEY_PREVIOUS_FILE) {
    previousKey = readKeyFile(env.DATA_ENCRYPTION_KEY_PREVIOUS_FILE, 'DATA_ENCRYPTION_KEY_PREVIOUS_FILE');
  }
  if (!key) {
    if (previousKey) log.warn('DATA_ENCRYPTION_KEY_PREVIOUS is set but DATA_ENCRYPTION_KEY is not — ignoring it');
    return createSecretBox({});
  }
  return createSecretBox({ key, previousKey: previousKey || undefined });
}

/**
 * Startup migration for tokens.private_key:
 *   - plaintext PEM + box enabled   -> encrypt
 *   - blob made with previous key   -> re-encrypt with the current key
 *   - plaintext PEM + box disabled  -> log an error (feature disabled)
 *   - blob with unknown key         -> log an error (cannot be used)
 * Returns counters.
 */
function migrateStoredKeys(db, box) {
  const result = { encrypted: 0, reencrypted: 0, plaintextRemaining: 0, undecryptable: 0 };
  let rows;
  try {
    rows = db.query("SELECT id, private_key FROM tokens WHERE private_key IS NOT NULL AND private_key != ''");
  } catch (err) {
    log.error('Could not read stored SSH keys for migration', { error: err.message });
    return result;
  }
  const updates = [];
  for (const row of rows) {
    const value = row.private_key;
    if (isEncrypted(value)) {
      if (!box.enabled || !box.canDecrypt(value)) {
        result.undecryptable++;
        continue;
      }
      if (box.needsReencrypt(value)) {
        try {
          updates.push([box.encrypt(box.decrypt(value)), row.id]);
          result.reencrypted++;
        } catch {
          result.undecryptable++;
        }
      }
    } else if (box.enabled) {
      updates.push([box.encrypt(value), row.id]);
      result.encrypted++;
    } else {
      result.plaintextRemaining++;
    }
  }
  if (updates.length > 0) {
    const apply = () => {
      for (const [blob, id] of updates) db.run('UPDATE tokens SET private_key = ? WHERE id = ?', [blob, id]);
    };
    if (typeof db.transaction === 'function') db.transaction(apply);
    else apply();
  }
  if (result.encrypted) log.info('Encrypted plaintext stored SSH keys', { count: result.encrypted });
  if (result.reencrypted) log.info('Re-encrypted stored SSH keys with the current key', { count: result.reencrypted });
  if (result.plaintextRemaining) {
    log.error('Plaintext SSH private keys found in the database but DATA_ENCRYPTION_KEY is not set. '
      + 'Set DATA_ENCRYPTION_KEY (or DATA_ENCRYPTION_KEY_FILE) and restart to encrypt them; '
      + 'stored-key login is disabled until then.', { count: result.plaintextRemaining });
  }
  if (result.undecryptable) {
    log.error('Stored SSH keys are encrypted with an unknown key and cannot be used. '
      + 'Set DATA_ENCRYPTION_KEY_PREVIOUS to the old key, or clear and re-upload the keys.',
    { count: result.undecryptable });
  }
  return result;
}

module.exports = {
  createSecretBox,
  loadSecretBoxFromEnv,
  migrateStoredKeys,
  deriveKey,
  keyIdOf,
  isEncrypted,
  isPlaintextPem,
  SecretBoxConfigError,
  PREFIX,
};
