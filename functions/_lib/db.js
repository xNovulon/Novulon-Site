// Database: Cloudflare D1, bound to the Pages project as DB. Nothing in it is reachable except through the API.
// The tables are created on the first request of each worker, so a fresh database needs no manual setup.

const SCHEMA_VERSION = '2';

// email: the confirmed address (or NULL). email_pending: an address waiting for its confirmation link.
const USERS_TABLE = `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT NOT NULL,
     username_key TEXT NOT NULL UNIQUE,
     email TEXT UNIQUE,
     email_pending TEXT,
     pass_hash TEXT NOT NULL,
     pass_salt TEXT NOT NULL,
     pass_iter INTEGER NOT NULL,
     role TEXT NOT NULL DEFAULT 'member',
     banned INTEGER NOT NULL DEFAULT 0,
     post_count INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL)`;

// version 1 required a confirmed email for every account
const MIGRATE_1_TO_2 = [
  `ALTER TABLE users RENAME TO users_v1`,
  USERS_TABLE,
  `INSERT INTO users (id, username, username_key, email, pass_hash, pass_salt, pass_iter, role, banned, post_count, created_at)
     SELECT id, username, username_key, CASE WHEN verified_at IS NOT NULL THEN email END, pass_hash, pass_salt, pass_iter,
            role, banned, post_count, created_at FROM users_v1`,
  `DROP TABLE users_v1`,
  `ALTER TABLE tokens ADD COLUMN data TEXT`,
  `DELETE FROM tokens`,
];

const SCHEMA = [
  USERS_TABLE,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS tokens (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL,
     kind TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at INTEGER,
     data TEXT)`,
  `CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id, kind)`,
  `CREATE TABLE IF NOT EXISTS threads (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     game TEXT NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     user_id INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     edited_at INTEGER,
     last_post_at INTEGER NOT NULL,
     last_user_id INTEGER,
     reply_count INTEGER NOT NULL DEFAULT 0,
     view_count INTEGER NOT NULL DEFAULT 0,
     pinned INTEGER NOT NULL DEFAULT 0,
     locked INTEGER NOT NULL DEFAULT 0,
     deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS threads_activity ON threads(deleted, pinned, last_post_at)`,
  `CREATE INDEX IF NOT EXISTS threads_game ON threads(deleted, game, pinned, last_post_at)`,
  `CREATE INDEX IF NOT EXISTS threads_user ON threads(user_id)`,
  `CREATE TABLE IF NOT EXISTS replies (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     thread_id INTEGER NOT NULL,
     user_id INTEGER NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     edited_at INTEGER,
     deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS replies_thread ON replies(thread_id, deleted, id)`,
  `CREATE INDEX IF NOT EXISTS replies_user ON replies(user_id)`,
  `CREATE TABLE IF NOT EXISTS rate (
     key TEXT PRIMARY KEY,
     exp INTEGER NOT NULL,
     n INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
];

let ready = null;   // one schema check per worker instance

export function ensureSchema(db) {
  if (!ready) {
    ready = (async () => {
      try {
        const row = await db.prepare(`SELECT v FROM meta WHERE k = 'schema'`).first();
        if (row && row.v === SCHEMA_VERSION) return;
        if (row && row.v === '1') {
          await db.batch(MIGRATE_1_TO_2.map((sql) => db.prepare(sql)));
          await db.prepare(`UPDATE meta SET v = ?1 WHERE k = 'schema'`).bind(SCHEMA_VERSION).run();
          return;
        }
      } catch (e) { /* no meta table yet */ }
      await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
      await db.prepare(`INSERT INTO meta (k, v) VALUES ('schema', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1`).bind(SCHEMA_VERSION).run();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// Fixed-window counter. Returns true while the key is under `max` hits per `windowSec`.
export async function allow(db, key, max, windowSec) {
  const now = Date.now();
  const row = await db.prepare(
    `INSERT INTO rate (key, exp, n) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       n = CASE WHEN rate.exp < ?3 THEN 1 ELSE rate.n + 1 END,
       exp = CASE WHEN rate.exp < ?3 THEN ?2 ELSE rate.exp END
     RETURNING n`).bind(key, now + windowSec * 1000, now).first();
  if (Math.random() < 0.02) {
    await db.prepare(`DELETE FROM rate WHERE exp < ?1`).bind(now).run();
    await db.prepare(`DELETE FROM sessions WHERE expires_at < ?1`).bind(now).run();
    await db.prepare(`DELETE FROM tokens WHERE expires_at < ?1`).bind(now - 7 * 864e5).run();
  }
  return !row || row.n <= max;
}
