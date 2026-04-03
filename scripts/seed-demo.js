#!/usr/bin/env node
'use strict';
/**
 * Claude Code Tracker — Demo Seeder
 * Creates 10 demo users with realistic fake data.
 * Usage:        node scripts/seed-demo.js
 * Force re-seed: node scripts/seed-demo.js --force
 */

const bcrypt = require('bcrypt');
const { db, compress } = require('../db');

// ── Seeded PRNG (Mulberry32) ──────────────────────────────────────────────────
function mkRng(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Demo users ────────────────────────────────────────────────────────────────
const DEMO_USERS = [
  { email: 'admin@demo.com',          role: 'admin' },
  { email: 'alice.dev@demo.com',      role: 'user'  },
  { email: 'bob.coder@demo.com',      role: 'user'  },
  { email: 'carol.eng@demo.com',      role: 'user'  },
  { email: 'dave.hacker@demo.com',    role: 'user'  },
  { email: 'eve.builder@demo.com',    role: 'user'  },
  { email: 'frank.dev@demo.com',      role: 'user'  },
  { email: 'grace.ops@demo.com',      role: 'user'  },
  { email: 'henry.arch@demo.com',     role: 'user'  },
  { email: 'iris.fullstack@demo.com', role: 'user'  },
];

// Showcase accounts shown on the login page — created without sync data
// so visitors see the onboarding flow when they log in.
const SHOWCASE_USERS = [
  { email: 'admin@claude-code-tracker.com', role: 'admin' },
  { email: 'user@claude-code-tracker.com',  role: 'user'  },
];

const DEMO_PASSWORD = 'demo1234';

// ── Shared data pools ─────────────────────────────────────────────────────────
const PROJECTS = [
  { id: 'ecommerce-store',  name: '~/projects/ecommerce-store'  },
  { id: 'api-gateway',      name: '~/projects/api-gateway'      },
  { id: 'mobile-app',       name: '~/projects/mobile-app'       },
  { id: 'dashboard',        name: '~/work/dashboard'            },
  { id: 'data-pipeline',    name: '~/work/data-pipeline'        },
  { id: 'portfolio',        name: '~/Desktop/Code/portfolio'    },
  { id: 'auth-service',     name: '~/projects/auth-service'     },
  { id: 'cli-tool',         name: '~/projects/cli-tool'         },
];

const MODELS    = ['claude-sonnet-4-5', 'claude-opus-4', 'claude-haiku-3-5'];
const MODEL_W   = [0.65, 0.25, 0.10];

const USER_MSGS = [
  'Help me fix this TypeScript error: Type string is not assignable to type number',
  'Refactor this function to be more readable and add proper error handling',
  'Add input validation to the user registration endpoint',
  'Write unit tests for the authentication module',
  'Explain how this regex works: /^(?=.*[A-Z])(?=.*\\d).{8,}$/',
  'Optimize this slow database query that fetches user orders with joins',
  'Debug why the CI pipeline is failing on the build step',
  'Create a middleware to log all API requests with timing information',
  'How do I properly handle async errors in Express.js routes?',
  'Review this code and look for security vulnerabilities',
  'Add cursor-based pagination to the products list endpoint',
  'Why is my React component re-rendering too often on every state change?',
  'Set up Redis caching for the most frequently accessed endpoints',
  'Write a migration script to move data from the old schema to the new one',
  'Fix the CORS issue blocking requests from the React frontend',
  'Add rate limiting to the login endpoint to prevent brute force attacks',
  'Implement JWT refresh token rotation properly',
  'Clean up this messy CSS and convert to use CSS custom properties',
  'Help me design the database schema for a multi-tenant SaaS application',
  'Debug this memory leak happening in the Node.js production server',
  'Add WebSocket support to the existing Express server',
  'Generate TypeScript types from this JSON API response',
  'Write a Docker compose file for this Node + Postgres + Redis stack',
  'Implement an event-driven architecture using an in-process event bus',
];

const ASSISTANT_REPLIES = [
  "I can see the issue. The problem is you're passing a string where a number is expected. Here's the fix:",
  "Let me refactor this for better readability by breaking it into smaller, well-named functions:",
  "I'll add validation using Zod to ensure type safety at the boundary:",
  "Here are comprehensive unit tests covering the happy path and edge cases:",
  "This regex matches passwords with: at least one uppercase letter `(?=.*[A-Z])`, one digit `(?=.*\\d)`, and minimum 8 characters `.{8,}`.",
  "The query is slow because it's missing an index and doing a full table scan. Here's the optimized version:",
  "The CI failure is caused by a missing environment variable in the workflow. Here's the fix:",
  "Here's a clean logging middleware that captures method, path, status code, and response time:",
  "For async error handling in Express, wrap your route handlers or use `express-async-errors`:",
  "I found several issues: SQL injection risk on line 23, missing input sanitization, and plaintext password storage. Let me fix all of these:",
  "Here's how to add cursor-based pagination that's more efficient than OFFSET for large datasets:",
  "The excess re-renders are caused by object identity issues in your `useEffect` dependency array. Here's the fix:",
  "I'll set up Redis caching with a TTL and cache invalidation strategy:",
  "Here's a safe migration script with a dry-run mode and rollback support:",
  "The CORS issue is because the `credentials: true` option requires an explicit origin. Here's the corrected config:",
];

const TOOL_CALLS = [
  { name: 'Read',  input: { file_path: 'src/routes/auth.js' }                                    },
  { name: 'Edit',  input: { file_path: 'src/routes/auth.js', old_string: 'TODO', new_string: '' } },
  { name: 'Bash',  input: { command: 'npm test -- --coverage' }                                  },
  { name: 'Grep',  input: { pattern: 'async function', path: 'src/' }                            },
  { name: 'Glob',  input: { pattern: 'src/**/*.ts' }                                             },
  { name: 'Bash',  input: { command: 'git log --oneline -10' }                                   },
  { name: 'Read',  input: { file_path: 'package.json' }                                          },
  { name: 'Bash',  input: { command: 'npm run lint' }                                            },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function pickW(rng, items, weights) {
  const r = rng(); let sum = 0;
  for (let i = 0; i < items.length; i++) { sum += weights[i]; if (r < sum) return items[i]; }
  return items[items.length - 1];
}
function pick(rng, arr)         { return arr[Math.floor(rng() * arr.length)]; }
function randInt(rng, min, max) { return Math.floor(rng() * (max - min + 1)) + min; }
function genUUID(rng) {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const v = c === 'x' ? Math.floor(rng() * 16) : (Math.floor(rng() * 4) + 8);
    return v.toString(16);
  });
}

