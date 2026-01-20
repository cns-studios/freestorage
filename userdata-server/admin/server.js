const express = require('express');
const sqlite3 = require('sqlite3');
const crypto = require('crypto');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3004;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/userdata.db');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
    console.error("FATAL: ADMIN_TOKEN environment variable is not set. Admin panel is disabled for security.");
    process.exit(1);
}

const db = new sqlite3.Database(DB_PATH);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/auth-status', (req, res) => {
    const cookies = parseCookies(req);
    res.json({ isAuthed: cookies.admin_token === ADMIN_TOKEN });
});

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
