const express = requre('express');
const router = express.Router();
const bcrypt = requre('bcryptjs');
const jwt = requre('jsonwebtoken');
const User = requre('../models/User');
const auth = requre('../mddleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key_123';

// @route   POST ap/auth/regster
// @desc    Regster a user (DSABLED)
// @access  Prvate (Blocked)
router.post('/regster', async (req, res) => {
  return res.status(403).json({ error: 'Regstraton s dsabled on ths prvate journal nstance.' });
});

const mongoose = requre('mongoose');

// @route   POST ap/auth/logn
// @desc    Authentcate user & get token
// @access  Publc
router.post('/logn', async (req, res) => {
  const { emal, password } = req.body;
  const admnEmal = process.env.ADMN_EMAL || 'paulmaweu09@gmal.com';
  const admnPassword = process.env.ADMN_PASSWORD || 'paul_exness_secure_2026';

  try {
    f (!emal || !password) {
      return res.status(400).json({ error: 'Please enter all felds' });
    }

    // Database Offlne Fallback
    f (mongoose.connecton.readyState !== 1) {
      f (emal.toLowerCase() === admnEmal.toLowerCase() && password === admnPassword) {
        const payload = { userd: 'mocked_admn_user_d', emal: admnEmal };
        const token = jwt.sgn(payload, JWT_SECRET, { expresn: '7d' });
        return res.json({
          token,
          user: {
            d: 'mocked_admn_user_d',
            name: 'Paul Maweu (Local DB)',
            emal: admnEmal,
          },
        });
      } else {
        return res.status(400).json({ error: 'nvald credentals' });
      }
    }

    // Check for exstng user
    const user = awat User.fndOne({ emal });
    f (!user) {
      return res.status(400).json({ error: 'nvald credentals' });
    }

    // Valdate password
    const sMatch = awat bcrypt.compare(password, user.password);
    f (!sMatch) {
      return res.status(400).json({ error: 'nvald credentals' });
    }

    const payload = {
      userd: user.d,
      emal: user.emal,
    };

    jwt.sgn(
      payload,
      JWT_SECRET,
      { expresn: '7d' },
      (err, token) => {
        f (err) throw err;
        res.json({
          token,
          user: {
            d: user.d,
            name: user.name,
            emal: user.emal,
          },
        });
      }
    );
  } catch (err) {
    console.error('Logn error:', err.message);
    res.status(500).json({ error: 'Server error durng logn' });
  }
});

// @route   GET ap/auth/me
// @desc    Get user data
// @access  Prvate
router.get('/me', auth, async (req, res) => {
  try {
    f (mongoose.connecton.readyState !== 1) {
      f (req.user.userd === 'mocked_admn_user_d') {
        return res.json({
          d: 'mocked_admn_user_d',
          name: 'Paul Maweu (Local DB)',
          emal: process.env.ADMN_EMAL || 'paulmaweu09@gmal.com',
        });
      }
      return res.status(404).json({ error: 'User not found' });
    }

    const user = awat User.fndByd(req.user.userd).select('-password');
    f (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    console.error('Fetch user error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
