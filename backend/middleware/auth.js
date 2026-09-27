const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

// When each owner last changed their password, cached briefly so the check
// below costs a database read at most once a minute per user.
const CHANGE_CACHE_MS = 60_000;
const passwordChanges = new Map(); // userId -> { at, changedAt (ms) }
async function passwordChangedAt(userId) {
  const hit = passwordChanges.get(userId);
  if (hit && Date.now() - hit.at < CHANGE_CACHE_MS) return hit.changedAt;
  const User = require('../models/User');
  const user = await User.findOne({ _id: userId }).select('passwordChangedAt').lean();
  const changedAt = user?.passwordChangedAt ? new Date(user.passwordChangedAt).getTime() : 0;
  passwordChanges.set(userId, { at: Date.now(), changedAt });
  return changedAt;
}

module.exports = function (req, res, next) {
  // Get token from header
  const authHeader = req.header('Authorization');

  // Check if no token
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token, authorization denied' });
  }

  const token = authHeader.split(' ')[1];

  try {
    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: 'JWT_SECRET is not configured' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Offline login tokens intentionally use a non-ObjectId placeholder. Once
    // MongoDB reconnects they must be replaced by a normal owner login token;
    // otherwise every owner-scoped query fails with a Mongoose CastError.
    if (mongoose.connection.readyState === 1 && !mongoose.Types.ObjectId.isValid(String(decoded.userId || ''))) {
      return res.status(401).json({ error: 'Your offline session expired after the database reconnected. Please sign in again.' });
    }
    if (decoded.role === 'sync_agent') {
      const path = req.originalUrl.split('?')[0];
      const permitted = [
        ['GET', /^\/api\/sync-agent\/trading-accounts$/],
        ['POST', /^\/api\/sync-agent\/trading-accounts\/[^/]+\/status$/],
        ['POST', /^\/api\/sync-agent\/trading-accounts\/import-legacy$/],
        ['GET', /^\/api\/trades\/latest-close$/],
        ['POST', /^\/api\/sync$/],
        ['POST', /^\/api\/sync-account-events$/],
        ['GET', /^\/api\/maintenance\/resync-request$/],
        ['POST', /^\/api\/maintenance\/resync-complete$/],
      ].some(([method, pattern]) => method === req.method && pattern.test(path));
      if (!permitted) return res.status(403).json({ error: 'This sync-agent token cannot access owner journal endpoints.' });
    }
    if (decoded.role === 'investor') {
      const path = req.originalUrl.split('?')[0];
      const permitted = [
        ['GET', /^\/api\/investor\/summary$/],
        ['GET', /^\/api\/investor\/trades$/],
        ['GET', /^\/api\/investor\/trades\/[^/]+\/replay$/],
      ].some(([method, pattern]) => method === req.method && pattern.test(path));
      if (!permitted) return res.status(403).json({ error: 'This investor token cannot access owner journal endpoints.' });
    }
    req.user = decoded;
    // Owner logins issued before the last password change (reset or change)
    // no longer work, so changing the password signs out other devices.
    if (!decoded.role && mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(String(decoded.userId || '')) && decoded.iat) {
      return passwordChangedAt(String(decoded.userId))
        .then(changedAt => {
          if (changedAt && decoded.iat < Math.floor(changedAt / 1000)) return res.status(401).json({ error: 'Your password was changed. Please sign in again.' });
          next();
        })
        .catch(() => next());
    }
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token is not valid' });
  }
};

/** Drop the cached change time so the new password takes effect at once on this server. */
module.exports.forgetPasswordChange = userId => passwordChanges.delete(String(userId));
