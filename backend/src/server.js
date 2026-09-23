/**
 * TunnelVault server entrypoint: loads .env, starts the stack (see app.js) and
 * handles signals. Configuration problems exit with code 78 (EX_CONFIG) and a
 * single actionable log line instead of a stack trace, so systemd units can use
 * RestartPreventExitStatus=78 to avoid a crash loop.
 */
require('dotenv').config({ quiet: true });

const { createLogger, setupGlobalHandlers } = require('./logger');
const log = createLogger('server');

// Set up global error handlers early
setupGlobalHandlers();

const EXIT_CONFIG = 78;
const FORCE_EXIT_MS = 10_000;

function fatal(err) {
  if (err && err.code === 'CONFIG') {
    log.fatal(err.message);
    process.exit(EXIT_CONFIG);
  }
  log.fatal('Startup failed', { error: err });
  process.exit(1);
}

let vault;
try {
  const { createTunnelVault } = require('./app');
  vault = createTunnelVault();
} catch (err) {
  fatal(err);
}

vault.start().catch(fatal);

// ─── Graceful shutdown ──────────────────────────────────
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Shutting down (${signal})...`);
  // Force exit if graceful shutdown hangs
  setTimeout(() => process.exit(1), FORCE_EXIT_MS).unref();
  vault.stop()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error('Error during shutdown', { error: err });
      process.exit(1);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
