const path = require('path');
const fs = require('fs');

// ─── Log Levels ─────────────────────────────────────────
const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

const LEVEL_COLORS = {
  debug: '\x1b[90m',   // gray
  info: '\x1b[36m',    // cyan
  warn: '\x1b[33m',    // yellow
  error: '\x1b[31m',   // red
  fatal: '\x1b[35m',   // magenta
};
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

// ─── Configuration ──────────────────────────────────────
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_FORMAT = process.env.LOG_FORMAT || 'pretty'; // 'pretty' or 'json'
const LOG_FILE = process.env.LOG_FILE || null;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Use JSON format in production by default
const useJson = LOG_FORMAT === 'json' || (NODE_ENV === 'production' && LOG_FORMAT !== 'pretty');
const minLevel = LEVELS[LOG_LEVEL] ?? LEVELS.info;

// ─── File transport ─────────────────────────────────────
let logStream = null;
if (LOG_FILE) {
  const logDir = path.dirname(LOG_FILE);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
}

// ─── Request ID tracking ────────────────────────────────
let _requestCounter = 0;
function nextRequestId() {
  _requestCounter = (_requestCounter + 1) % 1_000_000;
  return `req-${Date.now().toString(36)}-${_requestCounter.toString(36)}`;
}

// ─── Core logging function ──────────────────────────────
function log(level, scope, message, meta = {}) {
  if (LEVELS[level] < minLevel) return;

  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    level,
    scope,
    message,
    ...meta,
  };

  // Add stack trace for errors
  if (meta.error instanceof Error) {
    entry.error = {
      name: meta.error.name,
      message: meta.error.message,
      stack: meta.error.stack,
    };
  }

  if (useJson) {
    const line = JSON.stringify(entry);
    process.stdout.write(line + '\n');
    if (logStream) logStream.write(line + '\n');
  } else {
    const color = LEVEL_COLORS[level] || '';
    const levelTag = level.toUpperCase().padEnd(5);
    const scopeTag = scope ? `${DIM}[${scope}]${RESET} ` : '';
    const metaStr = Object.keys(meta).length > 0 ? ` ${DIM}${formatMeta(meta)}${RESET}` : '';
    const line = `${DIM}${timestamp}${RESET} ${color}${BOLD}${levelTag}${RESET} ${scopeTag}${message}${metaStr}`;
    process.stdout.write(line + '\n');
    if (logStream) {
      // Plain text for file (no ANSI codes)
      logStream.write(`${timestamp} ${levelTag} [${scope}] ${message} ${formatMeta(meta)}\n`);
    }
  }
}

function formatMeta(meta) {
  const parts = [];
  for (const [key, val] of Object.entries(meta)) {
    if (key === 'error' && val instanceof Error) {
      parts.push(`err="${val.message}"`);
    } else if (val !== undefined && val !== null) {
      parts.push(`${key}=${typeof val === 'object' ? JSON.stringify(val) : val}`);
    }
  }
  return parts.join(' ');
}

// ─── Scoped logger factory ──────────────────────────────
function createLogger(scope) {
  return {
    debug: (msg, meta) => log('debug', scope, msg, meta),
    info: (msg, meta) => log('info', scope, msg, meta),
    warn: (msg, meta) => log('warn', scope, msg, meta),
    error: (msg, meta) => log('error', scope, msg, meta),
    fatal: (msg, meta) => log('fatal', scope, msg, meta),

    // Create a child logger with additional scope
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

// ─── Express request logging middleware ──────────────────
function requestLogger() {
  const logger = createLogger('http');

  return (req, res, next) => {
    const reqId = nextRequestId();
    const start = process.hrtime.bigint();

    // Attach request ID to req for downstream use
    req.reqId = reqId;

    // Capture response finish
    const originalEnd = res.end;
    res.end = function (...args) {
      res.end = originalEnd;
      res.end(...args);

      const durationNs = Number(process.hrtime.bigint() - start);
      const durationMs = (durationNs / 1_000_000).toFixed(1);
      const status = res.statusCode;

      // Redact auth tokens from logged URLs
      const rawPath = req.originalUrl || req.url;
      const safePath = rawPath.replace(/auth_token=[^&]+/g, 'auth_token=***');

      const meta = {
        reqId,
        method: req.method,
        path: safePath,
        status,
        duration: `${durationMs}ms`,
        ip: req.ip || req.socket?.remoteAddress,
      };

      if (status >= 500) {
        logger.error(`${req.method} ${req.originalUrl} ${status}`, meta);
      } else if (status >= 400) {
        logger.warn(`${req.method} ${req.originalUrl} ${status}`, meta);
      } else {
        logger.info(`${req.method} ${req.originalUrl} ${status}`, meta);
      }
    };

    next();
  };
}

// ─── Express error handling middleware ───────────────────
function errorHandler() {
  const logger = createLogger('http');

  return (err, req, res, _next) => {
    const reqId = req.reqId || 'unknown';
    const status = err.status || err.statusCode || 500;

    logger.error('Unhandled route error', {
      reqId,
      method: req.method,
      path: req.originalUrl || req.url,
      status,
      error: err,
    });

    if (!res.headersSent) {
      res.status(status).json({
        error: status >= 500 ? 'Internal server error' : err.message,
        reqId,
      });
    }
  };
}

// ─── Global uncaught error handlers ─────────────────────
function setupGlobalHandlers() {
  const logger = createLogger('process');

  process.on('uncaughtException', (err) => {
    logger.fatal('Uncaught exception', { error: err });
    // Give time for log to flush, then exit
    if (logStream) {
      logStream.end(() => process.exit(1));
    } else {
      process.exit(1);
    }
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('Unhandled promise rejection', { error: err });
  });
}

module.exports = {
  createLogger,
  requestLogger,
  errorHandler,
  setupGlobalHandlers,
  nextRequestId,
};
