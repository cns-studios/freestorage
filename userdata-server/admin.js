const express = require('express');
const sqlite3 = require('sqlite3');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3004;
const DB_PATH = process.env.DB_PATH || './data/userdata.db';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
    console.error("FATAL: ADMIN_TOKEN environment variable is not set. Admin panel is disabled for security.");
    process.exit(1);
}

const db = new sqlite3.Database(DB_PATH);

app.use(express.json());

const parseCookies = (req) => {
    const list = {};
    const rc = req.headers.cookie;
    rc && rc.split(';').forEach(function(cookie) {
        const parts = cookie.split('=');
        list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
    return list;
};

const checkAuth = (req, res, next) => {
    const cookies = parseCookies(req);
    const token = cookies.admin_token;
    
    if (token !== ADMIN_TOKEN) {
        if (req.path === '/' && req.method === 'GET') {
            req.isAuthed = false;
            return next();
        }
        return res.status(403).json({ error: 'Forbidden' });
    }

    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const csrfCookie = cookies.csrf_token;
        const csrfHeader = req.headers['x-csrf-token'];
        
        if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
            return res.status(403).json({ error: 'CSRF Token Mismatch' });
        }
    }
    
    next();
};

app.post('/api/login', (req, res) => {
    const { token } = req.body;
    if (token === ADMIN_TOKEN) {
        const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        
        let cookieOpts = `Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`;
        if (isSecure) cookieOpts += '; Secure';
        res.setHeader('Set-Cookie', [
            `admin_token=${token}; ${cookieOpts}`,
            `csrf_token=${crypto.randomBytes(16).toString('hex')}; Path=/; SameSite=Strict; Max-Age=86400${isSecure ? '; Secure' : ''}`
        ]);
        
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid Token' });
    }
});

