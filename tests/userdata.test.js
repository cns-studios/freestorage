const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

const API_PORT = 3101;
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'freestorage-test-'));
const TEMP_DB_PATH = path.join(TEMP_DIR, 'userdata.db');

function initTempDb() {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(TEMP_DB_PATH);
        db.serialize(() => {
            db.run(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    encryption_key_encrypted TEXT NOT NULL,
                    peer_secret TEXT,
                    storage_limit_gb REAL DEFAULT 10.0,
                    storage_used_gb REAL DEFAULT 0.0,
                    total_online_minutes INTEGER DEFAULT 0,
                    last_ping_time INTEGER,
                    chunks_stored INTEGER DEFAULT 0,
                    status TEXT DEFAULT 'pending'
                )
            `);
            db.run(`
                CREATE TABLE IF NOT EXISTS ping_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    ping_time INTEGER,
                    FOREIGN KEY (user_id) REFERENCES users(id)
                )
            `, resolve);
        });
        db.close();
    });
}

function startServer() {
    return new Promise((resolve, reject) => {
        const env = { 
            ...process.env, 
            PORT: API_PORT,
            DB_PATH: TEMP_DB_PATH
        };
        const server = spawn('node', ['userdata-server/index.js'], { env, stdio: 'pipe' });
        
        server.stdout.on('data', (data) => {
            if (data.toString().includes(`Userdata server running on port ${API_PORT}`)) {
                resolve(server);
            }
        });
        
        server.stderr.on('data', (data) => console.error(`ERR: ${data}`));
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
                'Content-Length': data.length,
                ...(token && { 'Authorization': `Bearer ${token}` })
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

describe('Userdata Server (System Temp DB)', async () => {
    let server;
    let username = `user_test`;
    let password = 'password123';
    let token;

    before(async () => {
        await initTempDb();
        server = await startServer();
    });

    after(() => {
        if (server) server.kill();
        // Cleanup temp dir
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    });

    test('Register new user', async () => {
        const res = await post('/register', { username, password });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.message.includes('Registration successful'));
    });

    test('Approve user', async () => {
        const db = new sqlite3.Database(TEMP_DB_PATH);
        await new Promise((resolve, reject) => {
            db.run("UPDATE users SET status = 'approved' WHERE username = ?", [username], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        db.close();
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
                headers: { 'Authorization': `Bearer ${token}` }
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
