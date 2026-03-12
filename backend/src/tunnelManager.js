const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const EventEmitter = require('events');
const { createLogger } = require('./logger');
const log = createLogger('tunnel-mgr');

class TunnelManager extends EventEmitter {
  constructor(db) {
    super();
    this.tunnels = new Map();
    this.db = db || null;

    // Load persisted tunnels from DB on startup
    if (this.db) {
      try {
        const rows = this.db.query('SELECT * FROM tunnels');
        for (const row of rows) {
          const tunnel = {
            id: row.id,
            name: row.name,
            subdomain: row.subdomain,
            localPort: row.local_port,
            publicUrl: row.public_url,
            clientWs: null,
            status: 'inactive', // No WS connection after restart
            createdAt: row.created_at,
            connections: row.connections,
            bytesTransferred: row.bytes_transferred,
            protocol: row.protocol || 'http',
            allocatedPort: row.allocated_port || null,
          };
          this.tunnels.set(tunnel.id, tunnel);
        }
        // Mark all as inactive in DB since WS connections are gone
        if (rows.length > 0) {
          this.db.run("UPDATE tunnels SET status = 'inactive'");
        }
        log.info(`Loaded ${rows.length} tunnel(s) from database`);
      } catch (err) {
        log.error('Failed to load tunnels from DB', { error: err });
      }
    }
  }

