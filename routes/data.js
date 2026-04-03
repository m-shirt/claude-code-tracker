const express = require('express');
const { db, decompress } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function loadUserData(userId) {
  if (userId === 'all') {
    const users = db.prepare('SELECT id, name, email FROM users').all();
    let allSessions = [], allHistory = [];
    const modelUsage = {}, dailyMap = {};
    let firstSession = null;

    for (const u of users) {
      const row = db.prepare('SELECT stats_cache, history, sessions FROM user_data WHERE user_id = ?').get(u.id);
      if (!row) continue;
      const userName = u.name || u.email.split('@')[0];
      const sessions = decompress(row.sessions) || [];
      const history  = decompress(row.history)  || [];
      const stats    = decompress(row.stats_cache) || {};

      sessions.forEach(s => allSessions.push({ ...s, userName, userId: u.id }));
      history.forEach(h  => allHistory.push({ ...h, userName, userId: u.id }));

      // merge model usage (each value is { inputTokens, outputTokens, cacheReadInputTokens })
      Object.entries(stats.modelUsage || {}).forEach(([m, v]) => {
        if (!modelUsage[m]) modelUsage[m] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
        modelUsage[m].inputTokens          += (v.inputTokens          || 0);
        modelUsage[m].outputTokens         += (v.outputTokens         || 0);
        modelUsage[m].cacheReadInputTokens += (v.cacheReadInputTokens || 0);
      });
      // merge daily activity
      (stats.dailyActivity || []).forEach(({ date, messageCount }) => { dailyMap[date] = (dailyMap[date] || 0) + (messageCount || 0); });
      if (stats.firstSessionDate && (!firstSession || stats.firstSessionDate < firstSession)) firstSession = stats.firstSessionDate;
    }

    const dailyActivity = Object.entries(dailyMap).map(([date, messageCount]) => ({ date, messageCount })).sort((a, b) => a.date.localeCompare(b.date));
    return {
      stats: { modelUsage, dailyActivity, firstSessionDate: firstSession },
      history: allHistory,
      sessions: allSessions,
      syncedAt: Date.now(),
      totalUsers: users.length
    };
  }

  const row = db.prepare('SELECT stats_cache, history, sessions, synced_at FROM user_data WHERE user_id = ?').get(userId);
  if (!row) return null;
  return {
    stats:    decompress(row.stats_cache),
    history:  decompress(row.history),
    sessions: decompress(row.sessions),
    syncedAt: row.synced_at
  };
}

