const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
const db = new sqlite3.Database('./data/content.db');

db.serialize(() => {
  db.run('PRAGMA journal_mode=WAL;');

  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL,
      total_chunks INTEGER NOT NULL,
      chunks_complete INTEGER DEFAULT 0,
      upload_status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_hash TEXT NOT NULL,
      replica_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      FOREIGN KEY (file_id) REFERENCES files(id),
      UNIQUE(file_id, chunk_index)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chunk_replicas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id TEXT NOT NULL,
      peer_id INTEGER NOT NULL,
      stored_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (chunk_id) REFERENCES chunks(id),
      UNIQUE(chunk_id, peer_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS peers (
      id INTEGER PRIMARY KEY,
      user_id INTEGER UNIQUE NOT NULL,
      peer_secret TEXT,
      online BOOLEAN DEFAULT 0,
      last_seen INTEGER,
      total_uptime_minutes INTEGER DEFAULT 0,
      chunks_stored INTEGER DEFAULT 0,
      websocket_id TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cached_chunks (
      chunk_id TEXT PRIMARY KEY,
      chunk_data BLOB NOT NULL,
      cached_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (chunk_id) REFERENCES chunks(id)
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_chunk_status ON chunks(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_peer_online ON peers(online)');

  console.log('Content database initialized.');
});

db.close();