// ── Data generators ───────────────────────────────────────────────────────────
function generateSession(rng, idx, projectId, projectName, baseTime) {
  const msgCount = randInt(rng, 6, 24);
  let t = baseTime - randInt(rng, 0, 3600000);
  const startTime = t;
  const messages  = [];
  let userMsgCount = 0;

  for (let i = 0; i < msgCount; i++) {
    t += randInt(rng, 8000, 90000);
    const isUser    = i % 2 === 0;
    const model     = isUser ? null : pickW(rng, MODELS, MODEL_W);
    const toolCalls = (!isUser && rng() > 0.45) ? [pick(rng, TOOL_CALLS)] : [];
    const text      = isUser
      ? pick(rng, USER_MSGS)
      : pick(rng, ASSISTANT_REPLIES) + (toolCalls.length ? '\n\nLet me look at the code first.' : '');

    if (isUser) userMsgCount++;
    messages.push({
      uuid:      genUUID(rng),
      type:      isUser ? 'user' : 'assistant',
      role:      isUser ? 'user' : 'assistant',
      model,
      timestamp: t,
      text,
      toolCalls,
      usage: isUser ? null : {
        input_tokens:  randInt(rng, 200, 4000),
        output_tokens: randInt(rng, 80,  2000),
      },
    });
  }

  return {
    id:              `demo-${projectId}-${idx}`,
    projectId,
    projectName,
    messageCount:    messages.length,
    userMessageCount: userMsgCount,
    startTime:       new Date(startTime).toISOString(),
    endTime:         new Date(t).toISOString(),
    preview:         messages[0]?.text.slice(0, 120) || '',
    messages,
  };
}

