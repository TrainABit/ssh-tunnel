'use strict';

const { TMP_DIR, insertToken } = require('./helpers/platform-env');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../src/database');
const {
  createSecretBox, loadSecretBoxFromEnv, migrateStoredKeys, deriveKey, keyIdOf, isEncrypted, SecretBoxConfigError,
} = require('../src/secretBox');

const HEX_KEY = crypto.randomBytes(32).toString('hex');
const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n';

describe('secretBox', () => {
  test('roundtrip with AES-256-GCM blob format', () => {
    const box = createSecretBox({ key: HEX_KEY });
    assert.equal(box.enabled, true);
    const blob = box.encrypt(PEM);
    assert.match(blob, /^tvenc:v1:[0-9a-f]{8}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    assert.equal(blob.split(':')[2], keyIdOf(Buffer.from(HEX_KEY, 'hex')));
    assert.ok(!blob.includes('BEGIN'));
    assert.equal(box.decrypt(blob), PEM);
    // fresh IV every time
    assert.notEqual(box.encrypt(PEM), blob);
    assert.ok(isEncrypted(blob));
    assert.ok(!isEncrypted(PEM));
  });

  test('tampering is detected', () => {
    const box = createSecretBox({ key: HEX_KEY });
    const blob = box.encrypt('secret value');
    const parts = blob.split(':');
    const ct = Buffer.from(parts[5], 'base64url');
    ct[0] ^= 0x01;
    const tampered = [...parts.slice(0, 5), ct.toString('base64url')].join(':');
    assert.throws(() => box.decrypt(tampered), /Decryption failed/);
    const tag = Buffer.from(parts[4], 'base64url');
    tag[3] ^= 0x80;
    assert.throws(() => box.decrypt([...parts.slice(0, 4), tag.toString('base64url'), parts[5]].join(':')), /Decryption failed/);
    assert.throws(() => box.decrypt('tvenc:v1:zz:bad'), /Not a valid encrypted value/);
    assert.throws(() => box.decrypt(PEM), /Not a valid encrypted value/);
  });

  test('a different key cannot decrypt', () => {
    const a = createSecretBox({ key: HEX_KEY });
    const b = createSecretBox({ key: crypto.randomBytes(32).toString('hex') });
    assert.throws(() => b.decrypt(a.encrypt('x')), /unknown key/);
  });

  test('key formats: hex and base64 used directly, other strings derived with scrypt', () => {
    const raw = crypto.randomBytes(32);
    assert.deepEqual(deriveKey(raw.toString('hex')), raw);
    assert.deepEqual(deriveKey(raw.toString('base64')), raw);
    assert.deepEqual(deriveKey(raw.toString('base64url')), raw);
    const p1 = deriveKey('correct horse battery staple');
    const p2 = deriveKey('correct horse battery staple');
    assert.equal(p1.length, 32);
    assert.deepEqual(p1, p2);
    assert.notDeepEqual(p1, deriveKey('correct horse battery staplE'));
    const box = createSecretBox({ key: 'correct horse battery staple' });
    assert.equal(createSecretBox({ key: 'correct horse battery staple' }).decrypt(box.encrypt('hi')), 'hi');
  });

  test('disabled box (no key) refuses to encrypt', () => {
    const box = createSecretBox({});
    assert.equal(box.enabled, false);
    assert.throws(() => box.encrypt('x'), SecretBoxConfigError);
  });

  test('rotation: previous key decrypts, needsReencrypt flags old blobs', () => {
    const oldKey = crypto.randomBytes(32).toString('hex');
    const oldBox = createSecretBox({ key: oldKey });
    const oldBlob = oldBox.encrypt(PEM);
    const newBox = createSecretBox({ key: HEX_KEY, previousKey: oldKey });
    assert.equal(newBox.decrypt(oldBlob), PEM);
    assert.equal(newBox.needsReencrypt(oldBlob), true);
    assert.equal(newBox.needsReencrypt(newBox.encrypt(PEM)), false);
  });

  test('loadSecretBoxFromEnv: key, key file, unreadable file', () => {
    assert.equal(loadSecretBoxFromEnv({}).enabled, false);
    assert.equal(loadSecretBoxFromEnv({ DATA_ENCRYPTION_KEY: HEX_KEY }).enabled, true);
    const file = path.join(TMP_DIR, 'data.key');
    fs.writeFileSync(file, `${HEX_KEY}\n`, { mode: 0o600 });
    const fromFile = loadSecretBoxFromEnv({ DATA_ENCRYPTION_KEY_FILE: file });
    assert.equal(fromFile.enabled, true);
    assert.equal(fromFile.keyId, createSecretBox({ key: HEX_KEY }).keyId);
    assert.throws(
      () => loadSecretBoxFromEnv({ DATA_ENCRYPTION_KEY_FILE: path.join(TMP_DIR, 'missing.key') }),
      (err) => err instanceof SecretBoxConfigError && /DATA_ENCRYPTION_KEY_FILE/.test(err.message)
    );
  });

  test('startup migration encrypts plaintext keys and re-encrypts previous-key blobs', () => {
    db.run('DELETE FROM tokens');
    const oldKey = crypto.randomBytes(32).toString('hex');
    const oldBox = createSecretBox({ key: oldKey });
    const tPlain = insertToken(db, { privateKey: PEM });
    const tOld = insertToken(db, { privateKey: oldBox.encrypt(PEM) });
    const tNone = insertToken(db, { privateKey: '' });

    // Without a key: nothing changes, plaintext is reported
    const disabled = migrateStoredKeys(db, createSecretBox({}));
    assert.equal(disabled.plaintextRemaining, 1);
    assert.equal(disabled.undecryptable, 1);
    assert.equal(db.queryOne('SELECT private_key FROM tokens WHERE token = ?', [tPlain]).private_key, PEM);

    const box = createSecretBox({ key: HEX_KEY, previousKey: oldKey });
    const result = migrateStoredKeys(db, box);
    assert.equal(result.encrypted, 1);
    assert.equal(result.reencrypted, 1);
    assert.equal(result.plaintextRemaining, 0);
    for (const t of [tPlain, tOld]) {
      const v = db.queryOne('SELECT private_key FROM tokens WHERE token = ?', [t]).private_key;
      assert.ok(v.startsWith(`tvenc:v1:${box.keyId}:`), `token ${t} should be encrypted with the current key`);
      assert.equal(box.decrypt(v), PEM);
    }
    assert.equal(db.queryOne('SELECT private_key FROM tokens WHERE token = ?', [tNone]).private_key, '');

    // Idempotent
    const again = migrateStoredKeys(db, box);
    assert.deepEqual(again, { encrypted: 0, reencrypted: 0, plaintextRemaining: 0, undecryptable: 0 });

    // After rotation the previous key is no longer needed
    const onlyNew = createSecretBox({ key: HEX_KEY });
    const v = db.queryOne('SELECT private_key FROM tokens WHERE token = ?', [tOld]).private_key;
    assert.equal(onlyNew.decrypt(v), PEM);
  });
});
