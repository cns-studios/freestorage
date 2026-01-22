const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const crypto = require('crypto');

let mainWindow;
let tray;
let isQuitting = false;
let ws;
let userData = {};
let pingInterval;
const pendingDownloads = new Map();
let isCancelled = false;

const USERDATA_URL = 'https://auth-freestorage.cns-studios.com';
const CONTENT_URL = 'https://tracker-freestorage.cns-studios.com';
const WS_URL = 'wss://ws-freestorage.cns-studios.com';

const CHUNK_STORAGE_PATH = path.join(app.getPath('userData'), 'chunks');
if (!fs.existsSync(CHUNK_STORAGE_PATH)) {
    fs.mkdirSync(CHUNK_STORAGE_PATH, { recursive: true });
}

function getFreeSpace() {
    return new Promise((resolve) => {
        if (fs.statfs) {
            fs.statfs(CHUNK_STORAGE_PATH, (err, stats) => {
                if (err) resolve(0);
                else resolve(stats.bavail * stats.bsize);
            });
        } else {
            resolve(10 * 1024 * 1024 * 1024);
        }
    });
}

function log(level, action, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] [ACTION:${action}] ${message}`);
}

const CREDENTIALS_PATH = path.join(app.getPath('userData'), 'credentials.json');

function saveCredentials(data) {
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(data));
}

function getSavedCredentials() {
    if (fs.existsSync(CREDENTIALS_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
        } catch (e) { return null; }
    }
    return null;
}

function createTray() {
    if (tray) return;
    
    const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
    const iconPath = path.join(__dirname, 'build', iconName);
    const trayIcon = nativeImage.createFromPath(iconPath);
    tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));
    
    const contextMenu = Menu.buildFromTemplate([
        { 
            label: 'Show App', 
            click: () => {
                if (mainWindow) mainWindow.show();
            } 
        },
        { 
            label: 'Quit', 
            click: () => {
                isQuitting = true;
                app.quit();
            } 
        }
    ]);

    tray.setToolTip('FreeStorage Desktop');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
        if (mainWindow) mainWindow.show();
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 700,
        frame: false,
        backgroundColor: '#000000',
        titleBarStyle: 'hidden',
        icon: path.join(__dirname, 'build/icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    
    mainWindow.loadFile('index.html');

    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
            return false;
        }
    });
}

// Auto Updater Configuration
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('checking-for-update', () => {
    log('INFO', 'UPDATE', 'Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
    log('INFO', 'UPDATE', `Update available: ${info.version}`);
});

autoUpdater.on('update-not-available', (info) => {
    log('INFO', 'UPDATE', 'Update not available.');
});

autoUpdater.on('error', (err) => {
    log('ERROR', 'UPDATE', `Error in auto-updater: ${err}`);
});

autoUpdater.on('download-progress', (progressObj) => {
    let log_message = "Download speed: " + progressObj.bytesPerSecond;
    log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
    log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
    log('INFO', 'UPDATE', log_message);
});

autoUpdater.on('update-downloaded', (info) => {
    log('INFO', 'UPDATE', 'Update downloaded; will install on quit');
});

app.on('before-quit', () => {
    isQuitting = true;
});

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        createWindow();
        createTray();
        autoUpdater.checkForUpdates();
    });
}

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    } else {
        mainWindow.show();
    }
});

ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-close', () => mainWindow.close());
ipcMain.handle('get-app-version', () => {
    try {
        const versionPath = path.join(__dirname, 'version.json');
        if (fs.existsSync(versionPath)) {
            const versionData = JSON.parse(fs.readFileSync(versionPath));
            return versionData.display;
        }
    } catch (e) {}
    return app.getVersion();
});

ipcMain.handle('cancel-upload', () => {
    isCancelled = true;
    return { success: true };
});

ipcMain.handle('check-auth', async () => {
    const creds = getSavedCredentials();
    if (creds && creds.username && creds.password) {
        log('INFO', 'AUTH', `Auto-login for ${creds.username}`);
        try {
            const response = await fetch(`${USERDATA_URL}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(creds)
            });
            const data = await response.json();
            if (data.token) {
                userData = data;
                connectToContentServer(data.userId);
                startPinging(data.token);
                return { success: true, data };
            }
        } catch (e) {
            log('WARN', 'AUTH', `Auto-login failed: ${e.message}`);
        }
    }
    return { success: false };
});

