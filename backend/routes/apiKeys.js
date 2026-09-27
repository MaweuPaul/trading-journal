const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiKey = require('../models/ApiKey');
const auth = require('../middleware/auth');

// Access keys let AI agents reach the backtest MCP tools (routes/mcp.js) on
// the owner's behalf. Managed here with the normal login, never with a key.
function ownerOnly(req, res, next) {
  if (req.user.role === 'sync_agent' || req.user.role === 'investor') return res.status(403).json({ error: 'Owner session required.' });
  next();
}
function isOffline(req) {
  return mongoose.connection.readyState !== 1 || String(req.user.userId) === 'mocked_admin_user_id';
}
function offlineResponse(res) {
  return res.status(503).json({ error: 'Access keys need a connected database. Unavailable while running offline.' });
}

const MAX_KEYS = 20;
const publicKey = k => ({
  _id: k._id, name: k.name, prefix: k.prefix, journal: (k.scopes || []).includes('journal'), kind: k.kind || 'key', createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revoked: Boolean(k.revokedAt), revokedAt: k.revokedAt,
});

router.get('/api-keys', auth, ownerOnly, async (req, res) => {
  if (isOffline(req)) return res.json({ keys: [] });
  try {
    const keys = await ApiKey.find({ user: req.user.userId }).sort({ createdAt: -1 }).lean();
    res.json({ keys: keys.map(publicKey) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not load access keys' });
  }
});

router.post('/api-keys', auth, ownerOnly, async (req, res) => {
  if (isOffline(req)) return offlineResponse(res);
  try {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Give the key a name, e.g. "Claude Code laptop".' });
    const active = await ApiKey.countDocuments({ user: req.user.userId, revokedAt: null, kind: { $ne: 'oauth' } });
    if (active >= MAX_KEYS) return res.status(400).json({ error: `You already have ${MAX_KEYS} active keys. Revoke one first.` });
    const key = `tjk_${crypto.randomBytes(32).toString('base64url')}`;
    const doc = await ApiKey.create({
      user: req.user.userId,
      name,
      keyHash: crypto.createHash('sha256').update(key).digest('hex'),
      prefix: key.slice(0, 10),
      // Reading the real trade journal is opt-in per key.
      scopes: req.body.journal === true ? ['backtest', 'journal'] : ['backtest'],
    });
    // The plaintext is returned this once and never stored.
    res.status(201).json({ ...publicKey(doc), key });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not create access key' });
  }
});

// Turn journal (real trades, read-only) access on or off for a key.
router.patch('/api-keys/:id', auth, ownerOnly, async (req, res) => {
  if (isOffline(req)) return offlineResponse(res);
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Access key not found' });
    if (typeof req.body.journal !== 'boolean') return res.status(400).json({ error: 'Send { "journal": true } or { "journal": false }.' });
    const doc = await ApiKey.findOneAndUpdate(
      { _id: req.params.id, user: req.user.userId, revokedAt: null },
      { $set: { scopes: req.body.journal ? ['backtest', 'journal'] : ['backtest'] } },
      { new: true },
    );
    if (!doc) return res.status(404).json({ error: 'Access key not found or revoked' });
    res.json(publicKey(doc));
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not update access key' });
  }
});

router.delete('/api-keys/:id', auth, ownerOnly, async (req, res) => {
  if (isOffline(req)) return offlineResponse(res);
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Access key not found' });
    const doc = await ApiKey.findOneAndUpdate(
      { _id: req.params.id, user: req.user.userId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { new: true },
    );
    if (!doc) return res.status(404).json({ error: 'Access key not found or already revoked' });
    res.json(publicKey(doc));
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not revoke access key' });
  }
});

module.exports = router;
