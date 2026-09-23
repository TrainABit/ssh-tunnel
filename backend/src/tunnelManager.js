const crypto = require('crypto');
const EventEmitter = require('events');
const { createLogger } = require('./logger');
const log = createLogger('tunnel-mgr');

const STATS_FLUSH_MS = 5000;
const MAX_RECORDS_PER_TOKEN = 50;
const WS_OPEN = 1;

function tokenPrefix(token) {
  return typeof token === 'string' && token.length > 0 ? `${token.slice(0, 4)}***` : 'admin';
}

/** Parse an ISO timestamp or SQLite "YYYY-MM-DD HH:MM:SS" (UTC) into ms. */
function parseTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let v = value;
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(v)) v = `${v.replace(' ', 'T')}Z`;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** Lower-case DNS label: [a-z0-9-], no leading/trailing '-', 1..63 chars. */
function sanitizeSubdomain(value) {
  const s = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return s || 'tunnel';
}

function normalizeDomain(value) {
  return String(value || 'tunnel.local').trim().toLowerCase().replace(/^\*?\.+/, '').replace(/\.+$/, '');
}

/**
 * Public URL of an http tunnel: HTTP_TUNNEL_URL_TEMPLATE (e.g.
 * "https://{subdomain}.example.com") or http://{subdomain}.DOMAIN:PROXY_PORT.
 */
function httpPublicUrl(subdomain) {
  const template = process.env.HTTP_TUNNEL_URL_TEMPLATE;
  if (template && template.includes('{subdomain}')) return template.split('{subdomain}').join(subdomain);
  const domain = normalizeDomain(process.env.DOMAIN);
  return `http://${subdomain}.${domain}:${process.env.PROXY_PORT || 4001}`;
}

function isWsOpen(ws) {
  return !!ws && ws.readyState === WS_OPEN;
}

class TunnelManager extends EventEmitter {
  /**
   * @param {object} db - database module ({ query, queryOne, run, transaction })
   * @param {object} [options]
   * @param {number} [options.statsFlushMs=5000] - stats flush interval (never more often than this)
   * @param {number} [options.maxRecordsPerToken=50] - stored tunnel records per device token;
   *   the least recently used inactive ones are pruned beyond this
   */
  constructor(db, options = {}) {
    super();
    this.tunnels = new Map();
    this.db = db || null;
    this.statsFlushMs = options.statsFlushMs > 0 ? options.statsFlushMs : STATS_FLUSH_MS;
    this.maxRecordsPerToken = options.maxRecordsPerToken > 0 ? options.maxRecordsPerToken : MAX_RECORDS_PER_TOKEN;
    this._dirty = new Set(); // tunnel ids with unflushed stats
    this._destroyed = false;

    this._load();

    this._flushTimer = setInterval(() => this.flushStats(), this.statsFlushMs);
    this._flushTimer.unref();
  }

  _load() {
    if (!this.db) return;
    try {
      // Simulated (API-created, device-less) tunnels no longer exist.
      this.db.run("DELETE FROM tunnels WHERE status = 'simulated'");
      const rows = this.db.query('SELECT * FROM tunnels');
      for (const row of rows) {
        const protocol = row.protocol === 'tcp' ? 'tcp' : 'http';
        const tunnel = {
          id: row.id,
          name: row.name,
          subdomain: row.subdomain,
          localPort: row.local_port,
          publicUrl: protocol === 'http' ? httpPublicUrl(row.subdomain) : row.public_url,
          clientWs: null,
          // No WS connection after restart; a manual pause survives restarts.
          status: row.status === 'paused' ? 'paused' : 'inactive',
          createdAt: row.created_at,
          connections: row.connections || 0,
          bytesTransferred: row.bytes_transferred || 0,
          protocol,
          allocatedPort: row.allocated_port || null,
          ownerSecret: row.owner_secret || null,
          preferredPort: row.preferred_port || null,
          clientToken: row.client_token || null,
          clientId: null,
          lastActivity: row.last_activity || null,
          // Rows written before client_token was persisted (neither column set).
          // Their owner is unknown; the first reconnect that proves the
          // ownerSecret claims them, so devices keep their stable ports.
          legacyUnowned: !row.client_token && !row.last_activity,
        };
        this.tunnels.set(tunnel.id, tunnel);
      }
      this.db.run("UPDATE tunnels SET status = 'inactive' WHERE status NOT IN ('inactive', 'paused')");
      log.info(`Loaded ${rows.length} tunnel(s) from database`);
    } catch (err) {
      log.error('Failed to load tunnels from DB', { error: err });
    }
  }

