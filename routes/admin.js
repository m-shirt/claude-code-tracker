const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, decompress } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tracker.db');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/users', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.created_at, u.last_seen_at,
           ud.synced_at, ud.raw_size_bytes, ud.sync_count
    FROM users u
    LEFT JOIN user_data ud ON u.id = ud.user_id
    ORDER BY COALESCE(ud.synced_at, 0) DESC
  `).all();

  const result = users.map(u => {
    let sessionCount = 0;
    let projectCount = 0;
    if (u.synced_at) {
      try {
        const row = db.prepare('SELECT sessions FROM user_data WHERE user_id = ?').get(u.id);
        const sessions = decompress(row?.sessions);
        if (Array.isArray(sessions)) {
          sessionCount = sessions.length;
          projectCount = new Set(sessions.map(s => s.projectId)).size;
        }
      } catch {}
    }
    return { ...u, sessionCount, projectCount };
  });

  res.json(result);
});

router.patch('/users/:id/role', (req, res) => {
  const { role } = req.body || {};
  if (!['admin', 'user'].includes(role)) {
    return res.status(400).json({ error: 'Role must be "admin" or "user"' });
  }
  const info = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

const PROTECTED_EMAILS = ['admin@claude-code-tracker.com', 'user@claude-code-tracker.com'];

router.delete('/users/:id', (req, res) => {
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const target = db.prepare('SELECT email FROM users WHERE id = ?').get(req.params.id);
  if (target && PROTECTED_EMAILS.includes(target.email)) {
    return res.status(400).json({ error: 'This account is protected and cannot be deleted' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.delete('/users/:id/data', (req, res) => {
  db.prepare('DELETE FROM user_data WHERE user_id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Database Management ──────────────────────────────────────────────────────

router.get('/db/stats', (req, res) => {
  try {
    // File size
    let fileSizeBytes = 0;
    let walSizeBytes = 0;
    try { fileSizeBytes = fs.statSync(DB_PATH).size; } catch {}
    try { walSizeBytes = fs.statSync(DB_PATH + '-wal').size; } catch {}

    // Row counts
    const userCount     = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
    const dataCount     = db.prepare('SELECT COUNT(*) as n FROM user_data').get().n;
    const syncedCount   = db.prepare('SELECT COUNT(*) as n FROM user_data WHERE synced_at IS NOT NULL').get().n;
    const totalSyncRuns = db.prepare('SELECT SUM(sync_count) as n FROM user_data').get().n || 0;
    const totalRawBytes = db.prepare('SELECT SUM(raw_size_bytes) as n FROM user_data').get().n || 0;

    // SQLite page info
    const pageSize  = db.pragma('page_size',  { simple: true });
    const pageCount = db.pragma('page_count', { simple: true });
    const freePages = db.pragma('freelist_count', { simple: true });

    res.json({
      fileSizeBytes,
      walSizeBytes,
      userCount,
      dataCount,
      syncedCount,
      totalSyncRuns,
      totalRawBytes,
      pageSize,
      pageCount,
      freePages,
      usedPages: pageCount - freePages,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/db/vacuum', (req, res) => {
  try {
    db.exec('VACUUM');
    res.json({ ok: true, message: 'VACUUM completed — database has been compacted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/db/backup', (req, res) => {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return res.status(404).json({ error: 'Database file not found' });
    }
    // Checkpoint WAL into the main file before sending
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}

    const stat = fs.statSync(DB_PATH);
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="tracker-backup-${ts}.db"`);
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(DB_PATH).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/db/restore', express.raw({ type: 'application/octet-stream', limit: '200mb' }), (req, res) => {
  try {
    const buf = req.body;
    if (!buf || buf.length < 16) {
      return res.status(400).json({ error: 'Empty or too-small file' });
    }

    // Validate SQLite magic bytes: first 16 bytes = "SQLite format 3\x00"
    const magic = Buffer.from('SQLite format 3\x00');
    if (!buf.slice(0, 16).equals(magic)) {
      return res.status(400).json({ error: 'Not a valid SQLite database file' });
    }

    const tempPath = DB_PATH + '.restore';
    const backupPath = DB_PATH + '.bak';

    // Write uploaded file to temp path first
    fs.writeFileSync(tempPath, buf);

    // Checkpoint WAL, close current db, swap files
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    db.close();

    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, backupPath);
    fs.renameSync(tempPath, DB_PATH);

    res.json({ ok: true, message: 'Database restored successfully. Server is restarting…' });

    // Restart so all routes get a fresh db connection
    setImmediate(() => process.exit(0));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Demo Mode ────────────────────────────────────────────────────────────────

router.get('/demo/status', (req, res) => {
  const n = db.prepare("SELECT COUNT(*) as n FROM users WHERE email LIKE '%@demo.com'").get().n;
  res.json({ isDemo: n > 0, demoUserCount: n });
});

router.post('/demo/seed', (req, res) => {
  if (process.env.DISABLE_DEMO_MODE === 'true') return res.status(403).json({ error: 'Disabled on this instance.' });
  try {
    const { seedDemo } = require('../scripts/seed-demo');
    const force  = req.body?.force === true;
    const result = seedDemo(force);
    if (result.skipped) return res.json({ ok: true, skipped: true, count: result.count });
    res.json({ ok: true, skipped: false, count: result.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/demo/reset', (req, res) => {
  if (process.env.DISABLE_DEMO_MODE === 'true') return res.status(403).json({ error: 'Disabled on this instance.' });
  try {
    db.exec('DELETE FROM user_data; DELETE FROM users;');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
