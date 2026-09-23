const { Router } = require('express');
const crypto = require('crypto');
const { utils: sshUtils } = require('ssh2');
const defaultUserManager = require('../userManager');
const { createLogger } = require('../logger');
const log = createLogger('tokens');

const TOKEN_RE = /^[a-zA-Z0-9]{1,64}$/;
const IPV4_RE = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
// Linux user names are limited to 32 chars; gateway users are 'gw-' + token.
const MAX_GATEWAY_TOKEN_LENGTH = 29;
const MAX_PRIVATE_KEY_LENGTH = 16 * 1024;

/**
 * Generate a random 20-char alphanumeric token using rejection sampling
 * to avoid modulo bias (256 % 62 !== 0).
 */
function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const limit = 256 - (256 % chars.length); // = 248; reject bytes >= 248
  let result = '';
  while (result.length < 20) {
    const bytes = crypto.randomBytes(32);
    for (let i = 0; i < bytes.length && result.length < 20; i++) {
      if (bytes[i] < limit) {
        result += chars[bytes[i] % chars.length];
      }
    }
  }
  return result;
}

function hint(token) {
  return `${String(token).slice(0, 4)}***`;
}

/** Row without private_key, plus has_private_key. */
function safeTokenRow(row) {
  if (!row) return row;
  const { private_key: privateKey, ...rest } = row;
  return { ...rest, has_private_key: !!privateKey };
}

function parseActive(value) {
  if (value === 1 || value === '1' || value === true || value === 'true') return 1;
  if (value === 0 || value === '0' || value === false || value === 'false') return 0;
  return null;
}

/**
 * Validate an unencrypted SSH private key. Returns { key } or { error }.
 * Passphrase-protected keys are refused: the server would need the passphrase
 * at every login anyway, which defeats storing the key.
 */
function validatePrivateKey(value) {
  const text = String(value).replace(/\r\n?/g, '\n').trim();
  if (text.length > MAX_PRIVATE_KEY_LENGTH) return { error: 'private_key is too large' };
  const passphraseError = {
    error: 'Passphrase-protected private keys are not supported. Remove the passphrase (ssh-keygen -p) or log in with the key manually.',
  };
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:\s*4,\s*ENCRYPTED/.test(text)) return passphraseError;
  let parsed;
  try {
    parsed = sshUtils.parseKey(text);
  } catch (err) {
    parsed = err instanceof Error ? err : new Error('Invalid key');
  }
  if (Array.isArray(parsed)) parsed = parsed[0];
  if (parsed instanceof Error || !parsed) {
    const msg = parsed instanceof Error ? parsed.message : '';
    if (/encrypted|passphrase/i.test(msg)) return passphraseError;
    return { error: 'private_key is not a valid unencrypted SSH private key (supported: OpenSSH, PEM RSA/EC/DSA, PuTTY PPK)' };
  }
  if (typeof parsed.isPrivateKey !== 'function' || !parsed.isPrivateKey()) {
    return { error: 'private_key must be a private key (got a public key)' };
  }
  return { key: `${text}\n` };
}

/** Summarise a userManager result for API responses. */
function linuxUserResult(prefix, result) {
  if (!result) return {};
  const out = {
    [`linux_user_${prefix}`]: !!result.ok && !result.queued,
    linux_user_queued: !!result.queued,
  };
  if (!result.ok && result.error) out.linux_user_error = result.error;
  return out;
}

/**
 * @param {{ query: Function, queryOne: Function, run: Function, transaction?: Function }} db
 * @param {object} [deps]
 * @param {object} [deps.registry] - ClientRegistry (live device connections)
 * @param {object} [deps.tunnelManager] - TunnelManager
 * @param {object} [deps.secretBox] - secretBox instance (stored private keys)
 * @param {object} [deps.userManager] - { createLinuxUser, deleteLinuxUser } (tests)
 */
