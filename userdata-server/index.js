const express = require('express');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const fs = require('fs');
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
const DB_PATH = process.env.DB_PATH || './data/userdata.db';
const db = new sqlite3.Database(DB_PATH);

db.run('PRAGMA journal_mode=WAL;');

app.use(express.json());

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (origin.endsWith('.cns-studios.com') || origin.includes('localhost'))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        log('WARN', req, `Registration failed: Missing fields`);
        return res.status(400).json({ error: 'Missing fields' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const encryptionKey = crypto.randomBytes(32).toString('hex');
        const peerSecret = crypto.randomBytes(32).toString('hex');
        
        db.run(
            'INSERT INTO users (username, password_hash, encryption_key_encrypted, peer_secret, status) VALUES (?, ?, ?, ?, ?)',
            [username, passwordHash, encryptionKey, peerSecret, 'pending'],
            function(err) {
                if (err) {
                    log('ERROR', req, `Registration failed for ${username}: ${err.message}`);
                    return res.status(400).json({ error: 'Username exists or other error' });
                }
                
                log('INFO', req, `New user registered (Pending Approval): ${username} (ID: ${this.lastID})`);
                res.json({ message: 'Registration successful. Account pending admin approval.' });
            }
        );
    } catch (e) {
        log('ERROR', req, `Registration exception: ${e.message}`);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err) {
            log('ERROR', req, `Login db error: ${err.message}`);
            return res.status(500).json({ error: 'Db error' });
        }
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
    });
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

app.post('/sync-contribution', (req, res) => {
    const { userId, chunksStored, apiKey } = req.body;
    if (apiKey !== INTERNAL_API_KEY) return res.status(403).json({ error: 'Unauthorized' });
    
    db.run('UPDATE users SET chunks_stored = ? WHERE id = ?', [chunksStored, userId], (err) => {
        if (err) return res.status(500).json({ error: 'Db error' });
        res.json({ success: true });
    });
});

app.post('/ping', authenticateToken, (req, res) => {
    const userId = req.userId;
    const now = Math.floor(Date.now() / 1000);
    
    db.get('SELECT last_ping_time FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            log('ERROR', req, `Ping db error for user ${userId}`);
            return res.status(500).json({ error: 'Db error' });
        }
        
        if (user.last_ping_time && (now - user.last_ping_time) < 290) {
            log('WARN', req, `Ping rate limit exceeded for user ${userId}`);
            return res.status(429).json({ error: 'Ping rate limit exceeded. Please wait.' });
        }

        db.run('INSERT INTO ping_logs (user_id, ping_time) VALUES (?, ?)', [userId, now], (err) => {
            if (err) {
                log('ERROR', req, `Failed to log ping for user ${userId}`);
                return res.status(500).json({ error: 'Failed to log ping' });
            }

            db.all(
                'SELECT ping_time FROM ping_logs WHERE user_id = ?',
                [userId],
                (err, pings) => {
                    if (err) return res.status(500).json({ error: 'Db error' });

                    const totalMinutes = pings.length * 5;
                    log('DEBUG', req, `Ping received from UserID: ${userId}. Total Uptime: ${totalMinutes} mins`);
                    
                    db.run(
                        'UPDATE users SET total_online_minutes = ?, last_ping_time = ? WHERE id = ?',
                        [totalMinutes, now, userId],
                        (err) => {
                            if (err) log('ERROR', req, `Update user stats failed: ${err.message}`);
                        }
                    );
                    
                    db.get('SELECT chunks_stored FROM users WHERE id = ?', [userId], (err, userStats) => {
                        if (totalMinutes >= 4320) {
                            if (userStats && userStats.chunks_stored >= 100) {
                                db.run(
                                    'UPDATE users SET storage_limit_gb = storage_limit_gb + 1, total_online_minutes = 0 WHERE id = ?',
                                    [userId]
                                );
                                db.run('DELETE FROM ping_logs WHERE user_id = ?', [userId]);
                                log('INFO', req, `UserID: ${userId} earned +1GB storage for 72h uptime and 100+ chunks!`);
                                res.json({ message: 'Ping recorded. +1GB storage earned!', newLimit: true });
                            } else {
                                log('WARN', req, `UserID: ${userId} reached uptime goal but lacks chunks_stored proof.`);
                                res.json({ message: 'Ping recorded. Uptime goal reached, but more chunks must be stored to earn reward.', totalMinutes });
                            }
                        } else {
                            res.json({ message: 'Ping recorded', totalMinutes });
                        }
                    });
                }
            );
        });
    });
});

app.put('/user', authenticateToken, async (req, res) => {
    const { username, password } = req.body;
    const userId = req.userId;

    try {
        const updates = [];
        const values = [];

        if (username) {
            updates.push('username = ?');
            values.push(username);
        }

        if (password) {
            const hash = await bcrypt.hash(password, 10);
            updates.push('password_hash = ?');
            values.push(hash);
        }

        if (updates.length === 0) return res.json({ success: true });

        values.push(userId);
        db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values, function(err) {
            if (err) {
                log('ERROR', req, `Account update failed for user ${userId}: ${err.message}`);
                return res.status(500).json({ error: 'Update failed (Username might be taken)' });
            }
            log('INFO', req, `Account updated for user ${userId}`);
            res.json({ success: true });
        });
    } catch (e) {
        log('ERROR', req, `Account update exception: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/user', authenticateToken, (req, res) => {
    const userId = req.userId;
    db.run('DELETE FROM ping_logs WHERE user_id = ?', [userId]);
    db.run('DELETE FROM users WHERE id = ?', [userId], (err) => {
        if (err) {
            log('ERROR', req, `Account deletion failed for user ${userId}`);
            return res.status(500).json({ error: 'Db error' });
        }
        log('WARN', req, `Account deleted for user ${userId}`);
        res.json({ success: true });
    });
});

app.post('/update-storage', (req, res) => {
    const { userId, addGb, apiKey } = req.body;
    if (apiKey !== INTERNAL_API_KEY) {
        log('WARN', req, 'Unauthorized storage update attempt');
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    db.run(
        'UPDATE users SET storage_used_gb = storage_used_gb + ? WHERE id = ?',
        [addGb, userId],
        (err) => {
            if (err) {
                log('ERROR', req, `Storage update failed for user ${userId}`);
                return res.status(500).json({ error: 'Db error' });
            }
            log('INFO', req, `Updated usage for UserID: ${userId}. Added: ${addGb} GB`);
            res.json({ success: true });
        }
    );
});

app.get('/profile', authenticateToken, (req, res) => {
    db.get('SELECT storage_limit_gb, storage_used_gb, total_online_minutes, chunks_stored FROM users WHERE id = ?', [req.userId], (err, user) => {
        if (err) {
            log('ERROR', req, `Profile fetch db error for user ${req.userId}`);
            return res.status(500).json({ error: 'Db error' });
        }
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => log('INFO', null, `Userdata server running on port ${PORT}`));
