const { execFile } = require('child_process');
const { createLogger } = require('./logger');
const log = createLogger('user-mgr');

const MANAGE_USER_SCRIPT = '/opt/tunnelvault/manage-user.sh';

/**
 * Create a Linux user for a gateway token.
 * Runs via sudo; failures are logged but do not block the caller.
 * @param {string} linuxUser - e.g. "gw-abc123"
 * @param {string} publicKey - SSH public key string
 * @returns {Promise<void>}
 */
function createLinuxUser(linuxUser, publicKey) {
  return new Promise((resolve) => {
    execFile(
      'sudo',
      [MANAGE_USER_SCRIPT, 'create', linuxUser, publicKey],
      { timeout: 10000 },
      (err, stdout, stderr) => {
        if (err) {
          log.warn(`Failed to create Linux user '${linuxUser}'`, { error: err, stderr: stderr || undefined });
        } else {
          log.info(`Linux user '${linuxUser}' created`);
        }
        resolve();
      }
    );
  });
}

/**
 * Delete a Linux user for a gateway token.
 * Runs via sudo; failures are logged but do not block the caller.
 * @param {string} linuxUser - e.g. "gw-abc123"
 * @returns {Promise<void>}
 */
function deleteLinuxUser(linuxUser) {
  return new Promise((resolve) => {
    execFile(
      'sudo',
      [MANAGE_USER_SCRIPT, 'delete', linuxUser],
      { timeout: 10000 },
      (err, stdout, stderr) => {
        if (err) {
          log.warn(`Failed to delete Linux user '${linuxUser}'`, { error: err, stderr: stderr || undefined });
        } else {
          log.info(`Linux user '${linuxUser}' deleted`);
        }
        resolve();
      }
    );
  });
}

module.exports = { createLinuxUser, deleteLinuxUser };
