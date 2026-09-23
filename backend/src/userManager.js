'use strict';

/**
 * Linux users for the legacy SSH gateway (ForceCommand ssh_router.sh).
 *
 * Two modes:
 *  - Spool (USERMGR_SPOOL_DIR set, the default for installed servers): the API
 *    writes an atomic request file `<ms>-<rand>.req` (JSON, mode 0600) into the
 *    spool directory. A root-owned systemd path unit (tunnelvault-usermgr.path)
 *    notices it and runs gateway/usermgr-worker.sh, which validates the request
 *    and calls manage-user.sh. Works under NoNewPrivileges/ProtectSystem.
 *  - Legacy: `sudo /opt/tunnelvault/manage-user.sh …` (only works when the
 *    service is allowed to use sudo).
 *
 * createLinuxUser / deleteLinuxUser resolve { ok, queued?, error? } and never reject.
 */
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');
const log = createLogger('user-mgr');

const MANAGE_USER_SCRIPT = process.env.MANAGE_USER_SCRIPT || '/opt/tunnelvault/manage-user.sh';
// Linux user names are limited to 32 chars: 'gw-' + up to 29 token chars.
const USERNAME_RE = /^gw-[A-Za-z0-9]{1,29}$/;
const PUBKEY_RE = /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp\d+|ssh-dss|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( [\x20-\x7e]*)?$/;
// Characters never allowed anywhere in a key line (shell/authorized_keys hygiene)
const PUBKEY_FORBIDDEN_RE = /[`$\\"'\r\n\0]/;
const MAX_PUBKEY_LENGTH = 8192;

function userHint(name) {
  const s = String(name || '');
  return s.length > 7 ? `${s.slice(0, 7)}***` : s;
}

/** Validate an SSH public key line (single line, known type). Returns trimmed key or null. */
function normalizePublicKey(publicKey) {
  if (typeof publicKey !== 'string') return null;
  const pk = publicKey.trim();
  if (!pk || pk.length > MAX_PUBKEY_LENGTH) return null;
  if (PUBKEY_FORBIDDEN_RE.test(pk)) return null;
  return PUBKEY_RE.test(pk) ? pk : null;
}

function spoolDir() {
  const dir = (process.env.USERMGR_SPOOL_DIR || '').trim();
  return dir || null;
}

/** Write one request file atomically (tmp file + rename; tmp name never matches *.req). */
function writeSpoolRequest(dir, request) {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const base = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
      const tmp = path.join(dir, `.${base}.tmp`);
      const final = path.join(dir, `${base}.req`);
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(request) + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try { fs.chmodSync(tmp, 0o600); } catch {}
      fs.renameSync(tmp, final);
      resolve({ ok: true, queued: true });
    } catch (err) {
      resolve({ ok: false, error: `Could not queue user-management request: ${err.code || err.message}` });
    }
  });
}

function runManageUser(args) {
  return new Promise((resolve) => {
    execFile('sudo', ['-n', MANAGE_USER_SCRIPT, ...args], { timeout: 10000 }, (err, _stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message || '').trim().split('\n').slice(-1)[0] || 'failed';
        resolve({ ok: false, error: detail.slice(0, 300) });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

/**
 * Create (or update the authorized key of) a gateway Linux user.
 * @param {string} linuxUser - e.g. "gw-abc123" (max 32 chars)
 * @param {string} publicKey - SSH public key line
 * @returns {Promise<{ok: boolean, queued?: boolean, error?: string}>}
 */
async function createLinuxUser(linuxUser, publicKey) {
  if (!USERNAME_RE.test(String(linuxUser || ''))) {
    return { ok: false, error: 'Invalid Linux user name (must be gw- followed by 1-29 alphanumeric characters)' };
  }
  const pk = normalizePublicKey(publicKey);
  if (!pk) return { ok: false, error: 'Invalid SSH public key' };

  const dir = spoolDir();
  const result = dir
    ? await writeSpoolRequest(dir, { action: 'create', username: linuxUser, publicKey: pk })
    : await runManageUser(['create', linuxUser, pk]);
  if (result.ok) {
    log.info(result.queued ? 'Linux user creation queued' : 'Linux user created', { linux_user: userHint(linuxUser) });
  } else {
    log.warn('Failed to create Linux user', { linux_user: userHint(linuxUser), error: result.error });
  }
  return result;
}

/**
 * Delete a gateway Linux user.
 * @param {string} linuxUser - e.g. "gw-abc123"
 * @returns {Promise<{ok: boolean, queued?: boolean, error?: string}>}
 */
async function deleteLinuxUser(linuxUser) {
  if (!USERNAME_RE.test(String(linuxUser || ''))) {
    return { ok: false, error: 'Invalid Linux user name' };
  }
  const dir = spoolDir();
  const result = dir
    ? await writeSpoolRequest(dir, { action: 'delete', username: linuxUser })
    : await runManageUser(['delete', linuxUser]);
  if (result.ok) {
    log.info(result.queued ? 'Linux user deletion queued' : 'Linux user deleted', { linux_user: userHint(linuxUser) });
  } else {
    log.warn('Failed to delete Linux user', { linux_user: userHint(linuxUser), error: result.error });
  }
  return result;
}

module.exports = { createLinuxUser, deleteLinuxUser, normalizePublicKey, USERNAME_RE };
