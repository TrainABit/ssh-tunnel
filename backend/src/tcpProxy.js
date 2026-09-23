const net = require('net');
const { createLogger } = require('./logger');
const { lookupGeo } = require('./geoip');
const { openTunnelStream, spliceSocket } = require('./protocol');
const log = createLogger('tcp-proxy');

const WS_OPEN = 1;
const LAST_SEEN_THROTTLE_MS = 60_000;
const PREFERRED_PORT_RETRIES = 3;
const PREFERRED_PORT_RETRY_DELAY_MS = 200;

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Public TCP listeners for TCP tunnels. Each accepted connection becomes a
 * tunnel stream (tcp-open to the device) spliced to the socket with
 * backpressure in both directions. Traffic counters are kept in memory
 * (TunnelManager flushes them in batches); the only DB writes are one
 * sessions row per connection (open/close) and a throttled tokens.last_seen.
 */
class TcpProxy {
  /**
   * @param {ConnectionTracker} connectionTracker
   * @param {object} db - database module
   * @param {TunnelManager} tunnelManager
   * @param {object} [options] - { bindHost, portMin, portMax, maxConnectionsPerTunnel }
   */
  constructor(connectionTracker, db, tunnelManager, options = {}) {
    this.connectionTracker = connectionTracker || null;
    this.db = db || null;
    this.tunnelManager = tunnelManager || null;
    this.servers = new Map();    // tunnelId -> { server, port, ws, connections: Map<connId, conn> }
    this.usedPorts = new Set();
    this.portMin = options.portMin || envInt('TCP_PORT_MIN', 10000);
    this.portMax = options.portMax || envInt('TCP_PORT_MAX', 10999);
    if (!(this.portMin >= 1 && this.portMax <= 65535 && this.portMin <= this.portMax)) {
      log.error('Invalid TCP_PORT_MIN/TCP_PORT_MAX, using 10000-10999', { portMin: this.portMin, portMax: this.portMax });
      this.portMin = 10000;
      this.portMax = 10999;
    }
    // TCP_BIND_HOST unset = all interfaces (IPv4 + IPv6 where available).
    this.bindHost = options.bindHost || process.env.TCP_BIND_HOST || undefined;
    this.maxConnectionsPerTunnel = options.maxConnectionsPerTunnel || envInt('TCP_MAX_CONNECTIONS_PER_TUNNEL', 1000);
    this._starting = new Map();   // tunnelId -> { ws } of the start in progress (newest wins)
    this._lastSeen = new Map();   // token -> ms of last tokens.last_seen write
    this._destroyed = false;

    this._onTunnelRemoved = ({ id }) => this.stopListener(id);
    if (this.tunnelManager && typeof this.tunnelManager.on === 'function') {
      this.tunnelManager.on('tunnel:removed', this._onTunnelRemoved);
    }
  }

  _allocatePort(preferred, exclude) {
    // Try the preferred port first (e.g., previously used port for this tunnel)
    if (preferred && preferred >= this.portMin && preferred <= this.portMax
        && !this.usedPorts.has(preferred) && !exclude.has(preferred)) {
      this.usedPorts.add(preferred);
      return preferred;
    }
    for (let p = this.portMin; p <= this.portMax; p++) {
      if (!this.usedPorts.has(p) && !exclude.has(p)) {
        this.usedPorts.add(p);
        return p;
      }
    }
    return null;
  }

