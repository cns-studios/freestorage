const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8087;
const USERDATA_SERVER_URL = process.env.USERDATA_SERVER_URL || 'http://localhost:8086';

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Mock download link for the app
const APP_DOWNLOAD_LINK = 'https://github.com/user/freestorage/releases/latest';

app.get('/download-app', (req, res) => {
    res.redirect(APP_DOWNLOAD_LINK);
});

// Proxy login to userdata-server and set cookies
app.post('/api/login', async (req, res) => {
    try {
        const response = await fetch(`${USERDATA_SERVER_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        const data = await response.json();
        
        if (data.token) {
            // Set cookies for 7 days
            res.cookie('token', data.token, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: false });
            res.cookie('userId', data.userId, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: false });
            res.cookie('encryptionKey', data.encryptionKey, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: false });
            res.cookie('peerSecret', data.peerSecret, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: false });
            res.cookie('username', req.body.username, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: false });
            return res.json({ success: true, data });
        }
        res.status(401).json({ error: data.error || 'Login failed' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.clearCookie('userId');
    res.clearCookie('encryptionKey');
    res.clearCookie('peerSecret');
    res.clearCookie('username');
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`Web host running at http://localhost:${PORT}`);
});
