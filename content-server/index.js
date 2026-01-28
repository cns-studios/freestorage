const express = require('express');
const WebSocket = require('ws');
const { Pool } = require('pg');
const Redis = require('ioredis');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const app = express();

const pool = new Pool({
    host: process.env.CONTENT_DB_HOST || 'localhost',
    port: parseInt(process.env.CONTENT_DB_PORT) || 5432,
    database: process.env.CONTENT_DB_NAME || 'freestorage_content',
    user: process.env.CONTENT_DB_USER || 'postgres',
    password: process.env.CONTENT_DB_PASSWORD || 'postgres',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});

const redis = new Redis({
    host: process.env.DRAGONFLY_HOST || 'localhost',
    port: parseInt(process.env.DRAGONFLY_PORT) || 6379,
    password: process.env.DRAGONFLY_PASSWORD || undefined,
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3
});

const CACHE_TTL = 86400;
const FALLBACK_THRESHOLD = 3600;

const SECRET_KEY = process.env.SECRET_KEY || 'YOUR_SUPER_SECRET_KEY';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'YOUR_INTERNAL_SERVICE_KEY';

app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (origin.endsWith('cns-studios.com') || origin.includes('localhost'))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

const WS_PORT = process.env.WS_PORT || 3002;
const HTTP_PORT = process.env.HTTP_PORT || 3003;
const USERDATA_SERVER_URL = process.env.USERDATA_SERVER_URL || 'http://localhost:3001';

const wss = new WebSocket.Server({ port: WS_PORT });
const activePeers = new Map();
const peerIdToWsId = new Map();

function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });

    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.userId = decoded.userId;
        next();
    });
}

function getIp(reqOrWs) {
    if (reqOrWs.connection) return reqOrWs.ip || reqOrWs.connection.remoteAddress || 'unknown';
    if (reqOrWs._socket) return reqOrWs._socket.remoteAddress || 'unknown';
    return 'unknown';
}

function log(level, source, message) {
    const timestamp = new Date().toISOString();
    const ip = source ? getIp(source) : 'SYSTEM';
    console.log(`[${timestamp}] [${level}] [${ip}] ${message}`);
}

app.use((req, res, next) => {
    log('INFO', req, `${req.method} ${req.url}`);
    next();
});

