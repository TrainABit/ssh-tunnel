const { Router } = require('express');
const { createLogger } = require('../logger');
const log = createLogger('sessions');

/**
 * @param {{ query: Function, queryOne: Function, run: Function }} db
 */
function sessionsRouter(db) {
  const router = Router();

  // GET /api/sessions — list sessions with token label and target info
  router.get('/', (req, res) => {
    const activeOnly = req.query.active === '1';
    const days = parseInt(req.query.days, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);

    const conditions = [];
    const params = [];

    if (activeOnly) {
      conditions.push('s.disconnected_at IS NULL');
    }

    if (days > 0) {
      conditions.push(`s.connected_at >= datetime('now', ?)`)
      params.push(`-${days} days`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT
        s.id, s.token, s.client_ip,
        s.target_ip, s.target_port,
        s.connected_at, s.disconnected_at,
        t.label AS token_label
      FROM sessions s
      LEFT JOIN tokens t ON t.token = s.token
      ${where}
      ORDER BY s.connected_at DESC LIMIT ${limit}
    `;

    const sessions = db.query(sql, params);
    res.json({ sessions });
  });

  // POST /api/sessions — create session entry (called by ssh_router.sh)
  router.post('/', (req, res) => {
    const { token, client_ip, pid } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    // Validate token format
    if (!/^[a-zA-Z0-9]{1,64}$/.test(token)) {
      return res.status(400).json({ error: 'Invalid token format' });
    }

    // Validate client_ip if provided (IPv4/IPv6-like characters only, max 45 chars)
    const safeIp = client_ip ? String(client_ip).substring(0, 45).replace(/[^0-9a-fA-F.:]/g, '') : null;

    // Validate pid if provided (must be a positive integer)
    const safePid = pid ? Math.abs(parseInt(pid, 10)) || null : null;

    // Verify token exists
    const tokenRow = db.queryOne('SELECT id FROM tokens WHERE token = ?', [token]);
    if (!tokenRow) {
      return res.status(404).json({ error: 'Token not found' });
    }

    const result = db.run(
      `INSERT INTO sessions (token, client_ip, pid) VALUES (?, ?, ?)`,
      [token, safeIp, safePid]
    );

    // Update last_seen on the token
    db.run(
      `UPDATE tokens SET last_seen = datetime('now') WHERE token = ?`,
      [token]
    );

    log.info('Session started', { token, client_ip: client_ip || 'unknown', sessionId: Number(result.lastInsertRowid) });
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });

  // PATCH /api/sessions/:id — update session (set disconnected_at)
  router.patch('/:id', (req, res) => {
    // Validate session ID is numeric
    const sessionId = parseInt(req.params.id, 10);
    if (isNaN(sessionId) || sessionId < 1) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const result = db.run(
      `UPDATE sessions SET disconnected_at = datetime('now') WHERE id = ?`,
      [sessionId]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = db.queryOne('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    log.info('Session ended', { sessionId: req.params.id });
    res.json({ session });
  });

  return router;
}

module.exports = sessionsRouter;
