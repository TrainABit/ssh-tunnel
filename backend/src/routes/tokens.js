const { Router } = require('express');
const crypto = require('crypto');
const { createLinuxUser, deleteLinuxUser } = require('../userManager');
const { createLogger } = require('../logger');
const log = createLogger('tokens');

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

/**
 * @param {{ query: Function, queryOne: Function, run: Function }} db
 */
function tokensRouter(db) {
  const router = Router();

  // GET /api/tokens — list all tokens with session counts and last_connected
  // NOTE: private_key is intentionally excluded from list response
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
    `);
    res.json({ tokens });
  });

  // POST /api/tokens — create a new token
  router.post('/', (req, res) => {
    const { label, target_port, public_key } = req.body;
    const target_ip = req.body.target_ip || '';
    const token = req.body.token || generateToken();

    // Validate token format: alphanumeric only, max 64 chars
    if (!/^[a-zA-Z0-9]{1,64}$/.test(token)) {
      return res.status(400).json({ error: 'Token must be alphanumeric, 1-64 characters' });
    }

    // Validate target_ip format (each octet 0-255) only if provided
    if (target_ip && !/^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/.test(target_ip)) {
      return res.status(400).json({ error: 'target_ip must be a valid IPv4 address' });
    }

    // Validate target_port
    const port = parseInt(target_port, 10) || 22;
    if (port < 1 || port > 65535) {
      return res.status(400).json({ error: 'target_port must be between 1 and 65535' });
    }

    // Sanitize label
    const safeLabel = String(label || '').substring(0, 200);

    const linux_user = (public_key && public_key.trim()) ? 'gw-' + token : 'ws-' + token;

    try {
      db.run(
        `INSERT INTO tokens (token, label, target_ip, target_port, public_key, linux_user)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          token,
          safeLabel,
          target_ip,
          port,
          public_key || '',
          linux_user,
        ]
      );
      // Create Linux user in background (non-blocking) only if public_key is provided
      if (public_key && public_key.trim()) {
        createLinuxUser(linux_user, public_key);
      }
      log.info('Token created', { token: token.slice(0, 4) + '***', linux_user, target: target_ip ? `${target_ip}:${port}` : 'none' });
      res.status(201).json({ token, linux_user });
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: 'Token or linux_user already exists' });
      }
      log.error('Token creation failed', { error: err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/tokens/:token — get single token with last 50 sessions
  router.get('/:token', (req, res) => {
    if (!/^[a-zA-Z0-9]{1,64}$/.test(req.params.token)) {
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

    // Strip private_key, expose only boolean flag
    const { private_key, ...safeToken } = tokenRow;
    res.json({ ...safeToken, has_private_key: !!private_key, sessions });
  });

  // PATCH /api/tokens/:token — update token fields
  router.patch('/:token', (req, res) => {
    // Validate token format in URL param
    if (!/^[a-zA-Z0-9]{1,64}$/.test(req.params.token)) {
      return res.status(400).json({ error: 'Invalid token format' });
    }

    const allowed = ['target_ip', 'target_port', 'label', 'active', 'public_key', 'private_key'];
    const sets = [];
    const values = [];

    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        // Validate specific fields
        if (field === 'target_ip' && !/^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/.test(req.body[field])) {
          return res.status(400).json({ error: 'target_ip must be a valid IPv4 address' });
        }
        if (field === 'target_port') {
          const p = parseInt(req.body[field], 10);
          if (isNaN(p) || p < 1 || p > 65535) {
            return res.status(400).json({ error: 'target_port must be between 1 and 65535' });
          }
        }
        if (field === 'active' && ![0, 1, '0', '1', true, false].includes(req.body[field])) {
          return res.status(400).json({ error: 'active must be 0 or 1' });
        }
        if (field === 'public_key') {
          const pk = String(req.body[field]).trim();
          if (pk && !/^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp\d+|ssh-dss)\s/.test(pk)) {
            return res.status(400).json({ error: 'public_key must be a valid SSH public key format' });
          }
          if (pk.includes('\n') || pk.includes('\r')) {
            return res.status(400).json({ error: 'public_key must not contain newlines' });
          }
        }
        if (field === 'private_key') {
          const pk = String(req.body[field]).trim();
          if (pk && !pk.startsWith('-----BEGIN')) {
            return res.status(400).json({ error: 'private_key must be a PEM-format private key' });
          }
        }
        sets.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(req.params.token);
    const result = db.run(
      `UPDATE tokens SET ${sets.join(', ')} WHERE token = ?`,
      values
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Token not found' });
    }

    const updated = db.queryOne('SELECT * FROM tokens WHERE token = ?', [req.params.token]);
    res.json({ token: updated });
  });

  // DELETE /api/tokens/:token — delete token and its sessions
  router.delete('/:token', (req, res) => {
    if (!/^[a-zA-Z0-9]{1,64}$/.test(req.params.token)) {
      return res.status(400).json({ error: 'Invalid token format' });
    }
    const tokenRow = db.queryOne('SELECT * FROM tokens WHERE token = ?', [req.params.token]);
    if (!tokenRow) {
      return res.status(404).json({ error: 'Token not found' });
    }

    // Delete Linux user in background (non-blocking)
    if (tokenRow.linux_user) {
      deleteLinuxUser(tokenRow.linux_user);
    }

    db.run('DELETE FROM sessions WHERE token = ?', [req.params.token]);
    db.run('DELETE FROM tokens WHERE token = ?', [req.params.token]);

    log.info('Token deleted', { token: req.params.token.slice(0, 4) + '***', linux_user: tokenRow.linux_user });
    res.json({ message: 'Token and associated sessions deleted' });
  });

  return router;
}

module.exports = tokensRouter;