app.get('/', (req, res) => {
    const cookies = parseCookies(req);
    const isAuthed = cookies.admin_token === ADMIN_TOKEN;

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Dashboard</title>
            <style>
                :root { --primary: #2563eb; --danger: #ef4444; --success: #10b981; --bg: #f3f4f6; --card: #ffffff; }
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; background: var(--bg); color: #1f2937; }
                .container { max-width: 1200px; margin: 0 auto; }
                .card { background: var(--card); padding: 1.5rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 2rem; }
                h1 { margin: 0 0 1.5rem 0; font-size: 1.5rem; }
                
                .tabs { display: flex; gap: 1rem; margin-bottom: 1.5rem; border-bottom: 1px solid #e5e7eb; }
                .tab { padding: 0.5rem 1rem; cursor: pointer; border-bottom: 2px solid transparent; color: #6b7280; }
                .tab.active { border-bottom-color: var(--primary); color: var(--primary); font-weight: 500; }
                
                table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
                th, td { text-align: left; padding: 0.75rem 1rem; border-bottom: 1px solid #e5e7eb; }
                th { background: #f9fafb; font-weight: 600; color: #374151; }
                tr:last-child td { border-bottom: none; }
                
                .badge { padding: 2px 6px; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
                .badge.pending { background: #fef3c7; color: #d97706; }
                .badge.approved { background: #d1fae5; color: #059669; }
                
                .btn { padding: 4px 10px; border: 1px solid transparent; border-radius: 4px; cursor: pointer; font-size: 0.75rem; margin-right: 4px; transition: all 0.2s; }
                .btn-primary { background: var(--primary); color: white; }
                .btn-danger { background: var(--danger); color: white; }
                .btn-success { background: var(--success); color: white; }
                .btn-outline { border-color: #d1d5db; background: white; color: #374151; }
                .btn:hover { opacity: 0.9; }

                .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; }
                .modal { background: white; padding: 2rem; border-radius: 8px; width: 400px; max-width: 90%; }
                .form-group { margin-bottom: 1rem; }
                .form-group label { display: block; margin-bottom: 0.5rem; font-size: 0.875rem; font-weight: 500; }
                .form-group input, .form-group select { width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 4px; box-sizing: border-box; }
                .modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.5rem; }

                .login-container { max-width: 400px; margin: 4rem auto; }
                .login-form { display: flex; flex-direction: column; gap: 1rem; }
            </style>
        </head>
        <body>
            <div id="app">
                ${!isAuthed ? `
                    <div class="container login-container">
                        <div class="card">
                            <h1>Admin Login</h1>
                            <div class="login-form">
                                <input type="password" id="admin-token" placeholder="Enter Admin Token" class="form-group" style="padding: 0.75rem; border: 1px solid #d1d5db; border-radius: 4px;">
                                <button class="btn btn-primary" onclick="login()" style="padding: 0.75rem; font-size: 1rem;">Login</button>
                                <p id="login-error" style="color: var(--danger); display: none;"></p>
                            </div>
                        </div>
                    </div>
                ` : `
                    <div class="container">
                        <div class="card">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <h1>Admin Dashboard</h1>
                                <button class="btn btn-outline" onclick="logout()">Logout</button>
                            </div>
                            <div class="tabs">
                                <div class="tab active" onclick="setTab('pending')">Pending Approvals <span id="pending-count" class="badge pending">0</span></div>
                                <div class="tab" onclick="setTab('all')">All Users</div>
                            </div>
                            <div id="content">Loading...</div>
                        </div>
                    </div>
                `}
            </div>

            <div id="edit-modal" class="modal-overlay">
                <div class="modal">
                    <h2 style="margin-top:0">Edit User</h2>
                    <input type="hidden" id="edit-id">
                    <div class="form-group">
                        <label>Username</label>
                        <input type="text" id="edit-username">
                    </div>
                    <div class="form-group">
                        <label>Storage Limit (GB)</label>
                        <input type="number" id="edit-limit" step="0.1">
                    </div>
                    <div class="form-group">
                        <label>Status</label>
                        <select id="edit-status">
                            <option value="pending">Pending</option>
                            <option value="approved">Approved</option>
                        </select>
                    </div>
                    <div class="modal-actions">
                        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
                        <button class="btn btn-primary" onclick="saveUser()">Save Changes</button>
                    </div>
                </div>
            </div>

            <script>
                const isAuthed = ${isAuthed};
                let users = [];
                let currentTab = 'pending';

                function getCookie(name) {
                    const value = `;
 ${document.cookie}`;
                    const parts = value.split(`;
 ${name}=`);
                    if (parts.length === 2) return parts.pop().split(';').shift();
                }

                async function login() {
                    const token = document.getElementById('admin-token').value;
                    const res = await fetch('/api/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token })
                    });
                    if (res.ok) {
                        location.reload();
                    } else {
                        document.getElementById('login-error').innerText = 'Invalid Token';
                        document.getElementById('login-error').style.display = 'block';
                    }
                }

                function logout() {
                    document.cookie = 'admin_token=; Max-Age=0; Path=/;';
                    document.cookie = 'csrf_token=; Max-Age=0; Path=/;';
                    location.reload();
                }

                async function apiCall(url, method = 'GET', body = null) {
                    const headers = { 'Content-Type': 'application/json' };
                    if (method !== 'GET') {
                        headers['X-CSRF-Token'] = getCookie('csrf_token');
                    }
                    
                    const opts = { method, headers };
                    if (body) opts.body = JSON.stringify(body);

                    const res = await fetch(url, opts);
                    if (res.status === 403) {
                        location.reload();
                        throw new Error('Forbidden');
                    }
                    return res.json();
                }

                async function fetchUsers() {
                    if (!isAuthed) return;
                    try {
                        users = await apiCall('/api/users');
                        render();
                    } catch(e) {}
                }

                function setTab(tab) {
                    currentTab = tab;
                    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                    document.querySelector(".tab[onclick=\"setTab('" + tab + "')\"]").classList.add('active');
                    render();
                }

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
                    const pendingBadge = document.getElementById('pending-count');
                    if(pendingBadge) pendingBadge.innerText = pendingUsers.length;

                    const filtered = currentTab === 'pending' ? pendingUsers : users;
                    const content = document.getElementById('content');
                    
                    if (filtered.length === 0) {
                        content.innerHTML = '<p style="color:#6b7280; text-align:center;">No users found.</p>';
                        return;
                    }

                    let html = '<table><thead><tr><th>ID</th><th>Username</th><th>Status</th><th>Storage</th><th>Usage</th><th>Online</th><th>Last Ping</th><th>Actions</th></tr></thead><tbody>';
                    
                    filtered.forEach(u => {
                        const usage = u.storage_used_gb ? u.storage_used_gb.toFixed(2) : '0.00';
                        const lastPing = u.last_ping_time ? new Date(u.last_ping_time * 1000).toLocaleString() : '-';
                        const online = u.total_online_minutes ? Math.floor(u.total_online_minutes / 60) + 'h ' + (u.total_online_minutes % 60) + 'm' : '0m';
                        
                        let actions = '';
                        if (u.status === 'pending') {
                            actions = '<button class="btn btn-success" onclick="act(' + u.id + ', \'approve\')">Approve</button>' +
                                      '<button class="btn btn-danger" onclick="act(' + u.id + ', \'reject\')">Reject</button>';
                        } else {
                            actions = '<button class="btn btn-outline" onclick="editUser(' + u.id + ')">Edit</button>' +
                                      '<button class="btn btn-danger" onclick="deleteUser(' + u.id + ')">Delete</button>';
                        }

                        html += '<tr>' +
                            '<td>' + u.id + '</td>' +
                            '<td>' + escapeHtml(u.username) + '</td>' +
                            '<td><span class="badge ' + escapeHtml(u.status) + '">' + escapeHtml(u.status) + '</span></td>' +
                            '<td>' + u.storage_limit_gb + ' GB</td>' +
                            '<td>' + usage + ' GB</td>' +
                            '<td>' + online + '</td>' +
                            '<td style="font-size:0.75rem">' + escapeHtml(lastPing) + '</td>' +
                            '<td>' + actions + '</td>' +
                        '</tr>';
                    });
                    html += '</tbody></table>';
                    content.innerHTML = html;
                }

                async function act(id, action) {
                    if(!confirm(action + ' user ' + id + '?')) return;
                    await apiCall('/api/' + action, 'POST', { id });
                    fetchUsers();
                }

                async function deleteUser(id) {
                    if(!confirm('Permanently delete user ' + id + '? This cannot be undone.')) return;
                    await apiCall('/api/delete', 'POST', { id });
                    fetchUsers();
                }

                function editUser(id) {
                    const user = users.find(u => u.id === id);
                    if (!user) return;
                    document.getElementById('edit-id').value = user.id;
                    document.getElementById('edit-username').value = user.username;
                    document.getElementById('edit-limit').value = user.storage_limit_gb;
                    document.getElementById('edit-status').value = user.status;
                    document.getElementById('edit-modal').style.display = 'flex';
                }

                function closeModal() {
                    document.getElementById('edit-modal').style.display = 'none';
                }

                async function saveUser() {
                    const id = document.getElementById('edit-id').value;
                    const username = document.getElementById('edit-username').value;
                    const limit = document.getElementById('edit-limit').value;
                    const status = document.getElementById('edit-status').value;

                    await apiCall('/api/update', 'POST', { id, username, storage_limit_gb: limit, status });
                    closeModal();
                    fetchUsers();
                }

                if (isAuthed) fetchUsers();
            </script>
        </body>
        </html>
    `);
});

app.use('/api', checkAuth);

app.get('/api/users', (req, res) => {
    db.all("SELECT * FROM users ORDER BY created_at DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/approve', (req, res) => {
    const { id } = req.body;
    db.run("UPDATE users SET status = 'approved' WHERE id = ?", [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.post('/api/reject', (req, res) => {
    const { id } = req.body;
    db.run("DELETE FROM users WHERE id = ?", [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.post('/api/delete', (req, res) => {
    const { id } = req.body;
    db.run("DELETE FROM users WHERE id = ?", [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.post('/api/update', (req, res) => {
    const { id, username, storage_limit_gb, status } = req.body;
    
    if (!['pending', 'approved'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }
    
    db.run(
        "UPDATE users SET username = ?, storage_limit_gb = ?, status = ? WHERE id = ?", 
        [username, parseFloat(storage_limit_gb), status, id], 
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

app.listen(PORT, () => {
    console.log("Admin tool running at http://localhost:" + PORT);
});