  _listen(server, port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once('error', onError);
      server.listen({ port, host: this.bindHost, exclusive: true }, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
  }

  _isCurrent(tunnelId, ws) {
    if (!this.tunnelManager) return ws.readyState === WS_OPEN;
    const t = this.tunnelManager.getTunnel(tunnelId);
    return !!t && t.clientWs === ws && ws.readyState === WS_OPEN;
  }

  /**
   * Start the public listener of a TCP tunnel. Replaces an existing listener
   * of the same tunnel. Returns the port, or null (no port / connection gone).
   */
  async startListener(tunnelId, ws, localPort, tokenRecord, preferredPort) {
    if (this._destroyed) return null;
    if (this.servers.has(tunnelId)) this.stopListener(tunnelId);
    const attempt = { ws };
    this._starting.set(tunnelId, attempt);
    try {
      return await this._start(tunnelId, ws, localPort, tokenRecord, preferredPort, attempt);
    } finally {
      if (this._starting.get(tunnelId) === attempt) this._starting.delete(tunnelId);
    }
  }

  async _start(tunnelId, ws, localPort, tokenRecord, preferredPort, attempt) {
    const cancelled = () => this._destroyed || this._starting.get(tunnelId) !== attempt;

    const connections = new Map();
    const createServer = () => {
      const srv = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
        this._onConnection(tunnelId, ws, localPort, tokenRecord, connections, socket);
      });
      srv.maxConnections = this.maxConnectionsPerTunnel;
      return srv;
    };