ipcMain.handle('logout', () => {
    if (fs.existsSync(CREDENTIALS_PATH)) fs.unlinkSync(CREDENTIALS_PATH);
    userData = {};
    if (ws) ws.close();
    if (pingInterval) clearInterval(pingInterval);
    return { success: true };
});

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
            saveCredentials({ username, password });
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
            saveCredentials({ username, password });
            connectToContentServer(data.userId);
            startPinging(data.token);
            log('INFO', 'REGISTER', `Registration successful for ${username}`);
            return { success: true, data };
        } else if (data.message) {
            log('INFO', 'REGISTER', `Registration pending: ${data.message}`);
            return { success: true, message: data.message, pending: true };
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
    isCancelled = false;
    
    try {
        const stats = fs.statSync(filePath);
        const fileSize = stats.size;
        
        const padding = 16 - (fileSize % 16);
        const encryptedSize = fileSize + padding + 16;
        
        const CHUNK_SIZE = 10 * 1024 * 1024;
        const totalChunks = Math.ceil(encryptedSize / CHUNK_SIZE);
        
        const initResponse = await fetch(`${CONTENT_URL}/upload/init`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userData.token}`
            },
            body: JSON.stringify({
                userId: userData.userId,
                filename: filename,
                fileSize: encryptedSize,
                totalChunks: totalChunks
            })
        });
        
        if (!initResponse.ok) {
            throw new Error(`Init failed: ${initResponse.statusText}`);
        }
        
        const { fileId } = await initResponse.json();
        
        const key = Buffer.from(userData.encryptionKey, 'hex');
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        
        const readStream = fs.createReadStream(filePath);
        
        let buffer = Buffer.from(iv);
        let chunkIndex = 0;
        
        const uploadChunk = async (data, idx) => {
            const chunkHash = hashChunk(data);
            const res = await fetch(`${CONTENT_URL}/upload/chunk?fileId=${fileId}&chunkIndex=${idx}&chunkHash=${chunkHash}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: data
            });
            if (!res.ok) throw new Error(`Chunk ${idx} upload failed`);
            event.sender.send('upload-progress', { current: idx + 1, total: totalChunks });
        };

        for await (const chunk of readStream) {
            if (isCancelled) throw new Error('Upload cancelled');
            const encryptedChunk = cipher.update(chunk);
            buffer = Buffer.concat([buffer, encryptedChunk]);
            
            while (buffer.length >= CHUNK_SIZE) {
                if (isCancelled) throw new Error('Upload cancelled');
                const toUpload = buffer.slice(0, CHUNK_SIZE);
                buffer = buffer.slice(CHUNK_SIZE);
                await uploadChunk(toUpload, chunkIndex++);
            }
        }
        
        if (isCancelled) throw new Error('Upload cancelled');
        const finalEncrypted = cipher.final();
        buffer = Buffer.concat([buffer, finalEncrypted]);
        
        if (buffer.length > 0) {
            if (isCancelled) throw new Error('Upload cancelled');
            await uploadChunk(buffer, chunkIndex++);
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
        await fetch(`${CONTENT_URL}/files/user/${userData.userId}/all`, { 
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${userData.token}` }
        });
        
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
        const response = await fetch(`${CONTENT_URL}/files/user/${userId}/all`, { 
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${userData.token}` }
        });
        log('INFO', 'DELETE_ALL_FILES', 'All files deleted');
        return await response.json();
    } catch (e) {
        log('ERROR', 'DELETE_ALL_FILES', `Delete failed: ${e.message}`);
        return { error: e.message };
    }
});

ipcMain.handle('rename-file', async (event, { fileId, newFilename }) => {
    try {
        const res = await fetch(`${CONTENT_URL}/files/rename`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userData.token}`
            },
            body: JSON.stringify({ fileId, newFilename })
        });
        return await res.json();
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('download-file', async (event, fileId) => {
    if (!userData.encryptionKey) return { error: 'Not logged in' };
    log('INFO', 'DOWNLOAD', `Starting download: ${fileId}`);

    try {
        const response = await fetch(`${CONTENT_URL}/download/${fileId}`, {
            headers: { 'Authorization': `Bearer ${userData.token}` }
        });
        const { chunks, filename } = await response.json();
        if (!chunks || chunks.length === 0) throw new Error('File not found or no chunks');

        const chunkBuffers = [];
        
        for (const chunk of chunks) {
            const localPath = path.join(CHUNK_STORAGE_PATH, chunk.chunkId);
            let chunkBuffer;
            
            if (fs.existsSync(localPath)) {
                chunkBuffer = fs.readFileSync(localPath);
            } else {
                try {
                    chunkBuffer = await requestChunk(chunk.chunkId);
                } catch (err) {
                    log('ERROR', 'DOWNLOAD', `Chunk retrieval failed: ${chunk.chunkId}`);
                    throw new Error(`Failed to retrieve chunk ${chunk.chunkIndex}`);
                }
            }

            const actualHash = hashChunk(chunkBuffer);
            if (actualHash !== chunk.chunkHash) {
                log('ERROR', 'DOWNLOAD', `Integrity check failed for chunk ${chunk.chunkId}`);
                throw new Error(`Integrity check failed for chunk ${chunk.chunkIndex}`);
            }
            
            chunkBuffers.push(chunkBuffer);
        }
        
        const fullEncrypted = Buffer.concat(chunkBuffers);
        const decrypted = decryptData(fullEncrypted, userData.encryptionKey);
        
        const downloadsPath = app.getPath('downloads');
        const savePath = path.join(downloadsPath, filename || `downloaded_${fileId}`); 
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
        const response = await fetch(`${CONTENT_URL}/files/user/${userId}`, {
            headers: { 'Authorization': `Bearer ${userData.token}` }
        });
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
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${userData.token}` }
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
    
    ws.on('open', async () => {
        const freeStorage = await getFreeSpace();
        ws.send(JSON.stringify({ 
            type: 'auth', 
            userId, 
            peerSecret: userData.peerSecret,
            freeStorage: freeStorage
        }));
        log('INFO', 'WS', `Connected to content server (Free Space: ${(freeStorage / 1024 / 1024 / 1024).toFixed(2)} GB)`);
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
                } else {
                    log('WARN', 'WS', `Requested chunk missing: ${msg.chunkId}`);
                    if (userData.peerId) {
                        ws.send(JSON.stringify({
                            type: 'chunk_missing',
                            chunkId: msg.chunkId,
                            peerId: userData.peerId,
                            requestId: msg.requestId,
                            purpose: msg.purpose
                        }));
                    }
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