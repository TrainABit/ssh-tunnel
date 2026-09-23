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

// ─── Redaction ──────────────────────────────────────────
// Secrets must never reach the logs: tokens, passwords, keys, cookies, session ids.
const SENSITIVE_KEY_RE = /authorization|password|passphrase|private_?key|secret|cookie|session_?id/i;
// Keys that carry device tokens: logged as a 4-char prefix + '***'.
const TOKEN_KEY_RE = /^(token|auth_?token|client_?token|device_?token|linux_?user)$/i;
const MAX_REDACT_DEPTH = 6;

/** 'abcdef123' -> 'abcd***' (already-redacted values are kept). */
const TOKEN_PLACEHOLDERS = new Set(['admin', 'none', 'unknown']);
function tokenHint(value) {
  const s = String(value);
  if (s.endsWith('***') || TOKEN_PLACEHOLDERS.has(s)) return s;
  const m = /^(gw-|ws-)?(.*)$/s.exec(s);
  return `${m[1] || ''}${m[2].slice(0, 4)}***`;
}

/**
 * Redact secrets inside free text (log messages, URLs, error messages):
 *   ?auth_token=…, &token=…, ticket=…, access_token=…  -> =***
 *   Authorization/Bearer credentials                    -> Bearer ***
 *   /api/tokens/<token>                                 -> /api/tokens/abcd***
 *   gw-<token> / ws-<token> Linux user names            -> gw-abcd***
 */
function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    .replace(/([?&;](?:auth_token|token|ticket|access_token|session|password|secret)=)[^&#\s"']*/gi, '$1***')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
    .replace(/(\/api\/tokens\/)([A-Za-z0-9]{1,4})[A-Za-z0-9]*(?:\*\*\*)?/g, '$1$2***') // idempotent
    .replace(/\b(gw|ws)-([A-Za-z0-9]{4})[A-Za-z0-9]{4,}\b/g, '$1-$2***');
}

/** Redact a request URL/path (query secrets and token path segments). */
function redactPath(url) {
  return redactText(String(url || ''));
}

/** Deep-copy meta with sensitive keys removed and free text redacted. */
function redactMeta(meta, depth = 0, seen = new WeakSet()) {
  if (meta === null || meta === undefined) return meta;
  if (typeof meta === 'string') return redactText(meta);
  if (typeof meta !== 'object') return meta;
  if (meta instanceof Error) {
    return { name: meta.name, message: redactText(meta.message), stack: redactText(meta.stack), ...(meta.code ? { code: meta.code } : {}) };
  }
  if (Buffer.isBuffer(meta)) return `<${meta.length} bytes>`;
  if (seen.has(meta)) return '[Circular]';
  if (depth >= MAX_REDACT_DEPTH) return '[Object]';
  seen.add(meta);
  if (Array.isArray(meta)) return meta.map((v) => redactMeta(v, depth + 1, seen));
  const out = {};
  for (const [key, val] of Object.entries(meta)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      // Numbers/booleans (row ids, flags like hasPassword) carry no secret.
      out[key] = val === undefined || val === null || val === '' || typeof val === 'number' || typeof val === 'boolean'
        ? val : '[REDACTED]';
    } else if (TOKEN_KEY_RE.test(key) && typeof val === 'string' && val.length > 0) {
      out[key] = tokenHint(val);
    } else {
      out[key] = redactMeta(val, depth + 1, seen);
    }
  }
  return out;
}

// ─── Core logging function ──────────────────────────────
function log(level, scope, message, meta = {}) {
  if (LEVELS[level] < minLevel) return;

  const timestamp = new Date().toISOString();
  const safeMessage = redactText(typeof message === 'string' ? message : String(message));
  const safeMeta = meta && typeof meta === 'object' ? redactMeta(meta) : {};
  const entry = {
    timestamp,
    level,
    scope,
    message: safeMessage,
    ...safeMeta,
  };

  if (useJson) {
    let line;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ timestamp, level, scope, message: safeMessage });
    }
    process.stdout.write(line + '\n');
    if (logStream) logStream.write(line + '\n');
  } else {
    const color = LEVEL_COLORS[level] || '';
    const levelTag = level.toUpperCase().padEnd(5);
    const scopeTag = scope ? `${DIM}[${scope}]${RESET} ` : '';
    const metaText = formatMeta(safeMeta);
    const metaStr = metaText ? ` ${DIM}${metaText}${RESET}` : '';
    const line = `${DIM}${timestamp}${RESET} ${color}${BOLD}${levelTag}${RESET} ${scopeTag}${safeMessage}${metaStr}`;
    process.stdout.write(line + '\n');
    if (logStream) {
      // Plain text for file (no ANSI codes)
      logStream.write(`${timestamp} ${levelTag} [${scope}] ${safeMessage} ${metaText}\n`);
    }
  }
}

function formatMeta(meta) {
  const parts = [];
  for (const [key, val] of Object.entries(meta || {})) {
    if (key === 'error' && val && typeof val === 'object' && typeof val.message === 'string') {
      parts.push(`err="${val.message}"`);
    } else if (val !== undefined && val !== null) {
      let text;
      try { text = typeof val === 'object' ? JSON.stringify(val) : String(val); } catch { text = '[Unserializable]'; }
      parts.push(`${key}=${text}`);
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

      // Redact secrets (query tokens, /api/tokens/<token>) from the logged path
      const safePath = redactPath(req.originalUrl || req.url);

      const meta = {
        reqId,
        method: req.method,
        path: safePath,
        status,
        duration: `${durationMs}ms`,
        ip: req.ip || req.socket?.remoteAddress,
      };

      const line = `${req.method} ${safePath} ${status}`;
      if (status >= 500) {
        logger.error(line, meta);
      } else if (status >= 400) {
        logger.warn(line, meta);
      } else {
        logger.info(line, meta);
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
    let status = Number(err && (err.status || err.statusCode)) || 500;
    if (status < 400 || status > 599) status = 500;

    const meta = {
      reqId,
      method: req.method,
      path: redactPath(req.originalUrl || req.url),
      status,
    };
    if (status >= 500) {
      logger.error('Unhandled route error', { ...meta, error: err });
    } else {
      // Client errors (malformed JSON, payload too large, ...): no stack trace
      logger.warn('Request rejected', { ...meta, error: err && err.message });
    }

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
  redactText,
  redactPath,
  redactMeta,
  requestLogger,
  errorHandler,
  setupGlobalHandlers,
  nextRequestId,
};