router.get('/summary', requireAuth, (req, res) => {
  const data = loadUserData(req.user.effectiveId);
  if (!data) return res.status(404).json({ error: 'No data synced yet. Run sync-client.js on your local machine first.' });

  const { stats, history, sessions, syncedAt } = data;

  // Date range filter
  const fromDate = req.query.from ? req.query.from + 'T00:00:00.000Z' : null;
  const toDate   = req.query.to   ? req.query.to   + 'T23:59:59.999Z' : null;
  const filteredSessions = (sessions || []).filter(s => {
    if (!s.startTime) return true;
    if (fromDate && s.startTime < fromDate) return false;
    if (toDate   && s.startTime > toDate)   return false;
    return true;
  });
  const filteredHistory = (history || []).filter(h => {
    const t = h.timestamp || h.startTime;
    if (!t) return true;
    if (fromDate && t < fromDate) return false;
    if (toDate   && t > toDate)   return false;
    return true;
  });

  const projectIds = new Set(filteredSessions.map(s => s.projectId));
  const totalMsgs = filteredSessions.reduce((s, x) => s + (x.messageCount || 0), 0);

  // Date helpers
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const weekStart  = new Date(now - 7 * 86400000).toISOString();

  const conversationsThisMonth = filteredSessions.filter(s => s.startTime && s.startTime >= monthStart).length;
  const conversationsThisWeek  = filteredSessions.filter(s => s.startTime && s.startTime >= weekStart).length;

  // Token breakdown from filtered sessions messages
  let tokenInput = 0, tokenOutput = 0, tokenCache = 0;
  const modelUsageFiltered = {};
  filteredSessions.forEach(s => {
    (s.messages || []).forEach(m => {
      if (!m.usage) return;
      tokenInput  += (m.usage.input_tokens              || 0);
      tokenOutput += (m.usage.output_tokens             || 0);
      tokenCache  += (m.usage.cache_read_input_tokens   || 0);
      if (m.model) {
        if (!modelUsageFiltered[m.model]) modelUsageFiltered[m.model] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
        modelUsageFiltered[m.model].inputTokens          += (m.usage.input_tokens            || 0);
        modelUsageFiltered[m.model].outputTokens         += (m.usage.output_tokens           || 0);
        modelUsageFiltered[m.model].cacheReadInputTokens += (m.usage.cache_read_input_tokens || 0);
      }
    });
  });
  // Fall back to stats.modelUsage when no date filter (preserves existing behaviour for aggregated data)
  const hasFilter = fromDate || toDate;
  const modelUsage = (hasFilter && Object.keys(modelUsageFiltered).length)
    ? modelUsageFiltered
    : (stats?.modelUsage || {});
  if (!hasFilter) {
    Object.values(stats?.modelUsage || {}).forEach(m => {
      tokenInput  += (m.inputTokens          || 0);
      tokenOutput += (m.outputTokens         || 0);
      tokenCache  += (m.cacheReadInputTokens || 0);
    });
    // reset to stats-based totals
    tokenInput = 0; tokenOutput = 0; tokenCache = 0;
    Object.values(stats?.modelUsage || {}).forEach(m => {
      tokenInput  += (m.inputTokens          || 0);
      tokenOutput += (m.outputTokens         || 0);
      tokenCache  += (m.cacheReadInputTokens || 0);
    });
  }

  // tokensByDay — from filtered sessions
  const dayTokenMap = {};
  filteredSessions.forEach(s => {
    if (!s.startTime) return;
    const day = s.startTime.slice(0, 10);
    (s.messages || []).forEach(m => {
      if (!m.usage) return;
      const t = (m.usage.input_tokens || 0) + (m.usage.output_tokens || 0) + (m.usage.cache_read_input_tokens || 0);
      if (t) dayTokenMap[day] = (dayTokenMap[day] || 0) + t;
    });
  });
  const tokensByDay = Object.entries(dayTokenMap)
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // dailyActivity — filter stats array or fall back
  let dailyActivity = (stats?.dailyActivity || []);
  if (fromDate || toDate) {
    const fd = fromDate ? fromDate.slice(0, 10) : null;
    const td = toDate   ? toDate.slice(0, 10)   : null;
    dailyActivity = dailyActivity.filter(d => {
      if (fd && d.date < fd) return false;
      if (td && d.date > td) return false;
      return true;
    });
  }

  // projectTokens — top 6 projects by token count
  const projTokenMap = {};
  const projNameMap  = {};
  filteredSessions.forEach(s => {
    if (!s.projectId) return;
    projNameMap[s.projectId] = s.projectName || s.projectId;
    let t = 0;
    (s.messages || []).forEach(m => {
      if (!m.usage) return;
      t += (m.usage.input_tokens || 0) + (m.usage.output_tokens || 0) + (m.usage.cache_read_input_tokens || 0);
    });
    projTokenMap[s.projectId] = (projTokenMap[s.projectId] || 0) + t;
  });
  const projectTokens = Object.entries(projTokenMap)
    .map(([id, tokens]) => ({ name: (projNameMap[id] || id).split('/').pop(), tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 6);

  // toolStats — from filtered sessions
  const toolCountMap = {};
  let totalToolCalls = 0;
  filteredSessions.forEach(s => {
    (s.messages || []).forEach(m => {
      (m.toolCalls || []).forEach(tc => {
        const name = tc.name || 'unknown';
        toolCountMap[name] = (toolCountMap[name] || 0) + 1;
        totalToolCalls++;
      });
    });
  });
  const uniqueTools = Object.keys(toolCountMap).length;
  const topTools = Object.entries(toolCountMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const toolStats = { totalToolCalls, uniqueTools, topTools };

  res.json({
    totalProjects:  projectIds.size,
    totalSessions:  filteredSessions.length,
    totalMessages:  totalMsgs,
    totalCommands:  filteredHistory.length,
    firstSession:   stats?.firstSessionDate || null,
    modelUsage,
    dailyActivity,
    lastSynced:     syncedAt,
    totalUsers:     data.totalUsers || null,
    conversationsThisMonth,
    conversationsThisWeek,
    tokenInput,
    tokenOutput,
    tokenCache,
    tokensByDay,
    projectTokens,
    toolStats
  });
});

router.get('/stats', requireAuth, (req, res) => {
  const data = loadUserData(req.user.effectiveId);
  if (!data) return res.status(404).json({ error: 'No data synced yet' });
  res.json(data.stats);
});

router.get('/projects', requireAuth, (req, res) => {
  const data = loadUserData(req.user.effectiveId);
  if (!data) return res.status(404).json({ error: 'No data synced yet' });

  const map = {};
  (data.sessions || []).forEach(s => {
    if (!map[s.projectId]) {
      map[s.projectId] = { id: s.projectId, name: s.projectName, sessionCount: 0, totalMessages: 0, lastActivity: null, users: new Set() };
    }
    map[s.projectId].sessionCount++;
    map[s.projectId].totalMessages += s.messageCount || 0;
    if (s.startTime && (!map[s.projectId].lastActivity || s.startTime > map[s.projectId].lastActivity)) {
      map[s.projectId].lastActivity = s.startTime;
    }
    if (s.userName) map[s.projectId].users.add(s.userName);
  });

  // Convert Set to Array for JSON serialization
  Object.values(map).forEach(p => { p.users = [...p.users]; });

  res.json(Object.values(map).sort((a, b) => {
    if (!a.lastActivity) return 1;
    if (!b.lastActivity) return -1;
    return b.lastActivity.localeCompare(a.lastActivity);
  }));
});

router.get('/sessions', requireAuth, (req, res) => {
  const data = loadUserData(req.user.effectiveId);
  if (!data) return res.status(404).json({ error: 'No data synced yet' });

  let sessions = (data.sessions || []).map(s => {
    let tokenInput = 0, tokenOutput = 0, tokenCache = 0;
    (s.messages || []).forEach(m => {
      if (m.usage) {
        tokenInput  += m.usage.input_tokens              || 0;
        tokenOutput += m.usage.output_tokens             || 0;
        tokenCache  += m.usage.cache_read_input_tokens   || 0;
      }
    });
    return {
      id: s.id, projectId: s.projectId, projectName: s.projectName,
      messageCount: s.messageCount, userMessageCount: s.userMessageCount,
      startTime: s.startTime, endTime: s.endTime, preview: s.preview,
      userName: s.userName || null,
      tokenInput, tokenOutput, tokenCache,
      totalTokens: tokenInput + tokenOutput + tokenCache
    };
  });

  if (req.query.project) sessions = sessions.filter(s => s.projectId === req.query.project);

  sessions.sort((a, b) => {
    if (!a.startTime) return 1;
    if (!b.startTime) return -1;
    return b.startTime.localeCompare(a.startTime);
  });

  res.json(sessions);
});

router.get('/session/:id', requireAuth, (req, res) => {
  const data = loadUserData(req.user.effectiveId);
  if (!data) return res.status(404).json({ error: 'No data synced yet' });

  const session = (data.sessions || []).find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json({ id: session.id, messages: session.messages || [] });
});

router.get('/history', requireAuth, (req, res) => {
  const data = loadUserData(req.user.effectiveId);
  if (!data) return res.status(404).json({ error: 'No data synced yet' });

  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  let entries = [...(data.history || [])];

  if (req.query.project) entries = entries.filter(e => e.project && e.project.includes(req.query.project));
  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    entries = entries.filter(e => (e.display || '').toLowerCase().includes(q));
  }

  entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  res.json(entries.slice(0, limit));
});

router.get('/demo-status', requireAuth, (req, res) => {
  const n = db.prepare("SELECT COUNT(*) as n FROM users WHERE email LIKE '%@demo.com'").get().n;
  res.json({ isDemo: n > 0 });
});

// Public config — no auth required
router.get('/config', (req, res) => {
  res.json({
    demoMode:        process.env.DISABLE_DEMO_MODE !== 'true',
    disableDemoWipe: process.env.DISABLE_DEMO_WIPE === 'true'
  });
});

module.exports = router;
