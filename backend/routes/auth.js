const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const auth = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key_123';

// @route   POST api/auth/register
// @desc    Register a user (DISABLED)
// @access  Private (Blocked)
router.post('/register', async (req, res) => {
  return res.status(403).json({ error: 'Registration is disabled on this private journal instance.' });
});

const mongoose = require('mongoose');

// @route   POST api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  try {
    if (!email || !password) {
      return res.status(400).json({ error: 'Please enter all fields' });
    }

    // Database Offline Fallback
    if (mongoose.connection.readyState !== 1) {
      if (adminEmail && adminPassword && email.toLowerCase() === adminEmail.toLowerCase() && password === adminPassword) {
        const payload = { userId: 'mocked_admin_user_id', email: adminEmail };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
        return res.json({
          token,
          user: {
            id: 'mocked_admin_user_id',
            name: 'Paul Maweu (Local DB)',
            email: adminEmail,
          },
        });
      } else {
        return res.status(400).json({ error: 'Invalid credentials' });
      }
    }

    // Check for existing user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Validate password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const payload = {
      userId: user.id,
      email: user.email,
    };

    jwt.sign(
      payload,
      JWT_SECRET,
      { expiresIn: '7d' },
      (err, token) => {
        if (err) throw err;
        res.json({
          token,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
          },
        });
      }
    );
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// @route   GET api/auth/me
// @desc    Get user data
// @access  Private
router.get('/me', auth, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      if (req.user.userId === 'mocked_admin_user_id') {
        return res.json({
          id: 'mocked_admin_user_id',
          name: 'Paul Maweu (Local DB)',
          email: process.env.ADMIN_EMAIL,
        });
      }
      return res.status(404).json({ error: 'User not found' });
    }

    const user = await User.findById(req.user.userId).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    console.error('Fetch user error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
