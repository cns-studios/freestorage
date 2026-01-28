const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.USERDATA_DB_HOST || 'localhost',
    port: parseInt(process.env.USERDATA_DB_PORT) || 5432,
    database: process.env.USERDATA_DB_NAME || 'freestorage_userdata',
    user: process.env.USERDATA_DB_USER || 'postgres',
    password: process.env.USERDATA_DB_PASSWORD || 'postgres'
});

async function initDatabase() {
    const client = await pool.connect();
    
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                encryption_key_encrypted TEXT NOT NULL,
                peer_secret TEXT NOT NULL,
                storage_limit_gb INTEGER DEFAULT 10,
                storage_used_gb DOUBLE PRECISION DEFAULT 0,
                total_online_minutes INTEGER DEFAULT 0,
                chunks_stored INTEGER DEFAULT 0,
                last_ping_time BIGINT,
                status VARCHAR(20) DEFAULT 'pending',
                created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS ping_logs (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                ping_time BIGINT NOT NULL
            )
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_ping_user ON ping_logs(user_id, ping_time)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)
        `);

        console.log('Userdata database initialized.');
    } finally {
        client.release();
        await pool.end();
    }
}

initDatabase().catch(err => {
    console.error('Database initialization failed:', err.message);
    process.exit(1);
});