app.get('/health', async (req, res) => {
    const health = {
        status: 'healthy',
        timestamp: Date.now(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        activePeers: activePeers.size
    };

    try {
        const start = Date.now();
        await pool.query('SELECT 1');
        health.database = { status: 'connected', latencyMs: Date.now() - start };
    } catch (err) {
        health.status = 'unhealthy';
        health.database = { status: 'disconnected', error: err.message };
    }

    try {
        const start = Date.now();
        await redis.ping();
        health.cache = { status: 'connected', latencyMs: Date.now() - start };
    } catch (err) {
        health.status = 'unhealthy';
        health.cache = { status: 'disconnected', error: err.message };
    }

    health.websocket = { status: wss.clients.size > 0 ? 'active' : 'idle', connections: wss.clients.size };

    res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

log('INFO', null, `WebSocket server running on port ${WS_PORT}`);

wss.on('connection', (ws, req) => {
    const wsId = crypto.randomUUID();
    log('INFO', req, `New WebSocket connection: ${wsId}`);

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);

            if (msg.type === 'auth') {
                const { userId, peerSecret, freeStorage } = msg;
                if (!userId || !peerSecret) return;

                try {
                    const existing = await pool.query('SELECT peer_secret FROM peers WHERE user_id = $1', [userId]);
                    if (existing.rows[0] && existing.rows[0].peer_secret && existing.rows[0].peer_secret !== peerSecret) {
                        log('WARN', ws, `Peer auth failed for userId ${userId}: Invalid secret`);
                        return;
                    }

                    const now = Math.floor(Date.now() / 1000);
                    const result = await pool.query(`
                        INSERT INTO peers (user_id, peer_secret, online, last_seen, websocket_id, free_storage_bytes)
                        VALUES ($1, $2, true, $3, $4, $5)
                        ON CONFLICT (user_id) DO UPDATE SET
                            online = true,
                            last_seen = $3,
                            websocket_id = $4,
                            free_storage_bytes = $5,
                            peer_secret = COALESCE(peers.peer_secret, $2)
                        RETURNING id
                    `, [userId, peerSecret, now, wsId, freeStorage || 0]);

                    const peerId = result.rows[0].id;
                    activePeers.set(wsId, { ws, userId, peerId });
                    peerIdToWsId.set(peerId, wsId);
                    ws.send(JSON.stringify({ type: 'auth_ok', peerId }));
                    log('INFO', ws, `Peer authenticated: ${userId} (PeerID: ${peerId})`);
                } catch (err) {
                    log('ERROR', ws, `Peer auth error: ${err.message}`);
                }
            }

            if (msg.type === 'chunk_stored') {
                log('DEBUG', ws, `Chunk stored confirmation: ${msg.chunkId} by Peer ${msg.peerId}`);
                handleChunkStored(msg.chunkId, msg.peerId);
            }

            if (msg.type === 'chunk_missing') {
                log('WARN', ws, `Chunk reported missing: ${msg.chunkId} by Peer ${msg.peerId}`);
                handleChunkMissing(msg.chunkId, msg.peerId, msg.requestId, msg.purpose);
            }

            if (msg.type === 'request_chunk') {
                log('DEBUG', ws, `Chunk requested: ${msg.chunkId}`);
                handleChunkRequest(wsId, msg.chunkId);
            }

            if (msg.type === 'chunk_data') {
                if (msg.purpose === 'cache') {
                    await cacheChunkData(msg.chunkId, Buffer.from(msg.chunkData, 'base64'));
                    log('INFO', null, `Cached chunk ${msg.chunkId}`);
                } else if (msg.requestId) {
                    const requester = activePeers.get(msg.requestId);
                    if (requester) {
                        requester.ws.send(JSON.stringify({
                            type: 'chunk_data',
                            chunkId: msg.chunkId,
                            chunkData: msg.chunkData
                        }));
                        log('DEBUG', null, `Forwarded chunk ${msg.chunkId} to requester`);
                    }
                }
            }
        } catch (e) {
            log('ERROR', ws, `WS Message Error: ${e.message}`);
        }
    });

    ws.on('close', async () => {
        const peer = activePeers.get(wsId);
        if (peer) {
            log('INFO', null, `Peer disconnected: ${peer.userId}`);
            try {
                await pool.query('UPDATE peers SET online = false WHERE id = $1', [peer.peerId]);
            } catch (err) { }
            peerIdToWsId.delete(peer.peerId);
            activePeers.delete(wsId);
        }
    });
});

async function cacheChunkData(chunkId, chunkData) {
    const base64Data = chunkData.toString('base64');
    await redis.setex(`chunk:${chunkId}`, CACHE_TTL, base64Data);
}

async function getChunkFromCache(chunkId) {
    const data = await redis.get(`chunk:${chunkId}`);
    if (data) return Buffer.from(data, 'base64');

    const result = await pool.query('SELECT chunk_data FROM cached_chunks_fallback WHERE chunk_id = $1', [chunkId]);
    if (result.rows[0]) {
        const chunkData = result.rows[0].chunk_data;
        await redis.setex(`chunk:${chunkId}`, CACHE_TTL, chunkData.toString('base64'));
        return chunkData;
    }

    return null;
}

