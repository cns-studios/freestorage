const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { Pool } = require('pg');

const API_PORT = 3101;
const DB_CONFIG = {
    host: process.env.USERDATA_DB_HOST || 'localhost',
    port: parseInt(process.env.USERDATA_DB_PORT) || 5432,
    database: process.env.USERDATA_DB_NAME || 'freestorage_userdata_test',
    user: process.env.USERDATA_DB_USER || 'postgres',
    password: process.env.USERDATA_DB_PASSWORD || 'postgres'
};

const pool = new Pool(DB_CONFIG);

async function initTestDb() {
    const client = await pool.connect();
    try {
        await client.query('DROP TABLE IF EXISTS ping_logs CASCADE');
        await client.query('DROP TABLE IF EXISTS users CASCADE');
        await client.query(`
            CREATE TABLE users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                encryption_key_encrypted TEXT NOT NULL,
                peer_secret TEXT NOT NULL,
                storage_limit_gb DOUBLE PRECISION DEFAULT 10.0,
                storage_used_gb DOUBLE PRECISION DEFAULT 0.0,
                total_online_minutes INTEGER DEFAULT 0,
                last_ping_time BIGINT,
                chunks_stored INTEGER DEFAULT 0,
                status VARCHAR(20) DEFAULT 'pending',
                created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
            )
        `);
    } finally {
        client.release();
    }
}

function startServer() {
    return new Promise((resolve, reject) => {
        const env = {
            ...process.env,
            PORT: API_PORT,
            USERDATA_DB_NAME: DB_CONFIG.database
        };
        const server = spawn('node', ['userdata-server/index.js'], { env, stdio: 'pipe' });

        server.stdout.on('data', (data) => {
            if (data.toString().includes('Userdata server running on port ' + API_PORT)) {
                resolve(server);
            }
        });

        server.stderr.on('data', (data) => {
            if (!data.toString().includes('log')) console.error('ERR: ' + data);
        });
    });
}

function post(path, body, token) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const options = {
            hostname: 'localhost',
            port: API_PORT,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                ...(token && { 'Authorization': 'Bearer ' + token })
            }
        };
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

describe('Userdata Server (PostgreSQL Test DB)', async () => {
    let server;
    let username = 'user_test_' + Date.now();
    let password = 'password123';
    let token;

    before(async () => {
        await initTestDb();
        server = await startServer();
    });

    after(async () => {
        if (server) server.kill();
        await pool.end();
    });

    test('Register new user', async () => {
        const res = await post('/register', { username, password });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.message.includes('Registration successful'));
    });

    test('Approve user', async () => {
        await pool.query("UPDATE users SET status = 'approved' WHERE username = $1", [username]);
    });

    test('Login user', async () => {
        const res = await post('/login', { username, password });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.token);
        token = res.body.token;
    });

    test('Get Profile', async () => {
        const res = await new Promise((resolve, reject) => {
            http.get({
                hostname: 'localhost',
                port: API_PORT,
                path: '/profile',
                headers: { 'Authorization': 'Bearer ' + token }
            }, (resp) => {
                let data = '';
                resp.on('data', d => data += d);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            }).on('error', reject);
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(typeof res.body.storage_limit_gb, 'number');
    });
});
