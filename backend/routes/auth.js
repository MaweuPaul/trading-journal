const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { safeSecretEqual } = require('../lib/credentialEncryption');

function randomSyncSecret() {
  return crypto.randomBytes(24).toString('hex'); // 48 hex chars, shown once
}
function hashSyncSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

const router = express.Router();

// Credential-guessing throttle. This API has no CAPTCHA and CORS alone does
// not stop a same-origin script from looping, so cap attempts per IP.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait 15 minutes and try again.' },
});

function ownerEnv() {
  return {
    name: process.env.OWNER_NAME || process.env.ADMIN_NAME || 'Journal Owner',
    email: process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || '',
    password: process.env.OWNER_PASSWORD || process.env.ADMIN_PASSWORD || '',
    passwordHash: process.env.OWNER_PASSWORD_HASH || '',
  };
}

// Prefer a bcrypt hash (OWNER_PASSWORD_HASH) over a plaintext OWNER_PASSWORD when both
// are configured, so the owner's real password never has to sit in .env in the clear.
async function offlinePasswordMatches(env, suppliedPassword) {
  if (env.passwordHash) return bcrypt.compare(suppliedPassword, env.passwordHash);
  if (env.password) return safeSecretEqual(suppliedPassword, env.password);
  return false;
}

function signToken(user) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ userId: user.id || user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function signAgentToken(user) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ userId: user.id || user._id, email: user.email, role: 'sync_agent' }, process.env.JWT_SECRET, { expiresIn: '24h' });
}

function publicUser(user) {
  return { id: String(user.id || user._id), name: user.name, email: user.email };
}

// GET /api/auth/setup-status — reports whether registration and normal login
// are usable right now. Signup is always open (this is a multi-user app);
// the only thing that can be unavailable is the database itself, in which
// case an offline owner login may still work if one is configured.
router.get('/setup-status', async (_req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      const env = ownerEnv();
      return res.json({
        signupAvailable: false,
        databaseAvailable: false,
        offlineLoginAvailable: Boolean(env.email && (env.passwordHash || env.password)),
      });
    }
    res.json({
      signupAvailable: true,
      databaseAvailable: true,
      offlineLoginAvailable: false,
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not determine setup status' });
  }
});

// POST /api/auth/register — creates a new user account. Also generates that
// user's personal MT5 sync-agent secret up front and returns it once
// (plaintext), the same way an API key is normally issued, so a brand-new
// user can wire up sync.py immediately without a separate step.
router.post('/register', credentialLimiter, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'MongoDB must be connected to create an account.' });
    }

    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!name || name.length > 80) return res.status(400).json({ error: 'Enter a valid name.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET must be configured before setup.' });

    // Deliberately vague on the "already registered" case (same message, same
    // 400 status as any other validation failure) rather than a distinct 409
    // "that email already exists" -- confirming which emails are registered
    // is a user-enumeration leak, useful for phishing/credential-stuffing
    // targeting. A real owner of that email who tries to register again
    // should just try signing in or resetting their password instead.
    //
    // The bcrypt hash runs *before* the existence check (not after) so the
    // duplicate-email path takes roughly the same time as the success path
    // instead of returning suspiciously fast -- otherwise the two outcomes
    // would still be distinguishable by response time even with an identical
    // error message.
    const genericFailure = () => res.status(400).json({ error: 'Could not create an account with those details. If you already have an account, try signing in instead.' });
    const hashedPassword = await bcrypt.hash(password, 12);

    if (await User.findOne({ email })) return genericFailure();

    const syncSecret = randomSyncSecret();
    const user = await User.create({ name, email, password: hashedPassword, syncSecretHash: hashSyncSecret(syncSecret) });
    res.status(201).json({ token: signToken(user), user: publicUser(user), syncSecret });
  } catch (err) {
    if (err?.code === 11000) return res.status(400).json({ error: 'Could not create an account with those details. If you already have an account, try signing in instead.' });
    console.error('Registration error:', err.message);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

// POST /api/auth/login
router.post('/login', credentialLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  try {
    if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });
    if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET is not configured on this server.' });

    if (mongoose.connection.readyState !== 1) {
      const env = ownerEnv();
      const hasOfflineCredential = Boolean(env.email && (env.passwordHash || env.password));
      if (hasOfflineCredential && email === env.email.toLowerCase() && await offlinePasswordMatches(env, password)) {
        const user = { id: 'mocked_admin_user_id', name: `${env.name} (Offline)`, email: env.email };
        return res.json({ token: signToken(user), user });
      }
      return res.status(400).json({ error: 'Invalid credentials or database unavailable.' });
    }

    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: 'Invalid credentials.' });
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// POST /api/auth/sync-agent -- exchanges one user's personal sync secret for
// a short-lived agent JWT scoped to that same user. Each user's secret maps
// to exactly their own account (via syncSecretHash), so multiple users can
// each run their own local sync.py against this same backend without their
// trades ever landing in someone else's account.
router.post('/sync-agent', credentialLimiter, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'MongoDB is required for sync-agent authentication.' });
    const supplied = req.header('X-Sync-Secret') || req.body.syncSecret || '';
    if (!supplied) return res.status(401).json({ error: 'Invalid sync agent secret.' });
    const owner = await User.findOne({ syncSecretHash: hashSyncSecret(supplied) });
    if (!owner) return res.status(401).json({ error: 'Invalid sync agent secret.' });
    res.json({ token: signAgentToken(owner), user: publicUser(owner) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/sync-secret/rotate -- (re)generates the calling user's
// personal MT5 sync-agent secret. Like the investor password, the plaintext
// is only ever returned here, once; only its hash is stored afterward.
router.post('/sync-secret/rotate', auth, async (req, res) => {
  try {
    if (req.user.role === 'sync_agent' || req.user.role === 'investor') {
      return res.status(403).json({ error: 'Owner session required.' });
    }
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'MongoDB must be connected.' });
    const syncSecret = randomSyncSecret();
    const user = await User.findByIdAndUpdate(req.user.userId, { syncSecretHash: hashSyncSecret(syncSecret) }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ syncSecret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      if (req.user.userId === 'mocked_admin_user_id') {
        const env = ownerEnv();
        return res.json({ id: 'mocked_admin_user_id', name: `${env.name} (Offline)`, email: env.email });
      }
      return res.status(404).json({ error: 'User not found' });
    }
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