async function handleChunkRequest(requesterWsId, chunkId) {
    const cachedData = await getChunkFromCache(chunkId);
    if (cachedData) {
        const requester = activePeers.get(requesterWsId);
        if (requester) {
            requester.ws.send(JSON.stringify({
                type: 'chunk_data',
                chunkId,
                chunkData: cachedData.toString('base64')
            }));
            log('DEBUG', null, `Served chunk ${chunkId} from cache`);
        }
        return;
    }

    const replicas = await pool.query('SELECT peer_id FROM chunk_replicas WHERE chunk_id = $1', [chunkId]);
    if (!replicas.rows.length) {
        log('WARN', null, `Chunk ${chunkId} not found in network`);
        return;
    }

    const onlinePeersWithChunk = [];
    for (const rep of replicas.rows) {
        const wsId = peerIdToWsId.get(rep.peer_id);
        if (wsId && activePeers.has(wsId)) {
            onlinePeersWithChunk.push(activePeers.get(wsId));
        }
    }

    if (onlinePeersWithChunk.length > 0) {
        const provider = onlinePeersWithChunk[Math.floor(Math.random() * onlinePeersWithChunk.length)];
        provider.ws.send(JSON.stringify({
            type: 'retrieve_chunk',
            chunkId,
            requestId: requesterWsId
        }));
        log('DEBUG', null, `Requested chunk ${chunkId} from peer ${provider.peerId}`);
    } else {
        log('WARN', null, `Chunk ${chunkId} available but peers offline`);
    }
}

app.post('/upload/init', authenticateToken, async (req, res) => {
    const { userId, filename, fileSize, totalChunks } = req.body;

    if (parseInt(userId) !== req.userId) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const fileId = crypto.randomUUID();

    try {
        await pool.query(
            'INSERT INTO files (id, user_id, filename, file_size_bytes, total_chunks) VALUES ($1, $2, $3, $4, $5)',
            [fileId, userId, filename, fileSize, totalChunks]
        );
        log('INFO', req, `Upload initialized: ${filename} (${fileId})`);
        res.json({ fileId });
    } catch (err) {
        log('ERROR', req, `Upload init db error: ${err.message}`);
        res.status(500).json({ error: 'Db error' });
    }
});

app.post('/upload/chunk', async (req, res) => {
    const { fileId, chunkIndex, chunkHash } = req.query;
    const chunkData = req.body;
    const chunkId = crypto.randomUUID();

    if (!chunkData || chunkData.length === 0) {
        log('WARN', req, 'Empty chunk upload attempt');
        return res.status(400).json({ error: 'No data' });
    }

    try {
        await pool.query(
            'INSERT INTO chunks (id, file_id, chunk_index, chunk_hash) VALUES ($1, $2, $3, $4)',
            [chunkId, fileId, chunkIndex, chunkHash]
        );
        log('DEBUG', req, `Chunk uploaded: ${chunkId} (Index: ${chunkIndex})`);
        distributeChunkToPeers(chunkId, chunkData);
        res.json({ chunkId, status: 'distributing' });
    } catch (err) {
        log('ERROR', req, `Chunk insert error: ${err.message}`);
        res.status(500).json({ error: 'Db error' });
    }
});

async function distributeChunkToPeers(chunkId, chunkData) {
    try {
        const result = await pool.query(
            'SELECT id FROM peers WHERE online = true ORDER BY free_storage_bytes DESC, RANDOM() LIMIT 5'
        );
        const base64Data = chunkData.toString('base64');

        for (const peerRow of result.rows) {
            const wsId = peerIdToWsId.get(peerRow.id);
            if (wsId && activePeers.has(wsId)) {
                activePeers.get(wsId).ws.send(JSON.stringify({
                    type: 'store_chunk',
                    chunkId,
                    chunkData: base64Data
                }));
            }
        }
        log('DEBUG', null, `Distributed chunk ${chunkId} to ${result.rows.length} peers`);
    } catch (err) {
        log('ERROR', null, `Distribution error: ${err.message}`);
    }
}

async function handleChunkStored(chunkId, peerId) {
    try {
        await pool.query(
            'INSERT INTO chunk_replicas (chunk_id, peer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [chunkId, peerId]
        );

        await pool.query('UPDATE peers SET chunks_stored = chunks_stored + 1 WHERE id = $1', [peerId]);

        const peerResult = await pool.query('SELECT user_id, chunks_stored FROM peers WHERE id = $1', [peerId]);
        if (peerResult.rows[0]) {
            fetch(`${USERDATA_SERVER_URL}/sync-contribution`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: peerResult.rows[0].user_id,
                    chunksStored: peerResult.rows[0].chunks_stored,
                    apiKey: INTERNAL_API_KEY
                })
            }).catch(() => { });
        }

        const countResult = await pool.query('SELECT COUNT(*) as count FROM chunk_replicas WHERE chunk_id = $1', [chunkId]);
        const count = parseInt(countResult.rows[0].count);

        await pool.query('UPDATE chunks SET replica_count = $1 WHERE id = $2', [count, chunkId]);

        if (count >= 5) {
            await pool.query('UPDATE chunks SET status = $1 WHERE id = $2', ['ok', chunkId]);
            checkFileCompletion(chunkId);
        }
    } catch (err) {
        log('ERROR', null, `handleChunkStored error: ${err.message}`);
    }
}