    const tried = new Set();
    let server = null;
    let port = null;
    let preferredAttempts = 0;
    for (;;) {
      port = this._allocatePort(preferredPort || null, tried);
      if (port === null) {
        log.error('No TCP ports available', { tunnelId });
        return null;
      }
      server = createServer();
      try {
        await this._listen(server, port);
        break;
      } catch (err) {
        this.usedPorts.delete(port);
        if (err.code === 'EADDRINUSE' && port === preferredPort && preferredAttempts < PREFERRED_PORT_RETRIES) {
          // A just-closed listener of the same tunnel may still be releasing it.
          preferredAttempts++;
          await new Promise(r => setTimeout(r, PREFERRED_PORT_RETRY_DELAY_MS));
          if (cancelled()) return null;
          continue;
        }
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          if (port === preferredPort) {
            log.warn('Preferred port in use, falling back to dynamic allocation', { tunnelId, preferredPort });
          }
          tried.add(port);
          continue;
        }
        log.error('TCP server error on listen', { tunnelId, port, error: err.message });
        return null;
      }
    }

    // Superseded by a newer start, stopped meanwhile, or the device went away.
    if (cancelled() || !this._isCurrent(tunnelId, ws)) {
      server.close();
      this.usedPorts.delete(port);
      return null;
    }

    server.on('error', (err) => {
      log.error('TCP server error', { tunnelId, port, error: err.message });
      const entry = this.servers.get(tunnelId);
      if (entry && entry.server === server) this.stopListener(tunnelId);
    });

    log.info('TCP listener started', { tunnelId, port });
    this.servers.set(tunnelId, { server, port, ws, connections });
    return port;
  }

  _touchTokenLastSeen(token) {
    if (!token || !this.db) return;
    const now = Date.now();
    const last = this._lastSeen.get(token) || 0;
    if (now - last < LAST_SEEN_THROTTLE_MS) return;
    this._lastSeen.set(token, now);
    if (this._lastSeen.size > 10000) this._lastSeen.clear();
    try {
      this.db.run("UPDATE tokens SET last_seen = datetime('now') WHERE token = ?", [token]);
    } catch (err) {
      log.warn('Failed to update token last_seen', { error: err.message });
    }
  }

  _onConnection(tunnelId, ws, localPort, tokenRecord, connections, socket) {
    const remoteAddress = socket.remoteAddress || 'unknown';
    const tunnel = this.tunnelManager ? this.tunnelManager.getTunnel(tunnelId) : null;
    if (!this._isCurrent(tunnelId, ws) || (tunnel && tunnel.status !== 'active')) {
      socket.destroy();
      return;
    }

    const trackId = this.connectionTracker
      ? this.connectionTracker.startConnection(tunnelId, remoteAddress)
      : null;
    const onTraffic = (bytesIn, bytesOut) => {
      if (trackId) this.connectionTracker.updateBytes(trackId, bytesIn, bytesOut);
      if (this.tunnelManager) this.tunnelManager.addBytes(tunnelId, bytesIn + bytesOut);
    };
    const stream = tunnel
      ? openTunnelStream(tunnel, { onTraffic })
      : (ws.tunnelChannel ? ws.tunnelChannel.openStream({ tunnelId, localPort, onTraffic }) : null);
    if (!stream) {
      if (trackId) this.connectionTracker.completeConnection(trackId);
      socket.destroy();
      return;
    }
    if (this.tunnelManager) this.tunnelManager.incrementConnections(tunnelId);

    // One sessions row per TCP connection (not per packet).
    let sessionId = null;
    const token = (tokenRecord && tokenRecord.token) || null;
    if (this.db) {
      try {
        const result = this.db.run(
          'INSERT INTO sessions (token, client_ip, target_ip, target_port, tunnel_id) VALUES (?, ?, ?, ?, ?)',
          [token, remoteAddress, '127.0.0.1', localPort, tunnelId]
        );
        sessionId = Number(result.lastInsertRowid);
      } catch (err) {
        log.warn('Failed to create session record', { error: err.message });
      }
      this._touchTokenLastSeen(token);
    }

    const conn = { socket, stream, trackId, sessionId, done: false };
    connections.set(stream.connId, conn);

    // Fire-and-forget geo lookup — does not block connection setup
    if (sessionId || trackId) {
      Promise.resolve()
        .then(() => lookupGeo(remoteAddress))
        .then((geo) => {
          if (!geo) return;
          if (sessionId && this.db) {
            try {
              this.db.run('UPDATE sessions SET country=?, country_code=?, city=? WHERE id=?',
                [geo.country, geo.country_code, geo.city, sessionId]);
            } catch {}
          }
          if (trackId && this.connectionTracker) this.connectionTracker.updateGeo(trackId, geo);
        })
        .catch(() => {});
    }

    log.debug('TCP connection opened', { tunnelId, connId: stream.connId });

    socket.setNoDelay(true);
    socket.on('error', (err) => {
      log.debug('TCP socket error', { connId: stream.connId, error: err.message });
    });
    socket.once('close', () => {
      connections.delete(stream.connId);
      this._finishConnection(conn);
    });
    spliceSocket(socket, stream);
    socket.resume(); // pauseOnConnect: start reading once everything is wired
  }

  _finishConnection(conn) {
    if (conn.done) return;
    conn.done = true;
    if (this.connectionTracker && conn.trackId) this.connectionTracker.completeConnection(conn.trackId);
    if (this.db && conn.sessionId) {
      try {
        this.db.run("UPDATE sessions SET disconnected_at = datetime('now') WHERE id = ?", [conn.sessionId]);
      } catch {}
    }
  }

  /**
   * Open a tunnel stream to the device of an active tunnel (used by the HTTP
   * proxy). Returns a TunnelStream or null.
   */
  openStream(tunnelId, opts = {}) {
    const tunnel = this.tunnelManager ? this.tunnelManager.getTunnel(tunnelId) : null;
    if (!tunnel || tunnel.status !== 'active') return null;
    return openTunnelStream(tunnel, opts);
  }

  /**
   * Stop the public listener of a tunnel and drop its connections. If `ws` is
   * given, only stops the listener if it was started for that connection.
   */
  stopListener(tunnelId, ws) {
    // Cancel a start in progress (for that connection, if one is given).
    const starting = this._starting.get(tunnelId);
    if (starting && (!ws || starting.ws === ws)) this._starting.delete(tunnelId);
    const entry = this.servers.get(tunnelId);
    if (!entry) return false;
    if (ws && entry.ws !== ws) return false;
    this.servers.delete(tunnelId);
    this.usedPorts.delete(entry.port);
    entry.server.close(() => log.info('TCP listener stopped', { tunnelId, port: entry.port }));
    for (const conn of entry.connections.values()) {
      conn.socket.destroy();
      conn.stream.destroy();
      this._finishConnection(conn);
    }
    entry.connections.clear();
    return true;
  }

  getPort(tunnelId) { return this.servers.get(tunnelId)?.port ?? null; }

  destroy() {
    this._destroyed = true;
    for (const tunnelId of [...this.servers.keys()]) this.stopListener(tunnelId);
    if (this.tunnelManager && typeof this.tunnelManager.removeListener === 'function') {
      this.tunnelManager.removeListener('tunnel:removed', this._onTunnelRemoved);
    }
    this._lastSeen.clear();
    this._starting.clear();
  }
}

module.exports = TcpProxy;
