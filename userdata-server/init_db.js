const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./userdata.db');

db.serialize(() => {
  // Enable WAL mode
  db.run('PRAGMA journal_mode=WAL;');

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      encryption_key_encrypted TEXT NOT NULL,
      storage_limit_gb INTEGER DEFAULT 10,
      storage_used_gb REAL DEFAULT 0,
      total_online_minutes INTEGER DEFAULT 0,
      last_ping_time INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ping_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      ping_time INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_ping_user ON ping_logs(user_id, ping_time)
  `);

  console.log('Userdata database initialized.');
});

db.close();
