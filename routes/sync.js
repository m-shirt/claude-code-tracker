const express    = require('express');
const { execFile } = require('child_process');
const { db, compress, decompress } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const MAX_BYTES = 60 * 1024 * 1024; // 60 MB

router.post('/', requireAuth, (req, res) => {
  const { version, stats, history, sessions } = req.body || {};
  if (!stats || !Array.isArray(history) || !Array.isArray(sessions)) {
    return res.status(400).json({ error: 'Required fields: stats (object), history (array), sessions (array)' });
  }

  const rawSize = Buffer.byteLength(JSON.stringify(req.body));
  if (rawSize > MAX_BYTES) {
    return res.status(413).json({
      error: `Payload too large (${(rawSize / 1e6).toFixed(1)} MB). Run with --max-sessions to reduce.`
    });
  }

  const statsBlob    = compress(stats);
  const historyBlob  = compress(history);
  const sessionsBlob = compress(sessions);

  const now    = Date.now();
  const userId = req.user.id;
  const existing = db.prepare('SELECT sync_count FROM user_data WHERE user_id = ?').get(userId);
  const syncCount = existing ? existing.sync_count + 1 : 1;

  // Verify user exists before inserting
  const userExists = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!userExists) {
    return res.status(401).json({ error: 'User not found. Please register on the web app first, then use that token.' });
  }

  try {
    db.prepare(`
      INSERT INTO user_data (user_id, stats_cache, history, sessions, raw_size_bytes, synced_at, sync_count, client_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        stats_cache    = excluded.stats_cache,
        history        = excluded.history,
        sessions       = excluded.sessions,
        raw_size_bytes = excluded.raw_size_bytes,
        synced_at      = excluded.synced_at,
        sync_count     = excluded.sync_count,
        client_version = excluded.client_version
    `).run(userId, statsBlob, historyBlob, sessionsBlob, rawSize, now, syncCount, version || '1.0.0');
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  res.json({ ok: true, syncedAt: now, sessionCount: sessions.length, rawSizeBytes: rawSize });
});

router.get('/status', requireAuth, (req, res) => {
  const row = db.prepare(
    'SELECT synced_at, sync_count, raw_size_bytes, sessions FROM user_data WHERE user_id = ?'
  ).get(req.user.id);
  if (!row) return res.json({ syncedAt: null, syncCount: 0, rawSizeBytes: 0, sessionCount: 0 });

  let sessionCount = 0;
  try {
    const sessions = decompress(row.sessions);
    sessionCount = Array.isArray(sessions) ? sessions.length : 0;
  } catch {}

  res.json({
    syncedAt:      row.synced_at,
    syncCount:     row.sync_count,
    rawSizeBytes:  row.raw_size_bytes,
    sessionCount
  });
});

router.delete('/data', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM user_data WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/open-terminal', requireAuth, (req, res) => {
  const { token } = req.body;
  if (!token || !/^[A-Za-z0-9_\-.]+$/.test(token)) {
    return res.status(400).json({ error: 'Invalid token' });
  }

  const PORT   = process.env.PORT || 3456;
  const baseUrl = `http://localhost:${PORT}`;
  const cmd     = `curl -fsSL ${baseUrl}/sync-client.js | node - --url ${baseUrl} --token ${token}`;

  const script = [
    'tell application "System Events"',
    '  set termRunning to (name of processes) contains "iTerm2"',
    'end tell',
    'if termRunning then',
    '  tell application "iTerm2"',
    '    activate',
    '    set newWin to (create window with default profile)',
    `    tell current session of newWin to write text "${cmd}"`,
    '  end tell',
    'else',
    '  tell application "Terminal"',
    `    do script "${cmd}"`,
    '    activate',
    '  end tell',
    'end if'
  ].join('\n');

  execFile('osascript', ['-e', script], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

module.exports = router;
