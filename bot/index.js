const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const suffix = process.argv[2] || '';
const STORAGE_DIR = path.join(__dirname, `storage${suffix}`);
const CREDENTIALS_PATH = path.join(__dirname, `credentials${suffix}.json`);
const WS_URL = process.env.WS_URL || 'ws://localhost:3002';

if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

function getCredentials() {
    if (fs.existsSync(CREDENTIALS_PATH)) {
        try {
            const data = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
            if (data.userId && data.peerSecret) return data;
        } catch (e) {
            console.error('Error reading credentials file:', e.message);
        }
    }

    const newUserId = Math.floor(Math.random() * 9000000) + 1000000;
    const newPeerSecret = crypto.randomBytes(32).toString('hex');
    const creds = { userId: newUserId, peerSecret: newPeerSecret };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
    return creds;
}

const credentials = getCredentials();
const userId = credentials.userId;
const peerSecret = credentials.peerSecret;
console.log(`Bot${suffix} starting with UserID: ${userId}`);
console.log(`Using storage: ${STORAGE_DIR}`);

let ws;
let myPeerId = null;

function connect() {
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        console.log('Connected to Content Server');
        authenticate();
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            handleMessage(msg);
        } catch (e) {
            console.error('Error parsing message:', e.message);
        }
    });

    ws.on('close', () => {
        console.log('Disconnected. Reconnecting in 5s...');
        setTimeout(connect, 5000);
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
        ws.close();
    });
}

function getFreeSpace() {
    return new Promise((resolve) => {
        fs.statfs(STORAGE_DIR, (err, stats) => {
            if (err) {
                resolve(0);
            } else {
                resolve(stats.bavail * stats.bsize);
            }
        });
    });
}

async function authenticate() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const freeStorage = await getFreeSpace();
        ws.send(JSON.stringify({ type: 'auth', userId, peerSecret, freeStorage }));
        console.log(`Sent authentication (Free Storage: ${(freeStorage / 1024 / 1024 / 1024).toFixed(2)} GB)`);
    }
}

setInterval(authenticate, 5 * 60 * 1000);

function handleMessage(msg) {
    switch (msg.type) {
        case 'auth_ok':
            myPeerId = msg.peerId;
            console.log(`Authenticated successfully. PeerID: ${myPeerId}`);
            break;

        case 'store_chunk':
            handleStoreChunk(msg);
            break;

        case 'retrieve_chunk':
            handleRetrieveChunk(msg);
            break;
            
        case 'chunk_data':
             break;
    }
}

function handleStoreChunk(msg) {
    const { chunkId, chunkData } = msg;
    const filePath = path.join(STORAGE_DIR, chunkId);

    try {
        fs.writeFileSync(filePath, Buffer.from(chunkData, 'base64'));
        console.log(`Stored chunk: ${chunkId}`);

        if (myPeerId) {
            ws.send(JSON.stringify({
                type: 'chunk_stored',
                chunkId: chunkId,
                peerId: myPeerId
            }));
        } else {
            console.warn('Cannot confirm chunk storage: No PeerID assigned yet.');
        }
    } catch (e) {
        console.error(`Failed to store chunk ${chunkId}:`, e.message);
    }
}

function handleRetrieveChunk(msg) {
    const { chunkId, requestId, purpose } = msg;
    const filePath = path.join(STORAGE_DIR, chunkId);

    if (fs.existsSync(filePath)) {
        try {
            const data = fs.readFileSync(filePath);
            ws.send(JSON.stringify({
                type: 'chunk_data',
                chunkId: chunkId,
                chunkData: data.toString('base64'),
                requestId: requestId,
                purpose: purpose
            }));
            console.log(`Served chunk: ${chunkId}`);
        } catch (e) {
            console.error(`Failed to read chunk ${chunkId}:`, e.message);
        }
    } else {
        console.log(`Requested chunk not found: ${chunkId}`);
        if (myPeerId) {
            ws.send(JSON.stringify({
                type: 'chunk_missing',
                chunkId: chunkId,
                peerId: myPeerId,
                requestId: requestId,
                purpose: purpose
            }));
        }
    }
}

connect();