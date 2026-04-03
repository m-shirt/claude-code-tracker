const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-CHANGE-IN-PRODUCTION';

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    // Admin can view another user's data via ?asUser=<id>
    req.user = {
      ...payload,
      effectiveId: payload.role === 'admin'
        ? (req.query.asUser ? (req.query.asUser === 'all' ? 'all' : parseInt(req.query.asUser)) : 'all')
        : payload.id
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, JWT_SECRET };
