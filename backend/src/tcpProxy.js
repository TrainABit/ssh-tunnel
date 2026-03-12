const net = require('net');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('./logger');
const log = createLogger('tcp-proxy');

class TcpProxy {
  constructor(connectionTracker, db) {
    this.connectionTracker = connectionTracker || null;
    this.db = db || null;
    this.servers = new Map();    // tunnelId -> { server, port, connections: Map<connId, socket> }
    this.connTunnel = new Map(); // connId -> tunnelId
    this.connMeta = new Map();   // connId -> { trackId, sessionId }
    this.usedPorts = new Set();
    this.portMin = parseInt(process.env.TCP_PORT_MIN, 10) || 10000;
    this.portMax = parseInt(process.env.TCP_PORT_MAX, 10) || 10999;
  }

  _allocatePort() {
    for (let p = this.portMin; p <= this.portMax; p++) {
      if (!this.usedPorts.has(p)) {
        this.usedPorts.add(p);
        return p;
      }
    }
    return null;
  }

  startListener(tunnelId, ws, localPort, tokenRecord) {
    const port = this._allocatePort();
    if (port === null) {
      log.error('No TCP ports available', { tunnelId });
      return null;
    }

    const connections = new Map();

    const server = net.createServer((socket) => {
      const connId = uuidv4();
      connections.set(connId, socket);
      this.connTunnel.set(connId, tunnelId);

      // Track in ConnectionTracker
      const trackId = this.connectionTracker
        ? this.connectionTracker.startConnection(tunnelId, socket.remoteAddress)
        : null;

      // Create a DB session record if we have a per-client token
      let sessionId = null;
      if (this.db && tokenRecord && tokenRecord.token) {
        try {
          const result = this.db.run(
            `INSERT INTO sessions (token, client_ip, target_ip, target_port) VALUES (?, ?, ?, ?)`,
            [tokenRecord.token, socket.remoteAddress || 'unknown', '127.0.0.1', localPort]
          );
          sessionId = Number(result.lastInsertRowid);
          this.db.run(
            `UPDATE tokens SET last_seen = datetime('now') WHERE token = ?`,
            [tokenRecord.token]
          );
        } catch (err) {
          log.warn('Failed to create session record', { error: err.message });
        }
      }

      this.connMeta.set(connId, { trackId, sessionId });

      log.debug('TCP connection opened', { tunnelId, connId });

      if (ws.readyState !== 1) { socket.destroy(); return; }
      ws.send(JSON.stringify({ type: 'tcp-open', connId, tunnelId, localPort }));

      socket.on('data', (chunk) => {
        // Track bytes incoming from external SSH client
        if (this.connectionTracker && trackId) {
          this.connectionTracker.updateBytes(trackId, chunk.length, 0);
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

    server.listen(port, () => log.info('TCP listener started', { tunnelId, port }));
    server.on('error', (err) => {
      log.error('TCP server error', { tunnelId, port, error: err.message });
      this.stopListener(tunnelId);
    });

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
