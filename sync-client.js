#!/usr/bin/env node
/**
 * Claude Code Tracker — Sync Client v1.0.0
 *
 * Reads ~/.claude/ on this machine and uploads data to the tracker server.
 *
 * Usage:
 *   node sync-client.js --url https://your-server.com --token YOUR_JWT_TOKEN
 *
 * Options:
 *   --url           Server URL (required, or set TRACKER_URL env var)
 *   --token         JWT token from login (required, or set TRACKER_TOKEN env var)
 *   --max-sessions  Max sessions to include per project (default: unlimited)
 *   --dry-run       Show stats without uploading
 *   --claude-dir    Path to Claude data dir (default: ~/.claude)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');
const http  = require('http');

const VERSION = '1.0.0';

// ── Parse args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}
const isDryRun    = args.includes('--dry-run');
const serverUrl   = getArg('--url')          || process.env.TRACKER_URL;
const token       = getArg('--token')        || process.env.TRACKER_TOKEN;
const maxSessions = parseInt(getArg('--max-sessions')) || Infinity;
const claudeDir   = getArg('--claude-dir')   || path.join(os.homedir(), '.claude');

if (!isDryRun && !serverUrl) {
  console.error('Error: --url is required (or set TRACKER_URL env var)');
  console.error('Usage: node sync-client.js --url https://your-server.com --token YOUR_TOKEN');
  process.exit(1);
}
if (!isDryRun && !token) {
  console.error('Error: --token is required (or set TRACKER_TOKEN env var)');
  console.error('Get your token by logging into the tracker web app > Sync page');
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function projectDisplayName(dirName) {
  const homeDir = os.homedir();
  // Convert -Users-username-Desktop-... → ~/Desktop/...
  const withSlashes = dirName.replace(/-/g, '/');
  // Try to replace leading /Users/xxx or /home/xxx with ~
  return withSlashes.replace(new RegExp(`^${homeDir.replace(/\//g, '/')}/?`), '~/') || withSlashes;
}

function buildSession(projectDir, projectId, file) {
  const filePath = path.join(projectDir, file);
  const lines    = readJsonl(filePath);
  const msgs     = lines.filter(l => l.type === 'user' || l.type === 'assistant' || l.type === 'summary');
  const userMsgs = lines.filter(l => l.type === 'user');
  const sessionId = file.replace('.jsonl', '');

  const timestamps = msgs.map(m => m.timestamp).filter(Boolean).sort();
  const firstMsg   = userMsgs[0];
  const rawPreview = firstMsg?.message?.content;
  const preview = typeof rawPreview === 'string'
    ? rawPreview.slice(0, 120)
    : Array.isArray(rawPreview)
      ? (rawPreview.find(c => c.type === 'text')?.text || '').slice(0, 120)
      : '';

  // Enrich messages
  const messages = msgs.map(msg => {
    const content   = msg.message?.content;
    const toolCalls = [];
    const textParts = [];

    if (Array.isArray(content)) {
      content.forEach(part => {
        if (part.type === 'tool_use')  toolCalls.push({ name: part.name, input: part.input });
        else if (part.type === 'text') textParts.push(part.text);
      });
    } else if (typeof content === 'string') {
      textParts.push(content);
    }

    // summary entries have a different shape: { type: 'summary', summary: '...', timestamp: ... }
    const isSummary = msg.type === 'summary';
    return {
      uuid:      msg.uuid,
      type:      msg.type,
      role:      isSummary ? 'summary' : msg.message?.role,
      model:     msg.message?.model,
      timestamp: msg.timestamp,
      text:      isSummary ? (msg.summary || '') : textParts.join('\n'),
      toolCalls,
      usage:     msg.message?.usage
    };
  });

  return {
    id:               sessionId,
    projectId,
    projectName:      projectDisplayName(projectId),
    messageCount:     msgs.length,
    userMessageCount: userMsgs.length,
    startTime:        timestamps[0]  || null,
    endTime:          timestamps[timestamps.length - 1] || null,
    preview,
    messages
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Claude Code Tracker Sync Client v' + VERSION);
  console.log('Reading from:', claudeDir);

  if (!fs.existsSync(claudeDir)) {
    console.error(`Error: Claude directory not found at ${claudeDir}`);
    process.exit(1);
  }

  // Stats
  const statsPath = path.join(claudeDir, 'stats-cache.json');
  let stats = {};
  try { stats = JSON.parse(fs.readFileSync(statsPath, 'utf8')); }
  catch { console.warn('Warning: stats-cache.json not found or unreadable'); }

  // History
  const historyPath = path.join(claudeDir, 'history.jsonl');
  const history = readJsonl(historyPath);
  console.log(`History: ${history.length} commands`);

  // Sessions
  const projectsDir = path.join(claudeDir, 'projects');
  const sessions = [];

  if (fs.existsSync(projectsDir)) {
    const projectDirs = fs.readdirSync(projectsDir).filter(d => {
      return fs.statSync(path.join(projectsDir, d)).isDirectory();
    });

    for (const projectId of projectDirs) {
      const projectDir = path.join(projectsDir, projectId);
      let files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));

      // Apply max-sessions limit (take most recently modified)
      if (files.length > maxSessions) {
        files = files
          .map(f => ({ f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, maxSessions)
          .map(x => x.f);
        console.log(`  ${projectId}: limited to ${maxSessions} sessions`);
      }

      for (const file of files) {
        try {
          const session = buildSession(projectDir, projectId, file);
          sessions.push(session);
        } catch (e) {
          console.warn(`  Warning: failed to read ${file}: ${e.message}`);
        }
      }
    }
  }

  console.log(`Sessions: ${sessions.length} across ${new Set(sessions.map(s => s.projectId)).size} projects`);

  const payload = { version: VERSION, stats, history, sessions };
  const rawBytes = Buffer.byteLength(JSON.stringify(payload));
  console.log(`Payload size: ${(rawBytes / 1e6).toFixed(2)} MB`);

  if (isDryRun) {
    console.log('\n[Dry run] Skipping upload.');
    return;
  }

  if (rawBytes > 60 * 1024 * 1024) {
    console.error(`Error: Payload too large (${(rawBytes/1e6).toFixed(1)} MB). Use --max-sessions to reduce.`);
    process.exit(1);
  }

  // POST to server
  const totalMB = (rawBytes / 1e6).toFixed(2);
  console.log(`\nUploading ${totalMB} MB to ${serverUrl} ...`);
  const result = await postJSON(`${serverUrl}/api/sync`, payload, token, (uploaded, total) => {
    const pct      = Math.floor((uploaded / total) * 100);
    const filled   = Math.floor(pct / 5);           // 20-char bar
    const bar      = '█'.repeat(filled) + '░'.repeat(20 - filled);
    const upMB     = (uploaded / 1e6).toFixed(2);
    const totMB    = (total   / 1e6).toFixed(2);
    process.stdout.write(`\r  [${bar}] ${String(pct).padStart(3)}%  ${upMB} / ${totMB} MB `);
  });
  process.stdout.write('\n');

  if (result.ok) {
    const d = new Date(result.syncedAt);
    console.log(`\n✓ Sync complete!`);
    console.log(`  Sessions: ${result.sessionCount}`);
    console.log(`  Size:     ${(result.rawSizeBytes / 1e6).toFixed(2)} MB`);
    console.log(`  Time:     ${d.toLocaleString()}`);

    console.log(`\n  View dashboard: ${serverUrl.replace(/\/+$/, '')}/app.html`);
  } else {
    console.error('\n✗ Sync failed:', result.error || JSON.stringify(result));
    process.exit(1);
  }
}

function postJSON(url, body, token, onProgress) {
  return new Promise((resolve, reject) => {
    const bodyBuf  = Buffer.from(JSON.stringify(body));
    const total    = bodyBuf.length;
    const parsed   = new URL(url);
    const isHttps  = parsed.protocol === 'https:';
    const options  = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': total,
        'Authorization':  `Bearer ${token}`
      }
    };

    const req = (isHttps ? https : http).request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: data }); }
      });
    });

    req.on('error', reject);

    // Write in 64 KB chunks and report progress
    const CHUNK = 64 * 1024;
    let offset  = 0;
    function writeNext() {
      while (offset < total) {
        const slice = bodyBuf.slice(offset, offset + CHUNK);
        offset += slice.length;
        if (onProgress) onProgress(Math.min(offset, total), total);
        const canContinue = req.write(slice);
        if (!canContinue) { req.once('drain', writeNext); return; }
      }
      req.end();
    }
    writeNext();
  });
}

main().catch(e => {
  console.error('Unexpected error:', e.message);
  process.exit(1);
});
