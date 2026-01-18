const USERDATA_URL = 'https://auth-freestorage.cns-studios.com';
const CONTENT_URL = 'https://tracker-freestorage.cns-studios.com';
const WS_URL = 'wss://ws-freestorage.cns-studios.com';

let ws = null;
let currentUser = {};
const pendingDownloads = new Map();

function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
}

function showLoading(show) { document.getElementById('loading-overlay').style.display = show ? 'flex' : 'none'; }

async function login() {
    const u = document.getElementById('username').value;
    const p = document.getElementById('password').value;
    showLoading(true);
    const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
    });
    showLoading(false);
    const data = await res.json();
    if (data.success) location.reload();
    else document.getElementById('auth-msg').innerText = data.error;
}

async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    location.reload();
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).style.display = 'block';
    if (tabId === 'files') refreshFiles();
}

async function refreshFiles() {
    const res = await fetch(`${CONTENT_URL}/files/user/${currentUser.userId}`, {
        headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    const data = await res.json();
    const tbody = document.getElementById('file-list-body');
    tbody.innerHTML = '';
    data.files.forEach(file => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${file.filename}</td>
            <td>${(file.file_size_bytes / (1024*1024)).toFixed(2)} MB</td>
            <td style="text-align:right"><button style="width:auto; padding: 4px 12px;" onclick="downloadFile('${file.id}')">Download</button></td>
        `;
        tbody.appendChild(tr);
    });
}

async function downloadFile(fileId) {
    showLoading(true);
    try {
        const res = await fetch(`${CONTENT_URL}/download/${fileId}`, {
            headers: { 'Authorization': `Bearer ${currentUser.token}` }
        });
        const { chunks } = await res.json();
        const chunkBuffers = [];

        for (const chunk of chunks) {
            const data = await requestChunk(chunk.chunkId);
            
            const hash = await crypto.subtle.digest('SHA-256', data);
            const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
            
            if (hashHex !== chunk.chunkHash) throw new Error('Integrity check failed');
            chunkBuffers.push(data);
        }

        const fullEncrypted = new Uint8Array(chunkBuffers.reduce((acc, curr) => acc + curr.byteLength, 0));
        let offset = 0;
        chunkBuffers.forEach(buf => {
            fullEncrypted.set(new Uint8Array(buf), offset);
            offset += buf.byteLength;
        });

        const blob = new Blob([fullEncrypted], { type: 'application/octet-stream' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `file_${fileId}.bin`;
        a.click();
    } catch (e) {
        alert('Download failed: ' + e.message);
    }
    showLoading(false);
}

function requestChunk(chunkId) {
    return new Promise((resolve, reject) => {
        const requestId = Math.random().toString(36).substring(7);
        const timeout = setTimeout(() => {
            pendingDownloads.delete(requestId);
            reject(new Error('Timeout'));
        }, 10000);

        pendingDownloads.set(requestId, { resolve, reject, timeout });
        ws.send(JSON.stringify({ type: 'request_chunk', chunkId, requestId }));
    });
}

function initWS() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth', userId: currentUser.userId, peerSecret: currentUser.peerSecret }));
    };
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'chunk_data') {
            for (let [reqId, pend] of pendingDownloads) {
                clearTimeout(pend.timeout);
                const binary = atob(msg.chunkData);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                pend.resolve(bytes.buffer);
                pendingDownloads.delete(reqId);
                break;
            }
        }
    };
}

window.onload = () => {
    const token = getCookie('token');
    if (token) {
        currentUser = {
            token,
            userId: getCookie('userId'),
            encryptionKey: getCookie('encryptionKey'),
            peerSecret: getCookie('peerSecret'),
            username: getCookie('username')
        };
        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('app-screen').style.display = 'flex';
        initWS();
        
        fetch(`${USERDATA_URL}/profile`, { headers: { 'Authorization': `Bearer ${token}` }})
            .then(r => r.json())
            .then(p => {
                document.getElementById('storage-used').innerText = p.storage_used_gb.toFixed(2) + ' GB';
                document.getElementById('storage-limit').innerText = p.storage_limit_gb + ' GB';
            });
    }
};

