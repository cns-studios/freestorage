const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.CONTENT_DB_HOST || 'localhost',
  port: parseInt(process.env.CONTENT_DB_PORT) || 5432,
  database: process.env.CONTENT_DB_NAME || 'freestorage_content',
  user: process.env.CONTENT_DB_USER || 'postgres',
  password: process.env.CONTENT_DB_PASSWORD || 'postgres'
});

async function initDatabase() {
  const client = await pool.connect();

  try {
    await client.query(`
            CREATE TABLE IF NOT EXISTS files (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                file_size_bytes BIGINT NOT NULL,
                total_chunks INTEGER NOT NULL,
                chunks_complete INTEGER DEFAULT 0,
                upload_status VARCHAR(20) DEFAULT 'pending',
                created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
            )
        `);

    await client.query(`
            CREATE TABLE IF NOT EXISTS chunks (
                id VARCHAR(36) PRIMARY KEY,
                file_id VARCHAR(36) NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                chunk_index INTEGER NOT NULL,
                chunk_hash VARCHAR(64) NOT NULL,
                replica_count INTEGER DEFAULT 0,
                status VARCHAR(20) DEFAULT 'pending',
                UNIQUE(file_id, chunk_index)
            )
        `);

    await client.query(`
            CREATE TABLE IF NOT EXISTS chunk_replicas (
                id SERIAL PRIMARY KEY,
                chunk_id VARCHAR(36) NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
                peer_id INTEGER NOT NULL,
                stored_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
                UNIQUE(chunk_id, peer_id)
            )
        `);

    await client.query(`
            CREATE TABLE IF NOT EXISTS peers (
                id SERIAL PRIMARY KEY,
                user_id INTEGER UNIQUE NOT NULL,
                peer_secret TEXT,
                online BOOLEAN DEFAULT false,
                last_seen BIGINT,
                total_uptime_minutes INTEGER DEFAULT 0,
                chunks_stored INTEGER DEFAULT 0,
                free_storage_bytes BIGINT DEFAULT 0,
                websocket_id VARCHAR(36)
            )
        `);

    await client.query(`
            CREATE TABLE IF NOT EXISTS cached_chunks_fallback (
                chunk_id VARCHAR(36) PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
                chunk_data BYTEA NOT NULL,
                cached_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
            )
        `);

    await client.query('CREATE INDEX IF NOT EXISTS idx_chunk_status ON chunks(status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_chunk_replica_low ON chunks(replica_count) WHERE replica_count < 5');
    await client.query('CREATE INDEX IF NOT EXISTS idx_peer_online ON peers(online)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_replicas_chunk ON chunk_replicas(chunk_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_replicas_peer ON chunk_replicas(peer_id)');

    console.log('Content database initialized.');
  } finally {
    client.release();
    await pool.end();
  }
}

initDatabase().catch(err => {
  console.error('Database initialization failed:', err.message);
  process.exit(1);
});