const express = require('express');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const app = express();
const fs = require('fs');
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
const DB_PATH = process.env.DB_PATH || './data/content.db';
const db = new sqlite3.Database(DB_PATH);

const SECRET_KEY = process.env.SECRET_KEY || 'YOUR_SUPER_SECRET_KEY';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'YOUR_INTERNAL_SERVICE_KEY';

db.run('PRAGMA journal_mode=WAL;');

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

log('INFO', null, `WebSocket server running on port ${WS_PORT}`);

wss.on('connection', (ws, req) => {
    const wsId = crypto.randomUUID();
    log('INFO', req, `New WebSocket connection: ${wsId}`);
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            
            if (msg.type === 'auth') {
                const { userId, peerSecret, freeStorage } = msg;
                if (!userId || !peerSecret) return;

                db.get('SELECT peer_secret FROM peers WHERE user_id = ?', [userId], (err, row) => {
                    if (row && row.peer_secret && row.peer_secret !== peerSecret) {
                        log('WARN', ws, `Peer auth failed for userId ${userId}: Invalid secret`);
                        return;
                    }

                    db.run(
                        `INSERT INTO peers (user_id, peer_secret, online, last_seen, websocket_id, free_storage_bytes) 
                         VALUES (?, ?, 1, ?, ?, ?)
                         ON CONFLICT(user_id) DO UPDATE SET 
                            online=1, last_seen=excluded.last_seen, websocket_id=excluded.websocket_id, 
                            free_storage_bytes=excluded.free_storage_bytes,
                            peer_secret=COALESCE(peer_secret, excluded.peer_secret)`,
                        [userId, peerSecret, Math.floor(Date.now() / 1000), wsId, freeStorage || 0],
                        function(err) {
                            if (err) {
                                log('ERROR', ws, `Peer auth error: ${err.message}`);
                                return;
                            }
                            
                            db.get('SELECT id FROM peers WHERE user_id = ?', [userId], (err, row) => {
                                if (row) {
                                    activePeers.set(wsId, { ws, userId: userId, peerId: row.id });
                                    ws.send(JSON.stringify({ type: 'auth_ok', peerId: row.id }));
                                    log('INFO', ws, `Peer authenticated: ${userId} (PeerID: ${row.id})`);
                                }
                            });
                        }
                    );
                });
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
                    db.run('INSERT OR REPLACE INTO cached_chunks (chunk_id, chunk_data) VALUES (?, ?)',
                        [msg.chunkId, Buffer.from(msg.chunkData, 'base64')],
                        (err) => {
                            if (!err) log('INFO', null, `Cached chunk ${msg.chunkId} locally`);
                        }
                    );
                } else if (msg.requestId) {
                    const requesterWsId = msg.requestId;
                    const requester = activePeers.get(requesterWsId);
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
    
    ws.on('close', () => {
        const peer = activePeers.get(wsId);
        if (peer) {
            log('INFO', null, `Peer disconnected: ${peer.userId}`);
            db.run('UPDATE peers SET online = 0 WHERE id = ?', [peer.peerId]);
            activePeers.delete(wsId);
        }
    });
});

function handleChunkRequest(requesterWsId, chunkId) {
    db.get('SELECT chunk_data FROM cached_chunks WHERE chunk_id = ?', [chunkId], (err, row) => {
        if (row) {
            const requester = activePeers.get(requesterWsId);
            if (requester) {
                requester.ws.send(JSON.stringify({
                    type: 'chunk_data',
                    chunkId: chunkId,
                    chunkData: row.chunk_data.toString('base64')
                }));
                log('DEBUG', null, `Served chunk ${chunkId} from cache`);
            }
            return;
        }

        db.all('SELECT peer_id FROM chunk_replicas WHERE chunk_id = ?', [chunkId], (err, replicas) => {
            if (!replicas || replicas.length === 0) {
                log('WARN', null, `Chunk ${chunkId} not found in network`);
                return;
            }
            
            const onlinePeersWithChunk = [];
            for (const rep of replicas) {
                const conn = Array.from(activePeers.values()).find(p => p.peerId === rep.peer_id);
                if (conn) onlinePeersWithChunk.push(conn);
            }

            if (onlinePeersWithChunk.length > 0) {
                const provider = onlinePeersWithChunk[Math.floor(Math.random() * onlinePeersWithChunk.length)];
                provider.ws.send(JSON.stringify({
                    type: 'retrieve_chunk',
                    chunkId: chunkId,
                    requestId: requesterWsId
                }));
                log('DEBUG', null, `Requested chunk ${chunkId} from peer ${provider.peerId}`);
            } else {
                log('WARN', null, `Chunk ${chunkId} available but peers offline`);
            }
        });
    });
}

app.post('/upload/init', authenticateToken, (req, res) => {
    const { userId, filename, fileSize, totalChunks } = req.body;

    if (parseInt(userId) !== req.userId) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const fileId = crypto.randomUUID();
    
    db.run(
        'INSERT INTO files (id, user_id, filename, file_size_bytes, total_chunks) VALUES (?, ?, ?, ?, ?)',
        [fileId, userId, filename, fileSize, totalChunks],
        (err) => {
            if (err) {
                log('ERROR', req, `Upload init db error: ${err.message}`);
                return res.status(500).json({ error: 'Db error' });
            }
            log('INFO', req, `Upload initialized: ${filename} (${fileId})`);
            res.json({ fileId });
        }
    );
});

app.post('/upload/chunk', (req, res) => {
    const { fileId, chunkIndex, chunkHash } = req.query;
    const chunkData = req.body; 
    const chunkId = crypto.randomUUID();
    
    if (!chunkData || chunkData.length === 0) {
        log('WARN', req, 'Empty chunk upload attempt');
        return res.status(400).json({ error: 'No data' });
    }

    db.run(
        'INSERT INTO chunks (id, file_id, chunk_index, chunk_hash) VALUES (?, ?, ?, ?)',
        [chunkId, fileId, chunkIndex, chunkHash],
        (err) => {
            if (err) {
                log('ERROR', req, `Chunk insert error: ${err.message}`);
                return res.status(500).json({ error: 'Db error' });
            }
            log('DEBUG', req, `Chunk uploaded: ${chunkId} (Index: ${chunkIndex})`);
            distributeChunkToPeers(chunkId, chunkData);
            res.json({ chunkId, status: 'distributing' });
        }
    );
});

function distributeChunkToPeers(chunkId, chunkData) {
    db.all('SELECT id FROM peers WHERE online = 1 ORDER BY free_storage_bytes DESC, RANDOM() LIMIT 5', (err, peers) => {
        if (err || !peers) return;
        peers.forEach(peerRow => {
            const peerConnection = Array.from(activePeers.values()).find(p => p.peerId === peerRow.id);
            if (peerConnection) {
                peerConnection.ws.send(JSON.stringify({
                    type: 'store_chunk',
                    chunkId,
                    chunkData: chunkData.toString('base64')
                }));
            }
        });
        log('DEBUG', null, `Distributed chunk ${chunkId} to ${peers.length} peers`);
    });
}

function handleChunkStored(chunkId, peerId) {
    db.run(
        'INSERT INTO chunk_replicas (chunk_id, peer_id) VALUES (?, ?)',
        [chunkId, peerId],
        (err) => {
            if (err) return; 

            db.run('UPDATE peers SET chunks_stored = chunks_stored + 1 WHERE id = ?', [peerId]);
            
            db.get('SELECT user_id, chunks_stored FROM peers WHERE id = ?', [peerId], (err, peer) => {
                if (peer) {
                    fetch(`${USERDATA_SERVER_URL}/sync-contribution`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            userId: peer.user_id, 
                            chunksStored: peer.chunks_stored, 
                            apiKey: INTERNAL_API_KEY 
                        })
                    }).catch(() => {});
                }
            });

            db.get('SELECT COUNT(*) as count FROM chunk_replicas WHERE chunk_id = ?', [chunkId], (err, row) => {
                const count = row.count;
                db.run('UPDATE chunks SET replica_count = ? WHERE id = ?', [count, chunkId]);
                if (count >= 5) {
                    db.run('UPDATE chunks SET status = "ok" WHERE id = ?', [chunkId]);
                    checkFileCompletion(chunkId);
                }
            });
        }
    );
}

