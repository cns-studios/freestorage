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

let currentPath = '';
let allFiles = [];

async function decryptData(encryptedData, keyHex) {
    const key = await crypto.subtle.importKey(
        'raw', 
        new Uint8Array(keyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16))), 
        'AES-CBC', 
        false, 
        ['decrypt']
    );
    const iv = encryptedData.slice(0, 16);
    const data = encryptedData.slice(16);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data);
    return decrypted;
}

async function refreshFiles() {
    const res = await fetch(`${CONTENT_URL}/files/user/${currentUser.userId}`, {
        headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    const data = await res.json();
    allFiles = data.files || [];
    renderFiles();
}

function renderFiles() {
    const search = document.getElementById('file-search').value.toLowerCase();
    const tbody = document.getElementById('file-list-body');
    tbody.innerHTML = '';
    
    const items = new Map();
    
    allFiles.forEach(file => {
        if (search && !file.filename.toLowerCase().includes(search)) return;
        
        const relative = currentPath ? file.filename.substring(currentPath.length + 1) : file.filename;
        const parts = relative.split('/');
        
        if (parts.length > 1) {
            const folderName = parts[0];
            if (!items.has(folderName)) {
                items.set(folderName, { type: 'folder', name: folderName, count: 0 });
            }
            items.get(folderName).count++;
        } else {
            items.set(file.id, { type: 'file', ...file });
        }
    });

    if (currentPath) {
        const tr = document.createElement('tr');
        tr.className = 'file-row';
        tr.innerHTML = `<td colspan="3" onclick="goBack()" style="cursor:pointer">📁 .. (Go Back)</td>`;
        tbody.appendChild(tr);
    }

    items.forEach((item, key) => {
        const tr = document.createElement('tr');
        tr.className = 'file-row';
        if (item.type === 'folder') {
            tr.innerHTML = `
                <td onclick="enterFolder('${item.name}')" style="cursor:pointer">📁 ${item.name}</td>
                <td>${item.count} items</td>
                <td style="text-align:right">
                    <button class="action-btn" onclick="renameFolder('${item.name}')">Rename</button>
                    <button class="action-btn danger" onclick="deleteFolder('${item.name}')">Delete</button>
                </td>
            `;
        } else {
            tr.innerHTML = `
                <td>📄 ${item.filename.split('/').pop()}</td>
                <td>${(item.file_size_bytes / (1024*1024)).toFixed(2)} MB</td>
                <td style="text-align:right" class="file-actions">
                    <button class="action-btn" onclick="renameFile('${item.id}', '${item.filename}')">Rename</button>
                    <button class="action-btn" onclick="downloadFile('${item.id}')">Download</button>
                </td>
            `;
        }
        tbody.appendChild(tr);
    });
}

function enterFolder(name) {
    currentPath = currentPath ? `${currentPath}/${name}` : name;
    renderFiles();
}

function goBack() {
    const parts = currentPath.split('/');
    parts.pop();
    currentPath = parts.join('/');
    renderFiles();
}

async function renameFile(fileId, oldName) {
    const newName = prompt('New filename:', oldName);
    if (!newName || newName === oldName) return;
    await fetch(`${CONTENT_URL}/files/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser.token}` },
        body: JSON.stringify({ fileId, newFilename: newName })
    });
    refreshFiles();
}

async function renameFolder(oldName) {
    const newFolderName = prompt('New folder name:', oldName);
    if (!newFolderName || newFolderName === oldName) return;
    
    const prefix = currentPath ? `${currentPath}/${oldName}/` : `${oldName}/`;
    const newPrefix = currentPath ? `${currentPath}/${newFolderName}/` : `${newFolderName}/`;
    
    const affected = allFiles.filter(f => f.filename.startsWith(prefix));
    for (const file of affected) {
        const newName = file.filename.replace(prefix, newPrefix);
        await fetch(`${CONTENT_URL}/files/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser.token}` },
            body: JSON.stringify({ fileId: file.id, newFilename: newName })
        });
    }
    refreshFiles();
}

async function deleteFolder(folderName) {
    if (!confirm('Delete folder and all its content?')) return;
    const prefix = currentPath ? `${currentPath}/${folderName}/` : `${folderName}/`;
    const affected = allFiles.filter(f => f.filename.startsWith(prefix));
    for (const file of affected) {
        await fetch(`${CONTENT_URL}/files/${file.id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${currentUser.token}` }
        });
    }
    refreshFiles();
}

async function downloadFile(fileId) {
    showLoading(true);
    try {
        const res = await fetch(`${CONTENT_URL}/download/${fileId}`, {
            headers: { 'Authorization': `Bearer ${currentUser.token}` }
        });
        const { chunks, filename } = await res.json();
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

        const decrypted = await decryptData(fullEncrypted, currentUser.encryptionKey);
        const blob = new Blob([decrypted], { type: 'application/octet-stream' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || `file_${fileId}`;
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

async function updateAccount() {
    const username = document.getElementById('new-username').value;
    const password = document.getElementById('new-password').value;
    const res = await fetch(`${USERDATA_URL}/user`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser.token}` },
        body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.success) alert('Account updated');
}

async function deleteAccount() {
    if (!confirm('Are you absolutely sure? This will delete your account and all files forever.')) return;
    await fetch(`${CONTENT_URL}/files/user/${currentUser.userId}/all`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    await fetch(`${USERDATA_URL}/user`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    logout();
}

async function deleteAllFiles() {
    if (!confirm('Delete all your files?')) return;
    await fetch(`${CONTENT_URL}/files/user/${currentUser.userId}/all`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    refreshFiles();
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

