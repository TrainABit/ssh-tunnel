const { Router } = require('express');
const { createLogger } = require('../logger');
const log = createLogger('tunnels');

/** Web-terminal host key pin id (see sshWsHandler). */
function pinKeyFor(tunnel) {
  return tunnel.clientToken
    ? `token:${tunnel.clientToken}:${tunnel.localPort}`
    : `tunnel:${tunnel.id}`;
}

/**
 * @param {TunnelManager} tunnelManager
 * @param {object} [deps]
 * @param {object} [deps.db] - database module (host key pins, stored-key flags); defaults to tunnelManager.db
 * @param {object} [deps.secretBox] - secretBox instance (stored-key feature enabled?)
 */
function tunnelsRouter(tunnelManager, deps = {}) {
  const router = Router();
  const db = deps.db || tunnelManager.db || null;
  const secretBox = deps.secretBox || { enabled: false };

  /** API form of a tunnel: no ws, no ownerSecret. */
  function serialize(tunnel) {
    if (typeof tunnelManager.getTunnelInfo === 'function') {
      const info = tunnelManager.getTunnelInfo(tunnel.id);
      if (info) return info;
    }
    const { clientWs, ownerSecret, tunnelChannel, ...data } = tunnel;
    return data;
  }

  /** Add has_private_key + host_key_fingerprint to serialized tunnels. */
  function decorate(list) {
    let pins = new Map();
    let keyed = new Set();
    if (db) {
      try {
        pins = new Map(db.query('SELECT pin_key, fingerprint FROM ssh_host_keys').map((r) => [r.pin_key, r.fingerprint]));
        if (secretBox.enabled) {
          keyed = new Set(db.query("SELECT token FROM tokens WHERE private_key IS NOT NULL AND private_key != ''").map((r) => r.token));
        }
      } catch (err) {
        log.warn('Could not read host key pins / stored keys', { error: err.message });
      }
    }
    return list.map((t) => ({
      ...t,
      has_private_key: !!(t.clientToken && keyed.has(t.clientToken)),
      host_key_fingerprint: pins.get(pinKeyFor(t)) || null,
    }));
  }

  // GET /api/tunnels — list all tunnels
  router.get('/', (_req, res) => {
    res.json({ tunnels: decorate(tunnelManager.getAllTunnels()) });
  });

  // POST /api/tunnels — removed: tunnels are created by connecting devices only.
  router.post('/', (_req, res) => {
    res.status(405).json({
      error: 'Tunnels are created by connecting a device (tunnelvault connect). Creating tunnels via the API is no longer supported.',
    });
  });

  // GET /api/tunnels/:id — get single tunnel
  router.get('/:id', (req, res) => {
    const tunnel = tunnelManager.getTunnel(req.params.id);
    if (!tunnel) {
      return res.status(404).json({ error: 'Tunnel not found' });
    }
    res.json({ tunnel: decorate([serialize(tunnel)])[0] });
  });

  // DELETE /api/tunnels/:id/hostkey — forget the pinned web-terminal host key
  router.delete('/:id/hostkey', (req, res) => {
    const tunnel = tunnelManager.getTunnel(req.params.id);
    if (!tunnel) {
      return res.status(404).json({ error: 'Tunnel not found' });
    }
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const result = db.run('DELETE FROM ssh_host_keys WHERE pin_key = ?', [pinKeyFor(tunnel)]);
    log.info('Web terminal host key pin removed', { tunnelId: tunnel.id, removed: result.changes > 0 });
    res.json({ removed: result.changes > 0 });
  });

  // POST /api/tunnels/:id/toggle — toggle tunnel active/paused
  router.post('/:id/toggle', (req, res) => {
    const tunnel = tunnelManager.getTunnel(req.params.id);
    if (!tunnel) {
      return res.status(404).json({ error: 'Tunnel not found' });
    }

    if (tunnel.status === 'active') {
      // Stop: mark paused, close WS (the client reconnects and is held in standby)
      const ws = tunnel.clientWs;
      tunnel.status = 'paused';
      tunnel.clientWs = null;
      if (ws && ws.readyState <= 1) {
        try { ws.close(1000, 'Tunnel paused'); } catch (_) {}
      }
    } else if (tunnel.status === 'paused') {
      // Start from paused: close standby WS to force a fresh reconnect as active
      const ws = tunnel.clientWs;
      tunnel.status = 'inactive'; // client will reconnect → reconnect() activates it
      if (ws && ws.readyState <= 1) {
        tunnel.clientWs = null;
        try { ws.close(1000, 'Tunnel resumed'); } catch (_) {}
      }
    } else {
      // Already inactive: activate if WS present, else wait for client to reconnect
      if (tunnel.clientWs && tunnel.clientWs.readyState === 1) {
        tunnel.status = 'active';
      }
    }

    // Persist status to DB
    if (tunnelManager.db) {
      try {
        tunnelManager.db.run('UPDATE tunnels SET status = ? WHERE id = ?', [tunnel.status, tunnel.id]);
      } catch (_) { /* best-effort */ }
    }

    res.json({ tunnel: decorate([serialize(tunnel)])[0] });
  });

  // POST /api/tunnels/:id/reboot — send reboot command to the connected client device
  // (devices only obey it when they opted in with allow_reboot)
  router.post('/:id/reboot', (req, res) => {
    const tunnel = tunnelManager.getTunnel(req.params.id);
    if (!tunnel) {
      return res.status(404).json({ error: 'Tunnel not found' });
    }
    if (!tunnel.clientWs || tunnel.clientWs.readyState !== 1) {
      return res.status(409).json({ error: 'Client is not connected' });
    }
    try {
      const msg = { type: 'reboot' };
      if (tunnel.clientWs.tunnelChannel && typeof tunnel.clientWs.tunnelChannel.sendControl === 'function') {
        tunnel.clientWs.tunnelChannel.sendControl(msg);
      } else {
        tunnel.clientWs.send(JSON.stringify(msg));
      }
    } catch (err) {
      return res.status(500).json({ error: 'Failed to send reboot command' });
    }
    log.info('Reboot command sent', { tunnelId: tunnel.id });
    res.status(202).json({ message: 'Reboot command sent (the device only reboots if remote reboot is enabled on it)' });
  });

  // DELETE /api/tunnels/:id — remove tunnel
  router.delete('/:id', (req, res) => {
    const tunnel = tunnelManager.getTunnel(req.params.id);
    const removed = tunnelManager.removeTunnel(req.params.id);
    if (!removed) {
      return res.status(404).json({ error: 'Tunnel not found' });
    }
    // A pin scoped to this tunnel id can never be used again.
    if (db && tunnel && !tunnel.clientToken) {
      try { db.run('DELETE FROM ssh_host_keys WHERE pin_key = ?', [`tunnel:${tunnel.id}`]); } catch (_) {}
    }
    res.json({ message: 'Tunnel removed' });
  });

  return router;
}

module.exports = tunnelsRouter;
module.exports.pinKeyFor = pinKeyFor;
