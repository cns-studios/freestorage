const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const os = require('os');

const HTTP_PORT = 3103;
const WS_PORT = 3102;
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'freestorage-test-content-'));
const TEMP_DB_PATH = path.join(TEMP_DIR, 'content.db');

function initTempDb() {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(TEMP_DB_PATH);
        db.serialize(() => {
            db.run(`
                CREATE TABLE IF NOT EXISTS peers (
                  id INTEGER PRIMARY KEY,
                  user_id INTEGER UNIQUE NOT NULL,
                  peer_secret TEXT,
                  online BOOLEAN DEFAULT 0,
                  last_seen INTEGER,
                  total_uptime_minutes INTEGER DEFAULT 0,
                  chunks_stored INTEGER DEFAULT 0,
                  free_storage_bytes INTEGER DEFAULT 0,
                  websocket_id TEXT
                )
            `, resolve);
        });
        db.close();
    });
}

describe('Content Server Load Balancer (System Temp DB)', async () => {
    let server;
    let wsClients = [];

    before(async () => {
        await initTempDb();
        const env = { 
            ...process.env, 
            HTTP_PORT: HTTP_PORT, 
            WS_PORT: WS_PORT,
            DB_PATH: TEMP_DB_PATH,
            USERDATA_SERVER_URL: 'http://localhost:3101' 
        };
        server = spawn('node', ['index.js'], { cwd: './content-server', env, stdio: 'pipe' });
        
        await new Promise(resolve => {
            server.stdout.on('data', d => {
                if (d.toString().includes('Content server HTTP running')) resolve();
            });
        });
    });

    after(() => {
        wsClients.forEach(ws => ws.close());
        if (server) server.kill();
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    });

    async function connectPeer(userId, secret, freeStorageBytes) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
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

        const db = new sqlite3.Database(TEMP_DB_PATH);
        
        await new Promise((resolve, reject) => {
            db.all("SELECT user_id, free_storage_bytes FROM peers WHERE online = 1 ORDER BY free_storage_bytes DESC", (err, rows) => {
                if (err) return reject(err);
                try {
                    assert.strictEqual(rows[0].user_id, 1002);
                    assert.strictEqual(rows[1].user_id, 1001);
                    assert.strictEqual(rows[2].user_id, 1003);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
        db.close();
    });
});