function handleChunkMissing(chunkId, peerId, requestId, purpose) {
    db.run(
        'DELETE FROM chunk_replicas WHERE chunk_id = ? AND peer_id = ?',
        [chunkId, peerId],
        (err) => {
            if (err) return;
            db.get('SELECT COUNT(*) as count FROM chunk_replicas WHERE chunk_id = ?', [chunkId], (err, row) => {
                const count = row.count || 0;
                db.run('UPDATE chunks SET replica_count = ? WHERE id = ?', [count, chunkId]);
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
            });
        }
    );
}

function checkFileCompletion(chunkId) {
    db.get('SELECT file_id FROM chunks WHERE id = ?', [chunkId], (err, chunk) => {
        if (!chunk) return;
        db.get('SELECT user_id, total_chunks, file_size_bytes FROM files WHERE id = ?', [chunk.file_id], (err, file) => {
             db.get(
                'SELECT COUNT(*) as complete FROM chunks WHERE file_id = ? AND status = "ok"',
                [chunk.file_id],
                (err, result) => {
                    if (result.complete === file.total_chunks) {
                        db.run('UPDATE files SET upload_status = "complete", chunks_complete = ? WHERE id = ?',
                            [file.total_chunks, chunk.file_id]);
                        log('INFO', null, `File complete: ${chunk.file_id}`);

                        const sizeGb = file.file_size_bytes / (1024 * 1024 * 1024);
                        fetch(`${USERDATA_SERVER_URL}/update-storage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userId: file.user_id, addGb: sizeGb, apiKey: INTERNAL_API_KEY })
                        }).catch(e => log('ERROR', null, `Failed to update storage usage: ${e.message}`));
                    }
                }
            );
        });
    });
}

app.delete('/files/:fileId', authenticateToken, (req, res) => {
    const { fileId } = req.params;
    
    db.get('SELECT user_id, file_size_bytes FROM files WHERE id = ?', [fileId], (err, file) => {
        if (!file) {
            log('WARN', req, `Delete failed: File ${fileId} not found`);
            return res.status(404).json({ error: 'File not found' });
        }

        if (file.user_id !== req.userId) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        
        db.run('DELETE FROM chunk_replicas WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)', [fileId]);
        db.run('DELETE FROM cached_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)', [fileId]);
        db.run('DELETE FROM chunks WHERE file_id = ?', [fileId]);
        db.run('DELETE FROM files WHERE id = ?', [fileId], (err) => {
            if (err) {
                log('ERROR', req, `Delete db error: ${err.message}`);
                return res.status(500).json({ error: 'Db error' });
            }
            
            const sizeGb = file.file_size_bytes / (1024 * 1024 * 1024);
            fetch(`${USERDATA_SERVER_URL}/update-storage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: file.user_id, addGb: -sizeGb, apiKey: INTERNAL_API_KEY })
            }).catch(e => log('ERROR', null, `Failed to update storage usage: ${e.message}`));
            
            log('INFO', req, `File deleted: ${fileId}`);
            res.json({ success: true });
        });
    });
});

