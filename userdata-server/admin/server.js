const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3004;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
    console.error('FATAL: ADMIN_TOKEN environment variable is not set. Admin panel is disabled for security.');
    process.exit(1);
}

const pool = new Pool({
    host: process.env.USERDATA_DB_HOST || 'localhost',
    port: parseInt(process.env.USERDATA_DB_PORT) || 5432,
    database: process.env.USERDATA_DB_NAME || 'freestorage_userdata',
    user: process.env.USERDATA_DB_USER || 'postgres',
    password: process.env.USERDATA_DB_PASSWORD || 'postgres',
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const parseCookies = (req) => {
    const list = {};
    const rc = req.headers.cookie;
    rc && rc.split(';').forEach(function (cookie) {
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

app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/approve', async (req, res) => {
    const { id } = req.body;
    try {
        await pool.query("UPDATE users SET status = 'approved' WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/reject', async (req, res) => {
    const { id } = req.body;
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/delete', async (req, res) => {
    const { id } = req.body;
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/update', async (req, res) => {
    const { id, username, storage_limit_gb, status } = req.body;

    if (!['pending', 'approved'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    try {
        await pool.query(
            'UPDATE users SET username = $1, storage_limit_gb = $2, status = $3 WHERE id = $4',
            [username, parseFloat(storage_limit_gb), status, id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log('Admin tool running at http://localhost:' + PORT);
});
