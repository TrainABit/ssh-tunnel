'use strict';

/**
 * Deterministic SSH test keys.
 *
 * ssh2's utils.generateKeyPairSync('ed25519') returns an OpenSSH key that its
 * own parser rejects ("Malformed OpenSSH private key") roughly 0.4% of the
 * time. Tests that build ssh2 servers or log in with freshly generated keys
 * would then fail at random, so every test key goes through this helper,
 * which regenerates until both halves parse.
 */
const { utils: sshUtils } = require('ssh2');

const MAX_ATTEMPTS = 100;

function parses(text, passphrase) {
  let parsed;
  try {
    parsed = passphrase === undefined ? sshUtils.parseKey(text) : sshUtils.parseKey(text, passphrase);
  } catch (err) {
    return false;
  }
  if (Array.isArray(parsed)) parsed = parsed[0];
  return !!parsed && !(parsed instanceof Error);
}

/**
 * Same arguments/result as ssh2 utils.generateKeyPairSync(type, opts), but the
 * returned { private, public } are guaranteed to parse with utils.parseKey
 * (with opts.passphrase for encrypted private keys).
 */
function generateKeyPair(type = 'ed25519', opts = undefined) {
  const passphrase = opts && opts.passphrase ? opts.passphrase : undefined;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const pair = opts ? sshUtils.generateKeyPairSync(type, opts) : sshUtils.generateKeyPairSync(type);
    if (parses(pair.private, passphrase) && parses(pair.public)) return pair;
  }
  throw new Error(`Could not generate a parseable ${type} key pair in ${MAX_ATTEMPTS} attempts`);
}

module.exports = { generateKeyPair };
