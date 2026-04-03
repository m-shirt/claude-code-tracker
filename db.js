const Database = require('better-sqlite3');
const path = require('path');
const zlib = require('zlib');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'tracker.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'user',
    name         TEXT,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS user_data (
    user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stats_cache      BLOB,
    history          BLOB,
    sessions         BLOB,
    raw_size_bytes   INTEGER DEFAULT 0,
    synced_at        INTEGER NOT NULL,
    sync_count       INTEGER NOT NULL DEFAULT 0,
    client_version   TEXT
  );
`);

// Migration: add name column to existing databases
try { db.exec('ALTER TABLE users ADD COLUMN name TEXT'); } catch {}

function compress(obj) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
}

function decompress(buf) {
  if (!buf) return null;
  try {
    return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { db, compress, decompress };
