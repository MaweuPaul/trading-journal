const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const auth = require('../middleware/auth');

const router = express.Router();

function ownerEnv() {
  return {
    name: process.env.OWNER_NAME || process.env.ADMIN_NAME || 'Journal Owner',
    email: process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || '',
    password: process.env.OWNER_PASSWORD || process.env.ADMIN_PASSWORD || '',
  };
}

function signToken(user) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ userId: user.id || user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function publicUser(user) {
  return { id: String(user.id || user._id), name: user.name, email: user.email };
}

// GET /api/auth/setup-status — first-run state used by Login and Signup.
router.get('/setup-status', async (_req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      const env = ownerEnv();
      return res.json({
        setupRequired: false,
        signupAvailable: false,
        databaseAvailable: false,
        offlineLoginAvailable: Boolean(env.email && env.password),
      });
    }
    const ownerExists = Boolean(await User.exists({}));
    res.json({
      setupRequired: !ownerExists,
      signupAvailable: !ownerExists,
      databaseAvailable: true,
      offlineLoginAvailable: false,
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not determine setup status' });
  }
});

// POST /api/auth/register — creates the one and only owner account.
router.post('/register', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'MongoDB must be connected to create the owner account.' });
    }
    if (await User.exists({})) {
      return res.status(403).json({ error: 'This journal already has an owner. New account creation is locked.' });
    }

    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!name || name.length > 80) return res.status(400).json({ error: 'Enter a valid name.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET must be configured before setup.' });

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await User.create({ ownerKey: 'owner', name, email, password: hashedPassword });
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(403).json({ error: 'This journal already has an owner. New account creation is locked.' });
    }
    console.error('Owner registration error:', err.message);
    res.status(500).json({ error: 'Could not create the owner account.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  try {
    if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });
    if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET is not configured on this server.' });

    if (mongoose.connection.readyState !== 1) {
      const env = ownerEnv();
      if (env.email && env.password && email === env.email.toLowerCase() && password === env.password) {
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
