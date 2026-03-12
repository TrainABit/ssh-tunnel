const { Router } = require('express');

/**
 * @param {TunnelManager} tunnelManager
 */
function tunnelsRouter(tunnelManager) {
  const router = Router();

  // GET /api/tunnels — list all tunnels
  router.get('/', (req, res) => {
    const tunnels = tunnelManager.getAllTunnels();
    res.json({ tunnels });
  });

  // GET /api/tunnels/:id — get single tunnel
  router.get('/:id', (req, res) => {
    const tunnel = tunnelManager.getTunnel(req.params.id);
    if (!tunnel) {
      return res.status(404).json({ error: 'Tunnel not found' });
    }
    // Return serializable version (strip ws and ownerSecret)
    const { clientWs, ownerSecret, ...data } = tunnel;
    res.json({ tunnel: data });
  });

  // POST /api/tunnels — register a new tunnel via API (without WS)
  router.post('/', (req, res) => {
    const { name, localPort, subdomain } = req.body;
    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      return res.status(400).json({ error: 'name is required' });
    }
    // Check for duplicate name
    const existing = tunnelManager.getAllTunnels().find(t => t.name === trimmedName);
    if (existing) {
      return res.status(409).json({ error: 'A tunnel with this name already exists' });
    }
    const tunnel = tunnelManager.createTunnel(
      { name: trimmedName, localPort: localPort || 3000, subdomain },
      null
    );
    const { clientWs, ownerSecret, ...data } = tunnel;
    res.status(201).json({ tunnel: data });
  });

  // POST /api/tunnels/:id/toggle — toggle tunnel active/inactive
  router.post('/:id/toggle', (req, res) => {
    const tunnel = tunnelManager.getTunnel(req.params.id);
    if (!tunnel) {
      return res.status(404).json({ error: 'Tunnel not found' });
    }

    if (tunnel.status === 'active' || tunnel.status === 'simulated') {
      // Stop: close WS, mark paused (so client reconnects but stays in standby)
      if (tunnel.clientWs && tunnel.clientWs.readyState <= 1) {
        try { tunnel.clientWs.close(1000, 'Tunnel paused'); } catch (_) {}
      }
      tunnel.clientWs = null;
      tunnel.status = 'paused';
    } else if (tunnel.status === 'paused') {
      // Start from paused: close standby WS to force a fresh reconnect as active
      if (tunnel.clientWs && tunnel.clientWs.readyState <= 1) {
        try { tunnel.clientWs.close(1000, 'Tunnel resumed'); } catch (_) {}
        tunnel.clientWs = null;
      }
      tunnel.status = 'inactive'; // client will reconnect → reconnect() activates it
    } else {
      // Already inactive: activate if WS present, else wait for client to reconnect
      if (tunnel.clientWs && tunnel.clientWs.readyState <= 1) {
        tunnel.status = 'active';
      }
    }

    // Persist status to DB
    if (tunnelManager.db) {
      try {
        tunnelManager.db.run("UPDATE tunnels SET status = ? WHERE id = ?", [tunnel.status, tunnel.id]);
      } catch (_) { /* best-effort */ }
    }

    const { clientWs, ownerSecret, ...data } = tunnel;
    res.json({ tunnel: data });
  });

  // DELETE /api/tunnels/:id — remove tunnel
  router.delete('/:id', (req, res) => {
    const removed = tunnelManager.removeTunnel(req.params.id);
    if (!removed) {
      return res.status(404).json({ error: 'Tunnel not found' });
    }
    res.json({ message: 'Tunnel removed' });
  });

  return router;
}

module.exports = tunnelsRouter;