function generateUserData(rng) {
  const now   = Date.now();
  const DAY   = 86400000;

  // 3–5 projects per user
  const userProjects = [...PROJECTS].sort(() => rng() - 0.5).slice(0, randInt(rng, 3, 5));

  // Sessions: 2–7 per project
  const sessions = [];
  for (const proj of userProjects) {
    const n = randInt(rng, 2, 7);
    for (let i = 0; i < n; i++) {
      const baseTime = now - randInt(rng, 0, 90) * DAY;
      sessions.push(generateSession(rng, sessions.length, proj.id, proj.name, baseTime));
    }
  }

  // 30 days of daily activity
  const dailyActivity = [];
  for (let d = 29; d >= 0; d--) {
    const date   = new Date(now - d * DAY).toISOString().slice(0, 10);
    const active = rng() > 0.3;
    dailyActivity.push({ date, messageCount: active ? randInt(rng, 5, 80) : 0 });
  }

  // Model usage — each model has token breakdown objects
  const base = sessions.length;
  function genModelTokens(rng, minMult, maxMult) {
    const total = randInt(rng, base * minMult * 1000, base * maxMult * 1000);
    return {
      inputTokens:           Math.round(total * 0.55),
      outputTokens:          Math.round(total * 0.30),
      cacheReadInputTokens:  Math.round(total * 0.15),
    };
  }
  const modelUsage = {
    'claude-sonnet-4-5': genModelTokens(rng, 20, 50),
    'claude-opus-4':     genModelTokens(rng, 5,  15),
    'claude-haiku-3-5':  genModelTokens(rng, 2,  8),
  };

  const firstSessionDate = sessions.reduce((min, s) => (!min || s.startTime < min) ? s.startTime : min, null);
  const stats   = { firstSessionDate, modelUsage, dailyActivity };

  // History: 40–120 command entries
  const history = [];
  const hCount  = randInt(rng, 40, 120);
  for (let i = 0; i < hCount; i++) {
    history.push({
      timestamp: now - randInt(rng, 0, 90 * DAY),
      display:   pick(rng, USER_MSGS).slice(0, 80),
      project:   pick(rng, userProjects).name,
    });
  }

  return { stats, history, sessions };
}

// ── Main seed function (exported for use in admin route) ──────────────────────
function seedDemo(force = false) {
  const existing = db.prepare("SELECT COUNT(*) as n FROM users WHERE email LIKE '%@demo.com'").get().n;
  if (existing > 0 && !force) return { skipped: true, count: existing };

  if (existing > 0) db.prepare("DELETE FROM users WHERE email LIKE '%@demo.com'").run();

  const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 8);
  const now          = Date.now();

  const insertUser = db.prepare(
    'INSERT INTO users (email, password_hash, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  );
  const insertData = db.prepare(`
    INSERT INTO user_data (user_id, stats_cache, history, sessions, raw_size_bytes, synced_at, sync_count, client_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const results = db.transaction(() => {
    // Seed demo users with generated data
    const seeded = DEMO_USERS.map((u, i) => {
      const rng        = mkRng(i * 0xDEADBEEF + 0xCAFEBABE);
      const createdAt  = now - (120 - i * 8) * 86400000;
      const lastSeen   = now - randInt(rng, 0, 6 * 86400000);

      const id = insertUser.run(u.email, passwordHash, u.role, createdAt, lastSeen).lastInsertRowid;

      const { stats, history, sessions } = generateUserData(rng);
      const rawSize = Buffer.byteLength(JSON.stringify({ stats, history, sessions }));

      insertData.run(
        id,
        compress(stats),
        compress(history),
        compress(sessions),
        rawSize,
        lastSeen - randInt(rng, 0, 3600000),
        randInt(rng, 1, 30),
        '1.0.0'
      );

      return { email: u.email, role: u.role, sessions: sessions.length };
    });

    // Create showcase accounts without data (triggers onboarding on first login)
    SHOWCASE_USERS.forEach(u => {
      const alreadyExists = db.prepare('SELECT id FROM users WHERE email = ?').get(u.email);
      if (!alreadyExists) {
        insertUser.run(u.email, passwordHash, u.role, now, now);
      }
    });

    return seeded;
  })();

  return { skipped: false, count: results.length, users: results };
}

// ── CLI entry point ───────────────────────────────────────────────────────────
if (require.main === module) {
  const force = process.argv.includes('--force');
  console.log('\n🌱 Claude Code Tracker — Demo Seeder\n');

  const result = seedDemo(force);

  if (result.skipped) {
    console.log(`⚠️  Demo data already exists (${result.count} users). Use --force to re-seed.\n`);
    process.exit(0);
  }

  console.log(`✅ Seeded ${result.count} demo users:\n`);
  console.log('  Email                           Role    Sessions  Password');
  console.log('  ' + '─'.repeat(64));
  result.users.forEach(u => {
    console.log(`  ${u.email.padEnd(34)}${u.role.padEnd(8)}${String(u.sessions).padEnd(10)}${DEMO_PASSWORD}`);
  });
  console.log('\n  Admin login → admin@demo.com / demo1234\n');
}

module.exports = { seedDemo };
