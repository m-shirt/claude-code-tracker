// Load .env if present (no crash if missing)
const fs = require('fs');
if (fs.existsSync(require('path').join(__dirname, '.env'))) {
  fs.readFileSync(require('path').join(__dirname, '.env'), 'utf8')
    .split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx === -1) return;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = val;
    });
}

// Defaults (applied when not set via .env or environment)
process.env.DISABLE_DEMO_MODE = process.env.DISABLE_DEMO_MODE ?? 'true';
process.env.DISABLE_DEMO_WIPE = process.env.DISABLE_DEMO_WIPE ?? 'false';

// Auto-generate JWT_SECRET if not set and persist it to .env
if (!process.env.JWT_SECRET) {
  const secret = require('crypto').randomBytes(48).toString('hex');
  process.env.JWT_SECRET = secret;
  const envPath = require('path').join(__dirname, '.env');
  const entry   = `JWT_SECRET=${secret}\n`;
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    if (!content.includes('JWT_SECRET=')) fs.appendFileSync(envPath, entry);
  } else {
    fs.writeFileSync(envPath, entry);
  }
  console.log('\x1b[32mJWT_SECRET generated and saved to .env\x1b[0m');
}

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3456;

app.use(cors());
app.use(express.json({ limit: '65mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/auth',  require('./routes/auth'));
app.use('/api/sync',  require('./routes/sync'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api',       require('./routes/data'));

// Setup status — no auth required
app.get('/api/setup/status', (_req, res) => {
  try {
    const { db } = require('./db');
    const { count } = db.prepare('SELECT COUNT(*) as count FROM users').get();
    res.json({ needed: count === 0 });
  } catch { res.json({ needed: false }); }
});

// Public demo hint (no auth — used by login page)
app.get('/api/demo-hint', (_req, res) => {
  try {
    const { db } = require('./db');
    const n = db.prepare("SELECT COUNT(*) as n FROM users WHERE email LIKE '%@demo.com'").get().n;
    res.json({ isDemo: n > 0 });
  } catch { res.json({ isDemo: false }); }
});

// SPA entry points — named routes restore the correct view on refresh
const APP_HTML   = path.join(__dirname, 'public', 'app.html');
const SETUP_HTML = path.join(__dirname, 'public', 'setup.html');
const LOGIN_HTML = path.join(__dirname, 'public', 'login.html');

app.get('/setup', (_req, res) => res.sendFile(SETUP_HTML));

['/app', '/projects', '/conversations', '/prompts', '/sync', '/users', '/database'].forEach(r => {
  app.get(r, (_req, res) => res.sendFile(APP_HTML));
});
app.get('/', (_req, res) => {
  try {
    const { db } = require('./db');
    const { count } = db.prepare('SELECT COUNT(*) as count FROM users').get();
    if (count === 0) return res.redirect('/setup');
  } catch {}
  res.sendFile(LOGIN_HTML);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Code Tracker v2 — http://localhost:${PORT}`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} in use — killing existing process and retrying…`);
    const { execSync } = require('child_process');
    try {
      execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null || true`, { shell: true });
    } catch {}
    setTimeout(() => server.listen(PORT, '0.0.0.0'), 1000);
  } else {
    throw err;
  }
});