  _dbRun(sql, params, what, tunnelId) {
    if (!this.db) return;
    try {
      this.db.run(sql, params);
    } catch (err) {
      log.warn(`DB error in ${what}`, { error: err, tunnelId });
    }
  }

  _isLive(t) {
    return isWsOpen(t.clientWs);
  }

  /**
   * Is `sub` taken for an http tunnel owned by `owner`? Taken means used by a
   * different owner (any status), or by the same owner's active/paused tunnel.
   * Same-owner inactive records may share it (lookups prefer active tunnels).
   */
  _subdomainTaken(sub, owner, excludeIds) {
    for (const t of this.tunnels.values()) {
      if (t.protocol !== 'http' || excludeIds.has(t.id)) continue;
      if (String(t.subdomain || '').toLowerCase() !== sub) continue;
      if ((t.clientToken || null) !== owner) return true;
      if (t.status !== 'inactive') return true;
    }
    return false;
  }

  _uniqueSubdomain(base, owner, excludeIds) {
    if (!this._subdomainTaken(base, owner, excludeIds)) return base;
    for (let n = 2; n < 10000; n++) {
      const suffix = `-${n}`;
      const candidate = `${base.slice(0, 63 - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!this._subdomainTaken(candidate, owner, excludeIds)) return candidate;
    }
    return `${base.slice(0, 50).replace(/-+$/, '')}-${crypto.randomBytes(4).toString('hex')}`;
  }

  /** Keep at most maxRecordsPerToken records per device token (prunes LRU inactive ones). */
  _pruneRecordsForToken(token, reserve) {
    const records = [...this.tunnels.values()].filter(t => t.clientToken === token);
    let excess = records.length + reserve - this.maxRecordsPerToken;
    if (excess <= 0) return;
    const stale = records
      .filter(t => t.status === 'inactive' && !this._isLive(t))
      .sort((a, b) => (parseTimestamp(a.lastActivity || a.createdAt) || 0) - (parseTimestamp(b.lastActivity || b.createdAt) || 0));
    for (const t of stale) {
      if (excess <= 0) break;
      this.removeTunnel(t.id, { closeWs: false });
      excess--;
    }
  }

  /**
   * Create and register a new tunnel for a connected device.
   * @param {object} config - { name, localPort, subdomain?, protocol, clientToken?, clientId? }
   * @param {WebSocket} ws - the device connection (required)
   * @returns {object} the tunnel record
   */
  createTunnel(config, ws) {
    if (!ws) throw new TypeError('createTunnel requires the device WebSocket');
    const id = crypto.randomUUID();
    const protocol = config.protocol === 'tcp' ? 'tcp' : 'http';
    const owner = config.clientToken || null;
    const localPort = config.localPort;
    const name = String(config.name || 'unnamed').slice(0, 100);
    const now = new Date().toISOString();

    // Stale-record replacement: only the SAME device token, same local port and
    // protocol, and only records without a live device connection. The new
    // record inherits the preferred public port (stable TCP ports) and a
    // manual pause.
    const replaced = [];
    if (owner) {
      for (const t of this.tunnels.values()) {
        if (t.clientToken === owner && t.localPort === localPort && t.protocol === protocol
            && (t.status === 'inactive' || t.status === 'paused') && !this._isLive(t)) {
          replaced.push(t);
        }
      }
    }
    replaced.sort((a, b) => (parseTimestamp(b.lastActivity || b.createdAt) || 0) - (parseTimestamp(a.lastActivity || a.createdAt) || 0));
    const predecessor = replaced[0] || null;
    const replacedIds = new Set(replaced.map(t => t.id));

    let subdomain;
    if (protocol === 'http') {
      subdomain = this._uniqueSubdomain(sanitizeSubdomain(config.subdomain || name), owner, replacedIds);
    } else {
      subdomain = sanitizeSubdomain(config.subdomain || name);
    }

    for (const t of replaced) this.removeTunnel(t.id, { closeWs: false, reason: 'replaced' });
    if (owner) this._pruneRecordsForToken(owner, 1);

    const inheritedPort = predecessor ? (predecessor.preferredPort || predecessor.allocatedPort || null) : null;
    const status = predecessor && predecessor.status === 'paused' ? 'paused' : 'active';

    const tunnel = {
      id,
      name,
      subdomain,
      localPort,
      publicUrl: protocol === 'tcp' ? 'tcp:?' : httpPublicUrl(subdomain),
      clientWs: ws,
      status,
      createdAt: now,
      connections: 0,
      bytesTransferred: 0,
      ownerSecret: crypto.randomBytes(32).toString('hex'),
      protocol,
      allocatedPort: null,
      preferredPort: protocol === 'tcp' ? inheritedPort : null,
      clientToken: owner,
      clientId: config.clientId || ws.clientId || null,
      lastActivity: now,
      legacyUnowned: false,
    };

    this.tunnels.set(id, tunnel);
    this._dbRun(
      `INSERT INTO tunnels (id, name, subdomain, local_port, public_url, status, created_at, connections,
         bytes_transferred, protocol, allocated_port, owner_secret, preferred_port, client_token, last_activity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tunnel.id, tunnel.name, tunnel.subdomain, tunnel.localPort, tunnel.publicUrl, tunnel.status,
        tunnel.createdAt, 0, 0, tunnel.protocol, null, tunnel.ownerSecret, tunnel.preferredPort,
        tunnel.clientToken, tunnel.lastActivity],
      'createTunnel', id
    );

    if (predecessor) {
      log.info('Replaced stale tunnel record', { tunnelId: id, replaced: predecessor.id, preferredPort: tunnel.preferredPort });
    }
    this.emit('tunnel:created', tunnel);
    return tunnel;
  }

