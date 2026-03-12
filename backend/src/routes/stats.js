const { Router } = require('express');

/**
 * @param {TunnelManager} tunnelManager
 * @param {ConnectionTracker} connectionTracker
 * @param {number} startTime - process start timestamp
 * @param {{ query: Function, queryOne: Function, run: Function }} [db] - optional SQLite helpers
 */
function statsRouter(tunnelManager, connectionTracker, startTime, db) {
  const router = Router();

  // GET /api/stats — aggregated dashboard stats
  router.get('/', (req, res) => {
    const tunnelStats = tunnelManager.getStats();
    const connStats = connectionTracker.getStats();
    const history = connectionTracker.getHistory();

    const uptimeMs = Date.now() - startTime;
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;

    const result = {
      activeTunnels: tunnelStats.activeTunnels,
      activeConnections: connStats.activeConnections,
      totalConnections: connStats.totalConnections,
      bytesTransferred: connStats.bytesTransferred + tunnelStats.bytesTransferred,
      uptime: `${hours}h ${minutes}m ${seconds}s`,
      uptimeMs,
      connectionHistory: history,
    };

    // Merge SSH token/session stats from SQLite if available
    if (db) {
      const tokenStats = db.queryOne(`
        SELECT
          COUNT(*) AS total_tokens,
          COUNT(CASE WHEN active = 1 THEN 1 END) AS active_tokens
        FROM tokens
      `);
      const sessionStats = db.queryOne(`
        SELECT
          COUNT(*) AS total_sessions,
          COUNT(CASE WHEN disconnected_at IS NULL THEN 1 END) AS live_sessions
        FROM sessions
      `);

      result.total_tokens = tokenStats?.total_tokens ?? 0;
      result.active_tokens = tokenStats?.active_tokens ?? 0;
      result.total_sessions = sessionStats?.total_sessions ?? 0;
      result.live_sessions = sessionStats?.live_sessions ?? 0;

      // Recent sessions for the activity feed
      result.recent_sessions = db.query(`
        SELECT
          s.id, s.token, s.client_ip,
          s.target_ip, s.target_port,
          s.connected_at, s.disconnected_at,
          t.label AS token_label
        FROM sessions s
        LEFT JOIN tokens t ON t.token = s.token
        ORDER BY s.connected_at DESC
        LIMIT 8
      `);
    }

    res.json(result);
  });

  return router;
}

module.exports = statsRouter;
