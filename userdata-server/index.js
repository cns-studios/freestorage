const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();

const pool = new Pool({
    host: process.env.USERDATA_DB_HOST || 'localhost',
    port: parseInt(process.env.USERDATA_DB_PORT) || 5432,
    database: process.env.USERDATA_DB_NAME || 'freestorage_userdata',
    user: process.env.USERDATA_DB_USER || 'postgres',
    password: process.env.USERDATA_DB_PASSWORD || 'postgres',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});

app.use(express.json());

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (origin.endsWith('cns-studios.com') || origin.includes('localhost'))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

const SECRET_KEY = process.env.SECRET_KEY || 'YOUR_SUPER_SECRET_KEY';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'YOUR_INTERNAL_SERVICE_KEY';

function getIp(req) {
    return req.ip || req.connection.remoteAddress || 'unknown';
}

function log(level, req, message) {
    const timestamp = new Date().toISOString();
    const ip = req ? getIp(req) : 'SYSTEM';
    console.log(`[${timestamp}] [${level}] [${ip}] ${message}`);
}

app.use((req, res, next) => {
    log('INFO', req, `${req.method} ${req.url}`);
    next();
});

app.get('/health', async (req, res) => {
    const health = {
        status: 'healthy',
        timestamp: Date.now(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    };

    try {
        const start = Date.now();
        const result = await pool.query('SELECT 1 as check');
        health.database = {
            status: 'connected',
            latencyMs: Date.now() - start
        };
    } catch (err) {
        health.status = 'unhealthy';
        health.database = {
            status: 'disconnected',
            error: err.message
        };
    }

    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        log('WARN', req, 'Registration failed: Missing fields');
        return res.status(400).json({ error: 'Missing fields' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const encryptionKey = crypto.randomBytes(32).toString('hex');
        const peerSecret = crypto.randomBytes(32).toString('hex');

        const result = await pool.query(
            `INSERT INTO users (username, password_hash, encryption_key_encrypted, peer_secret, status)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [username, passwordHash, encryptionKey, peerSecret, 'pending']
        );

        log('INFO', req, `New user registered (Pending Approval): ${username} (ID: ${result.rows[0].id})`);
        res.json({ message: 'Registration successful. Account pending admin approval.' });
    } catch (err) {
        log('ERROR', req, `Registration failed for ${username}: ${err.message}`);
        res.status(400).json({ error: 'Username exists or other error' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];

        if (!user) {
            log('WARN', req, `Login failed: User not found (${username})`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            log('WARN', req, `Login failed: Invalid password for ${username}`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (user.status !== 'approved') {
            log('WARN', req, `Login failed: Account pending approval for ${username}`);
            return res.status(403).json({ error: 'Account pending admin approval.' });
        }

        const token = jwt.sign({ userId: user.id }, SECRET_KEY);
        log('INFO', req, `User logged in: ${username} (ID: ${user.id})`);
        res.json({
            token,
            userId: user.id,
            encryptionKey: user.encryption_key_encrypted,
            peerSecret: user.peer_secret,
            storageLimitGb: user.storage_limit_gb,
            storageUsedGb: user.storage_used_gb
        });
    } catch (err) {
        log('ERROR', req, `Login db error: ${err.message}`);
        res.status(500).json({ error: 'Db error' });
    }
});

function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) {
        log('WARN', req, 'Auth failed: No token');
        return res.status(401).json({ error: 'No token' });
    }

    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) {
            log('WARN', req, 'Auth failed: Invalid token');
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.userId = decoded.userId;
        next();
    });
}

app.post('/sync-contribution', async (req, res) => {
    const { userId, chunksStored, apiKey } = req.body;
    if (apiKey !== INTERNAL_API_KEY) return res.status(403).json({ error: 'Unauthorized' });

    try {
        await pool.query('UPDATE users SET chunks_stored = $1 WHERE id = $2', [chunksStored, userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Db error' });
    }
});

app.post('/ping', authenticateToken, async (req, res) => {
    const userId = req.userId;
    const now = Math.floor(Date.now() / 1000);

    try {
        const userResult = await pool.query('SELECT last_ping_time, total_online_minutes, chunks_stored FROM users WHERE id = $1', [userId]);
        const user = userResult.rows[0];

        if (!user) {
            log('ERROR', req, `Ping db error for user ${userId}`);
            return res.status(500).json({ error: 'Db error' });
        }

        if (user.last_ping_time && (now - user.last_ping_time) < 290) {
            log('WARN', req, `Ping rate limit exceeded for user ${userId}`);
            return res.status(429).json({ error: 'Ping rate limit exceeded. Please wait.' });
        }

        const newTotalMinutes = user.total_online_minutes + 5;

        await pool.query(
            'UPDATE users SET total_online_minutes = $1, last_ping_time = $2 WHERE id = $3',
            [newTotalMinutes, now, userId]
        );

        log('DEBUG', req, `Ping received from UserID: ${userId}. Total Uptime: ${newTotalMinutes} mins`);

        if (newTotalMinutes >= 4320) {
            if (user.chunks_stored >= 100) {
                await pool.query(
                    'UPDATE users SET storage_limit_gb = storage_limit_gb + 1, total_online_minutes = 0 WHERE id = $1',
                    [userId]
                );
                log('INFO', req, `UserID: ${userId} earned +1GB storage for 72h uptime and 100+ chunks!`);
                return res.json({ message: 'Ping recorded. +1GB storage earned!', newLimit: true });
            } else {
                log('WARN', req, `UserID: ${userId} reached uptime goal but lacks chunks_stored proof.`);
                return res.json({ message: 'Ping recorded. Uptime goal reached, but more chunks must be stored to earn reward.', totalMinutes: newTotalMinutes });
            }
        }

        res.json({ message: 'Ping recorded', totalMinutes: newTotalMinutes });
    } catch (err) {
        log('ERROR', req, `Ping error: ${err.message}`);
        res.status(500).json({ error: 'Db error' });
    }
});

app.put('/user', authenticateToken, async (req, res) => {
    const { username, password } = req.body;
    const userId = req.userId;

    try {
        const updates = [];
        const values = [];
        let paramIndex = 1;

        if (username) {
            updates.push(`username = $${paramIndex++}`);
            values.push(username);
        }

        if (password) {
            const hash = await bcrypt.hash(password, 10);
            updates.push(`password_hash = $${paramIndex++}`);
            values.push(hash);
        }

        if (updates.length === 0) return res.json({ success: true });

        values.push(userId);
        await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}`, values);

        log('INFO', req, `Account updated for user ${userId}`);
        res.json({ success: true });
    } catch (err) {
        log('ERROR', req, `Account update failed for user ${userId}: ${err.message}`);
        res.status(500).json({ error: 'Update failed (Username might be taken)' });
    }
});

app.delete('/user', authenticateToken, async (req, res) => {
    const userId = req.userId;

    try {
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        log('WARN', req, `Account deleted for user ${userId}`);
        res.json({ success: true });
    } catch (err) {
        log('ERROR', req, `Account deletion failed for user ${userId}`);
        res.status(500).json({ error: 'Db error' });
    }
});

app.post('/reset-storage', async (req, res) => {
    const { userId, apiKey } = req.body;
    if (apiKey !== INTERNAL_API_KEY) return res.status(403).json({ error: 'Unauthorized' });

    try {
        await pool.query('UPDATE users SET storage_used_gb = 0 WHERE id = $1', [userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Db error' });
    }
});

app.post('/update-storage', async (req, res) => {
    const { userId, addGb, apiKey } = req.body;
    if (apiKey !== INTERNAL_API_KEY) {
        log('WARN', req, 'Unauthorized storage update attempt');
        return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
        await pool.query(
            'UPDATE users SET storage_used_gb = storage_used_gb + $1 WHERE id = $2',
            [addGb, userId]
        );
        log('INFO', req, `Updated usage for UserID: ${userId}. Added: ${addGb} GB`);
        res.json({ success: true });
    } catch (err) {
        log('ERROR', req, `Storage update failed for user ${userId}`);
        res.status(500).json({ error: 'Db error' });
    }
});

app.get('/profile', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT storage_limit_gb, storage_used_gb, total_online_minutes, chunks_stored FROM users WHERE id = $1',
            [req.userId]
        );
        const user = result.rows[0];

        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    } catch (err) {
        log('ERROR', req, `Profile fetch db error for user ${req.userId}`);
        res.status(500).json({ error: 'Db error' });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => log('INFO', null, `Userdata server running on port ${PORT}`));
