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
      // Deactivate: close WS if present, mark inactive
      if (tunnel.clientWs && tunnel.clientWs.readyState <= 1) {
        try {
          tunnel.clientWs.close(1000, 'Tunnel toggled off');
        } catch (err) {
          // ignore close errors
        }
      }
      tunnel.clientWs = null;
      tunnel.status = 'inactive';
    } else {
      // Activate: only mark active if WS is actually connected
      // If not connected, keep as inactive — client will reconnect automatically
      if (tunnel.clientWs && tunnel.clientWs.readyState <= 1) {
        tunnel.status = 'active';
      }
      // else: leave status as 'inactive' — do not set to 'simulated'
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