  /**
   * Update the allocated TCP port for a tunnel and persist to DB.
   * Also saves it as the preferred_port so future reconnects reuse the same port.
   */
  setAllocatedPort(id, port) {
    const t = this.tunnels.get(id);
    if (!t || !port) return;
    t.allocatedPort = port;
    t.preferredPort = port;
    t.publicUrl = `tcp:${port}`;
    this._dbRun(
      'UPDATE tunnels SET allocated_port = ?, preferred_port = ?, public_url = ? WHERE id = ?',
      [port, port, t.publicUrl, id], 'setAllocatedPort', id
    );
  }

  /**
   * Remove a tunnel by id (and its DB row). Closes the device connection
   * unless options.closeWs === false.
   */
  removeTunnel(id, options = {}) {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) return false;
    const { closeWs = true, code = 1000, reason = 'Tunnel removed' } = options;

    if (closeWs && tunnel.clientWs && tunnel.clientWs.readyState <= WS_OPEN) {
      try {
        tunnel.clientWs.close(code, reason);
      } catch (err) {
        log.warn('Error closing WS during tunnel removal', { error: err, tunnelId: id });
      }
    }

    this.tunnels.delete(id);
    this._dirty.delete(id);
    this._dbRun('DELETE FROM tunnels WHERE id = ?', [id], 'removeTunnel', id);
    this.emit('tunnel:removed', { id });
    return true;
  }

  /**
   * Remove every tunnel owned by a device token (token deleted). Closes their
   * device connections with 4000. Returns the number of tunnels removed.
   */
  removeTunnelsForToken(token) {
    if (typeof token !== 'string' || token.length === 0) return 0;
    const sockets = new Set();
    let count = 0;
    for (const t of [...this.tunnels.values()]) {
      if (t.clientToken !== token) continue;
      if (t.clientWs) sockets.add(t.clientWs);
      if (this.removeTunnel(t.id, { closeWs: false })) count++;
    }
    this._dbRun('DELETE FROM tunnels WHERE client_token = ?', [token], 'removeTunnelsForToken');
    for (const ws of sockets) {
      if (ws.readyState <= WS_OPEN) {
        try { ws.close(4000, 'Token revoked'); } catch {}
      }
    }
    if (count > 0) log.info('Removed tunnels for token', { token: tokenPrefix(token), count });
    return count;
  }

  /**
   * Remove 'inactive' tunnels whose last activity (or creation) is older than
   * maxIdleMs. Active and paused tunnels are never removed. Returns the count.
   */
  cleanupIdleTunnels(maxIdleMs) {
    if (!(maxIdleMs > 0)) return 0;
    const cutoff = Date.now() - maxIdleMs;
    let count = 0;
    for (const t of [...this.tunnels.values()]) {
      if (t.status !== 'inactive' || this._isLive(t)) continue;
      const ts = parseTimestamp(t.lastActivity) ?? parseTimestamp(t.createdAt);
      if (ts === null || ts >= cutoff) continue;
      if (this.removeTunnel(t.id, { closeWs: false })) count++;
    }
    if (count > 0) log.info('Removed idle tunnels', { count });
    return count;
  }

  /** Get a tunnel by id. */
  getTunnel(id) {
    return this.tunnels.get(id) || null;
  }

  /**
   * Find an http tunnel by subdomain (case-insensitive). Prefers active
   * tunnels; TCP tunnels never match.
   */
  getTunnelBySubdomain(subdomain) {
    if (typeof subdomain !== 'string' || subdomain.length === 0) return null;
    const sub = subdomain.toLowerCase();
    let fallback = null;
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.protocol !== 'http') continue;
      if (String(tunnel.subdomain || '').toLowerCase() !== sub) continue;
      if (tunnel.status === 'active') return tunnel;
      if (!fallback) fallback = tunnel;
    }
    return fallback;
  }

  /** Number of tunnels of a device token attached to an open device connection. */
  countLiveTunnelsForToken(token, excludeId = null) {
    if (!token) return 0;
    let n = 0;
    for (const t of this.tunnels.values()) {
      if (t.clientToken === token && t.id !== excludeId && this._isLive(t)) n++;
    }
    return n;
  }

  /** One tunnel in API form (no ws, no ownerSecret), or null. */
  getTunnelInfo(id) {
    const t = this.tunnels.get(id);
    return t ? this._serialize(t) : null;
  }

  /** Return all tunnels (serializable, without ws reference). */
  getAllTunnels() {
    const result = [];
    for (const t of this.tunnels.values()) result.push(this._serialize(t));
    return result;
  }

  /** Return aggregated stats. */
  getStats() {
    let totalConnections = 0;
    let totalBytes = 0;
    let active = 0;
    for (const t of this.tunnels.values()) {
      totalConnections += t.connections;
      totalBytes += t.bytesTransferred;
      if (t.status === 'active') active++;
    }
    return { activeTunnels: active, totalConnections, bytesTransferred: totalBytes };
  }

  /** Increment connection count (in memory; flushed by flushStats). */
  incrementConnections(id) {
    const t = this.tunnels.get(id);
    if (!t) return;
    t.connections++;
    this._dirty.add(id);
  }

  /** Add transferred bytes (in memory; flushed by flushStats). */
  addBytes(id, bytes) {
    const t = this.tunnels.get(id);
    if (!t || !(bytes > 0)) return;
    t.bytesTransferred += bytes;
    this._dirty.add(id);
  }

  /**
   * Write accumulated connection/byte counters (and last_activity) of every
   * tunnel with traffic since the last flush, in ONE transaction.
   * Returns the number of tunnels written.
   */
  flushStats() {
    if (this._dirty.size === 0) return 0;
    const ids = [...this._dirty];
    this._dirty.clear();
    const now = new Date().toISOString();
    const rows = [];
    for (const id of ids) {
      const t = this.tunnels.get(id);
      if (!t) continue;
      t.lastActivity = now;
      rows.push(t);
    }
    if (!this.db || rows.length === 0) return rows.length;
    const write = () => {
      for (const t of rows) {
        this.db.run(
          'UPDATE tunnels SET connections = ?, bytes_transferred = ?, last_activity = ? WHERE id = ?',
          [t.connections, t.bytesTransferred, t.lastActivity, t.id]
        );
      }
    };
    try {
      if (typeof this.db.transaction === 'function') this.db.transaction(write);
      else write();
    } catch (err) {
      log.warn('DB error flushing tunnel stats', { error: err, count: rows.length });
      if (!this._destroyed) for (const t of rows) this._dirty.add(t.id); // retry next time
      return 0;
    }
    return rows.length;
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

    t.lastActivity = new Date().toISOString();
    // Don't overwrite 'paused' — tunnel was manually stopped
    if (t.status !== 'paused') t.status = 'inactive';
    this._dbRun('UPDATE tunnels SET status = ?, last_activity = ? WHERE id = ?',
      [t.status, t.lastActivity, id], 'markDisconnected', id);
    t.clientWs = null;
    this.emit('tunnel:disconnected', { id });
  }

  /**
   * Reconnect: attach a new ws to an existing tunnel. Requires the ownership
   * secret AND the same owning token as the tunnel
   * ((ws.clientToken?.token ?? null) === (tunnel.clientToken ?? null)).
   * @returns {boolean}
   */
  /**
   * Check (without side effects) whether ws may reconnect tunnel id with secret.
   * Returns { ok: false } or { ok: true, claim: bool } (claim = adopt a legacy record).
   */
  verifyReconnect(id, ws, secret) {
    const t = this.tunnels.get(id);
    if (!t || !ws) return { ok: false };

    // Verify ownership — prevent hijacking by other authenticated clients
    if (!t.ownerSecret || typeof secret !== 'string' || secret.length === 0) return { ok: false };
    const expected = crypto.createHash('sha256').update(t.ownerSecret).digest();
    const given = crypto.createHash('sha256').update(secret).digest();
    if (!crypto.timingSafeEqual(expected, given)) return { ok: false, reason: 'secret' };

    const wsOwner = (ws.clientToken && ws.clientToken.token) || null;
    const tunnelOwner = t.clientToken || null;
    if (wsOwner === tunnelOwner) return { ok: true, claim: false };
    // pre-2.0 record without a recorded owner: the proven secret holder becomes the owner
    if (t.legacyUnowned && tunnelOwner === null) return { ok: true, claim: true };
    return { ok: false, reason: 'owner' };
  }

  reconnect(id, ws, secret) {
    const check = this.verifyReconnect(id, ws, secret);
    if (!check.ok) {
      if (check.reason === 'secret') log.warn('Reconnect rejected — invalid ownership secret', { tunnelId: id });
      if (check.reason === 'owner') log.warn('Reconnect rejected — tunnel belongs to a different token', { tunnelId: id });
      return false;
    }
    const t = this.tunnels.get(id);
    const wsOwner = (ws.clientToken && ws.clientToken.token) || null;
    const claimed = check.claim;

    t.legacyUnowned = false;
    t.clientToken = wsOwner;
    t.clientWs = ws;
    t.clientId = ws.clientId || null;
    t.lastActivity = new Date().toISOString();
    if (t.protocol === 'http') t.publicUrl = httpPublicUrl(t.subdomain);
    if (claimed) log.info('Legacy tunnel claimed by its device token', { tunnelId: id, token: tokenPrefix(wsOwner) });

    // If manually paused, keep paused — don't activate
    if (t.status !== 'paused') t.status = 'active';
    this._dbRun(
      'UPDATE tunnels SET status = ?, client_token = ?, last_activity = ?, public_url = ? WHERE id = ?',
      [t.status, t.clientToken, t.lastActivity, t.publicUrl, id], 'reconnect', id
    );
    if (t.status === 'active') this.emit('tunnel:reconnected', { id });
    return true;
  }

  /** Flush stats and stop timers (graceful shutdown). */
  destroy() {
    if (this._destroyed) return;
    clearInterval(this._flushTimer);
    this.flushStats();
    this._destroyed = true;
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
      clientToken: t.clientToken || null,
      clientId: t.clientId || null,
      lastActivity: t.lastActivity || null,
      // ownerSecret intentionally excluded
    };
  }
}

module.exports = TunnelManager;
module.exports.sanitizeSubdomain = sanitizeSubdomain;
module.exports.normalizeDomain = normalizeDomain;
module.exports.httpPublicUrl = httpPublicUrl;
module.exports.parseTimestamp = parseTimestamp;
