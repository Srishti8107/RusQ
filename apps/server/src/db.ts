/**
 * SQLite persistence via Node's built-in `node:sqlite` (no native addon to
 * compile – simpler on Windows and on any host with Node ≥ 22.13).
 *
 * Every client-created record is keyed by its client UUID, and inserts use
 * `INSERT OR IGNORE`, which is what makes uploads idempotent.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('victim','rescuer','admin')),
  name TEXT NOT NULL,
  team_id TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  profile TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sos (
  id TEXT PRIMARY KEY,
  server_id TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  data TEXT NOT NULL,
  via TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  server_id TEXT UNIQUE NOT NULL,
  team_id TEXT NOT NULL,
  data TEXT NOT NULL,
  via TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  server_id TEXT UNIQUE NOT NULL,
  report_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photo_chunks (
  photo_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  total INTEGER NOT NULL,
  info TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (photo_id, idx)
);

CREATE TABLE IF NOT EXISTS snapshots (
  version INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);

-- Live (authoritative) stock; snapshots are published copies of it.
CREATE TABLE IF NOT EXISTS stock (resource TEXT PRIMARY KEY, qty INTEGER NOT NULL CHECK (qty >= 0));

CREATE TABLE IF NOT EXISTS allotments (
  id TEXT PRIMARY KEY,
  server_id TEXT UNIQUE NOT NULL,
  device_id TEXT NOT NULL,
  report_id TEXT,
  snapshot_version INTEGER NOT NULL,
  data TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_claim TEXT,
  decided_by TEXT,
  decided_at TEXT,
  note TEXT,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  resource TEXT NOT NULL,
  live_stock INTEGER NOT NULL,
  claimed INTEGER NOT NULL,
  allotment_ids TEXT NOT NULL,
  devices TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_by TEXT,
  resolution TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  at TEXT NOT NULL,
  details TEXT
);

CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/** Human-friendly, monotonically increasing server ids: SOS-000123, RPT-000045 … */
export function nextServerId(db: Db, prefix: string): string {
  db.prepare('INSERT INTO counters (name, n) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1').run(prefix);
  const row = db.prepare('SELECT n FROM counters WHERE name = ?').get(prefix) as { n: number };
  return `${prefix}-${String(row.n).padStart(6, '0')}`;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function kvGet(db: Db, k: string): string | undefined {
  return (db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined)?.v;
}

export function kvSet(db: Db, k: string, v: string) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}
