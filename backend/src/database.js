const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tunnelvault.db');

// Ensure the directory exists (owner-only: the DB holds tokens and secrets)
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
}

const db = new Database(DB_PATH);

// The database contains device tokens, tunnel ownership secrets and encrypted
// SSH keys — keep it readable by the service user only (best-effort).
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.chmodSync(DB_PATH + suffix, 0o600); } catch {}
}

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Wait instead of failing when the gateway helper (sqlite3 CLI) holds a lock
db.pragma('busy_timeout = 5000');

// ─── Schema ───────────────────────────────────────────────
// The backend owns the schema. Installers must not create tables themselves;
// they start the service (or require this module) and let the migrations run.
db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      target_ip TEXT NOT NULL DEFAULT '',
      target_port INTEGER NOT NULL DEFAULT 22,
      public_key TEXT NOT NULL DEFAULT '',
      linux_user TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT,
      active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT,
      connected_at TEXT NOT NULL DEFAULT (datetime('now')),
      disconnected_at TEXT,
      client_ip TEXT,
      pid INTEGER
  );

  CREATE TABLE IF NOT EXISTS tunnels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subdomain TEXT NOT NULL,
      local_port INTEGER NOT NULL DEFAULT 3000,
      public_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'inactive',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      connections INTEGER NOT NULL DEFAULT 0,
      bytes_transferred INTEGER NOT NULL DEFAULT 0,
      protocol TEXT NOT NULL DEFAULT 'http',
      allocated_port INTEGER
  );

  -- Pinned SSH host keys for the web terminal (trust on first use).
  -- pin_key is "token:<token>:<localPort>" for token-owned tunnels, else "tunnel:<id>".
  CREATE TABLE IF NOT EXISTS ssh_host_keys (
      pin_key TEXT PRIMARY KEY,
      key_type TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Dashboard login sessions. Only hashes are stored: a keyed SHA-256 of the
  -- session id (cookie) and a SHA-256 of the session key (X-TV-Session-Key).
  CREATE TABLE IF NOT EXISTS admin_sessions (
      id_hash TEXT PRIMARY KEY,
      key_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      last_seen TEXT,
      ip TEXT,
      user_agent TEXT
  );
`);

// ─── Additive migrations (idempotent) ─────────────────────
function columnInfo(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

/** Returns true when the column was added. */
function addColumnIfMissing(table, column, definition) {
  if (!columnInfo(table).some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }
  return false;
}

addColumnIfMissing('tunnels', 'protocol', "TEXT NOT NULL DEFAULT 'http'");
addColumnIfMissing('tunnels', 'allocated_port', 'INTEGER');
addColumnIfMissing('tunnels', 'owner_secret', 'TEXT');
addColumnIfMissing('tunnels', 'preferred_port', 'INTEGER');
addColumnIfMissing('tunnels', 'client_token', 'TEXT');   // owning device token (NULL = admin token)
addColumnIfMissing('tunnels', 'last_activity', 'TEXT');  // last connect / traffic, for idle cleanup
addColumnIfMissing('sessions', 'target_ip', 'TEXT');
addColumnIfMissing('sessions', 'target_port', 'INTEGER');
addColumnIfMissing('sessions', 'country', 'TEXT');
addColumnIfMissing('sessions', 'country_code', 'TEXT');
addColumnIfMissing('sessions', 'city', 'TEXT');
addColumnIfMissing('sessions', 'tunnel_id', 'TEXT');
// Encrypted at rest (see secretBox.js); '' = no stored key
addColumnIfMissing('tokens', 'private_key', "TEXT NOT NULL DEFAULT ''");
// Dashboard sessions are bound to a session key (auth.js). Sessions from before
// have none and can never validate again: drop them (one-time re-login).
if (addColumnIfMissing('admin_sessions', 'key_hash', 'TEXT')) {
  db.exec('DELETE FROM admin_sessions');
}

// ─── Versioned migrations (table rebuilds) ────────────────
const SCHEMA_VERSION = 2;

function migrateToV2() {
  // Older databases declared sessions.token NOT NULL, which silently dropped
  // session rows for tunnels opened with the admin token. Rebuild as nullable.
  const tokenCol = columnInfo('sessions').find(c => c.name === 'token');
  if (tokenCol && tokenCol.notnull) {
    const cols = columnInfo('sessions').map(c => c.name);
    const target = ['id', 'token', 'connected_at', 'disconnected_at', 'client_ip', 'pid',
      'target_ip', 'target_port', 'country', 'country_code', 'city', 'tunnel_id'];
    const copy = target.filter(c => cols.includes(c)).join(', ');
    db.exec(`
      CREATE TABLE sessions_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token TEXT,
          connected_at TEXT NOT NULL DEFAULT (datetime('now')),
          disconnected_at TEXT,
          client_ip TEXT,
          pid INTEGER,
          target_ip TEXT,
          target_port INTEGER,
          country TEXT,
          country_code TEXT,
          city TEXT,
          tunnel_id TEXT
      );
      INSERT INTO sessions_v2 (${copy}) SELECT ${copy} FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v2 RENAME TO sessions;
    `);
  }
}

const currentVersion = db.pragma('user_version', { simple: true });
if (currentVersion < SCHEMA_VERSION) {
  db.transaction(() => {
    if (currentVersion < 2) migrateToV2();
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

// Indexes for dashboard counts, retention cleanup and per-token lookups
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_connected_at ON sessions(connected_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
  CREATE INDEX IF NOT EXISTS idx_sessions_open ON sessions(disconnected_at) WHERE disconnected_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_tunnels_client_token ON tunnels(client_token);
  CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
`);

// ─── Helper functions ─────────────────────────────────────

/**
 * Run a SELECT query, return all rows.
 */
function query(sql, params = []) {
  return db.prepare(sql).all(...(Array.isArray(params) ? params : [params]));
}

/**
 * Run a SELECT query, return first row or undefined.
 */
function queryOne(sql, params = []) {
  return db.prepare(sql).get(...(Array.isArray(params) ? params : [params]));
}

/**
 * Run an INSERT/UPDATE/DELETE, return { changes, lastInsertRowid }.
 */
function run(sql, params = []) {
  return db.prepare(sql).run(...(Array.isArray(params) ? params : [params]));
}

/**
 * Run fn inside a single transaction (one fsync for many writes).
 * Returns fn's return value.
 */
function transaction(fn) {
  return db.transaction(fn)();
}

/**
 * Get the raw database instance.
 */
function getDb() {
  return db;
}

/**
 * Close the database connection gracefully.
 */
function close() {
  if (db.open) db.close();
}

module.exports = { query, queryOne, run, transaction, getDb, close, DB_PATH };
