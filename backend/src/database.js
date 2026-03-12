const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tunnelvault.db');

// Ensure the directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Create tables ────────────────────────────────────────
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
      token TEXT NOT NULL,
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
`);

// Migrations for existing installations
try { db.exec(`ALTER TABLE tunnels ADD COLUMN protocol TEXT NOT NULL DEFAULT 'http'`); } catch {}
try { db.exec(`ALTER TABLE tunnels ADD COLUMN allocated_port INTEGER`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN target_ip TEXT`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN target_port INTEGER`); } catch {}

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
 * Get the raw database instance.
 */
function getDb() {
  return db;
}

/**
 * Close the database connection gracefully.
 */
function close() {
  db.close();
}

module.exports = { query, queryOne, run, getDb, close };
