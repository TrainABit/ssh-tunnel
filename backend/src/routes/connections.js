const { Router } = require('express');

/**
 * @param {ConnectionTracker} connectionTracker
 */
function connectionsRouter(connectionTracker) {
  const router = Router();

  // GET /api/connections — list active connections, optionally filtered
  router.get('/', (req, res) => {
    const tunnelId = req.query.tunnel || null;
    const connections = connectionTracker.getConnections(tunnelId);
    res.json({ connections });
  });

  return router;
}

module.exports = connectionsRouter;
