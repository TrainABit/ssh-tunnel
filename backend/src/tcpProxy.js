const net = require('net');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('./logger');
const log = createLogger('tcp-proxy');

class TcpProxy {
  constructor(connectionTracker, db, tunnelManager) {
    this.connectionTracker = connectionTracker || null;
    this.db = db || null;
    this.tunnelManager = tunnelManager || null;
    this.servers = new Map();    // tunnelId -> { server, port, connections: Map<connId, socket> }
    this.connTunnel = new Map(); // connId -> tunnelId
    this.connMeta = new Map();   // connId -> { trackId, sessionId }
    this.usedPorts = new Set();
    this.portMin = parseInt(process.env.TCP_PORT_MIN, 10) || 10000;
    this.portMax = parseInt(process.env.TCP_PORT_MAX, 10) || 10999;
  }

  _allocatePort(preferred) {
    // Try the preferred port first (e.g., previously used port for this tunnel)
    if (preferred && preferred >= this.portMin && preferred <= this.portMax && !this.usedPorts.has(preferred)) {
      this.usedPorts.add(preferred);
      return preferred;
    }
    for (let p = this.portMin; p <= this.portMax; p++) {
      if (!this.usedPorts.has(p)) {
        this.usedPorts.add(p);
        return p;
      }
    }
    return null;
  }

  async startListener(tunnelId, ws, localPort, tokenRecord, preferredPort) {
    const port = this._allocatePort(preferredPort || null);
    if (port === null) {
      log.error('No TCP ports available', { tunnelId });
      return null;
    }

    const connections = new Map();

    const server = net.createServer((socket) => {
      const connId = uuidv4();
      connections.set(connId, socket);
      this.connTunnel.set(connId, tunnelId);

      // Track in ConnectionTracker and tunnel stats
      const trackId = this.connectionTracker
        ? this.connectionTracker.startConnection(tunnelId, socket.remoteAddress)
        : null;
      if (this.tunnelManager) {
        this.tunnelManager.incrementConnections(tunnelId);
      }

      // Create a DB session record for every TCP connection
      let sessionId = null;
      if (this.db) {
        try {
          const token = tokenRecord?.token || null;
          const result = this.db.run(
            `INSERT INTO sessions (token, client_ip, target_ip, target_port) VALUES (?, ?, ?, ?)`,
            [token, socket.remoteAddress || 'unknown', '127.0.0.1', localPort]
          );
          sessionId = Number(result.lastInsertRowid);
          if (token) {
            this.db.run(
              `UPDATE tokens SET last_seen = datetime('now') WHERE token = ?`,
              [token]
            );
          }
        } catch (err) {
          log.warn('Failed to create session record', { error: err.message });
        }
      }

      this.connMeta.set(connId, { trackId, sessionId });

      log.debug('TCP connection opened', { tunnelId, connId });

      if (ws.readyState !== 1) { socket.destroy(); return; }
      ws.send(JSON.stringify({ type: 'tcp-open', connId, tunnelId, localPort }));

      socket.on('data', (chunk) => {
        if (this.connectionTracker && trackId) {
          this.connectionTracker.updateBytes(trackId, chunk.length, 0);
        }
        if (this.tunnelManager) {
          this.tunnelManager.addBytes(tunnelId, chunk.length);
        }
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'tcp-data', connId, data: chunk.toString('base64') }));
        } else {
          socket.destroy();
        }
      });

      const cleanup = () => {
        const meta = this.connMeta.get(connId);
        if (meta) {
          if (this.connectionTracker && meta.trackId) {
            this.connectionTracker.completeConnection(meta.trackId);
          }
          if (this.db && meta.sessionId) {
            try {
              this.db.run(
                `UPDATE sessions SET disconnected_at = datetime('now') WHERE id = ?`,
                [meta.sessionId]
              );
            } catch {}
          }
          this.connMeta.delete(connId);
        }
        this.connTunnel.delete(connId);
        connections.delete(connId);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'tcp-close', connId }));
      };
      socket.on('end', cleanup);
      socket.on('error', (err) => {
        log.warn('TCP socket error', { connId, error: err.message });
        socket.destroy();
      });
      socket.on('close', () => {
        // Ensure cleanup if not already done
        if (this.connMeta.has(connId)) {
          const meta = this.connMeta.get(connId);
          if (this.connectionTracker && meta.trackId) {
            this.connectionTracker.completeConnection(meta.trackId);
          }
          if (this.db && meta.sessionId) {
            try {
              this.db.run(
                `UPDATE sessions SET disconnected_at = datetime('now') WHERE id = ?`,
                [meta.sessionId]
              );
            } catch {}
          }
          this.connMeta.delete(connId);
        }
        this.connTunnel.delete(connId);
        connections.delete(connId);
      });
    });

    // Wrap listen in a promise so callers can await and handle EADDRINUSE
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (err) {
      this.usedPorts.delete(port);
      // If the preferred port was already in use on the OS, retry with any free port
      if (err.code === 'EADDRINUSE' && preferredPort && port === preferredPort) {
        log.warn('Preferred port in use, falling back to dynamic allocation', { tunnelId, preferredPort });
        return this.startListener(tunnelId, ws, localPort, tokenRecord, null);
      }
      log.error('TCP server error on listen', { tunnelId, port, error: err.message });
      return null;
    }

    server.on('error', (err) => {
      log.error('TCP server error', { tunnelId, port, error: err.message });
      this.stopListener(tunnelId);
    });

    log.info('TCP listener started', { tunnelId, port });
    this.servers.set(tunnelId, { server, port, connections });
    return port;
  }

  forwardData(connId, data) {
    const tunnelId = this.connTunnel.get(connId);
    if (!tunnelId) return;
    const entry = this.servers.get(tunnelId);
    const socket = entry?.connections.get(connId);
    if (socket && !socket.destroyed) socket.write(Buffer.from(data, 'base64'));
  }

  closeConn(connId) {
    const tunnelId = this.connTunnel.get(connId);
    if (!tunnelId) return;
    const entry = this.servers.get(tunnelId);
    const socket = entry?.connections.get(connId);
    if (socket && !socket.destroyed) socket.end();
    this.connTunnel.delete(connId);
    entry?.connections.delete(connId);
  }

  stopListener(tunnelId) {
    const entry = this.servers.get(tunnelId);
    if (!entry) return;
    for (const [connId, socket] of entry.connections) {
      socket.destroy();
      // Clean up meta for each connection
      const meta = this.connMeta.get(connId);
      if (meta) {
        if (this.connectionTracker && meta.trackId) {
          this.connectionTracker.completeConnection(meta.trackId);
        }
        if (this.db && meta.sessionId) {
          try {
            this.db.run(
              `UPDATE sessions SET disconnected_at = datetime('now') WHERE id = ?`,
              [meta.sessionId]
            );
          } catch {}
        }
        this.connMeta.delete(connId);
      }
      this.connTunnel.delete(connId);
    }
    entry.connections.clear();
    this.usedPorts.delete(entry.port);
    entry.server.close(() => log.info('TCP listener stopped', { tunnelId, port: entry.port }));
    this.servers.delete(tunnelId);
  }

  getPort(tunnelId) { return this.servers.get(tunnelId)?.port ?? null; }

  destroy() {
    for (const tunnelId of [...this.servers.keys()]) this.stopListener(tunnelId);
  }
}

module.exports = TcpProxy;
