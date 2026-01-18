const express = require('express');
const sqlite3 = require('sqlite3');
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

// Middleware to check admin token
const checkToken = (req, res, next) => {
    if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
        return res.status(403).send('Forbidden');
    }
    next();
};

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Approval</title>
            <style>
                body { font-family: sans-serif; padding: 2rem; background: #f0f0f0; }
                .container { max-width: 800px; margin: 0 auto; background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
                table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
                th, td { text-align: left; padding: 10px; border-bottom: 1px solid #ddd; }
                th { background: #fafafa; }
                .btn { padding: 5px 10px; border: none; border-radius: 4px; cursor: pointer; color: white; margin-right: 5px; }
                .approve { background: #10b981; }
                .reject { background: #ef4444; }
                h1 { margin-top: 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Pending User Approvals</h1>
                <div id="list">Loading...</div>
            </div>
            <script>
                const ADMIN_TOKEN = prompt('Enter Admin Token');
                async function load() {
                    const res = await fetch('/api/users', {
                        headers: { 'X-Admin-Token': ADMIN_TOKEN }
                    });
                    if (res.status === 403) {
                        alert('Invalid Token');
                        return;
                    }
                    const users = await res.json();
                    const list = document.getElementById('list');
                    if (users.length === 0) {
                        list.innerHTML = '<p>No pending users.</p>';
                        return;
                    }
                    let html = '<table><thead><tr><th>ID</th><th>Username</th><th>Registered</th><th>Actions</th></tr></thead><tbody>';
                    users.forEach(u => {
                        html += \`<tr>
                            <td>\${u.id}</td>
                            <td>\${u.username}</td>
                            <td>\${new Date(u.created_at * 1000).toLocaleString()}</td>
                            <td>
                                <button class="btn approve" onclick="act(\${u.id}, 'approve')">Approve</button>
                                <button class="btn reject" onclick="act(\${u.id}, 'reject')">Reject</button>
                            </td>
                        </tr>\`;
                    });
                    html += '</tbody></table>';
                    list.innerHTML = html;
                }
                
                async function act(id, action) {
                    if(!confirm(action + ' user ' + id + '?')) return;
                    await fetch('/api/' + action, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Admin-Token': ADMIN_TOKEN
                        },
                        body: JSON.stringify({ id })
                    });
                    load();
                }
                load();
            </script>
        </body>
        </html>
    `);
});

app.get('/api/users', checkToken, (req, res) => {
    db.all("SELECT id, username, created_at FROM users WHERE status = 'pending'", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/approve', checkToken, (req, res) => {
    const { id } = req.body;
    db.run("UPDATE users SET status = 'approved' WHERE id = ?", [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.post('/api/reject', checkToken, (req, res) => {
    const { id } = req.body;
    db.run("DELETE FROM users WHERE id = ?", [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.listen(PORT, () => {
    console.log("Admin tool running at http://localhost:" + PORT);
});