let users = [];
let currentTab = 'pending';
let isAuthed = false;

// DOM Elements
const loginView = document.getElementById('login-view');
const dashboardView = document.getElementById('dashboard-view');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const adminTokenInput = document.getElementById('admin-token');
const loginError = document.getElementById('login-error');
const pendingCount = document.getElementById('pending-count');
const contentDiv = document.getElementById('content');
const tabs = document.querySelectorAll('.tab');
const modal = document.getElementById('edit-modal');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalSaveBtn = document.getElementById('modal-save-btn');

// --- Auth & Init ---

async function checkAuth() {
    try {
        const res = await fetch('/auth-status');
        const data = await res.json();
        isAuthed = data.isAuthed;
        updateView();
        if (isAuthed) fetchUsers();
    } catch (e) {
        console.error("Auth check failed", e);
    }
}

function updateView() {
    if (isAuthed) {
        loginView.style.display = 'none';
        dashboardView.style.display = 'block';
    } else {
        loginView.style.display = 'block';
        dashboardView.style.display = 'none';
    }
}

async function login() {
    const token = adminTokenInput.value;
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        if (res.ok) {
            isAuthed = true;
            updateView();
            fetchUsers();
            adminTokenInput.value = '';
            loginError.style.display = 'none';
        } else {
            loginError.innerText = 'Invalid Token';
            loginError.style.display = 'block';
        }
    } catch (e) {
        loginError.innerText = 'Network Error';
        loginError.style.display = 'block';
    }
}

function logout() {
    document.cookie = 'admin_token=; Max-Age=0; Path=/;';
    document.cookie = 'csrf_token=; Max-Age=0; Path=/;';
    isAuthed = false;
    updateView();
}

// --- API Helpers ---

function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
}

async function apiCall(url, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (method !== 'GET') {
        const token = getCookie('csrf_token');
        if (token) headers['X-CSRF-Token'] = token;
    }
    
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    if (res.status === 403) {
        // Auth lost
        isAuthed = false;
        updateView();
        throw new Error('Forbidden');
    }
    return res.json();
}

async function fetchUsers() {
    try {
        users = await apiCall('/api/users');
        render();
    } catch (e) {
        console.error(e);
    }
}

// --- UI Logic ---

function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function render() {
    const pendingUsers = users.filter(u => u.status === 'pending');
    pendingCount.innerText = pendingUsers.length;

    const filtered = currentTab === 'pending' ? pendingUsers : users;
    
    if (filtered.length === 0) {
        contentDiv.innerHTML = '<p style="color: var(--text-muted); text-align:center;">No users found.</p>';
        return;
    }

    let html = '<table><thead><tr><th>ID</th><th>Username</th><th>Status</th><th>Storage</th><th>Usage</th><th>Online</th><th>Last Ping</th><th>Actions</th></tr></thead><tbody>';
    
    filtered.forEach(u => {
        const usage = u.storage_used_gb ? u.storage_used_gb.toFixed(2) : '0.00';
        const lastPing = u.last_ping_time ? new Date(u.last_ping_time * 1000).toLocaleString() : '-';
        const online = u.total_online_minutes ? Math.floor(u.total_online_minutes / 60) + 'h ' + (u.total_online_minutes % 60) + 'm' : '0m';
        
        let actions = '';
        if (u.status === 'pending') {
            actions = `<button class="btn btn-success" data-action="approve" data-id="${u.id}">Approve</button>
                       <button class="btn btn-danger" data-action="reject" data-id="${u.id}">Reject</button>`;
        } else {
            actions = `<button class="btn btn-outline" data-action="edit" data-id="${u.id}">Edit</button>
                       <button class="btn btn-danger" data-action="delete" data-id="${u.id}">Delete</button>`;
        }

        html += `<tr>
            <td>${u.id}</td>
            <td>${escapeHtml(u.username)}</td>
            <td><span class="badge ${escapeHtml(u.status)}">${escapeHtml(u.status)}</span></td>
            <td>${u.storage_limit_gb} GB</td>
            <td>${usage} GB</td>
            <td>${online}</td>
            <td style="font-size:0.75rem">${escapeHtml(lastPing)}</td>
            <td>${actions}</td>
        </tr>`;
    });
    html += '</tbody></table>';
    contentDiv.innerHTML = html;
}

// --- Event Listeners ---

loginBtn.addEventListener('click', login);
logoutBtn.addEventListener('click', logout);

tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentTab = tab.dataset.tab;
        render();
    });
});

contentDiv.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = parseInt(btn.dataset.id);
    if (!action || !id) return;

    if (action === 'approve') {
        if (!confirm(`Approve user ${id}?`)) return;
        await apiCall('/api/approve', 'POST', { id });
        fetchUsers();
    } else if (action === 'reject') {
        if (!confirm(`Reject user ${id}?`)) return;
        await apiCall('/api/reject', 'POST', { id });
        fetchUsers();
    } else if (action === 'delete') {
        if (!confirm(`Permanently delete user ${id}?`)) return;
        await apiCall('/api/delete', 'POST', { id });
        fetchUsers();
    } else if (action === 'edit') {
        openEditModal(id);
    }
});

function openEditModal(id) {
    const user = users.find(u => u.id === id);
    if (!user) return;
    document.getElementById('edit-id').value = user.id;
    document.getElementById('edit-username').value = user.username;
    document.getElementById('edit-limit').value = user.storage_limit_gb;
    document.getElementById('edit-status').value = user.status;
    modal.style.display = 'flex';
}

modalCancelBtn.addEventListener('click', () => {
    modal.style.display = 'none';
});

modalSaveBtn.addEventListener('click', async () => {
    const id = document.getElementById('edit-id').value;
    const username = document.getElementById('edit-username').value;
    const limit = document.getElementById('edit-limit').value;
    const status = document.getElementById('edit-status').value;

    await apiCall('/api/update', 'POST', { id, username, storage_limit_gb: limit, status });
    modal.style.display = 'none';
    fetchUsers();
});

// Start
checkAuth();