function tokensRouter(db, deps = {}) {
  const router = Router();
  const registry = deps.registry || null;
  const tunnelManager = deps.tunnelManager || null;
  const secretBox = deps.secretBox || { enabled: false };
  const userManager = deps.userManager || defaultUserManager;
  const inTransaction = (fn) => (typeof db.transaction === 'function' ? db.transaction(fn) : fn());

  // GET /api/tokens — list all tokens with session counts and last_connected
  // NOTE: private_key is never returned; only has_private_key.
  router.get('/', (_req, res) => {
    const tokens = db.query(`
      SELECT
        t.id, t.token, t.label, t.target_ip, t.target_port,
        t.public_key, t.linux_user, t.created_at, t.last_seen, t.active,
        (t.private_key IS NOT NULL AND t.private_key != '') AS has_private_key,
        COUNT(s.id) AS session_count,
        MAX(s.connected_at) AS last_connected
      FROM tokens t
      LEFT JOIN sessions s ON s.token = t.token
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `).map((t) => ({ ...t, has_private_key: !!t.has_private_key }));
    res.json({ tokens, stored_keys_enabled: !!secretBox.enabled });
  });

  // POST /api/tokens — create a new token
  router.post('/', async (req, res) => {
    const body = req.body || {};
    const { label, target_port } = body;
    const target_ip = body.target_ip || '';
    const token = body.token === undefined || body.token === null || body.token === '' ? generateToken() : body.token;

    // Validate token format: alphanumeric only, max 64 chars
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
      return res.status(400).json({ error: 'Token must be alphanumeric, 1-64 characters' });
    }

    // Validate target_ip format (each octet 0-255) only if provided
    if (target_ip && (typeof target_ip !== 'string' || !IPV4_RE.test(target_ip))) {
      return res.status(400).json({ error: 'target_ip must be a valid IPv4 address' });
    }

    // Validate target_port
    const port = parseInt(target_port, 10) || 22;
    if (port < 1 || port > 65535) {
      return res.status(400).json({ error: 'target_port must be between 1 and 65535' });
    }

    let publicKey = '';
    if (body.public_key !== undefined && body.public_key !== null && String(body.public_key).trim() !== '') {
      publicKey = userManager.normalizePublicKey
        ? userManager.normalizePublicKey(String(body.public_key))
        : defaultUserManager.normalizePublicKey(String(body.public_key));
      if (!publicKey) {
        return res.status(400).json({ error: 'public_key must be a single-line SSH public key (ssh-ed25519, ssh-rsa, ecdsa-sha2-*)' });
      }
      if (token.length > MAX_GATEWAY_TOKEN_LENGTH) {
        return res.status(400).json({
          error: `Tokens used with an SSH public key must be at most ${MAX_GATEWAY_TOKEN_LENGTH} characters (the Linux user gw-<token> is limited to 32 characters)`,
        });
      }
    }

    // Sanitize label
    const safeLabel = String(label || '').substring(0, 200);
    const linux_user = publicKey ? 'gw-' + token : 'ws-' + token;

    try {
      db.run(
        `INSERT INTO tokens (token, label, target_ip, target_port, public_key, linux_user)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [token, safeLabel, target_ip, port, publicKey, linux_user]
      );
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: 'Token or linux_user already exists' });
      }
      log.error('Token creation failed', { error: err });
      return res.status(500).json({ error: 'Internal server error' });
    }

    // Gateway user (only when a public key is set). Reported, never silent.
    let userResult = null;
    if (publicKey) {
      userResult = await userManager.createLinuxUser(linux_user, publicKey);
    }
    log.info('Token created', { token: hint(token), gateway: !!publicKey, target: target_ip ? `${target_ip}:${port}` : 'none' });
    return res.status(201).json({
      token,
      linux_user,
      linux_user_created: !!(userResult && userResult.ok && !userResult.queued),
      linux_user_queued: !!(userResult && userResult.queued),
      ...(userResult && !userResult.ok && userResult.error ? { linux_user_error: userResult.error } : {}),
    });
  });

  // GET /api/tokens/:token — get single token with last 50 sessions
  router.get('/:token', (req, res) => {
    if (!TOKEN_RE.test(req.params.token)) {
      return res.status(400).json({ error: 'Invalid token format' });
    }
    const tokenRow = db.queryOne('SELECT * FROM tokens WHERE token = ?', [req.params.token]);
    if (!tokenRow) {
      return res.status(404).json({ error: 'Token not found' });
    }

    const sessions = db.query(
      `SELECT * FROM sessions WHERE token = ? ORDER BY connected_at DESC LIMIT 50`,
      [req.params.token]
    );

    res.json({ ...safeTokenRow(tokenRow), sessions });
  });

  // PATCH /api/tokens/:token — update token fields
  router.patch('/:token', async (req, res) => {
    const token = req.params.token;
    if (!TOKEN_RE.test(token)) {
      return res.status(400).json({ error: 'Invalid token format' });
    }
    const body = req.body || {};
    const existing = db.queryOne('SELECT id, token, linux_user, public_key, active FROM tokens WHERE token = ?', [token]);
    if (!existing) {
      return res.status(404).json({ error: 'Token not found' });
    }

    const sets = [];
    const values = [];
    const set = (field, value) => { sets.push(`${field} = ?`); values.push(value); };
    let newActive = null;
    let newPublicKey = null;

    if (body.target_ip !== undefined) {
      const ip = body.target_ip === null ? '' : body.target_ip;
      if (typeof ip !== 'string' || (ip !== '' && !IPV4_RE.test(ip))) {
        return res.status(400).json({ error: 'target_ip must be a valid IPv4 address' });
      }
      set('target_ip', ip);
    }
    if (body.target_port !== undefined) {
      const p = parseInt(body.target_port, 10);
      if (isNaN(p) || p < 1 || p > 65535) {
        return res.status(400).json({ error: 'target_port must be between 1 and 65535' });
      }
      set('target_port', p);
    }
    if (body.label !== undefined) {
      set('label', String(body.label === null ? '' : body.label).substring(0, 200));
    }
    if (body.active !== undefined) {
      newActive = parseActive(body.active);
      if (newActive === null) {
        return res.status(400).json({ error: 'active must be 0 or 1' });
      }
      set('active', newActive);
    }
    if (body.public_key !== undefined) {
      const raw = body.public_key === null ? '' : String(body.public_key).trim();
      if (raw === '') {
        newPublicKey = '';
      } else {
        newPublicKey = userManager.normalizePublicKey
          ? userManager.normalizePublicKey(raw)
          : defaultUserManager.normalizePublicKey(raw);
        if (!newPublicKey) {
          return res.status(400).json({ error: 'public_key must be a valid single-line SSH public key' });
        }
        if (token.length > MAX_GATEWAY_TOKEN_LENGTH) {
          return res.status(400).json({
            error: `Tokens used with an SSH public key must be at most ${MAX_GATEWAY_TOKEN_LENGTH} characters (Linux user name limit)`,
          });
        }
      }
      set('public_key', newPublicKey);
    }
    if (body.private_key !== undefined) {
      const raw = body.private_key === null ? '' : body.private_key;
      if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'private_key must be a string' });
      }
      if (raw.trim() === '') {
        set('private_key', '');
      } else {
        if (!secretBox.enabled) {
          return res.status(409).json({
            error: 'Stored SSH keys are disabled on this server: set DATA_ENCRYPTION_KEY (or DATA_ENCRYPTION_KEY_FILE) and restart TunnelVault to enable encrypted key storage.',
          });
        }
        const check = validatePrivateKey(raw);
        if (check.error) return res.status(400).json({ error: check.error });
        set('private_key', secretBox.encrypt(check.key));
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(token);
    const result = db.run(`UPDATE tokens SET ${sets.join(', ')} WHERE token = ?`, values);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Token not found' });
    }

    const response = {};

    // Revocation: close live device connections of a deactivated token right away.
    if (newActive === 0) {
      let disconnected = 0;
      try {
        disconnected = registry && typeof registry.disconnectToken === 'function'
          ? registry.disconnectToken(token) : 0;
      } catch (err) {
        log.error('Failed to disconnect revoked token', { token: hint(token), error: err.message });
      }
      response.disconnected = disconnected;
      log.info('Token deactivated', { token: hint(token), disconnected });
    } else if (newActive === 1 && Number(existing.active) !== 1) {
      log.info('Token reactivated', { token: hint(token) });
    }

    // Keep the gateway Linux user's authorized key in sync.
    if (newPublicKey !== null && newPublicKey !== existing.public_key
        && typeof existing.linux_user === 'string' && existing.linux_user.startsWith('gw-')) {
      const r = newPublicKey
        ? await userManager.createLinuxUser(existing.linux_user, newPublicKey)
        : await userManager.deleteLinuxUser(existing.linux_user);
      Object.assign(response, linuxUserResult('synced', r));
    }

    const updated = db.queryOne('SELECT * FROM tokens WHERE token = ?', [token]);
    return res.json({ token: safeTokenRow(updated), ...response });
  });

  // DELETE /api/tokens/:token — revoke and delete a token, its tunnels, pins and sessions
  router.delete('/:token', async (req, res) => {
    const token = req.params.token;
    if (!TOKEN_RE.test(token)) {
      return res.status(400).json({ error: 'Invalid token format' });
    }
    const tokenRow = db.queryOne('SELECT id, linux_user FROM tokens WHERE token = ?', [token]);
    if (!tokenRow) {
      return res.status(404).json({ error: 'Token not found' });
    }

    // 1. Revoke: close live connections, remove the token's tunnels (frees their public ports).
    let disconnected = 0;
    let tunnelsRemoved = 0;
    try {
      if (registry && typeof registry.disconnectToken === 'function') disconnected = registry.disconnectToken(token);
    } catch (err) {
      log.error('Failed to disconnect deleted token', { token: hint(token), error: err.message });
    }
    try {
      if (tunnelManager && typeof tunnelManager.removeTunnelsForToken === 'function') {
        tunnelsRemoved = tunnelManager.removeTunnelsForToken(token);
      }
    } catch (err) {
      log.error('Failed to remove tunnels of deleted token', { token: hint(token), error: err.message });
    }

    // 2. Delete DB state in one transaction.
    const pinPrefix = `token:${token}:`;
    inTransaction(() => {
      db.run('DELETE FROM ssh_host_keys WHERE substr(pin_key, 1, ?) = ?', [pinPrefix.length, pinPrefix]);
      db.run('DELETE FROM tunnels WHERE client_token = ?', [token]);
      db.run('DELETE FROM sessions WHERE token = ?', [token]);
      db.run('DELETE FROM tokens WHERE token = ?', [token]);
    });

    // 3. Gateway Linux user.
    let userResult = null;
    if (typeof tokenRow.linux_user === 'string' && tokenRow.linux_user.startsWith('gw-')) {
      userResult = await userManager.deleteLinuxUser(tokenRow.linux_user);
    }

    log.info('Token deleted', { token: hint(token), disconnected, tunnels_removed: tunnelsRemoved });
    return res.json({
      message: 'Token and associated sessions deleted',
      disconnected,
      tunnels_removed: tunnelsRemoved,
      ...(userResult ? linuxUserResult('deleted', userResult) : {}),
    });
  });

  return router;
}

module.exports = tokensRouter;
module.exports.validatePrivateKey = validatePrivateKey;
module.exports.generateToken = generateToken;
module.exports.MAX_GATEWAY_TOKEN_LENGTH = MAX_GATEWAY_TOKEN_LENGTH;
