'use strict';

/**
 * Data retention and housekeeping (hourly + at startup).
 *
 *  - sessions older than SESSION_RETENTION_DAYS (default 90, 0 = keep forever)
 *    are deleted (they hold visitor IPs = personal data). A session's age is
 *    measured from its end (or its start if it never ended).
 *  - at startup, sessions of tunnel connections still marked open are closed:
 *    tunnel connections cannot survive a restart. Legacy SSH-gateway sessions
 *    (pid set, no tunnel_id) are left alone — sshd keeps those alive.
 *  - expired dashboard sessions (admin_sessions) are deleted.
 *  - 'inactive' tunnels idle for TUNNEL_IDLE_RETENTION_DAYS (default 30,
 *    0 = off) are removed via tunnelManager.cleanupIdleTunnels().
 */
const { createLogger } = require('./logger');
const log = createLogger('maintenance');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function nonNegativeInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * @param {object} opts
 * @param {object} opts.db
 * @param {object} [opts.tunnelManager]
 * @param {number} [opts.sessionRetentionDays=90]
 * @param {number} [opts.tunnelIdleRetentionDays=30]
 * @param {number} [opts.intervalMs=3600000]
 */
function createMaintenance(opts = {}) {
  const db = opts.db;
  const tunnelManager = opts.tunnelManager || null;
  const sessionRetentionDays = nonNegativeInt(opts.sessionRetentionDays, 90);
  const tunnelIdleRetentionDays = nonNegativeInt(opts.tunnelIdleRetentionDays, 30);
  const intervalMs = opts.intervalMs > 0 ? opts.intervalMs : HOUR_MS;
  let timer = null;

  /** Close session rows of tunnel connections left open by a previous process. */
  function closeDanglingSessions() {
    try {
      return db.run(`UPDATE sessions SET disconnected_at = datetime('now')
                     WHERE disconnected_at IS NULL AND (tunnel_id IS NOT NULL OR pid IS NULL)`).changes;
    } catch (err) {
      log.warn('Could not close dangling sessions', { error: err.message });
      return 0;
    }
  }

  function purgeOldSessions() {
    if (sessionRetentionDays <= 0) return 0;
    const cutoff = `-${sessionRetentionDays} days`;
    try {
      // connected_at <= disconnected_at, so the first condition narrows via the index.
      return db.run(`DELETE FROM sessions
                     WHERE connected_at < datetime('now', ?)
                       AND COALESCE(disconnected_at, connected_at) < datetime('now', ?)`,
      [cutoff, cutoff]).changes;
    } catch (err) {
      log.warn('Session retention cleanup failed', { error: err.message });
      return 0;
    }
  }

  function purgeExpiredAdminSessions() {
    try {
      return db.run("DELETE FROM admin_sessions WHERE expires_at <= datetime('now')").changes;
    } catch (err) {
      log.warn('Admin session cleanup failed', { error: err.message });
      return 0;
    }
  }

  function purgeIdleTunnels() {
    if (tunnelIdleRetentionDays <= 0 || !tunnelManager || typeof tunnelManager.cleanupIdleTunnels !== 'function') return 0;
    try {
      return tunnelManager.cleanupIdleTunnels(tunnelIdleRetentionDays * DAY_MS) || 0;
    } catch (err) {
      log.warn('Idle tunnel cleanup failed', { error: err.message });
      return 0;
    }
  }

  /** One retention pass. Returns counters. */
  function runOnce() {
    const result = {
      sessionsDeleted: purgeOldSessions(),
      adminSessionsDeleted: purgeExpiredAdminSessions(),
      tunnelsRemoved: purgeIdleTunnels(),
    };
    if (result.sessionsDeleted || result.adminSessionsDeleted || result.tunnelsRemoved) {
      log.info('Retention cleanup', result);
    }
    return result;
  }

  /** Startup pass: close dangling sessions, then the regular retention pass. */
  function runStartup() {
    const sessionsClosed = closeDanglingSessions();
    if (sessionsClosed) log.info('Closed sessions left open by the previous run', { count: sessionsClosed });
    return { sessionsClosed, ...runOnce() };
  }

  function start() {
    if (timer) return;
    timer = setInterval(runOnce, intervalMs);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, runStartup, start, stop, sessionRetentionDays, tunnelIdleRetentionDays };
}

module.exports = { createMaintenance, nonNegativeInt };
