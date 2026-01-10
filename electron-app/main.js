const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const crypto = require('crypto');

let mainWindow;
let ws;
let userData = {};
let pingInterval;
const pendingDownloads = new Map();

const USERDATA_URL = 'http://localhost:3001';
const CONTENT_URL = 'http://localhost:3003';
const WS_URL = 'ws://localhost:3002';

const CHUNK_STORAGE_PATH = path.join(app.getPath('userData'), 'chunks');
if (!fs.existsSync(CHUNK_STORAGE_PATH)) {
    fs.mkdirSync(CHUNK_STORAGE_PATH, { recursive: true });
}

function log(level, action, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] [ACTION:${action}] ${message}`);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    
    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

ipcMain.handle('login', async (event, { username, password }) => {
    log('INFO', 'LOGIN', `Attempting login for ${username}`);
    try {
        const response = await fetch(`${USERDATA_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        if (data.token) {
            userData = data;
            connectToContentServer(data.userId);
            startPinging(data.token);
            log('INFO', 'LOGIN', `Login successful for ${username}`);
            return { success: true, data };
        }
        log('WARN', 'LOGIN', `Login failed for ${username}: ${data.error}`);
        return { success: false, error: data.error };
    } catch (e) {
        log('ERROR', 'LOGIN', `Login error: ${e.message}`);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('register', async (event, { username, password }) => {
    log('INFO', 'REGISTER', `Attempting registration for ${username}`);
    try {
        const response = await fetch(`${USERDATA_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        if (data.token) {
            userData = data;
            connectToContentServer(data.userId);
            startPinging(data.token);
            log('INFO', 'REGISTER', `Registration successful for ${username}`);
            return { success: true, data };
        }
        log('WARN', 'REGISTER', `Registration failed: ${data.error}`);
        return { success: false, error: data.error };
    } catch (e) {
        log('ERROR', 'REGISTER', `Registration error: ${e.message}`);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('upload-file', async (event, { filePath, relativePath }) => {
    const filename = relativePath || path.basename(filePath);
    log('INFO', 'UPLOAD', `Starting upload: ${filename}`);
    
    try {
        const fileData = fs.readFileSync(filePath);
        const encrypted = encryptData(fileData, userData.encryptionKey);
        const chunks = chunkData(encrypted, 10 * 1024 * 1024);
        
        const initResponse = await fetch(`${CONTENT_URL}/upload/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: userData.userId,
                filename: filename,
                fileSize: encrypted.length,
                totalChunks: chunks.length
            })
        });
        
        const { fileId } = await initResponse.json();
        
        for (let i = 0; i < chunks.length; i++) {
            const chunkHash = hashChunk(chunks[i]);
            
            await fetch(`${CONTENT_URL}/upload/chunk?fileId=${fileId}&chunkIndex=${i}&chunkHash=${chunkHash}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: chunks[i]
            });
            
            event.sender.send('upload-progress', { current: i + 1, total: chunks.length });
        }
        
        log('INFO', 'UPLOAD', `Upload complete: ${filename} (${fileId})`);
        return { fileId };
    } catch (e) {
        log('ERROR', 'UPLOAD', `Upload failed: ${e.message}`);
        throw e;
    }
});

ipcMain.handle('update-account', async (event, updates) => {
    log('INFO', 'UPDATE_ACCOUNT', 'Updating account credentials');
    try {
        const response = await fetch(`${USERDATA_URL}/user`, {
            method: 'PUT',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userData.token}` 
            },
            body: JSON.stringify(updates)
        });
        return await response.json();
    } catch (e) {
        log('ERROR', 'UPDATE_ACCOUNT', `Update failed: ${e.message}`);
        return { error: e.message };
    }
});

