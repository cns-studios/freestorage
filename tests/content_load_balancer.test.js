const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { Pool } = require('pg');

const HTTP_PORT = 3103;
const WS_PORT = 3102;
const DB_CONFIG = {
    host: process.env.CONTENT_DB_HOST || 'localhost',
    port: parseInt(process.env.CONTENT_DB_PORT) || 5432,
    database: process.env.CONTENT_DB_NAME || 'freestorage_content_test',
    user: process.env.CONTENT_DB_USER || 'postgres',
    password: process.env.CONTENT_DB_PASSWORD || 'postgres'
};

const pool = new Pool(DB_CONFIG);

async function initTestDb() {
    const client = await pool.connect();
    try {
        await client.query('DROP TABLE IF EXISTS peers CASCADE');
        await client.query(`
            CREATE TABLE peers (
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
    } finally {
        client.release();
    }
}

describe('Content Server Load Balancer (PostgreSQL Test DB)', async () => {
    let server;
    let wsClients = [];

    before(async () => {
        await initTestDb();
        const env = {
            ...process.env,
            HTTP_PORT: HTTP_PORT,
            WS_PORT: WS_PORT,
            CONTENT_DB_NAME: DB_CONFIG.database,
            USERDATA_SERVER_URL: 'http://localhost:3101'
        };
        server = spawn('node', ['index.js'], { cwd: './content-server', env, stdio: 'pipe' });

        await new Promise((resolve) => {
            server.stdout.on('data', (d) => {
                if (d.toString().includes('Content server HTTP running')) resolve();
            });
        });
    });

    after(async () => {
        wsClients.forEach(ws => ws.close());
        if (server) server.kill();
        await pool.end();
    });

    async function connectPeer(userId, secret, freeStorageBytes) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket('ws://localhost:' + WS_PORT);
            wsClients.push(ws);

            ws.on('open', () => {
                ws.send(JSON.stringify({
                    type: 'auth',
                    userId,
                    peerSecret: secret,
                    freeStorage: freeStorageBytes
                }));
            });

            ws.on('message', (data) => {
                const msg = JSON.parse(data);
                if (msg.type === 'auth_ok') resolve(msg.peerId);
            });

            ws.on('error', reject);
        });
    }

    test('Prioritize peers with more storage', async () => {
        await connectPeer(1001, 'secret', 10 * 1024 * 1024 * 1024);
        await connectPeer(1002, 'secret', 100 * 1024 * 1024 * 1024);
        await connectPeer(1003, 'secret', 1 * 1024 * 1024 * 1024);

        await new Promise(r => setTimeout(r, 500));

        const result = await pool.query('SELECT user_id, free_storage_bytes FROM peers WHERE online = true ORDER BY free_storage_bytes DESC');
        const rows = result.rows;

        assert.strictEqual(rows[0].user_id, 1002);
        assert.strictEqual(rows[1].user_id, 1001);
        assert.strictEqual(rows[2].user_id, 1003);
    });
});