async function handleChunkMissing(chunkId, peerId, requestId, purpose) {
    try {
        await pool.query('DELETE FROM chunk_replicas WHERE chunk_id = $1 AND peer_id = $2', [chunkId, peerId]);

        const countResult = await pool.query('SELECT COUNT(*) as count FROM chunk_replicas WHERE chunk_id = $1', [chunkId]);
        const count = parseInt(countResult.rows[0].count);

        await pool.query('UPDATE chunks SET replica_count = $1 WHERE id = $2', [count, chunkId]);
        log('WARN', null, `Chunk ${chunkId} removed from Peer ${peerId}. New replica count: ${count}`);

        if (requestId) {
            if (purpose === 'cache') {
                cacheChunkLocally(chunkId);
            } else {
                handleChunkRequest(requestId, chunkId);
            }
        }

        if (count < 5) {
            cacheChunkLocally(chunkId);
        }
    } catch (err) {
        log('ERROR', null, `handleChunkMissing error: ${err.message}`);
    }
}

async function checkFileCompletion(chunkId) {
    try {
        const chunkResult = await pool.query('SELECT file_id FROM chunks WHERE id = $1', [chunkId]);
        if (!chunkResult.rows[0]) return;

        const fileId = chunkResult.rows[0].file_id;
        const fileResult = await pool.query('SELECT user_id, total_chunks, file_size_bytes FROM files WHERE id = $1', [fileId]);
        if (!fileResult.rows[0]) return;

        const file = fileResult.rows[0];
        const completeResult = await pool.query(
            'SELECT COUNT(*) as complete FROM chunks WHERE file_id = $1 AND status = $2',
            [fileId, 'ok']
        );

        if (parseInt(completeResult.rows[0].complete) === file.total_chunks) {
            await pool.query(
                'UPDATE files SET upload_status = $1, chunks_complete = $2 WHERE id = $3',
                ['complete', file.total_chunks, fileId]
            );
            log('INFO', null, `File complete: ${fileId}`);

            const sizeGb = file.file_size_bytes / (1024 * 1024 * 1024);
            fetch(`${USERDATA_SERVER_URL}/update-storage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: file.user_id, addGb: sizeGb, apiKey: INTERNAL_API_KEY })
            }).catch(e => log('ERROR', null, `Failed to update storage usage: ${e.message}`));
        }
    } catch (err) {
        log('ERROR', null, `checkFileCompletion error: ${err.message}`);
    }
}

app.delete('/files/:fileId', authenticateToken, async (req, res) => {
    const { fileId } = req.params;

    try {
        const fileResult = await pool.query('SELECT user_id, file_size_bytes, upload_status FROM files WHERE id = $1', [fileId]);
        if (!fileResult.rows[0]) {
            log('WARN', req, `Delete failed: File ${fileId} not found`);
            return res.status(404).json({ error: 'File not found' });
        }

        const file = fileResult.rows[0];
        if (file.user_id !== req.userId) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const chunksResult = await pool.query('SELECT id FROM chunks WHERE file_id = $1', [fileId]);
        for (const chunk of chunksResult.rows) {
            await redis.del(`chunk:${chunk.id}`);
        }

        await pool.query('DELETE FROM files WHERE id = $1', [fileId]);

        if (file.upload_status === 'complete') {
            const sizeGb = file.file_size_bytes / (1024 * 1024 * 1024);
            fetch(`${USERDATA_SERVER_URL}/update-storage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: file.user_id, addGb: -sizeGb, apiKey: INTERNAL_API_KEY })
            }).catch(e => log('ERROR', null, `Failed to update storage usage: ${e.message}`));
        }

        log('INFO', req, `File deleted: ${fileId}`);
        res.json({ success: true });
    } catch (err) {
        log('ERROR', req, `Delete db error: ${err.message}`);
        res.status(500).json({ error: 'Db error' });
    }
});