ipcMain.handle('delete-account', async (event) => {
    log('WARN', 'DELETE_ACCOUNT', 'Initiating account deletion');
    try {
        await fetch(`${CONTENT_URL}/files/user/${userData.userId}/all`, { method: 'DELETE' });
        
        const response = await fetch(`${USERDATA_URL}/user`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${userData.token}` }
        });
        log('INFO', 'DELETE_ACCOUNT', 'Account deleted');
        return await response.json();
    } catch (e) {
        log('ERROR', 'DELETE_ACCOUNT', `Delete failed: ${e.message}`);
        return { error: e.message };
    }
});

ipcMain.handle('delete-all-files', async (event, userId) => {
    log('WARN', 'DELETE_ALL_FILES', 'Deleting all files');
    try {
        const response = await fetch(`${CONTENT_URL}/files/user/${userId}/all`, { method: 'DELETE' });
        log('INFO', 'DELETE_ALL_FILES', 'All files deleted');
        return await response.json();
    } catch (e) {
        log('ERROR', 'DELETE_ALL_FILES', `Delete failed: ${e.message}`);
        return { error: e.message };
    }
});

ipcMain.handle('download-file', async (event, fileId) => {
    if (!userData.encryptionKey) return { error: 'Not logged in' };
    log('INFO', 'DOWNLOAD', `Starting download: ${fileId}`);

    try {
        const response = await fetch(`${CONTENT_URL}/download/${fileId}`);
        const { chunks } = await response.json();
        if (!chunks || chunks.length === 0) throw new Error('File not found or no chunks');

        const chunkBuffers = [];
        
        for (const chunk of chunks) {
            const localPath = path.join(CHUNK_STORAGE_PATH, chunk.chunkId);
            if (fs.existsSync(localPath)) {
                chunkBuffers.push(fs.readFileSync(localPath));
                continue;
            }

            try {
                const chunkData = await requestChunk(chunk.chunkId);
                chunkBuffers.push(chunkData);
            } catch (err) {
                log('ERROR', 'DOWNLOAD', `Chunk retrieval failed: ${chunk.chunkId}`);
                console.error(`Failed to retrieve chunk ${chunk.chunkId}`, err);
                throw new Error(`Failed to retrieve chunk ${chunk.chunkIndex}`);
            }
        }
        
        const fullEncrypted = Buffer.concat(chunkBuffers);
        const decrypted = decryptData(fullEncrypted, userData.encryptionKey);
        
        const downloadsPath = app.getPath('downloads');
        const savePath = path.join(downloadsPath, `downloaded_${fileId}.bin`); 
        fs.writeFileSync(savePath, decrypted);
        
        log('INFO', 'DOWNLOAD', `Download complete: ${savePath}`);
        return { savePath };
    } catch (e) {
        log('ERROR', 'DOWNLOAD', `Download failed: ${e.message}`);
        return { error: e.message };
    }
});

ipcMain.handle('get-files', async (event, userId) => {
    try {
        const response = await fetch(`${CONTENT_URL}/files/user/${userId}`);
        const data = await response.json();
        return data; 
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('delete-file', async (event, fileId) => {
    log('INFO', 'DELETE_FILE', `Deleting file: ${fileId}`);
    try {
        const response = await fetch(`${CONTENT_URL}/files/${fileId}`, {
            method: 'DELETE'
        });
        const data = await response.json();
        if (data.success) return { success: true };
        return { error: data.error };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('get-profile', async (event, token) => {
    try {
        const response = await fetch(`${USERDATA_URL}/profile`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        return data;
    } catch (e) {
        return { error: e.message };
    }
});

async function requestChunk(chunkId, attempt = 1) {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            if (attempt <= 3) {
                 log('WARN', 'WS', `WS not ready, retrying chunk ${chunkId} (attempt ${attempt})...`);
                 setTimeout(() => requestChunk(chunkId, attempt + 1).then(resolve).catch(reject), 1000);
                 return;
            }
            return reject(new Error('WebSocket not connected'));
        }

        const timeout = setTimeout(() => {
            pendingDownloads.delete(chunkId);
            if (attempt <= 3) {
                log('WARN', 'WS', `Timeout waiting for chunk ${chunkId}, retrying (attempt ${attempt + 1})...`);
                requestChunk(chunkId, attempt + 1).then(resolve).catch(reject);
            } else {
                reject(new Error('Timeout waiting for chunk'));
            }
        }, 5000);

        pendingDownloads.set(chunkId, { 
            resolve: (data) => {
                clearTimeout(timeout);
                resolve(data);
            }, 
            reject: (err) => {
                clearTimeout(timeout);
                reject(err);
            }
        });

        ws.send(JSON.stringify({
            type: 'request_chunk',
            chunkId: chunkId
        }));
    });
}


function connectToContentServer(userId) {
    if (ws) ws.close();
    ws = new WebSocket(WS_URL);
    
    ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', userId }));
        log('INFO', 'WS', 'Connected to content server');
    });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            
            if (msg.type === 'store_chunk') {
                const chunkPath = path.join(CHUNK_STORAGE_PATH, msg.chunkId);
                fs.writeFileSync(chunkPath, Buffer.from(msg.chunkData, 'base64'));
                log('DEBUG', 'WS', `Stored chunk: ${msg.chunkId}`);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'chunk_stored',
                        chunkId: msg.chunkId,
                        peerId: userData.peerId
                    }));
                }
            }
            
            if (msg.type === 'retrieve_chunk') {
                const chunkPath = path.join(CHUNK_STORAGE_PATH, msg.chunkId);
                if (fs.existsSync(chunkPath)) {
                    const chunkData = fs.readFileSync(chunkPath);
                    ws.send(JSON.stringify({
                        type: 'chunk_data',
                        chunkId: msg.chunkId,
                        chunkData: chunkData.toString('base64'),
                        requestId: msg.requestId, 
                        purpose: msg.purpose
                    }));
                    log('DEBUG', 'WS', `Served chunk request: ${msg.chunkId}`);
                }
            }
            
            if (msg.type === 'chunk_data') {
                const pending = pendingDownloads.get(msg.chunkId);
                if (pending) {
                    pending.resolve(Buffer.from(msg.chunkData, 'base64'));
                    pendingDownloads.delete(msg.chunkId);
                }
            }

            if (msg.type === 'auth_ok') {
                userData.peerId = msg.peerId;
                log('INFO', 'WS', 'Authenticated with content server');
            }
        } catch (e) {
            log('ERROR', 'WS', `WS Error: ${e.message}`);
        }
    });
}

function startPinging(token) {
    if (pingInterval) clearInterval(pingInterval);
    ping();
    pingInterval = setInterval(ping, 5 * 60 * 1000); 

    async function ping() {
        try {
            await fetch(`${USERDATA_URL}/ping`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            log('DEBUG', 'PING', 'Ping sent');
        } catch (e) {
            log('ERROR', 'PING', `Ping failed: ${e.message}`);
        }
    }
}

function encryptData(data, keyHex) {
    const key = Buffer.from(keyHex, 'hex');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([iv, encrypted]);
}

function decryptData(encryptedData, keyHex) {
    const key = Buffer.from(keyHex, 'hex');
    const iv = encryptedData.slice(0, 16);
    const encrypted = encryptedData.slice(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function chunkData(data, chunkSize) {
    const chunks = [];
    for (let i = 0; i < data.length; i += chunkSize) {
        chunks.push(data.slice(i, i + chunkSize));
    }
    return chunks;
}

function hashChunk(chunk) {
    return crypto.createHash('sha256').update(chunk).digest('hex');
}