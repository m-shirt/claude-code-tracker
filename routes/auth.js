const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  // First registered user becomes admin
  const { count } = db.prepare('SELECT COUNT(*) as count FROM users').get();
  const role = count === 0 ? 'admin' : 'user';

  try {
    const hash = await bcrypt.hash(password, 12);
    const displayName = (name || '').trim() || email.split('@')[0];
    const result = db.prepare(
      'INSERT INTO users (email, password_hash, role, name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(email, hash, role, displayName, Date.now());

    const user = { id: result.lastInsertRowid, email, role, name: displayName };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), user.id);

  const payload = { id: user.id, email: user.email, role: user.role, name: user.name || user.email.split('@')[0] };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: payload });
});

module.exports = router;
