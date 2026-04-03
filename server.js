const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3456;

if (!process.env.JWT_SECRET) {
  console.warn('\x1b[33mWARNING: JWT_SECRET not set — using insecure default. Set it before deploying!\x1b[0m');
}

app.use(cors());
app.use(express.json({ limit: '65mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/auth',  require('./routes/auth'));
app.use('/api/sync',  require('./routes/sync'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api',       require('./routes/data'));

// Public demo hint (no auth — used by login page)
app.get('/api/demo-hint', (_req, res) => {
  try {
    const { db } = require('./db');
    const n = db.prepare("SELECT COUNT(*) as n FROM users WHERE email LIKE '%@demo.com'").get().n;
    res.json({ isDemo: n > 0 });
  } catch { res.json({ isDemo: false }); }
});

// SPA entry points — named routes restore the correct view on refresh
const APP_HTML = path.join(__dirname, 'public', 'app.html');
['/app', '/projects', '/conversations', '/prompts', '/sync', '/users', '/database'].forEach(r => {
  app.get(r, (_req, res) => res.sendFile(APP_HTML));
});
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Code Tracker v2 — http://localhost:${PORT}`);
});