app.get('/download/:fileId', authenticateToken, async (req, res) => {
    const { fileId } = req.params;

    try {
        const fileResult = await pool.query('SELECT user_id, filename FROM files WHERE id = $1', [fileId]);
        if (!fileResult.rows[0] || fileResult.rows[0].user_id !== req.userId) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const chunksResult = await pool.query(
            'SELECT id, chunk_index, chunk_hash FROM chunks WHERE file_id = $1 ORDER BY chunk_index',
            [fileId]
        );

        log('INFO', req, `Download requested for file ${fileId}`);
        res.json({
            filename: fileResult.rows[0].filename,
            chunks: chunksResult.rows.map(c => ({ chunkId: c.id, chunkIndex: c.chunk_index, chunkHash: c.chunk_hash }))
        });
    } catch (err) {
        log('ERROR', req, `Download fetch error: ${err.message}`);
        res.status(500).json({ error: 'Db error' });
    }
});

app.post('/files/rename', authenticateToken, async (req, res) => {
    const { fileId, newFilename } = req.body;

    try {
        const fileResult = await pool.query('SELECT user_id FROM files WHERE id = $1', [fileId]);
        if (!fileResult.rows[0] || fileResult.rows[0].user_id !== req.userId) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        await pool.query('UPDATE files SET filename = $1 WHERE id = $2', [newFilename, fileId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Db error' });
    }
});

app.get('/files/user/:userId', authenticateToken, async (req, res) => {
    const { userId } = req.params;

    if (parseInt(userId) !== req.userId) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
        const result = await pool.query('SELECT * FROM files WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
        res.json({ files: result.rows });
    } catch (err) {
        log('ERROR', req, `File list fetch error: ${err.message}`);
        res.status(500).json({ error: 'Db error' });
    }
});

app.delete('/files/user/:userId/all', authenticateToken, async (req, res) => {
    const { userId } = req.params;

    if (parseInt(userId) !== req.userId) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
        const chunksResult = await pool.query(
            'SELECT c.id FROM chunks c JOIN files f ON c.file_id = f.id WHERE f.user_id = $1',
            [userId]
        );
        for (const chunk of chunksResult.rows) {
            await redis.del(`chunk:${chunk.id}`);
        }

        await pool.query('DELETE FROM files WHERE user_id = $1', [userId]);

        fetch(`${USERDATA_SERVER_URL}/reset-storage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, apiKey: INTERNAL_API_KEY })
        }).catch(e => log('ERROR', null, `Failed to reset storage usage: ${e.message}`));

        log('WARN', req, `All files deleted for user ${userId}`);
        res.json({ success: true });
    } catch (err) {
        log('ERROR', req, `Bulk delete db error: ${err.message}`);
        res.status(500).json({ error: 'Db error' });
    }
});

async function cacheChunkLocally(chunkId) {
    const exists = await redis.exists(`chunk:${chunkId}`);
    if (exists) return;

    const fallbackResult = await pool.query('SELECT chunk_id FROM cached_chunks_fallback WHERE chunk_id = $1', [chunkId]);
    if (fallbackResult.rows[0]) return;

    try {
        const repResult = await pool.query(
            'SELECT peer_id FROM chunk_replicas WHERE chunk_id = $1 ORDER BY RANDOM() LIMIT 1',
            [chunkId]
        );

        if (repResult.rows[0]) {
            const wsId = peerIdToWsId.get(repResult.rows[0].peer_id);
            if (wsId && activePeers.has(wsId)) {
                activePeers.get(wsId).ws.send(JSON.stringify({
                    type: 'retrieve_chunk',
                    chunkId,
                    purpose: 'cache'
                }));
            }
        }
    } catch (err) {
        log('ERROR', null, `cacheChunkLocally error: ${err.message}`);
    }
}

async function distributeCachedChunk(chunkId, chunkData) {
    try {
        const result = await pool.query(`
            SELECT p.id FROM peers p
            WHERE p.online = true
            AND p.id NOT IN (SELECT peer_id FROM chunk_replicas WHERE chunk_id = $1)
            ORDER BY RANDOM() LIMIT 1
        `, [chunkId]);

        if (result.rows[0]) {
            const wsId = peerIdToWsId.get(result.rows[0].id);
            if (wsId && activePeers.has(wsId)) {
                activePeers.get(wsId).ws.send(JSON.stringify({
                    type: 'store_chunk',
                    chunkId,
                    chunkData: chunkData.toString('base64')
                }));
                log('DEBUG', null, `Redistributing cached chunk ${chunkId} to peer ${result.rows[0].id}`);
            }
        }
    } catch (err) {
        log('ERROR', null, `distributeCachedChunk error: ${err.message}`);
    }
}

setInterval(async () => {
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;

    try {
        const staleResult = await pool.query(
            'SELECT id, websocket_id FROM peers WHERE online = true AND last_seen < $1',
            [tenMinutesAgo]
        );

        for (const peer of staleResult.rows) {
            log('INFO', null, `Peer ${peer.id} marked offline (timeout)`);
            await pool.query('UPDATE peers SET online = false WHERE id = $1', [peer.id]);
            if (peer.websocket_id && activePeers.has(peer.websocket_id)) {
                try {
                    activePeers.get(peer.websocket_id).ws.terminate();
                } catch (e) { }
                peerIdToWsId.delete(peer.id);
                activePeers.delete(peer.websocket_id);
            }
        }

        const lowReplicaChunks = await pool.query('SELECT id, replica_count, status FROM chunks WHERE replica_count < 5');
        for (const chunk of lowReplicaChunks.rows) {
            let newStatus = chunk.status;
            if (chunk.replica_count >= 5) newStatus = 'ok';
            else if (chunk.replica_count === 4) newStatus = 'attention';
            else if (chunk.replica_count <= 3) newStatus = 'warning';

            if (newStatus !== chunk.status) {
                await pool.query('UPDATE chunks SET status = $1 WHERE id = $2', [newStatus, chunk.id]);
                if (newStatus === 'warning') {
                    cacheChunkLocally(chunk.id);
                }
            }
        }
    } catch (err) {
        log('ERROR', null, `Maintenance error: ${err.message}`);
    }
}, 30000);

setInterval(async () => {
    try {
        const keys = await redis.keys('chunk:*');

        for (const key of keys) {
            const ttl = await redis.ttl(key);
            if (ttl > 0 && ttl < FALLBACK_THRESHOLD) {
                const chunkId = key.replace('chunk:', '');
                const data = await redis.get(key);
                if (data) {
                    await pool.query(`
                        INSERT INTO cached_chunks_fallback (chunk_id, chunk_data)
                        VALUES ($1, $2)
                        ON CONFLICT (chunk_id) DO UPDATE SET chunk_data = $2, cached_at = EXTRACT(EPOCH FROM NOW())::BIGINT
                    `, [chunkId, Buffer.from(data, 'base64')]);
                    log('DEBUG', null, `Persisted chunk ${chunkId} to PostgreSQL fallback`);
                }
            }
        }

        const lowReplicaChunks = await pool.query('SELECT id FROM chunks WHERE replica_count < 5 LIMIT 10');
        for (const chunk of lowReplicaChunks.rows) {
            const cachedData = await getChunkFromCache(chunk.id);
            if (cachedData) {
                distributeCachedChunk(chunk.id, cachedData);
            }
        }
    } catch (err) {
        log('ERROR', null, `Cache fallback error: ${err.message}`);
    }
}, 3600000);

app.listen(HTTP_PORT, () => log('INFO', null, `Content server HTTP running on port ${HTTP_PORT}`));