app.delete('/files/user/:userId/all', authenticateToken, (req, res) => {
    const { userId } = req.params;
    
    if (parseInt(userId) !== req.userId) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    db.get('SELECT SUM(file_size_bytes) as total_size FROM files WHERE user_id = ?', [userId], (err, result) => {
        const totalSize = result ? result.total_size : 0;
        
        db.run('DELETE FROM chunk_replicas WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id IN (SELECT id FROM files WHERE user_id = ?))', [userId]);
        db.run('DELETE FROM cached_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id IN (SELECT id FROM files WHERE user_id = ?))', [userId]);
        db.run('DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE user_id = ?)', [userId]);
        db.run('DELETE FROM files WHERE user_id = ?', [userId], (err) => {
            if (err) {
                log('ERROR', req, `Bulk delete db error: ${err.message}`);
                return res.status(500).json({ error: 'Db error' });
            }
            
            if (totalSize > 0) {
                const sizeGb = totalSize / (1024 * 1024 * 1024);
                fetch(`${USERDATA_SERVER_URL}/update-storage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, addGb: -sizeGb, apiKey: INTERNAL_API_KEY })
                }).catch(e => log('ERROR', null, `Failed to update storage usage: ${e.message}`));
            }
            log('WARN', req, `All files deleted for user ${userId}`);
            res.json({ success: true });
        });
    });
});

app.get('/download/:fileId', authenticateToken, (req, res) => {
    const { fileId } = req.params;

    db.get('SELECT user_id FROM files WHERE id = ?', [fileId], (err, file) => {
        if (!file || file.user_id !== req.userId) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        db.all(
            `SELECT c.id, c.chunk_index, c.chunk_hash
            FROM chunks c
            WHERE c.file_id = ?
            ORDER BY c.chunk_index`,
            [fileId],
            (err, chunks) => {
                if (err) {
                    log('ERROR', req, `Download fetch error: ${err.message}`);
                    return res.status(500).json({ error: 'Db error' });
                }
                log('INFO', req, `Download requested for file ${fileId}`);
                res.json({ chunks: chunks.map(c => ({ chunkId: c.id, chunkIndex: c.chunk_index, chunkHash: c.chunk_hash }))});
            }
        );
    });
});

app.get('/files/user/:userId', authenticateToken, (req, res) => {
    const { userId } = req.params;

    if (parseInt(userId) !== req.userId) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    db.all(
        'SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC',
        [userId],
        (err, files) => {
            if (err) {
                log('ERROR', req, `File list fetch error: ${err.message}`);
                return res.status(500).json({ error: 'Db error' });
            }
            res.json({ files });
        }
    );
});

setInterval(() => {
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    db.all('SELECT id, websocket_id FROM peers WHERE online = 1 AND last_seen < ?', [tenMinutesAgo], (err, peers) => {
        if (err || !peers) return;
        peers.forEach(peer => {
            log('INFO', null, `Peer ${peer.id} marked offline (timeout)`);
            db.run('UPDATE peers SET online = 0 WHERE id = ?', [peer.id]);
            if (peer.websocket_id && activePeers.has(peer.websocket_id)) {
                try {
                    activePeers.get(peer.websocket_id).ws.terminate();
                } catch (e) {}
                activePeers.delete(peer.websocket_id);
            }
        });
    });

    db.all('SELECT id, replica_count, status FROM chunks', (err, chunks) => {
        if (err) return;
        chunks.forEach(chunk => {
            let newStatus = chunk.status;
            if (chunk.replica_count >= 5) newStatus = 'ok';
            else if (chunk.replica_count === 4) newStatus = 'attention';
            else if (chunk.replica_count <= 3) newStatus = 'warning';
            
            if (newStatus !== chunk.status) {
                db.run('UPDATE chunks SET status = ? WHERE id = ?', [newStatus, chunk.id]);
                if (newStatus === 'warning') {
                    cacheChunkLocally(chunk.id);
                }
            }
        });
    });

    db.all('SELECT chunk_id, chunk_data FROM cached_chunks', (err, cachedItems) => {
        if (err) return;
        cachedItems.forEach(item => {
            db.get('SELECT replica_count FROM chunks WHERE id = ?', [item.chunk_id], (err, chunk) => {
                if (chunk && chunk.replica_count < 5) {
                    distributeCachedChunk(item.chunk_id, item.chunk_data);
                } else if (chunk && chunk.replica_count >= 5) {
                    db.run('DELETE FROM cached_chunks WHERE chunk_id = ?', [item.chunk_id]);
                }
            });
        });
    });
}, 30000); 

function cacheChunkLocally(chunkId) {
    db.get('SELECT chunk_id FROM cached_chunks WHERE chunk_id = ?', [chunkId], (err, row) => {
        if (row) return; 
        db.get('SELECT peer_id FROM chunk_replicas WHERE chunk_id = ? ORDER BY RANDOM() LIMIT 1', [chunkId], (err, rep) => {
            if (rep) {
                const conn = Array.from(activePeers.values()).find(p => p.peerId === rep.peer_id);
                if (conn) {
                    conn.ws.send(JSON.stringify({
                        type: 'retrieve_chunk',
                        chunkId,
                        purpose: 'cache'
                    }));
                }
            }
        });
    });
}

function distributeCachedChunk(chunkId, chunkData) {
    const sql = `
        SELECT p.id 
        FROM peers p 
        WHERE p.online = 1 
        AND p.id NOT IN (SELECT peer_id FROM chunk_replicas WHERE chunk_id = ?)
        ORDER BY RANDOM() LIMIT 1
    `;
    db.get(sql, [chunkId], (err, peer) => {
        if (peer) {
            const conn = Array.from(activePeers.values()).find(p => p.peerId === peer.id);
            if (conn) {
                conn.ws.send(JSON.stringify({
                    type: 'store_chunk',
                    chunkId,
                    chunkData: chunkData.toString('base64')
                }));
                log('DEBUG', null, `Redistributing cached chunk ${chunkId} to peer ${peer.id}`);
            }
        }
    });
}

app.listen(HTTP_PORT, () => log('INFO', null, `Content server HTTP running on port ${HTTP_PORT}`));