  /**
   * Create and register a new tunnel.
   * @param {object} config - { name, localPort, subdomain? }
   * @param {WebSocket|null} ws - WebSocket connection from the client (null for simulated tunnels)
   * @returns {object} the tunnel record
   */
  createTunnel(config, ws) {
    const id = uuidv4();
    const subdomain = config.subdomain || config.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const domain = process.env.DOMAIN || 'tunnel.local';
    const protocol = config.protocol === 'tcp' ? 'tcp' : 'http';

    // Remove any inactive tunnels with the same subdomain to prevent
    // stale entries from shadowing new registrations
    for (const [existingId, existing] of this.tunnels.entries()) {
      if (existing.subdomain === subdomain && (existing.status === 'inactive' || existing.status === 'paused')) {
        this.tunnels.delete(existingId);
        if (this.db) {
          try {
            this.db.run('DELETE FROM tunnels WHERE id = ?', [existingId]);
          } catch (err) {
            log.warn('DB error removing stale tunnel', { error: err, tunnelId: existingId });
          }
        }
      }
    }

    // Generate an ownership secret — clients must present this to reconnect
    const ownerSecret = crypto.randomBytes(32).toString('hex');

    const publicUrl = protocol === 'tcp'
      ? `tcp:${config.allocatedPort || '?'}`
      : `http://${subdomain}.${domain}:${process.env.PROXY_PORT || 4001}`;

    const tunnel = {
      id,
      name: config.name,
      subdomain,
      localPort: config.localPort,
      publicUrl,
      clientWs: ws,
      status: ws ? 'active' : 'simulated',
      createdAt: new Date().toISOString(),
      connections: 0,
      bytesTransferred: 0,
      ownerSecret,
      protocol,
      allocatedPort: config.allocatedPort || null,
      clientToken: config.clientToken || null,
    };

    this.tunnels.set(id, tunnel);

    // Persist to database
    if (this.db) {
      try {
        this.db.run(
          `INSERT INTO tunnels (id, name, subdomain, local_port, public_url, status, created_at, connections, bytes_transferred, protocol, allocated_port)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [tunnel.id, tunnel.name, tunnel.subdomain, tunnel.localPort, tunnel.publicUrl, tunnel.status, tunnel.createdAt, tunnel.connections, tunnel.bytesTransferred, tunnel.protocol, tunnel.allocatedPort]
        );
      } catch (err) {
        log.error('Failed to persist tunnel to DB', { error: err, tunnelId: tunnel.id });
      }
    }

    this.emit('tunnel:created', tunnel);
    return tunnel;
  }

  /**
   * Update the allocated TCP port for a tunnel and persist to DB.
   */
  setAllocatedPort(id, port) {
    const t = this.tunnels.get(id);
    if (!t) return;
    t.allocatedPort = port;
    t.publicUrl = `tcp:${port}`;
    if (this.db) {
      try {
        this.db.run('UPDATE tunnels SET allocated_port = ?, public_url = ? WHERE id = ?', [port, t.publicUrl, id]);
      } catch (err) {
        log.warn('DB error in setAllocatedPort', { error: err, tunnelId: id });
      }
    }
  }

  /**
   * Remove a tunnel by id.
   */
  removeTunnel(id) {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) return false;

    if (tunnel.clientWs && tunnel.clientWs.readyState <= 1) {
      try {
        tunnel.clientWs.close(1000, 'Tunnel removed');
      } catch (err) {
        log.warn('Error closing WS during tunnel removal', { error: err, tunnelId: id });
      }
    }

    this.tunnels.delete(id);

    // Remove from database
    if (this.db) {
      try {
        this.db.run('DELETE FROM tunnels WHERE id = ?', [id]);
      } catch (err) {
        log.error('Failed to delete tunnel from DB', { error: err, tunnelId: id });
      }
    }

    this.emit('tunnel:removed', { id });
    return true;
  }

  /**
   * Get a tunnel by id.
   */
  getTunnel(id) {
    return this.tunnels.get(id) || null;
  }

  /**
   * Find a tunnel by subdomain.
   * Prefers active tunnels over inactive ones to handle subdomain reuse
   * after client disconnects and reconnects with the same subdomain.
   */
  getTunnelBySubdomain(subdomain) {
    let fallback = null;
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.subdomain === subdomain) {
        if (tunnel.status === 'active') return tunnel;
        if (!fallback) fallback = tunnel;
      }
    }
    return fallback;
  }

  /**
   * Return all tunnels (serializable, without ws reference).
   */
  getAllTunnels() {
    const result = [];
    for (const t of this.tunnels.values()) {
      result.push(this._serialize(t));
    }
    return result;
  }

  /**
   * Return aggregated stats.
   */
  getStats() {
    let totalConnections = 0;
    let totalBytes = 0;
    let active = 0;

    for (const t of this.tunnels.values()) {
      totalConnections += t.connections;
      totalBytes += t.bytesTransferred;
      if (t.status === 'active' || t.status === 'simulated') active++;
    }

    return {
      activeTunnels: active,
      totalConnections,
      bytesTransferred: totalBytes,
    };
  }

  /**
   * Increment connection count for a tunnel.
   */
  incrementConnections(id) {
    const t = this.tunnels.get(id);
    if (t) {
      t.connections++;
      if (this.db) {
        try {
          this.db.run('UPDATE tunnels SET connections = ? WHERE id = ?', [t.connections, id]);
        } catch (err) {
          log.warn('DB error in incrementConnections', { error: err, tunnelId: id });
        }
      }
    }
  }

  /**
   * Add bytes transferred for a tunnel.
   */
  addBytes(id, bytes) {
    const t = this.tunnels.get(id);
    if (t) {
      t.bytesTransferred += bytes;
      if (this.db) {
        try {
          this.db.run('UPDATE tunnels SET bytes_transferred = ? WHERE id = ?', [t.bytesTransferred, id]);
        } catch (err) {
          log.warn('DB error in addBytes', { error: err, tunnelId: id });
        }
      }
    }
  }

  /**
   * Mark a tunnel as disconnected (client ws gone).
   * @param {string} id
   * @param {WebSocket} [disconnectingWs] - if provided, only disconnect if tunnel's current WS matches
   */
  markDisconnected(id, disconnectingWs) {
    const t = this.tunnels.get(id);
    if (!t) return;

    // Guard against race: if a new WS has already reconnected, don't overwrite it
    if (disconnectingWs && t.clientWs && t.clientWs !== disconnectingWs) {
      log.debug('Skipping markDisconnected — tunnel already reconnected with new WS', { tunnelId: id });
      return;
    }

    // Don't overwrite 'paused' — tunnel was manually stopped
    if (t.status !== 'paused') {
      t.status = 'inactive';
      if (this.db) {
        try {
          this.db.run("UPDATE tunnels SET status = 'inactive' WHERE id = ?", [id]);
        } catch (err) {
          log.warn('DB error in markDisconnected', { error: err, tunnelId: id });
        }
      }
    }
    t.clientWs = null;
    this.emit('tunnel:disconnected', { id });
  }

  /**
   * Reconnect: attach a new ws to an existing tunnel.
   * @param {string} id - tunnel ID
   * @param {WebSocket} ws - new WebSocket connection
   * @param {string} secret - ownership secret (must match tunnel's ownerSecret)
   * @returns {boolean}
   */
  reconnect(id, ws, secret) {
    const t = this.tunnels.get(id);
    if (!t) return false;

    // Verify ownership — prevent hijacking by other authenticated clients
    if (!t.ownerSecret || !secret) return false;
    const bufA = Buffer.from(t.ownerSecret);
    const bufB = Buffer.from(String(secret));
    if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
      log.warn('Reconnect rejected — invalid ownership secret', { tunnelId: id });
      return false;
    }

    t.clientWs = ws;

    // If manually paused, keep paused — don't activate
    if (t.status === 'paused') {
      return true;
    }

    t.status = 'active';
    if (this.db) {
      try {
        this.db.run("UPDATE tunnels SET status = 'active' WHERE id = ?", [id]);
      } catch (err) {
        log.warn('DB error in reconnect', { error: err, tunnelId: id });
      }
    }
    this.emit('tunnel:reconnected', { id });
    return true;
  }

  // ---- private helpers ----

  _serialize(t) {
    return {
      id: t.id,
      name: t.name,
      subdomain: t.subdomain,
      localPort: t.localPort,
      publicUrl: t.publicUrl,
      status: t.status,
      createdAt: t.createdAt,
      connections: t.connections,
      bytesTransferred: t.bytesTransferred,
      protocol: t.protocol || 'http',
      allocatedPort: t.allocatedPort || null,
      // ownerSecret intentionally excluded
    };
  }
}

module.exports = TunnelManager;
