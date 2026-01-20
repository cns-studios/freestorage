const USERDATA_URL = 'https://auth-freestorage.cns-studios.com';
const CONTENT_URL = 'https://tracker-freestorage.cns-studios.com';
const WS_URL = 'wss://ws-freestorage.cns-studios.com';

let ws = null;
let currentUser = {};
const pendingDownloads = new Map();

// Custom Modal Logic
const modalOverlay = document.getElementById('custom-modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const modalInput = document.getElementById('modal-input');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');

let modalResolve = null;

function showModal({ title, message, type = 'alert', placeholder = '', confirmText = 'OK', cancelText = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
        modalResolve = resolve;
        modalTitle.innerText = title;
        modalMessage.innerText = message;
        modalInput.value = '';
        
        modalInput.style.display = type === 'prompt' ? 'block' : 'none';
        if (type === 'prompt' && placeholder) modalInput.placeholder = placeholder;
        
        modalCancel.style.display = type === 'alert' ? 'none' : 'block';
        modalCancel.innerText = cancelText;
        
        modalConfirm.innerText = confirmText;
        if (danger) {
            modalConfirm.classList.add('danger');
            modalConfirm.style.background = 'rgba(239, 68, 68, 0.1)';
            modalConfirm.style.color = 'var(--danger-color)';
            modalConfirm.style.borderColor = 'var(--danger-color)';
        } else {
            modalConfirm.classList.remove('danger');
            modalConfirm.style.background = 'var(--accent-color)';
            modalConfirm.style.color = '#000';
            modalConfirm.style.borderColor = 'var(--accent-color)';
        }

        modalOverlay.style.display = 'flex';
        if (type === 'prompt') modalInput.focus();
    });
}

function closeModal(result) {
    modalOverlay.style.display = 'none';
    if (modalResolve) {
        modalResolve(result);
        modalResolve = null;
    }
}

modalCancel.onclick = () => closeModal(false);
modalConfirm.onclick = () => {
    if (modalInput.style.display === 'block') {
        closeModal(modalInput.value);
    } else {
        closeModal(true);
    }
};

modalInput.onkeydown = (e) => {
    if (e.key === 'Enter') modalConfirm.click();
    if (e.key === 'Escape') modalCancel.click();
};

async function customAlert(message, title = 'Alert') {
    await showModal({ title, message, type: 'alert' });
}

async function customConfirm(message, title = 'Confirm', danger = false) {
    return await showModal({ title, message, type: 'confirm', danger });
}

async function customPrompt(message, defaultValue = '', title = 'Input') {
    const result = await showModal({ title, message, type: 'prompt', placeholder: defaultValue });
    return result === false ? null : result;
}

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
    if (data.success) {
        if (data.data.encryptionKey) localStorage.setItem('encryptionKey', data.data.encryptionKey);
        if (data.data.peerSecret) localStorage.setItem('peerSecret', data.data.peerSecret);
        location.reload();
    }
    else document.getElementById('auth-msg').innerText = data.error;
}

async function logout() {
    localStorage.removeItem('encryptionKey');
    localStorage.removeItem('peerSecret');
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

async function downloadFolder(folderName) {
    const prefix = currentPath ? `${currentPath}/${folderName}/` : `${folderName}/`;
    const affected = allFiles.filter(f => f.filename.startsWith(prefix));
    for (const file of affected) {
        await downloadFile(file.id);
    }
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
        tr.innerHTML = `<td colspan="3" onclick="goBack()" style="cursor:pointer;">
            <div class="cell-content">
                <svg class="icon" style="width:16px; height:16px; stroke: currentColor; fill:none; stroke-width:1.5" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="9" y1="14" x2="15" y2="14"></line></svg>
                .. (Go Back)
            </div>
        </td>`;
        tbody.appendChild(tr);
    }

    items.forEach((item, key) => {
        const tr = document.createElement('tr');
        tr.className = 'file-row';
        if (item.type === 'folder') {
            tr.innerHTML = `
                <td onclick="enterFolder('${item.name}')" style="cursor:pointer;">
                    <div class="cell-content">
                        <svg class="icon" style="width:16px; height:16px; stroke: #888; fill:none; stroke-width:1.5" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                        ${item.name}
                    </div>
                </td>
                <td>${item.count} items</td>
                <td style="text-align:right">
                    <button class="action-btn" title="Download" onclick="downloadFolder('${item.name}')"><svg class="icon" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></button>
                    <button class="action-btn" title="Rename" onclick="renameFolder('${item.name}')"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
                    <button class="action-btn danger" title="Delete" onclick="deleteFolder('${item.name}')"><svg class="icon" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
                </td>
            `;
        } else {
            const sizeGb = (item.file_size_bytes / (1024 * 1024 * 1024)).toFixed(1);
            tr.innerHTML = `
                <td>
                    <div class="cell-content">
                        <svg class="icon" style="width:16px; height:16px; stroke: #444; fill:none; stroke-width:1.5" viewBox="0 0 24 24"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
                        ${item.filename.split('/').pop()}
                    </div>
                </td>
                <td>${sizeGb} GB</td>
                <td style="text-align:right" class="file-actions">
                    <button class="action-btn" title="Rename" onclick="renameFile('${item.id}', '${item.filename}')"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
                    <button class="action-btn" title="Download" onclick="downloadFile('${item.id}')"><svg class="icon" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></button>
                    <button class="action-btn danger" title="Delete" onclick="deleteFile('${item.id}')"><svg class="icon" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
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
    const lastDotIndex = oldName.lastIndexOf('.');
    const ext = lastDotIndex !== -1 ? oldName.substring(lastDotIndex) : '';
    const baseName = lastDotIndex !== -1 ? oldName.substring(0, lastDotIndex) : oldName;

    const newBaseName = await customPrompt(`New filename (ending with ${ext}):`, baseName, 'Rename File');
    if (!newBaseName || newBaseName === baseName) return;
    
    const newName = newBaseName + ext;
    
    await fetch(`${CONTENT_URL}/files/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser.token}` },
        body: JSON.stringify({ fileId, newFilename: newName })
    });
    refreshFiles();
}

async function renameFolder(oldName) {
    const newFolderName = await customPrompt('New folder name:', oldName, 'Rename Folder');
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
    if (!await customConfirm('Delete folder and all its content?', 'Delete Folder', true)) return;
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
        await customAlert('Download failed: ' + e.message, 'Error');
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
    if (data.success) await customAlert('Account updated', 'Success');
}

async function deleteAccount() {
    if (!await customConfirm('Are you absolutely sure? This will delete your account and all files forever.', 'Delete Account', true)) return;
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
    if (!await customConfirm('Delete all your files?', 'Delete All Files', true)) return;
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
            encryptionKey: localStorage.getItem('encryptionKey'),
            peerSecret: localStorage.getItem('peerSecret'),
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

