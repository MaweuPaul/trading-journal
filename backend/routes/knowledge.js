const express = require('express');
const mongoose = require('mongoose');
const { v2: cloudinary } = require('cloudinary');
const auth = require('../middleware/auth');
const KnowledgeEntry = require('../models/KnowledgeEntry');

const router = express.Router();

const CLOUDINARY_READY = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);
if (CLOUDINARY_READY) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

function ownerOnly(req, res, next) {
  if (req.user.role === 'sync_agent' || req.user.role === 'investor') {
    return res.status(403).json({ error: 'Owner session required.' });
  }
  next();
}

function normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(t => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

function validateEntryInput(body) {
  const title = String(body.title || '').trim();
  if (!title) return 'Title is required.';
  if (title.length > 160) return 'Title must be 160 characters or fewer.';
  if (String(body.content || '').length > 20000) return 'Content is too long.';
  return '';
}

// GET /api/knowledge-entries?search=&tag=
router.get('/knowledge-entries', auth, ownerOnly, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'The knowledge base requires MongoDB to be connected.' });
    }
    const query = { user: req.user.userId };
    const search = String(req.query.search || '').trim();
    if (search) {
      const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ title: pattern }, { content: pattern }];
    }
    const tag = String(req.query.tag || '').trim().toLowerCase();
    if (tag) query.tags = tag;

    const entries = await KnowledgeEntry.find(query).sort({ createdAt: -1 }).lean();
    res.json({ entries });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/knowledge-entries', auth, ownerOnly, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'The knowledge base requires MongoDB to be connected.' });
    }
    const validationError = validateEntryInput(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const entry = await KnowledgeEntry.create({
      user: req.user.userId,
      title: String(req.body.title).trim(),
      content: String(req.body.content || ''),
      tags: normalizeTags(req.body.tags),
    });
    res.status(201).json({ entry });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/knowledge-entries/:id', auth, ownerOnly, async (req, res) => {
  try {
    const entry = await KnowledgeEntry.findOne({ _id: req.params.id, user: req.user.userId });
    if (!entry) return res.status(404).json({ error: 'Knowledge entry not found.' });

    const validationError = validateEntryInput({ ...req.body, title: req.body.title ?? entry.title });
    if (validationError) return res.status(400).json({ error: validationError });

    if (req.body.title !== undefined) entry.title = String(req.body.title).trim();
    if (req.body.content !== undefined) entry.content = String(req.body.content || '');
    if (req.body.tags !== undefined) entry.tags = normalizeTags(req.body.tags);
    await entry.save();
    res.json({ entry });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/knowledge-entries/:id', auth, ownerOnly, async (req, res) => {
  try {
    const entry = await KnowledgeEntry.findOne({ _id: req.params.id, user: req.user.userId });
    if (!entry) return res.status(404).json({ error: 'Knowledge entry not found.' });

    if (CLOUDINARY_READY) {
      await Promise.all((entry.screenshots || []).map(shot =>
        cloudinary.uploader.destroy(shot.publicId, { resource_type: 'image' }).catch(() => {})
      ));
    }
    await entry.deleteOne();
    res.json({ deleted: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/knowledge-entries/:id/screenshots  { imageData, caption }
router.post('/knowledge-entries/:id/screenshots', auth, ownerOnly, async (req, res) => {
  try {
    if (!CLOUDINARY_READY) return res.status(500).json({ error: 'Cloudinary is not configured on the backend.' });
    const { imageData, caption = '' } = req.body;
    if (!imageData || typeof imageData !== 'string' || !imageData.startsWith('data:image/')) {
      return res.status(400).json({ error: 'imageData must be a base64 data URL image.' });
    }

    const entry = await KnowledgeEntry.findOne({ _id: req.params.id, user: req.user.userId });
    if (!entry) return res.status(404).json({ error: 'Knowledge entry not found.' });

    const upload = await cloudinary.uploader.upload(imageData, {
      folder: `trade-journal/${req.user.userId}/knowledge/${entry._id}`,
      resource_type: 'image',
      overwrite: false,
    });

    entry.screenshots.push({
      url: upload.secure_url,
      publicId: upload.public_id,
      caption: String(caption).trim().slice(0, 180),
      uploadedAt: new Date(),
    });
    await entry.save();
    res.json({ entry });
  } catch (error) {
    console.error('Knowledge screenshot upload error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/knowledge-entries/:id/screenshots/:screenshotId', auth, ownerOnly, async (req, res) => {
  try {
    const entry = await KnowledgeEntry.findOne({ _id: req.params.id, user: req.user.userId });
    if (!entry) return res.status(404).json({ error: 'Knowledge entry not found.' });
    const shot = entry.screenshots.id(req.params.screenshotId);
    if (!shot) return res.status(404).json({ error: 'Screenshot not found.' });
    shot.caption = String(req.body.caption || '').trim().slice(0, 180);
    await entry.save();
    res.json({ entry });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/knowledge-entries/:id/screenshots/:screenshotId', auth, ownerOnly, async (req, res) => {
  try {
    const entry = await KnowledgeEntry.findOne({ _id: req.params.id, user: req.user.userId });
    if (!entry) return res.status(404).json({ error: 'Knowledge entry not found.' });
    const shot = entry.screenshots.id(req.params.screenshotId);
    if (!shot) return res.status(404).json({ error: 'Screenshot not found.' });
    if (CLOUDINARY_READY) {
      await cloudinary.uploader.destroy(shot.publicId, { resource_type: 'image' }).catch(() => {});
    }
    shot.deleteOne();
    await entry.save();
    res.json({ entry });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
