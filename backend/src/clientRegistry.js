'use strict';

const { createLogger } = require('./logger');
const { CLOSE_CODES } = require('./protocol');
const log = createLogger('registry');

const TERMINATE_AFTER_MS = 2000;
const ADMIN_KEY = Symbol('admin-token');

function tokenKey(token) {
  return typeof token === 'string' && token.length > 0 ? token : ADMIN_KEY;
}

function tokenPrefix(token) {
  return typeof token === 'string' && token.length > 0 ? `${token.slice(0, 4)}***` : 'admin';
}

/**
 * Tracks live device WebSocket connections by owning token so they can be
 * closed when a token is revoked, and so per-token connection caps can be
 * enforced.
 *
 * ws objects carry `ws.clientToken` (token DB row, or null for the admin
 * token) and `ws.clientId`.
 */
class ClientRegistry {
  constructor(opts = {}) {
    this._byToken = new Map(); // tokenKey -> Set<ws> (insertion order = connection order)
    this._all = new Set();
    this.terminateAfterMs = opts.terminateAfterMs ?? TERMINATE_AFTER_MS;
  }

  static tokenOf(ws) {
    const t = ws && ws.clientToken && ws.clientToken.token;
    return typeof t === 'string' && t.length > 0 ? t : null;
  }

  add(ws) {
    if (!ws || this._all.has(ws)) return;
    const key = tokenKey(ClientRegistry.tokenOf(ws));
    let set = this._byToken.get(key);
    if (!set) {
      set = new Set();
      this._byToken.set(key, set);
    }
    set.add(ws);
    this._all.add(ws);
  }

  remove(ws) {
    if (!ws || !this._all.has(ws)) return;
    this._all.delete(ws);
    const key = tokenKey(ClientRegistry.tokenOf(ws));
    const set = this._byToken.get(key);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this._byToken.delete(key);
    }
  }

  /** Connections for a device token (oldest first). null/'' -> admin-token connections. */
  connectionsForToken(token) {
    const set = this._byToken.get(tokenKey(token));
    return set ? [...set] : [];
  }

  /**
   * Close every connection of `token` (close frame first, terminate() after
   * 2 s if the peer does not complete the closing handshake). The sockets are
   * removed from the registry immediately. Returns the number of connections.
   */
  disconnectToken(token, { code = CLOSE_CODES.TOKEN_REVOKED, reason = 'Token revoked' } = {}) {
    if (typeof token !== 'string' || token.length === 0) return 0;
    const conns = this.connectionsForToken(token);
    for (const ws of conns) {
      this.remove(ws);
      this.closeConnection(ws, code, reason);
    }
    if (conns.length > 0) {
      log.info('Disconnected token connections', { token: tokenPrefix(token), count: conns.length, code });
    }
    return conns.length;
  }

  /** Close one connection with a close code; force-terminate after a grace period. */
  closeConnection(ws, code, reason) {
    if (!ws || ws._tvClosing) return;
    ws._tvClosing = true;
    ws._tvCloseCode = code;
    try {
      if (ws.readyState === 0 || ws.readyState === 1) ws.close(code, reason);
    } catch (err) {
      log.warn('Error closing WebSocket', { error: err.message });
    }
    if (ws.readyState === 3) return;
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
    }, this.terminateAfterMs);
    if (typeof timer.unref === 'function') timer.unref();
    if (typeof ws.once === 'function') ws.once('close', () => clearTimeout(timer));
  }

  /** Close every tracked connection (shutdown). */
  closeAll(code = 1001, reason = 'Server shutting down') {
    for (const ws of [...this._all]) {
      this.remove(ws);
      this.closeConnection(ws, code, reason);
    }
  }

  get size() {
    return this._all.size;
  }
}

// Usable as `require('./clientRegistry')` or `const { ClientRegistry } = require(...)`.
module.exports = ClientRegistry;
module.exports.ClientRegistry = ClientRegistry;
module.exports.tokenPrefix = tokenPrefix;
