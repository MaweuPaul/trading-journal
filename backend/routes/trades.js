const express = require('express');
const router = express.Router();
const Trade = require('../models/Trade');
const SyncRequest = require('../models/SyncRequest');
const AccountEvent = require('../models/AccountEvent');
const auth = require('../middleware/auth');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { v2: cloudinary } = require('cloudinary');

const LOCAL_DB_PATH = path.join(__dirname, '../local_trades.json');
const LOCAL_EVENTS_PATH = path.join(__dirname, '../local_account_events.json');
const OFFLINE_SCREENSHOTS_DIR = path.join(__dirname, '../public/screenshots');
const CLOUDINARY_READY = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

// Ensure offline screenshots directory exists
if (!fs.existsSync(OFFLINE_SCREENSHOTS_DIR)) {
  fs.mkdirSync(OFFLINE_SCREENSHOTS_DIR, { recursive: true });
}

if (CLOUDINARY_READY) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// Load initial n-memory trades from local file f exists
let inMemoryTrades = [];
let inMemoryAccountEvents = [];
const inMemorySyncRequests = {};
try {
  if (fs.existsSync(LOCAL_DB_PATH)) {
    inMemoryTrades = JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf8'));
    console.log(` Loaded ${inMemoryTrades.length} trades from local persistent database file.`);
  }
  if (fs.existsSync(LOCAL_EVENTS_PATH)) {
    inMemoryAccountEvents = JSON.parse(fs.readFileSync(LOCAL_EVENTS_PATH, 'utf8'));
    console.log(` Loaded ${inMemoryAccountEvents.length} account events from local persistent database file.`);
  }
} catch (e) {
  console.error("Failed to load local persistent database:", e.message);
}

function saveLocalDatabase() {
  try {
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(inMemoryTrades, null, 2), 'utf8');
  } catch (e) {
    console.error("Failed to save local persistent database:", e.message);
  }
}

function saveLocalAccountEvents() {
  try {
    fs.writeFileSync(LOCAL_EVENTS_PATH, JSON.stringify(inMemoryAccountEvents, null, 2), 'utf8');
  } catch (e) {
    console.error("Failed to save local account events:", e.message);
  }
}

function isOfflineTradeVisibleToUser(trade, userId) {
  if (String(userId) === 'mocked_admin_user_id') return true;
  if (!trade.user) return true;
  return String(trade.user) === String(userId);
}

function isOfflineAccountEventVisibleToUser(event, userId) {
  if (String(userId) === 'mocked_admin_user_id') return true;
  if (!event.user) return true;
  return String(event.user) === String(userId);
}

function sameTradeOwnerAndDealId(trade, userId, dealId) {
  return isOfflineTradeVisibleToUser(trade, userId) && String(trade.dealId) === String(dealId);
}

function sameEventOwnerAndExternalId(event, userId, externalId) {
  return isOfflineAccountEventVisibleToUser(event, userId) && String(event.externalId || '') === String(externalId || '');
}

function accountEventNetAmount(event) {
  const amount = Number(event.amount || 0);
  if (event.type === 'withdrawal') return -Math.abs(amount);
  if (event.type === 'deposit') return Math.abs(amount);
  return amount;
}

function summarizeAccountEvents(events) {
  return events.reduce((summary, event) => {
    const amount = Number(event.amount || 0);
    if (event.type === 'deposit') summary.deposits += Math.abs(amount);
    else if (event.type === 'withdrawal') summary.withdrawals += Math.abs(amount);
    else summary.adjustments += amount;
    summary.netCashFlow += accountEventNetAmount(event);
    summary.totalEvents += 1;
    return summary;
  }, { deposits: 0, withdrawals: 0, adjustments: 0, netCashFlow: 0, totalEvents: 0 });
}

function getRangeStart(range) {
  if (!range || range === 'all') return null;
  const now = new Date();
  if (range === 'today') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (range === '7d') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (range === '30d') return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (range === '3m') {
    const d = new Date();
    d.setMonth(now.getMonth() - 3);
    return d;
  }
  if (range === '6m') {
    const d = new Date();
    d.setMonth(now.getMonth() - 6);
    return d;
  }
  return null;
}

function syncLocalTrade(updatedTrade) {
  const idx = inMemoryTrades.findIndex(t => String(t._id) === String(updatedTrade._id));
  const plain = typeof updatedTrade.toObject === 'function' ? updatedTrade.toObject() : updatedTrade;
  const formatted = {
    ...plain,
    _id: String(plain._id),
    user: plain.user ? String(plain.user) : null,
    openTime: plain.openTime ? new Date(plain.openTime).toISOString() : null,
    closeTime: plain.closeTime ? new Date(plain.closeTime).toISOString() : null,
    createdAt: plain.createdAt ? new Date(plain.createdAt).toISOString() : null,
    updatedAt: plain.updatedAt ? new Date(plain.updatedAt).toISOString() : null,
  };

  if (idx === -1) inMemoryTrades.push(formatted);
  else inMemoryTrades[idx] = formatted;
  saveLocalDatabase();
}

// Sync/Backup MongoDB trades to local persistent database file
async function backupMongoToLocal() {
  try {
    if (mongoose.connection.readyState === 1) {
      console.log(' Backing up MongoDB trades to local persistent database file...');
      const [allTrades, allEvents] = await Promise.all([
        Trade.find({}).sort({ closeTime: -1 }).lean(),
        AccountEvent.find({}).sort({ occurredAt: -1 }).lean(),
      ]);
      
      // Map MongoDB _id to string for consstency
      const formattedTrades = allTrades.map(t => ({
        ...t,
        _id: String(t._id),
        user: t.user ? String(t.user) : null,
        openTime: t.openTime ? new Date(t.openTime).toISOString() : null,
        closeTime: t.closeTime ? new Date(t.closeTime).toISOString() : null,
        createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : null,
        updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : null,
      }));

      inMemoryTrades = formattedTrades;
      saveLocalDatabase();
      console.log(` Successfully backed up ${inMemoryTrades.length} trades from MongoDB to local JSON.`);

      inMemoryAccountEvents = allEvents.map(e => ({
        ...e,
        _id: String(e._id),
        user: e.user ? String(e.user) : null,
        occurredAt: e.occurredAt ? new Date(e.occurredAt).toISOString() : null,
        createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : null,
        updatedAt: e.updatedAt ? new Date(e.updatedAt).toISOString() : null,
      }));
      saveLocalAccountEvents();
      console.log(` Successfully backed up ${inMemoryAccountEvents.length} account events from MongoDB to local JSON.`);
    }
  } catch (err) {
    console.error(' Failed to backup MongoDB trades to local JSON:', err.message);
  }
}

// Subscribe to mongoose connection events to trigger backup when connection is established
mongoose.connection.on('connected', () => {
  // Wait 5 seconds to let any seeding/migrations complete first
  setTimeout(backupMongoToLocal, 5000);
  // After backup, auto-upload any offline screenshots that were saved to disk
  setTimeout(uploadOfflineScreenshots, 10000);
});

// Periodic 24-hour auto-backup of MongoDB → local JSON
setInterval(async () => {
  if (mongoose.connection.readyState === 1) {
    console.log(' [Scheduled] Running 24-hour auto-backup of MongoDB → local JSON...');
    await backupMongoToLocal();
  }
}, 24 * 60 * 60 * 1000);

// ── Offline Screenshot Auto-Upload ──────────────────────────────────────────
// When we saved screenshots to disk because MongoDB was offline, this function
// picks them up, uploads them to Cloudinary, updates the trade in MongoDB, and
// removes the local file (cleanup).
async function uploadOfflineScreenshots() {
  if (!CLOUDINARY_READY) return;
  if (mongoose.connection.readyState !== 1) return;

  try {
    // Each offline screenshot is stored at:
    //   OFFLINE_SCREENSHOTS_DIR/{tradeId}/{timestamp}_{screenshotId}.jpg
    // and a companion .meta.json file holds { tradeId, caption, userId }
    if (!fs.existsSync(OFFLINE_SCREENSHOTS_DIR)) return;

    const tradeDirs = fs.readdirSync(OFFLINE_SCREENSHOTS_DIR);
    for (const tradeId of tradeDirs) {
      const tradeDir = path.join(OFFLINE_SCREENSHOTS_DIR, tradeId);
      if (!fs.statSync(tradeDir).isDirectory()) continue;

      const files = fs.readdirSync(tradeDir);
      const metaFiles = files.filter(f => f.endsWith('.meta.json'));

      for (const metaFile of metaFiles) {
        const metaPath = path.join(tradeDir, metaFile);
        const imgFile = metaFile.replace('.meta.json', '');
        const imgPath = path.join(tradeDir, imgFile);

        if (!fs.existsSync(imgPath)) {
          // Image missing, clean up orphan meta
          fs.unlinkSync(metaPath);
          continue;
        }

        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          const trade = await Trade.findOne({ _id: meta.tradeId });
          if (!trade) {
            // Trade gone from MongoDB — remove the offline files
            fs.unlinkSync(imgPath);
            fs.unlinkSync(metaPath);
            continue;
          }

          // Build context tags with full trade metadata for reconstruction
          const contextTags = buildCloudinaryContext(trade, meta.caption);

          // Upload image from disk to Cloudinary
          const upload = await cloudinary.uploader.upload(imgPath, {
            folder: `trade-journal/${meta.userId}/${meta.tradeId}`,
            resource_type: 'image',
            context: contextTags,
            overwrite: false,
          });

          // Upload sidecar metadata.json to Cloudinary (as raw file)
          const sidecarData = JSON.stringify(buildSidecarMetadata(trade, meta.caption, upload.secure_url), null, 2);
          await cloudinary.uploader.upload(
            `data:application/json;base64,${Buffer.from(sidecarData).toString('base64')}`,
            {
              folder: `trade-journal/${meta.userId}/${meta.tradeId}`,
              public_id: `${upload.public_id.split('/').pop()}_metadata`,
              resource_type: 'raw',
              overwrite: true,
            }
          );

          // Remove the offline placeholder from trade and add Cloudinary URL
          trade.screenshots = trade.screenshots.filter(
            s => s.publicId !== `offline:${meta.tradeId}:${imgFile}`
          );
          trade.screenshots.push({
            url: upload.secure_url,
            publicId: upload.public_id,
            caption: meta.caption || '',
            uploadedAt: new Date(),
          });
          await trade.save();
          syncLocalTrade(trade);

          // Remove local files after successful upload
          fs.unlinkSync(imgPath);
          fs.unlinkSync(metaPath);
          console.log(` [OfflineSync] Uploaded offline screenshot for trade ${meta.tradeId} → Cloudinary`);

          // If trade dir is now empty, remove it
          const remaining = fs.readdirSync(tradeDir);
          if (remaining.length === 0) fs.rmdirSync(tradeDir);
        } catch (err) {
          console.error(` [OfflineSync] Failed to upload offline screenshot ${metaFile}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error(' [OfflineSync] Failed to process offline screenshots:', err.message);
  }
}

// Build Cloudinary context string with full trade metadata
function buildCloudinaryContext(trade, caption) {
  const t = typeof trade.toObject === 'function' ? trade.toObject() : trade;
  return [
    `dealId=${t.dealId}`,
    `positionId=${t.positionId || ''}`,
    `symbol=${t.symbol}`,
    `direction=${t.direction}`,
    `entryPrice=${t.entryPrice}`,
    `exitPrice=${t.exitPrice}`,
    `lotSize=${t.lotSize}`,
    `pnlUSD=${t.pnlUSD}`,
    `pnlPct=${t.pnlPct || 0}`,
    `commission=${t.commission || 0}`,
    `swap=${t.swap || 0}`,
    `openTime=${t.openTime instanceof Date ? t.openTime.toISOString() : t.openTime}`,
    `closeTime=${t.closeTime instanceof Date ? t.closeTime.toISOString() : t.closeTime}`,
    `durationMinutes=${t.durationMinutes || 0}`,
    `runningBalance=${t.runningBalance || 0}`,
    `emotion=${t.emotion || ''}`,
    `grade=${t.grade || ''}`,
    `tags=${(t.tags || []).join(',')}`,
    `caption=${(caption || '').replace(/[|=]/g, ' ').slice(0, 200)}`,
    `journalVersion=1`,
  ].join('|');
}

// Build sidecar metadata object for the companion metadata.json file
function buildSidecarMetadata(trade, caption, imageUrl) {
  const t = typeof trade.toObject === 'function' ? trade.toObject() : trade;
  return {
    _schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    imageUrl,
    caption: caption || '',
    trade: {
      _id: String(t._id),
      dealId: t.dealId,
      positionId: t.positionId || '',
      symbol: t.symbol,
      direction: t.direction,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      lotSize: t.lotSize,
      pnlUSD: t.pnlUSD,
      pnlPct: t.pnlPct || 0,
      commission: t.commission || 0,
      swap: t.swap || 0,
      openTime: t.openTime instanceof Date ? t.openTime.toISOString() : t.openTime,
      closeTime: t.closeTime instanceof Date ? t.closeTime.toISOString() : t.closeTime,
      durationMinutes: t.durationMinutes || 0,
      runningBalance: t.runningBalance || 0,
      notes: t.notes || '',
      tags: t.tags || [],
      emotion: t.emotion || '',
      grade: t.grade || '',
      checklist: t.checklist || [],
    },
  };
}

// POST /api/maintenance/resync-request  ask the local MT5 sync script to run a full sync
router.post('/maintenance/resync-request', auth, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1 || String(req.user.userId) === 'mocked_admin_user_id') {
      inMemorySyncRequests[String(req.user.userId)] = {
        forceFullSync: true,
        requestedAt: new Date().toISOString(),
        completedAt: null,
      };
      return res.json({ ok: true, forceFullSync: true, requestedAt: inMemorySyncRequests[String(req.user.userId)].requestedAt });
    }

    const request = await SyncRequest.findOneAndUpdate(
      { user: req.user.userId },
      { forceFullSync: true, requestedAt: new Date(), completedAt: null },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({ ok: true, forceFullSync: request.forceFullSync, requestedAt: request.requestedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/maintenance/resync-request  consumed by sync.py
router.get('/maintenance/resync-request', auth, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1 || String(req.user.userId) === 'mocked_admin_user_id') {
      const request = inMemorySyncRequests[String(req.user.userId)] || {};
      return res.json({
        forceFullSync: Boolean(request.forceFullSync),
        requestedAt: request.requestedAt || null,
        completedAt: request.completedAt || null,
      });
    }

    const request = await SyncRequest.findOne({ user: req.user.userId }).lean();
    res.json({
      forceFullSync: Boolean(request?.forceFullSync),
      requestedAt: request?.requestedAt || null,
      completedAt: request?.completedAt || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/maintenance/resync-complete  called by sync.py after a forced full sync
router.post('/maintenance/resync-complete', auth, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1 || String(req.user.userId) === 'mocked_admin_user_id') {
      inMemorySyncRequests[String(req.user.userId)] = {
        ...(inMemorySyncRequests[String(req.user.userId)] || {}),
        forceFullSync: false,
        completedAt: new Date().toISOString(),
      };
      return res.json({ ok: true });
    }

    await SyncRequest.findOneAndUpdate(
      { user: req.user.userId },
      { forceFullSync: false, completedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/maintenance/trades  clear this user's trade database
router.delete('/maintenance/trades', auth, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      const before = inMemoryTrades.length;
      inMemoryTrades = inMemoryTrades.filter(t => !isOfflineTradeVisibleToUser(t, req.user.userId));
      saveLocalDatabase();
      return res.json({ deleted: before - inMemoryTrades.length });
    }

    const result = await Trade.deleteMany({ user: req.user.userId });
    inMemoryTrades = inMemoryTrades.filter(t => String(t.user) !== String(req.user.userId));
    saveLocalDatabase();
    res.json({ deleted: result.deletedCount || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/maintenance/dedupe-trades  remove repeated deal IDs for this user
router.post('/maintenance/dedupe-trades', auth, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      const seen = new Set();
      const deduped = [];
      let removed = 0;
      for (const trade of inMemoryTrades) {
        if (!isOfflineTradeVisibleToUser(trade, req.user.userId)) {
          deduped.push(trade);
          continue;
        }
        const key = `${String(trade.user || req.user.userId)}:${String(trade.dealId)}`;
        if (seen.has(key)) {
          removed++;
          continue;
        }
        seen.add(key);
        deduped.push(trade);
      }
      inMemoryTrades = deduped;
      if (removed > 0) saveLocalDatabase();
      return res.json({ removed });
    }

    const duplicateGroups = await Trade.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(req.user.userId) } },
      { $sort: { createdAt: 1, _id: 1 } },
      {
        $group: {
          _id: '$dealId',
          ids: { $push: '$_id' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ]);

    const duplicateIds = duplicateGroups.flatMap(group => group.ids.slice(1));
    let removed = 0;
    if (duplicateIds.length > 0) {
      const result = await Trade.deleteMany({ _id: { $in: duplicateIds }, user: req.user.userId });
      removed = result.deletedCount || 0;
    }

    inMemoryTrades = inMemoryTrades.filter(t => {
      if (String(t.user) !== String(req.user.userId)) return true;
      return !duplicateIds.some(id => String(id) === String(t._id));
    });
    if (removed > 0) saveLocalDatabase();

    res.json({ removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/maintenance/recalculate-balances
// Re-derive each trade's runningBalance from the known current balance and P&L history.
// This fixes incorrect balances stored by old versions of sync.py without losing journal data.
router.post('/maintenance/recalculate-balances', auth, async (req, res) => {
  try {
    // The current MT5 balance is passed in from the client (or we use the latest stored balance)
    const currentBalance = req.body.currentBalance != null ? Number(req.body.currentBalance) : null;

    if (mongoose.connection.readyState !== 1) {
      // Offline mode: work on inMemoryTrades
      let userTrades = inMemoryTrades
        .filter(t => isOfflineTradeVisibleToUser(t, req.user.userId))
        .sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime)); // oldest first

      if (userTrades.length === 0) return res.json({ updated: 0 });

      // Anchor from known current balance if provided, otherwise latest stored balance
      const latestBal = currentBalance != null
        ? currentBalance
        : Number(userTrades[userTrades.length - 1].runningBalance || 0);

      // Walk backward from latest: latestBal is balance AFTER the last trade
      // So balance BEFORE last trade = latestBal - (pnlUSD + commission + swap) of last trade
      // Then walk forward to assign each trade's running balance
      const totalNet = userTrades.reduce((s, t) => s + Number(t.pnlUSD || 0) + Number(t.commission || 0) + Number(t.swap || 0), 0);
      let runBal = latestBal - totalNet; // balance before first trade
      let updated = 0;

      for (const trade of userTrades) {
        runBal += Number(trade.pnlUSD || 0) + Number(trade.commission || 0) + Number(trade.swap || 0);
        const newBal = Math.round(runBal * 100) / 100;
        const idx = inMemoryTrades.findIndex(t => String(t._id) === String(trade._id));
        if (idx !== -1 && Math.abs(Number(inMemoryTrades[idx].runningBalance) - newBal) > 0.001) {
          inMemoryTrades[idx].runningBalance = newBal;
          updated++;
        }
      }

      if (updated > 0) saveLocalDatabase();
      return res.json({ updated, latestBalance: latestBal });
    }

    // MongoDB mode
    const userTrades = await Trade.find({ user: req.user.userId })
      .sort({ closeTime: 1 })
      .select('_id pnlUSD commission swap runningBalance closeTime');

    if (userTrades.length === 0) return res.json({ updated: 0 });

    const latestBal = currentBalance != null
      ? currentBalance
      : Number(userTrades[userTrades.length - 1].runningBalance || 0);

    const totalNet = userTrades.reduce((s, t) => s + Number(t.pnlUSD || 0) + Number(t.commission || 0) + Number(t.swap || 0), 0);
    let runBal = latestBal - totalNet;
    let updated = 0;
    const bulkOps = [];

    for (const trade of userTrades) {
      runBal += Number(trade.pnlUSD || 0) + Number(trade.commission || 0) + Number(trade.swap || 0);
      const newBal = Math.round(runBal * 100) / 100;
      if (Math.abs(Number(trade.runningBalance) - newBal) > 0.001) {
        bulkOps.push({ updateOne: { filter: { _id: trade._id }, update: { $set: { runningBalance: newBal } } } });
        updated++;
      }
    }

    if (bulkOps.length > 0) await Trade.bulkWrite(bulkOps);

    // Sync to inMemoryTrades
    for (const op of bulkOps) {
      const idx = inMemoryTrades.findIndex(t => String(t._id) === String(op.updateOne.filter._id));
      if (idx !== -1) inMemoryTrades[idx].runningBalance = op.updateOne.update.$set.runningBalance;
    }
    if (updated > 0) saveLocalDatabase();

    res.json({ updated, latestBalance: latestBal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/account-events  deposits, withdrawals, and account adjustments
router.get('/account-events', auth, async (req, res) => {
  try {
    const { range, limit = 25 } = req.query;
    const fromDate = getRangeStart(range);
    const max = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);

    if (mongoose.connection.readyState !== 1) {
      let events = inMemoryAccountEvents.filter(e => isOfflineAccountEventVisibleToUser(e, req.user.userId));
      if (fromDate) events = events.filter(e => new Date(e.occurredAt) >= fromDate);
      events.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
      return res.json({
        events: events.slice(0, max),
        summary: summarizeAccountEvents(events),
      });
    }

    const query = { user: req.user.userId };
    if (fromDate) query.occurredAt = { $gte: fromDate };
    const events = await AccountEvent.find(query).sort({ occurredAt: -1 }).limit(max).lean();
    const summaryEvents = await AccountEvent.find(query).select('type amount').lean();

    res.json({
      events,
      summary: summarizeAccountEvents(summaryEvents),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/account-events  manually record a deposit, withdrawal, or adjustment
router.post('/account-events', auth, async (req, res) => {
  try {
    const type = String(req.body.type || '').toLowerCase();
    const amount = Number(req.body.amount);
    const occurredAt = req.body.occurredAt ? new Date(req.body.occurredAt) : new Date();
    const note = String(req.body.note || '').trim();

    if (!['deposit', 'withdrawal', 'adjustment'].includes(type)) {
      return res.status(400).json({ error: 'type must be deposit, withdrawal, or adjustment' });
    }
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'amount must be a non-zero number' });
    }
    if (Number.isNaN(occurredAt.getTime())) {
      return res.status(400).json({ error: 'occurredAt must be a valid date' });
    }

    const normalizedAmount = type === 'adjustment' ? amount : Math.abs(amount);

    if (mongoose.connection.readyState !== 1) {
      const event = {
        _id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type,
        amount: normalizedAmount,
        currency: 'USD',
        occurredAt: occurredAt.toISOString(),
        note,
        source: 'manual',
        externalId: '',
        balanceAfter: req.body.balanceAfter == null ? null : Number(req.body.balanceAfter),
        user: req.user.userId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      inMemoryAccountEvents.push(event);
      saveLocalAccountEvents();
      return res.status(201).json({ event });
    }

    const event = await AccountEvent.create({
      type,
      amount: normalizedAmount,
      currency: 'USD',
      occurredAt,
      note,
      source: 'manual',
      balanceAfter: req.body.balanceAfter == null ? null : Number(req.body.balanceAfter),
      user: req.user.userId,
    });

    inMemoryAccountEvents.push({
      ...event.toObject(),
      _id: String(event._id),
      user: String(event.user),
      occurredAt: event.occurredAt ? new Date(event.occurredAt).toISOString() : null,
      createdAt: event.createdAt ? new Date(event.createdAt).toISOString() : null,
      updatedAt: event.updatedAt ? new Date(event.updatedAt).toISOString() : null,
    });
    saveLocalAccountEvents();

    res.status(201).json({ event });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/account-events/:id  remove a manual cash-flow entry
router.delete('/account-events/:id', auth, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      const before = inMemoryAccountEvents.length;
      inMemoryAccountEvents = inMemoryAccountEvents.filter(e => {
        if (String(e._id) !== String(req.params.id)) return true;
        return !isOfflineAccountEventVisibleToUser(e, req.user.userId);
      });
      const deleted = before - inMemoryAccountEvents.length;
      if (deleted > 0) saveLocalAccountEvents();
      return res.json({ deleted });
    }

    const result = await AccountEvent.deleteOne({ _id: req.params.id, user: req.user.userId });
    inMemoryAccountEvents = inMemoryAccountEvents.filter(e => String(e._id) !== String(req.params.id));
    if (result.deletedCount > 0) saveLocalAccountEvents();
    res.json({ deleted: result.deletedCount || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync-account-events  receive MT5 balance operations from sync.py
router.post('/sync-account-events', auth, async (req, res) => {
  try {
    const { events } = req.body;
    if (!Array.isArray(events)) {
      return res.status(400).json({ error: 'events array is required' });
    }

    let inserted = 0;
    let skipped = 0;

    if (mongoose.connection.readyState !== 1) {
      for (const e of events) {
        const externalId = String(e.externalId || '');
        if (!externalId || inMemoryAccountEvents.some(x => sameEventOwnerAndExternalId(x, req.user.userId, externalId))) {
          skipped++;
          continue;
        }

        const type = ['deposit', 'withdrawal', 'adjustment'].includes(String(e.type)) ? String(e.type) : 'adjustment';
        const amount = type === 'adjustment' ? Number(e.amount || 0) : Math.abs(Number(e.amount || 0));
        const event = {
          _id: externalId,
          type,
          amount,
          currency: e.currency || 'USD',
          occurredAt: e.occurredAt || new Date().toISOString(),
          note: String(e.note || ''),
          source: 'mt5',
          externalId,
          balanceAfter: e.balanceAfter == null ? null : Number(e.balanceAfter),
          user: req.user.userId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        inMemoryAccountEvents.push(event);
        inserted++;
      }
      if (inserted > 0) saveLocalAccountEvents();
      return res.json({ inserted, skipped, total: events.length });
    }

    for (const e of events) {
      const externalId = String(e.externalId || '');
      if (!externalId) {
        skipped++;
        continue;
      }

      const existing = await AccountEvent.findOne({ user: req.user.userId, externalId }).select('_id');
      if (existing) {
        skipped++;
        continue;
      }

      const type = ['deposit', 'withdrawal', 'adjustment'].includes(String(e.type)) ? String(e.type) : 'adjustment';
      const amount = type === 'adjustment' ? Number(e.amount || 0) : Math.abs(Number(e.amount || 0));
      const created = await AccountEvent.create({
        type,
        amount,
        currency: e.currency || 'USD',
        occurredAt: e.occurredAt ? new Date(e.occurredAt) : new Date(),
        note: String(e.note || ''),
        source: 'mt5',
        externalId,
        balanceAfter: e.balanceAfter == null ? null : Number(e.balanceAfter),
        user: req.user.userId,
      });

      inMemoryAccountEvents.push({
        ...created.toObject(),
        _id: String(created._id),
        user: String(created.user),
        occurredAt: created.occurredAt ? new Date(created.occurredAt).toISOString() : null,
        createdAt: created.createdAt ? new Date(created.createdAt).toISOString() : null,
        updatedAt: created.updatedAt ? new Date(created.updatedAt).toISOString() : null,
      });
      inserted++;
    }

    if (inserted > 0) saveLocalAccountEvents();
    res.json({ inserted, skipped, total: events.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//  GET /api/performance  equty curve + full rsk metrics 
router.get('/performance', auth, async (req, res) => {
  try {
    const { range } = req.query;

    // Buld date filter
    let fromDate = null;
    const now = new Date();
    if (range === '7d')  fromDate = new Date(now - 7  * 86400000);
    if (range === '30d') fromDate = new Date(now - 30 * 86400000);
    if (range === '3m')  fromDate = new Date(now - 90 * 86400000);
    if (range === '6m')  fromDate = new Date(now - 180 * 86400000);
    if (range === '1y')  fromDate = new Date(now - 365 * 86400000);

    let trades;
    if (mongoose.connection.readyState === 1) {
      const q = { user: req.user.userId };
      if (fromDate) q.closeTime = { $gte: fromDate };
      trades = await Trade.find(q)
        .sort({ closeTime: 1 })
        .select('closeTime openTime pnlUSD runningBalance symbol direction lotSize commission swap');
    } else {
      trades = inMemoryTrades
        .filter(t => {
          if (String(t.user) !== String(req.user.userId)) return false;
          if (fromDate && new Date(t.closeTime) < fromDate) return false;
          return true;
        })
        .sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));
    } if (trades.length === 0) {
      return res.json({ equityCurve: [], drawdownCurve: [], stats: null });
    }

    //  Equty curve + drawdown 
    let peakBalance = -Infinity;
    const equityCurve = [];

    for (const t of trades) {
      const bal = Number(t.runningBalance || 0);
      if (bal > peakBalance) peakBalance = bal;
      const drawdownPct = peakBalance > 0 ? ((bal - peakBalance) / peakBalance) * 100 : 0;
      equityCurve.push({
        date:        t.closeTime,
        balance:     parseFloat(bal.toFixed(2)),
        drawdown:    parseFloat(drawdownPct.toFixed(2)),
        pnl:         parseFloat(Number(t.pnlUSD).toFixed(2)),
        symbol:      t.symbol,
        direction:   t.direction,
      });
    }

    //  Rsk stats 
    const wins   = trades.filter(t => Number(t.pnlUSD) > 0);
    const losses = trades.filter(t => Number(t.pnlUSD) < 0);

    const grossProfit = wins.reduce((s, t)   => s + Number(t.pnlUSD), 0);
    const grossLoss   = Math.abs(losses.reduce((s, t) => s + Number(t.pnlUSD), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    const avgWin  = wins.length   > 0 ? grossProfit / wins.length   : 0;
    const avgLoss = losses.length > 0 ? grossLoss   / losses.length : 0;
    const rrRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

    const winRate    = (wins.length / trades.length) * 100;
    const expectancy = (winRate / 100) * avgWin - ((100 - winRate) / 100) * avgLoss;

    // Max drawdown %
    let peakBal = -Infinity, maxDD = 0;
    for (const t of trades) {
      const b = Number(t.runningBalance);
      if (b > peakBal) peakBal = b;
      const dd = peakBal > 0 ? ((b - peakBal) / peakBal) * 100 : 0;
      if (dd < maxDD) maxDD = dd;
    }

    // Max consecutve wins / losses
    let maxConsecW = 0, curW = 0, maxConsecL = 0, curL = 0;
    for (const t of trades) {
      if (Number(t.pnlUSD) > 0) { curW++; curL = 0; maxConsecW = Math.max(maxConsecW, curW); }
      else                       { curL++; curW = 0; maxConsecL = Math.max(maxConsecL, curL); }
    }

    // Largest single wn / loss
    const largestWin  = wins.length   > 0 ? Math.max(...wins.map(t => Number(t.pnlUSD))) : 0;
    const largestLoss = losses.length > 0 ? Math.min(...losses.map(t => Number(t.pnlUSD))) : 0;

    // Net P&L and overall account growth
    const startBal   = Number(trades[0].runningBalance) - Number(trades[0].pnlUSD);
    const currentBal = Number(trades[trades.length - 1].runningBalance);
    const netPnL     = currentBal - startBal;
    const growthPct  = startBal > 0 ? (netPnL / startBal) * 100 : 0;

    res.json({
      equityCurve,
      stats: {
        totalTrades:    trades.length,
        winRate:        parseFloat(winRate.toFixed(1)),
        profitFactor:   parseFloat(profitFactor.toFixed(2)),
        avgWin:         parseFloat(avgWin.toFixed(2)),
        avgLoss:        parseFloat(avgLoss.toFixed(2)),
        rrRatio:        parseFloat(rrRatio.toFixed(2)),
        expectancy:     parseFloat(expectancy.toFixed(2)),
        maxDrawdownPct: parseFloat(maxDD.toFixed(2)),
        maxConsecWins:  maxConsecW,
        maxConsecLosses:maxConsecL,
        largestWin:     parseFloat(largestWin.toFixed(2)),
        largestLoss:    parseFloat(largestLoss.toFixed(2)),
        grossProfit:    parseFloat(grossProfit.toFixed(2)),
        grossLoss:      parseFloat(grossLoss.toFixed(2)),
        netPnL:         parseFloat(netPnL.toFixed(2)),
        growthPct:      parseFloat(growthPct.toFixed(2)),
        startBalance:   parseFloat(startBal.toFixed(2)),
        currentBalance: parseFloat(currentBal.toFixed(2)),
      },
    });
  } catch (err) {
    console.error('Performance route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});



const DEFAULT_CHECKLST = [
  { rule: 'HTF Trend Algned', complied: false },
  { rule: 'Daly/H4 Key Level Tap', complied: false },
  { rule: 'Confluence / Confrmaton Entry', complied: false },
  { rule: 'Rsk-to-Reward Rato >= 1:2', complied: false },
  { rule: 'Stop Loss and Take Proft Defned', complied: false },
];

// GET /api/trades  all trades, newest frst, wth optonal flters
router.get('/trades', auth, async (req, res) => {
  try {
    const { symbol, direction, from, to, page = 1, limit = 50 } = req.query;

    // Database Offlne Fallback
    if (mongoose.connection.readyState !== 1) {
      let filtered = inMemoryTrades.filter(t => isOfflineTradeVisibleToUser(t, req.user.userId));
      if (symbol) filtered = filtered.filter(t => t.symbol === symbol.toUpperCase());
      if (direction) filtered = filtered.filter(t => t.direction === direction.toUpperCase());
      if (from) filtered = filtered.filter(t => new Date(t.closeTime) >= new Date(from));
      if (to) filtered = filtered.filter(t => new Date(t.closeTime) <= new Date(to));

      // Sort newest frst
      filtered.sort((a, b) => new Date(b.closeTime) - new Date(a.closeTime));

      const skp = (parseInt(page) - 1) * parseInt(limit);
      const paginated = filtered.slice(skp, skp + parseInt(limit));

      return res.json({
        trades: paginated,
        total: filtered.length,
        page: parseInt(page),
        limit: parseInt(limit)
      });
    }

    const query = { user: req.user.userId };
    if (symbol) query.symbol = symbol.toUpperCase();
    if (direction) query.direction = query.direction = direction.toUpperCase();
    if (from || to) {
      query.closeTime = {};
      if (from) query.closeTime.$gte = new Date(from);
      if (to) query.closeTime.$lte = new Date(to);
    }

    const skp = (parseInt(page) - 1) * parseInt(limit);
    const [trades, total] = await Promise.all([
      Trade.find(query).sort({ closeTime: -1 }).skip(skp).limit(parseInt(limit)),
      Trade.countDocuments(query),
    ]);

    res.json({ trades, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/trades/:id  update journal data (notes, tags, emotion, grade, checklist + Edge Coach fields)
router.put('/trades/:id', auth, async (req, res) => {
  try {
    const {
      notes, tags, emotion, grade, checklist,
      // Edge Coach fields
      analysisGrade, executionGrade,
      plannedRR, exitReason, manuallyIntervened,
      confidenceRating, accountType,
      isReEntry, tradeGroup,
      primarySetup, setupConfirmations,
      executionChecklist,
    } = req.body;

    // Helper to apply all fields to a trade object
    function applyFields(t) {
      if (notes !== undefined) t.notes = notes;
      if (tags !== undefined) t.tags = Array.isArray(tags) ? tags : [];
      if (emotion !== undefined) t.emotion = emotion;
      if (grade !== undefined) t.grade = grade;
      if (checklist !== undefined) t.checklist = Array.isArray(checklist) ? checklist : [];
      // Edge Coach
      if (analysisGrade !== undefined) t.analysisGrade = analysisGrade;
      if (executionGrade !== undefined) t.executionGrade = executionGrade;
      if (plannedRR !== undefined) t.plannedRR = plannedRR === '' ? null : Number(plannedRR) || null;
      if (exitReason !== undefined) t.exitReason = exitReason;
      if (manuallyIntervened !== undefined) t.manuallyIntervened = manuallyIntervened === null ? null : Boolean(manuallyIntervened);
      if (confidenceRating !== undefined) t.confidenceRating = confidenceRating === '' ? null : Number(confidenceRating) || null;
      if (accountType !== undefined) t.accountType = accountType;
      if (isReEntry !== undefined) t.isReEntry = Boolean(isReEntry);
      if (tradeGroup !== undefined) t.tradeGroup = String(tradeGroup || '').trim().slice(0, 60);
      if (primarySetup !== undefined) t.primarySetup = primarySetup;
      if (setupConfirmations !== undefined) t.setupConfirmations = Array.isArray(setupConfirmations) ? setupConfirmations : [];
      if (executionChecklist !== undefined) t.executionChecklist = Array.isArray(executionChecklist) ? executionChecklist : [];
      return t;
    }

    // Database Offline Fallback
    if (mongoose.connection.readyState !== 1) {
      const tradeIdx = inMemoryTrades.findIndex(t => t._id === req.params.id);
      if (tradeIdx === -1) return res.status(404).json({ error: 'Trade not found' });
      inMemoryTrades[tradeIdx] = applyFields(inMemoryTrades[tradeIdx]);
      saveLocalDatabase();
      return res.json(inMemoryTrades[tradeIdx]);
    }

    const update = {};
    if (notes !== undefined) update.notes = notes;
    if (tags !== undefined) update.tags = Array.isArray(tags) ? tags : [];
    if (emotion !== undefined) update.emotion = emotion;
    if (grade !== undefined) update.grade = grade;
    if (checklist !== undefined) update.checklist = Array.isArray(checklist) ? checklist : [];
    if (analysisGrade !== undefined) update.analysisGrade = analysisGrade;
    if (executionGrade !== undefined) update.executionGrade = executionGrade;
    if (plannedRR !== undefined) update.plannedRR = plannedRR === '' ? null : Number(plannedRR) || null;
    if (exitReason !== undefined) update.exitReason = exitReason;
    if (manuallyIntervened !== undefined) update.manuallyIntervened = manuallyIntervened === null ? null : Boolean(manuallyIntervened);
    if (confidenceRating !== undefined) update.confidenceRating = confidenceRating === '' ? null : Number(confidenceRating) || null;
    if (accountType !== undefined) update.accountType = accountType;
    if (isReEntry !== undefined) update.isReEntry = Boolean(isReEntry);
    if (tradeGroup !== undefined) update.tradeGroup = String(tradeGroup || '').trim().slice(0, 60);
    if (primarySetup !== undefined) update.primarySetup = primarySetup;
    if (setupConfirmations !== undefined) update.setupConfirmations = Array.isArray(setupConfirmations) ? setupConfirmations : [];
    if (executionChecklist !== undefined) update.executionChecklist = Array.isArray(executionChecklist) ? executionChecklist : [];

    const updated = await Trade.findOneAndUpdate(
      { _id: req.params.id, user: req.user.userId },
      update,
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: 'Trade not found' });

    // Mirror to inMemoryTrades and local JSON
    const tradeIdx = inMemoryTrades.findIndex(t => String(t._id) === String(req.params.id));
    if (tradeIdx !== -1) {
      inMemoryTrades[tradeIdx] = applyFields(inMemoryTrades[tradeIdx]);
      saveLocalDatabase();
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/trades/:id/screenshots  upload a manually captured chart screenshot
router.post('/trades/:id/screenshots', auth, async (req, res) => {
  try {
    const { imageData, caption = '' } = req.body;
    if (!imageData || typeof imageData !== 'string' || !imageData.startsWith('data:image/')) {
      return res.status(400).json({ error: 'imageData must be a base64 data URL image.' });
    }

    // ── OFFLINE MODE: Save screenshot to disk ────────────────────────────────
    if (mongoose.connection.readyState !== 1) {
      const offlineTrade = inMemoryTrades.find(
        t => String(t._id) === String(req.params.id) && isOfflineTradeVisibleToUser(t, req.user.userId)
      );
      if (!offlineTrade) {
        return res.status(404).json({ error: 'Trade not found' });
      }

      const tradeDir = path.join(OFFLINE_SCREENSHOTS_DIR, String(req.params.id));
      if (!fs.existsSync(tradeDir)) fs.mkdirSync(tradeDir, { recursive: true });

      // Decode base64 and write raw image to disk
      const matches = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
      const ext = matches ? matches[1] : 'jpg';
      const rawBase64 = matches ? matches[2] : imageData.split(',')[1];
      const timestamp = Date.now();
      const imgFileName = `${timestamp}_offline.${ext}`;
      const imgPath = path.join(tradeDir, imgFileName);
      fs.writeFileSync(imgPath, Buffer.from(rawBase64, 'base64'));

      // Write companion .meta.json sidecar for auto-upload later
      const metaPath = path.join(tradeDir, `${imgFileName}.meta.json`);
      const offlineMeta = {
        tradeId: String(req.params.id),
        userId: String(req.user.userId),
        caption: String(caption).trim().slice(0, 180),
        savedAt: new Date().toISOString(),
        trade: {
          dealId: offlineTrade.dealId,
          positionId: offlineTrade.positionId || '',
          symbol: offlineTrade.symbol,
          direction: offlineTrade.direction,
          entryPrice: offlineTrade.entryPrice,
          exitPrice: offlineTrade.exitPrice,
          lotSize: offlineTrade.lotSize,
          pnlUSD: offlineTrade.pnlUSD,
          pnlPct: offlineTrade.pnlPct || 0,
          commission: offlineTrade.commission || 0,
          swap: offlineTrade.swap || 0,
          openTime: offlineTrade.openTime,
          closeTime: offlineTrade.closeTime,
          durationMinutes: offlineTrade.durationMinutes || 0,
          runningBalance: offlineTrade.runningBalance || 0,
          notes: offlineTrade.notes || '',
          tags: offlineTrade.tags || [],
          emotion: offlineTrade.emotion || '',
          grade: offlineTrade.grade || '',
        },
      };
      fs.writeFileSync(metaPath, JSON.stringify(offlineMeta, null, 2), 'utf8');

      // Add a local-file placeholder entry to the trade so UI can preview it
      const localUrl = `/public/screenshots/${req.params.id}/${imgFileName}`;
      const localPublicId = `offline:${req.params.id}:${imgFileName}`;
      const tradeIdx = inMemoryTrades.findIndex(t => String(t._id) === String(req.params.id));
      if (tradeIdx !== -1) {
        if (!Array.isArray(inMemoryTrades[tradeIdx].screenshots)) {
          inMemoryTrades[tradeIdx].screenshots = [];
        }
        inMemoryTrades[tradeIdx].screenshots.push({
          url: localUrl,
          publicId: localPublicId,
          caption: String(caption).trim().slice(0, 180),
          uploadedAt: new Date().toISOString(),
          offlinePending: true,
        });
        saveLocalDatabase();
      }

      return res.json({
        ...offlineTrade,
        screenshots: inMemoryTrades[tradeIdx]?.screenshots || [],
        _offlineScreenshot: true,
        _message: 'Screenshot saved locally. Will be uploaded to Cloudinary when MongoDB reconnects.',
      });
    }

    // ── ONLINE MODE: Upload to Cloudinary with full metadata ─────────────────
    if (!CLOUDINARY_READY) {
      return res.status(500).json({ error: 'Cloudinary is not configured on the backend.' });
    }

    const trade = await Trade.findOne({ _id: req.params.id, user: req.user.userId });
    if (!trade) {
      return res.status(404).json({ error: 'Trade not found' });
    }

    // Build Cloudinary context tags with all trade metadata for reconstruction
    const contextTags = buildCloudinaryContext(trade, caption);

    const upload = await cloudinary.uploader.upload(imageData, {
      folder: `trade-journal/${req.user.userId}/${trade._id}`,
      resource_type: 'image',
      context: contextTags,
      overwrite: false,
    });

    // Upload sidecar metadata.json to Cloudinary alongside the image (as raw)
    const sidecarData = JSON.stringify(buildSidecarMetadata(trade, caption, upload.secure_url), null, 2);
    try {
      await cloudinary.uploader.upload(
        `data:application/json;base64,${Buffer.from(sidecarData).toString('base64')}`,
        {
          folder: `trade-journal/${req.user.userId}/${trade._id}`,
          public_id: `${upload.public_id.split('/').pop()}_metadata`,
          resource_type: 'raw',
          overwrite: true,
        }
      );
    } catch (sidecarErr) {
      // Non-fatal — image already uploaded, sidecar failure should not block
      console.warn('Sidecar metadata upload failed (non-fatal):', sidecarErr.message);
    }

    trade.screenshots.push({
      url: upload.secure_url,
      publicId: upload.public_id,
      caption: String(caption).trim().slice(0, 180),
      uploadedAt: new Date(),
    });

    await trade.save();
    syncLocalTrade(trade);
    res.json(trade);
  } catch (err) {
    console.error('Screenshot upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/trades/:id/screenshots/:screenshotId  update screenshot caption
router.patch('/trades/:id/screenshots/:screenshotId', auth, async (req, res) => {
  try {
    const { caption = '' } = req.body;

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'Screenshot captions require MongoDB to be connected.' });
    }

    const trade = await Trade.findOne({ _id: req.params.id, user: req.user.userId });
    if (!trade) {
      return res.status(404).json({ error: 'Trade not found' });
    }

    const screenshot = trade.screenshots.id(req.params.screenshotId);
    if (!screenshot) {
      return res.status(404).json({ error: 'Screenshot not found' });
    }

    screenshot.caption = String(caption).trim().slice(0, 180);
    await trade.save();
    syncLocalTrade(trade);
    res.json(trade);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/trades/:id/screenshots/:screenshotId  remove a screenshot from Cloudinary and the trade
router.delete('/trades/:id/screenshots/:screenshotId', auth, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'Screenshot deletes require MongoDB to be connected.' });
    }

    const trade = await Trade.findOne({ _id: req.params.id, user: req.user.userId });
    if (!trade) {
      return res.status(404).json({ error: 'Trade not found' });
    }

    const screenshot = trade.screenshots.id(req.params.screenshotId);
    if (!screenshot) {
      return res.status(404).json({ error: 'Screenshot not found' });
    }

    if (CLOUDINARY_READY && screenshot.publicId) {
      await cloudinary.uploader.destroy(screenshot.publicId, { resource_type: 'image' });
    }

    screenshot.deleteOne();
    await trade.save();
    syncLocalTrade(trade);
    res.json(trade);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync  receve trades from Python scrpt
router.post('/sync', auth, async (req, res) => {
  try {
    const { trades } = req.body;
    if (!Array.isArray(trades) || trades.length === 0) {
      return res.status(400).json({ error: 'trades array is required' });
    }

    let inserted = 0;
    let skipped = 0;

    // Database Offlne Fallback
    if (mongoose.connection.readyState !== 1) {
      for (const t of trades) {
        const exists = inMemoryTrades.some(x => sameTradeOwnerAndDealId(x, req.user.userId, t.dealId));
        if (exists) {
          skipped++;
          continue;
        }

        const newTrade = {
          _id: String(t.dealId),
          dealId: String(t.dealId),
          positionId: String(t.positionId || ''),
          symbol: t.symbol,
          direction: t.direction,
          entryPrice: Number(t.entryPrice),
          exitPrice: Number(t.exitPrice),
          lotSize: Number(t.lotSize),
          pnlUSD: Number(t.pnlUSD),
          pnlPct: Number(t.pnlPct || 0),
          commission: Number(t.commission || 0),
          swap: Number(t.swap || 0),
          openTime: t.openTime,
          closeTime: t.closeTime,
          durationMinutes: Number(t.durationMinutes || 0),
          runningBalance: Number(t.runningBalance || 0),
          checklist: DEFAULT_CHECKLST,
          user: req.user.userId,
          synced: new Date().toISOString()
        };

        inMemoryTrades.push(newTrade);
        inserted++;
      } if (inserted > 0) {
        saveLocalDatabase();
      }

      return res.json({ inserted, skipped, total: trades.length });
    }

    for (const t of trades) {
      try {
        const existing = await Trade.findOne({
          user: req.user.userId,
          dealId: String(t.dealId),
        }).select('_id');

        if (existing) {
          skipped++;
          continue;
        }

        const created = await Trade.create({
          dealId:     String(t.dealId),
          positionId: String(t.positionId || ''),
          symbol: t.symbol,
          direction: t.direction,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          lotSize: t.lotSize,
          pnlUSD: t.pnlUSD,
          pnlPct: t.pnlPct || 0,
          commission: t.commission || 0,
          swap: t.swap || 0,
          openTime: new Date(t.openTime),
          closeTime: new Date(t.closeTime),
          durationMinutes: t.durationMinutes || 0,
          runningBalance: t.runningBalance || 0,
          checklist: DEFAULT_CHECKLST,
          user: req.user.userId,
        });

        // Mrror to inMemoryTrades
        const exists = inMemoryTrades.some(x => sameTradeOwnerAndDealId(x, req.user.userId, t.dealId));
        if (!exists) {
          inMemoryTrades.push({
            ...created.toObject(),
            _id: String(created._id),
            user: String(created.user),
            openTime: created.openTime ? new Date(created.openTime).toISOString() : null,
            closeTime: created.closeTime ? new Date(created.closeTime).toISOString() : null,
          });
        }

        inserted++;
      } catch (e) {
        if (e.code === 11000) {
          skipped++;
        } else {
          throw e;
        }
      }
    } if (inserted > 0) {
      saveLocalDatabase();
    }

    res.json({ inserted, skipped, total: trades.length });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats  aggregated performance metrics
router.get('/stats', auth, async (req, res) => {
  try {
    const { range } = req.query;
    let trades;

    // Database Offlne Fallback
    if (mongoose.connection.readyState !== 1) {
      let filtered = inMemoryTrades.filter(t => isOfflineTradeVisibleToUser(t, req.user.userId));
      if (range && range !== 'all') {
        const now = new Date();
        if (range === 'today') {
          const todayStr = now.toISOString().split('T')[0];
          filtered = filtered.filter(t => t.closeTime.startsWith(todayStr));
        } else if (range === '7d') {
          const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          filtered = filtered.filter(t => new Date(t.closeTime) >= sevenDaysAgo);
        } else if (range === '30d') {
          const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          filtered = filtered.filter(t => new Date(t.closeTime) >= thirtyDaysAgo);
        } else if (range === '3m') {
          const threeMonthsAgo = new Date();
          threeMonthsAgo.setMonth(now.getMonth() - 3);
          filtered = filtered.filter(t => new Date(t.closeTime) >= threeMonthsAgo);
        } else if (range === '6m') {
          const sixMonthsAgo = new Date();
          sixMonthsAgo.setMonth(now.getMonth() - 6);
          filtered = filtered.filter(t => new Date(t.closeTime) >= sixMonthsAgo);
        }
      }
      filtered.sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));
      trades = filtered;
    } else {
      const query = { user: req.user.userId };
      if (range && range !== 'all') {
        const now = new Date();
        if (range === 'today') {
          const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
          query.closeTime = { $gte: today };
        } else if (range === '7d') {
          const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          query.closeTime = { $gte: sevenDaysAgo };
        } else if (range === '30d') {
          const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          query.closeTime = { $gte: thirtyDaysAgo };
        } else if (range === '3m') {
          const threeMonthsAgo = new Date();
          threeMonthsAgo.setMonth(now.getMonth() - 3);
          query.closeTime = { $gte: threeMonthsAgo };
        } else if (range === '6m') {
          const sixMonthsAgo = new Date();
          sixMonthsAgo.setMonth(now.getMonth() - 6);
          query.closeTime = { $gte: sixMonthsAgo };
        }
      }
      trades = await Trade.find(query).sort({ closeTime: 1 });
    } if (trades.length === 0) {
      return res.json({
        totalTrades: 0, winRate: 0, profitFactor: 0, netPnL: 0,
        biggestWin: 0, biggestLoss: 0, currentDrawdown: 0,
        equityCurve: [], bySymbol: [], byDayOfWeek: [], byMonth: [],
        avgDurationMin: 0,
        avgWinUSD: 0, avgLossUSD: 0, winLossRatio: 0, expectancyUSD: 0,
        maxWinStreak: 0, maxLossStreak: 0, sharpeRatio: 0,
        bySession: [], byTag: [], byEmotion: [], byGrade: [], globalComplianceRate: 0
      });
    }

    const wins = trades.filter(t => t.pnlUSD > 0);
    const losses = trades.filter(t => t.pnlUSD < 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnlUSD, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUSD, 0));
    const netPnL = trades.reduce((s, t) => s + t.pnlUSD, 0);

    // Equty curve (running balance over time)
    const equityCurve = trades.map(t => ({
      date: t.closeTime,
      balance: t.runningBalance,
      pnl: t.pnlUSD,
    }));

    // Drawdown: peak-to-trough on running balance
    let peak = -Infinity;
    let maxDrawdownPct = 0;
    for (const t of trades) {
      if (t.runningBalance > peak) peak = t.runningBalance;
      const dd = peak > 0 ? ((peak - t.runningBalance) / peak) * 100 : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
    const lastBalance = trades[trades.length - 1]?.runningBalance || 0;
    const currentDrawdown = peak > 0 ? ((peak - lastBalance) / peak) * 100 : 0;

    // Advanced Metrcs
    const avgWinUSD = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLossUSD = losses.length > 0 ? grossLoss / losses.length : 0;
    const winLossRatio = avgLossUSD > 0 ? avgWinUSD / avgLossUSD : avgWinUSD > 0 ? Infinity : 0;
    
    const winRate = (wins.length / trades.length) * 100;
    const lossRate = 100 - winRate;
    const expectancyUSD = (winRate / 100 * avgWinUSD) - (lossRate / 100 * avgLossUSD);

    // Wn/Loss Streaks
    let currentWnStreak = 0;
    let currentLossStreak = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    for (const t of trades) {
      if (t.pnlUSD > 0) {
        currentWnStreak++;
        currentLossStreak = 0;
        if (currentWnStreak > maxWinStreak) maxWinStreak = currentWnStreak;
      } else if (t.pnlUSD < 0) {
        currentLossStreak++;
        currentWnStreak = 0;
        if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
      }
    }

    // Sharpe Rato
    const meanPnL = netPnL / trades.length;
    const variance = trades.reduce((s, t) => s + Math.pow(t.pnlUSD - meanPnL, 2), 0) / trades.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? meanPnL / stdDev : 0;

    // P&L by symbol
    const symbolMap = {};
    for (const t of trades) {
      if (!symbolMap[t.symbol]) symbolMap[t.symbol] = { symbol: t.symbol, pnl: 0, trades: 0, wins: 0 };
      symbolMap[t.symbol].pnl += t.pnlUSD;
      symbolMap[t.symbol].trades++;
      if (t.pnlUSD > 0) symbolMap[t.symbol].wins++;
    }
    const bySymbol = Object.values(symbolMap).map(s => ({
      ...s,
      winRate: s.trades > 0 ? (s.wins / s.trades) * 100 : 0,
    })).sort((a, b) => b.pnl - a.pnl);

    // P&L by day of week
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayMap = {};
    for (const t of trades) {
      const day = days[new Date(t.closeTime).getDay()];
      if (!dayMap[day]) dayMap[day] = { day, pnl: 0, trades: 0 };
      dayMap[day].pnl += t.pnlUSD;
      dayMap[day].trades++;
    }
    const byDayOfWeek = days.map(d => dayMap[d] || { day: d, pnl: 0, trades: 0 });

    // Monthly P&L
    const monthMap = {};
    for (const t of trades) {
      const d = new Date(t.closeTime);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!monthMap[key]) monthMap[key] = { month: key, pnl: 0, trades: 0, wins: 0 };
      monthMap[key].pnl += t.pnlUSD;
      monthMap[key].trades++;
      if (t.pnlUSD > 0) monthMap[key].wins++;
    }
    const byMonth = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));

    const avgDurationMin = trades.reduce((s, t) => s + (t.durationMinutes || 0), 0) / trades.length;

    // Sesson Analytcs based on closeTime UTC hour
    const bySessionMap = {
      Tokyo: { session: 'Tokyo (Asan)', pnl: 0, trades: 0, wins: 0 },
      London: { session: 'London (Eur)', pnl: 0, trades: 0, wins: 0 },
      Overlap: { session: 'London/NY Overlap', pnl: 0, trades: 0, wins: 0 },
      NewYork: { session: 'New York (US)', pnl: 0, trades: 0, wins: 0 },
      Pacfc: { session: 'Pacfc/Late NY', pnl: 0, trades: 0, wins: 0 },
    };
    for (const t of trades) {
      const utcHour = new Date(t.closeTime).getUTCHours();
      let sess = 'Pacfc';
      if (utcHour >= 0 && utcHour < 8) sess = 'Tokyo';
      else if (utcHour >= 8 && utcHour < 13) sess = 'London';
      else if (utcHour >= 13 && utcHour < 16) sess = 'Overlap';
      else if (utcHour >= 16 && utcHour < 21) sess = 'NewYork';

      bySessionMap[sess].pnl += t.pnlUSD;
      bySessionMap[sess].trades++;
      if (t.pnlUSD > 0) bySessionMap[sess].wins++;
    }
    const bySession = Object.values(bySessionMap).map(s => ({
      ...s,
      winRate: s.trades > 0 ? (s.wins / s.trades) * 100 : 0
    }));

    // Performance by Tag
    const tagMap = {};
    for (const t of trades) {
      if (t.tags && t.tags.length > 0) {
        for (const tag of t.tags) {
          const trimmed = tag.trim();
          if (!trimmed) continue;
          if (!tagMap[trimmed]) tagMap[trimmed] = { tag: trimmed, pnl: 0, trades: 0, wins: 0 };
          tagMap[trimmed].pnl += t.pnlUSD;
          tagMap[trimmed].trades++;
          if (t.pnlUSD > 0) tagMap[trimmed].wins++;
        }
      }
    }
    const byTag = Object.values(tagMap).map(tg => ({
      ...tg,
      winRate: tg.trades > 0 ? (tg.wins / tg.trades) * 100 : 0
    })).sort((a, b) => b.pnl - a.pnl);

    // Performance by emotion
    const emotionMap = {};
    for (const t of trades) {
      if (t.emotion) {
        const emo = t.emotion;
        if (!emotionMap[emo]) emotionMap[emo] = { emotion: emo, pnl: 0, trades: 0, wins: 0 };
        emotionMap[emo].pnl += t.pnlUSD;
        emotionMap[emo].trades++;
        if (t.pnlUSD > 0) emotionMap[emo].wins++;
      }
    }
    const byEmotion = Object.values(emotionMap).map(em => ({
      ...em,
      winRate: em.trades > 0 ? (em.wins / em.trades) * 100 : 0
    })).sort((a, b) => b.pnl - a.pnl);

    // Global Checklst compliance
    let totalRules = 0;
    let compledRules = 0;
    for (const t of trades) {
      if (t.checklist && t.checklist.length > 0) {
        for (const rule of t.checklist) {
          totalRules++;
          if (rule.complied) compledRules++;
        }
      }
    }
    const globalComplianceRate = totalRules > 0 ? (compledRules / totalRules) * 100 : 0;

    // Performance by Grade
    const gradeMap = {};
    for (const t of trades) {
      if (t.grade) {
        const grd = t.grade;
        if (!gradeMap[grd]) gradeMap[grd] = { grade: grd, pnl: 0, trades: 0, wins: 0 };
        gradeMap[grd].pnl += t.pnlUSD;
        gradeMap[grd].trades++;
        if (t.pnlUSD > 0) gradeMap[grd].wins++;
      }
    }
    const byGrade = Object.values(gradeMap).map(g => ({
      ...g,
      winRate: g.trades > 0 ? (g.wins / g.trades) * 100 : 0
    })).sort((a, b) => a.grade.localeCompare(b.grade));

    res.json({
      totalTrades: trades.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      netPnL,
      biggestWin: wins.length > 0 ? Math.max(...wins.map(t => t.pnlUSD)) : 0,
      biggestLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnlUSD)) : 0,
      currentDrawdown,
      maxDrawdownPct,
      equityCurve,
      bySymbol,
      byDayOfWeek,
      byMonth,
      avgDurationMin,
      avgWinUSD,
      avgLossUSD,
      winLossRatio,
      expectancyUSD,
      maxWinStreak,
      maxLossStreak,
      sharpeRatio,
      bySession,
      byTag,
      byEmotion,
      byGrade,
      globalComplianceRate,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calendar  aggregate closed trades daly net P&L and stats
router.get('/calendar', auth, async (req, res) => {
  try {
    const { symbol, grade } = req.query;

    // Database Offlne Fallback
    if (mongoose.connection.readyState !== 1) {
      let filtered = inMemoryTrades.filter(t => isOfflineTradeVisibleToUser(t, req.user.userId));
      if (symbol) filtered = filtered.filter(t => t.symbol === symbol.toUpperCase());
      if (grade) filtered = filtered.filter(t => t.grade === grade.toUpperCase());

      const calendarData = {};
      for (const t of filtered) {
        const dateStr = t.closeTime.split('T')[0];
        if (!calendarData[dateStr]) {
          calendarData[dateStr] = {
            pnl: 0,
            tradesCount: 0,
            wins: 0,
            date: dateStr
          };
        }
        calendarData[dateStr].pnl += t.pnlUSD;
        calendarData[dateStr].tradesCount++;
        if (t.pnlUSD > 0) calendarData[dateStr].wins++;
      }
      return res.json(calendarData);
    }

    const query = { user: req.user.userId };
    if (symbol) query.symbol = symbol.toUpperCase();
    if (grade) query.grade = grade.toUpperCase();

    const trades = await Trade.find(query).sort({ closeTime: 1 });
    const calendarData = {};
    for (const t of trades) {
      // Group by close date in YYYY-MM-DD
      const dateStr = new Date(t.closeTime).toISOString().split('T')[0];
      if (!calendarData[dateStr]) {
        calendarData[dateStr] = {
          pnl: 0,
          tradesCount: 0,
          wins: 0,
          date: dateStr
        };
      }
      calendarData[dateStr].pnl += t.pnlUSD;
      calendarData[dateStr].tradesCount++;
      if (t.pnlUSD > 0) calendarData[dateStr].wins++;
    }
    res.json(calendarData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/balance  latest running balance
router.get('/balance', auth, async (req, res) => {
  try {
    // Database Offlne Fallback
    if (mongoose.connection.readyState !== 1) {
      const sorted = inMemoryTrades
        .filter(t => isOfflineTradeVisibleToUser(t, req.user.userId))
        .sort((a, b) => new Date(b.closeTime) - new Date(a.closeTime));
      const latest = sorted[0];
      const latestBalanceSyncTime = latest?.synced || latest?.updatedAt || latest?.createdAt || latest?.closeTime || null;
      const latestBalanceTime = latestBalanceSyncTime ? new Date(latestBalanceSyncTime) : null;
      const laterEvents = inMemoryAccountEvents.filter(e => {
        if (!isOfflineAccountEventVisibleToUser(e, req.user.userId)) return false;
        if (e.source !== 'manual') return false;
        if (!latestBalanceTime) return true;
        return new Date(e.createdAt || e.occurredAt) > latestBalanceTime;
      });
      const eventsNet = laterEvents.reduce((sum, e) => sum + accountEventNetAmount(e), 0);
      const latestEvent = laterEvents.sort((a, b) => new Date(b.createdAt || b.occurredAt) - new Date(a.createdAt || a.occurredAt))[0];
      return res.json({
        balance: (latest?.runningBalance || 0) + eventsNet,
        asOf: latestEvent?.createdAt || latest?.synced || latest?.updatedAt || latest?.closeTime || null,
        tradeAsOf: latest?.closeTime || null,
      });
    }

    const latest = await Trade.findOne({ user: req.user.userId }).sort({ closeTime: -1 }).lean();
    const latestBalanceSyncTime = latest?.synced || latest?.updatedAt || latest?.createdAt || latest?.closeTime || null;
    const eventQuery = { user: req.user.userId, source: 'manual' };
    if (latestBalanceSyncTime) eventQuery.createdAt = { $gt: latestBalanceSyncTime };
    const laterEvents = await AccountEvent.find(eventQuery).sort({ createdAt: -1 }).lean();
    const eventsNet = laterEvents.reduce((sum, e) => sum + accountEventNetAmount(e), 0);
    const latestEvent = laterEvents[0];
    res.json({
      balance: (latest?.runningBalance || 0) + eventsNet,
      asOf: latestEvent?.createdAt || latest?.synced || latest?.updatedAt || latest?.closeTime || null,
      tradeAsOf: latest?.closeTime || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── EXPORT ROUTES ─────────────────────────────────────────────────────────

// GET /api/export/json  Full backup download: all trades + account events
router.get('/export/json', auth, async (req, res) => {
  try {
    let trades, events;

    if (mongoose.connection.readyState === 1) {
      [trades, events] = await Promise.all([
        Trade.find({ user: req.user.userId }).sort({ closeTime: -1 }).lean(),
        AccountEvent.find({ user: req.user.userId }).sort({ occurredAt: -1 }).lean(),
      ]);
    } else {
      trades = inMemoryTrades.filter(t => isOfflineTradeVisibleToUser(t, req.user.userId));
      events = inMemoryAccountEvents.filter(e => isOfflineAccountEventVisibleToUser(e, req.user.userId));
    }

    const payload = {
      _schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      source: mongoose.connection.readyState === 1 ? 'mongodb' : 'local_cache',
      tradeCount: trades.length,
      accountEventCount: events.length,
      trades: trades.map(t => ({
        ...t,
        _id: String(t._id),
        user: t.user ? String(t.user) : null,
      })),
      accountEvents: events.map(e => ({
        ...e,
        _id: String(e._id),
        user: e.user ? String(e.user) : null,
      })),
    };

    const filename = `trade-journal-backup-${new Date().toISOString().split('T')[0]}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export/csv  All trades as a flat CSV
router.get('/export/csv', auth, async (req, res) => {
  try {
    let trades;

    if (mongoose.connection.readyState === 1) {
      trades = await Trade.find({ user: req.user.userId }).sort({ closeTime: -1 }).lean();
    } else {
      trades = inMemoryTrades
        .filter(t => isOfflineTradeVisibleToUser(t, req.user.userId))
        .sort((a, b) => new Date(b.closeTime) - new Date(a.closeTime));
    }

    const CSV_HEADERS = [
      'dealId', 'positionId', 'symbol', 'direction',
      'entryPrice', 'exitPrice', 'lotSize',
      'pnlUSD', 'pnlPct', 'commission', 'swap',
      'openTime', 'closeTime', 'durationMinutes', 'runningBalance',
      'emotion', 'grade', 'tags', 'notes',
      'screenshotCount', 'screenshotUrls',
    ];

    function escapeCsv(val) {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }

    const rows = trades.map(t => [
      escapeCsv(t.dealId),
      escapeCsv(t.positionId || ''),
      escapeCsv(t.symbol),
      escapeCsv(t.direction),
      escapeCsv(t.entryPrice),
      escapeCsv(t.exitPrice),
      escapeCsv(t.lotSize),
      escapeCsv(t.pnlUSD),
      escapeCsv(t.pnlPct || 0),
      escapeCsv(t.commission || 0),
      escapeCsv(t.swap || 0),
      escapeCsv(t.openTime instanceof Date ? t.openTime.toISOString() : t.openTime),
      escapeCsv(t.closeTime instanceof Date ? t.closeTime.toISOString() : t.closeTime),
      escapeCsv(t.durationMinutes || 0),
      escapeCsv(t.runningBalance || 0),
      escapeCsv(t.emotion || ''),
      escapeCsv(t.grade || ''),
      escapeCsv((t.tags || []).join('; ')),
      escapeCsv(t.notes || ''),
      escapeCsv((t.screenshots || []).length),
      escapeCsv((t.screenshots || []).map(s => s.url).join(' | ')),
    ].join(','));

    const csvContent = [CSV_HEADERS.join(','), ...rows].join('\n');
    const filename = `trade-journal-${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'text/csv');
    res.send(csvContent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export/status  Export/backup status metadata
router.get('/export/status', auth, async (req, res) => {
  try {
    let tradeCount = 0;
    let eventCount = 0;
    let oldestTrade = null;
    let newestTrade = null;
    let dbMode = 'offline';

    if (mongoose.connection.readyState === 1) {
      dbMode = 'mongodb';
      [tradeCount, eventCount] = await Promise.all([
        Trade.countDocuments({ user: req.user.userId }),
        AccountEvent.countDocuments({ user: req.user.userId }),
      ]);
      const [oldest, newest] = await Promise.all([
        Trade.findOne({ user: req.user.userId }).sort({ closeTime: 1 }).select('closeTime').lean(),
        Trade.findOne({ user: req.user.userId }).sort({ closeTime: -1 }).select('closeTime').lean(),
      ]);
      oldestTrade = oldest?.closeTime || null;
      newestTrade = newest?.closeTime || null;
    } else {
      const userTrades = inMemoryTrades.filter(t => isOfflineTradeVisibleToUser(t, req.user.userId));
      tradeCount = userTrades.length;
      eventCount = inMemoryAccountEvents.filter(e => isOfflineAccountEventVisibleToUser(e, req.user.userId)).length;
      if (userTrades.length > 0) {
        const sorted = [...userTrades].sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));
        oldestTrade = sorted[0]?.closeTime || null;
        newestTrade = sorted[sorted.length - 1]?.closeTime || null;
      }
    }

    // Check for pending offline screenshots
    let pendingOfflineScreenshots = 0;
    if (fs.existsSync(OFFLINE_SCREENSHOTS_DIR)) {
      const tradeDirs = fs.readdirSync(OFFLINE_SCREENSHOTS_DIR);
      for (const d of tradeDirs) {
        const files = fs.readdirSync(path.join(OFFLINE_SCREENSHOTS_DIR, d)).catch(() => []);
        if (Array.isArray(files)) {
          pendingOfflineScreenshots += files.filter(f => !f.endsWith('.meta.json')).length;
        }
      }
    }

    // Local JSON backup file info
    let localBackupInfo = null;
    try {
      if (fs.existsSync(LOCAL_DB_PATH)) {
        const stat = fs.statSync(LOCAL_DB_PATH);
        localBackupInfo = {
          path: LOCAL_DB_PATH,
          sizeBytes: stat.size,
          lastModified: stat.mtime.toISOString(),
        };
      }
    } catch (e) { /* ignore */ }

    res.json({
      dbMode,
      tradeCount,
      eventCount,
      oldestTrade,
      newestTrade,
      pendingOfflineScreenshots,
      localBackupInfo,
      exportedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── EDGE COACH ROUTE ─────────────────────────────────────────────────────────
// GET /api/coach  behavioral analytics: missed profit, grade gap, exit reasons,
//                confidence vs win rate, plan adherence, manual intervention, demo vs live
router.get('/coach', auth, async (req, res) => {
  try {
    const { range } = req.query;
    const fromDate = getRangeStart(range);
    let trades;

    if (mongoose.connection.readyState === 1) {
      const q = { user: req.user.userId };
      if (fromDate) q.closeTime = { $gte: fromDate };
      trades = await Trade.find(q).sort({ closeTime: -1 }).lean();
    } else {
      trades = inMemoryTrades
        .filter(t => {
          if (!isOfflineTradeVisibleToUser(t, req.user.userId)) return false;
          if (fromDate && new Date(t.closeTime) < fromDate) return false;
          return true;
        })
        .sort((a, b) => new Date(b.closeTime) - new Date(a.closeTime));
    }

    if (trades.length === 0) {
      return res.json({
        earlyExits: { count: 0, totalMissedRR: 0, estimatedMissedUSD: 0, trades: [] },
        gradeGap: { avgAnalysisGrade: null, avgExecutionGrade: null, gapScore: 0 },
        exitReasonBreakdown: [],
        confidenceVsWinRate: [],
        planAdherence: { score: null, trades: 0 },
        manualIntervention: { interventionCount: 0, cleanCount: 0, interventionAvgPnL: 0, cleanAvgPnL: 0, interventionAvgRR: 0, cleanAvgRR: 0 },
        demoVsLive: { demo: null, live: null },
        setupAnalytics: [],
        totalTrades: 0,
      });
    }

    const GRADE_POINTS = { 'A': 5, 'B': 4, 'C': 3, 'D': 2, 'F': 1, '': null };
    function gradeAvg(arr) {
      const valid = arr.filter(g => g && GRADE_POINTS[g] != null);
      if (!valid.length) return null;
      const avg = valid.reduce((s, g) => s + GRADE_POINTS[g], 0) / valid.length;
      if (avg >= 4.5) return 'A';
      if (avg >= 3.5) return 'B';
      if (avg >= 2.5) return 'C';
      if (avg >= 1.5) return 'D';
      return 'F';
    }
    function gradeScore(arr) {
      const valid = arr.filter(g => g && GRADE_POINTS[g] != null);
      if (!valid.length) return null;
      return parseFloat((valid.reduce((s, g) => s + GRADE_POINTS[g], 0) / valid.length).toFixed(2));
    }

    // ── 1. Early Exits / Missed Profit ───────────────────────────────────────
    const earlyExitTrades = trades.filter(t =>
      t.plannedRR != null &&
      !['TP', 'SL', ''].includes(t.exitReason || '') &&
      t.exitReason
    );
    // Calculate actual RR from pnlPct (pnlPct is % of balance)
    // Missed RR = plannedRR - actualRR (estimated from pnlPct / avg risk %)
    // We estimate actualRR from pnlPct. For USD missed we use (missedRR / actualRR) * actualPnL
    let totalMissedRR = 0;
    let estimatedMissedUSD = 0;
    const earlyExitDetails = earlyExitTrades.map(t => {
      // Estimate actual RR: if trade is profitable, actual RR = pnlUSD / (pnlUSD / pnlPct * risk%) - rough estimate
      // Better: compare pnlPct to planned RR to estimate the % achieved
      const actualRR = t.pnlUSD > 0 && t.plannedRR > 0
        ? parseFloat((t.pnlPct > 0 ? (t.pnlPct / (Math.abs(t.pnlPct) / t.plannedRR || 1)) : 0).toFixed(2))
        : null;
      const missedRR = t.plannedRR - (actualRR || 0);
      // Estimate missed USD: missedRR / plannedRR * plannedUSD (if we had hit target)
      const estimatedTargetUSD = t.pnlUSD > 0 ? (t.pnlUSD / (actualRR || t.plannedRR)) * t.plannedRR : 0;
      const missedUSD = Math.max(0, estimatedTargetUSD - t.pnlUSD);
      totalMissedRR += missedRR > 0 ? missedRR : 0;
      estimatedMissedUSD += missedUSD;
      return {
        _id: String(t._id),
        symbol: t.symbol,
        direction: t.direction,
        closeTime: t.closeTime,
        pnlUSD: t.pnlUSD,
        plannedRR: t.plannedRR,
        exitReason: t.exitReason,
        missedRR: parseFloat(Math.max(0, missedRR).toFixed(2)),
        estimatedMissedUSD: parseFloat(missedUSD.toFixed(2)),
      };
    });

    // ── 2. Grade Gap ─────────────────────────────────────────────────────────
    const analysisGrades = trades.map(t => t.analysisGrade).filter(Boolean);
    const executionGrades = trades.map(t => t.executionGrade).filter(Boolean);
    const avgAnalysisScore = gradeScore(analysisGrades);
    const avgExecutionScore = gradeScore(executionGrades);
    const gapScore = avgAnalysisScore != null && avgExecutionScore != null
      ? parseFloat((avgAnalysisScore - avgExecutionScore).toFixed(2))
      : null;

    // ── 3. Exit Reason Breakdown ──────────────────────────────────────────────
    const exitMap = {};
    for (const t of trades) {
      const r = t.exitReason || 'Not Set';
      if (!exitMap[r]) exitMap[r] = { reason: r, count: 0, wins: 0, totalMissedRR: 0 };
      exitMap[r].count++;
      if (t.pnlUSD > 0) exitMap[r].wins++;
    }
    const exitReasonBreakdown = Object.values(exitMap)
      .map(r => ({ ...r, winRate: r.count > 0 ? parseFloat(((r.wins / r.count) * 100).toFixed(1)) : 0 }))
      .sort((a, b) => b.count - a.count);

    // ── 4. Confidence vs Win Rate ─────────────────────────────────────────────
    const confidenceMap = {};
    for (const t of trades) {
      if (t.confidenceRating == null) continue;
      const c = String(t.confidenceRating);
      if (!confidenceMap[c]) confidenceMap[c] = { confidence: t.confidenceRating, count: 0, wins: 0 };
      confidenceMap[c].count++;
      if (t.pnlUSD > 0) confidenceMap[c].wins++;
    }
    const confidenceVsWinRate = Object.values(confidenceMap)
      .map(c => ({ ...c, winRate: c.count > 0 ? parseFloat(((c.wins / c.count) * 100).toFixed(1)) : 0 }))
      .sort((a, b) => a.confidence - b.confidence);

    // ── 5. Plan Adherence (execution checklist compliance) ────────────────────
    let execTotal = 0, execComplied = 0;
    const tradesWithExecChecklist = trades.filter(t => t.executionChecklist && t.executionChecklist.length > 0);
    for (const t of tradesWithExecChecklist) {
      for (const item of t.executionChecklist) {
        execTotal++;
        if (item.complied) execComplied++;
      }
    }
    const planAdherenceScore = execTotal > 0 ? parseFloat(((execComplied / execTotal) * 100).toFixed(1)) : null;

    // ── 6. Manual Intervention Stats ─────────────────────────────────────────
    const intervened = trades.filter(t => t.manuallyIntervened === true);
    const clean      = trades.filter(t => t.manuallyIntervened === false);
    const avgPnL = arr => arr.length > 0 ? parseFloat((arr.reduce((s, t) => s + t.pnlUSD, 0) / arr.length).toFixed(2)) : 0;
    const avgRROf = arr => {
      const valid = arr.filter(t => t.plannedRR != null && t.plannedRR > 0);
      return valid.length > 0
        ? parseFloat((valid.reduce((s, t) => s + (t.pnlPct / (t.pnlPct / t.plannedRR || 1)), 0) / valid.length).toFixed(2))
        : null;
    };
    const winRateOf = arr => arr.length > 0 ? parseFloat(((arr.filter(t => t.pnlUSD > 0).length / arr.length) * 100).toFixed(1)) : 0;

    // ── 7. Demo vs Live Comparison ────────────────────────────────────────────
    function buildAccountStats(arr) {
      if (!arr.length) return null;
      const wins = arr.filter(t => t.pnlUSD > 0);
      const grossProfit = wins.reduce((s, t) => s + t.pnlUSD, 0);
      const grossLoss = Math.abs(arr.filter(t => t.pnlUSD < 0).reduce((s, t) => s + t.pnlUSD, 0));
      return {
        tradeCount: arr.length,
        winRate: parseFloat(((wins.length / arr.length) * 100).toFixed(1)),
        avgPnL: parseFloat((arr.reduce((s, t) => s + t.pnlUSD, 0) / arr.length).toFixed(2)),
        profitFactor: grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 999 : 0,
        planAdherence: (() => {
          let tot = 0, ok = 0;
          for (const t of arr) {
            if (!t.executionChecklist) continue;
            for (const item of t.executionChecklist) { tot++; if (item.complied) ok++; }
          }
          return tot > 0 ? parseFloat(((ok / tot) * 100).toFixed(1)) : null;
        })(),
      };
    }
    const liveArr  = trades.filter(t => t.accountType === 'live');
    const demoArr  = trades.filter(t => t.accountType === 'demo');
    const mixedArr = trades.filter(t => !t.accountType || t.accountType === '');

    // ── 8. Setup Analytics ────────────────────────────────────────────────────
    const setupMap = {};
    for (const t of trades) {
      const key = t.primarySetup || 'Untagged';
      if (!setupMap[key]) setupMap[key] = { setup: key, count: 0, wins: 0, totalPnL: 0, totalRR: 0, rrCount: 0 };
      setupMap[key].count++;
      if (t.pnlUSD > 0) setupMap[key].wins++;
      setupMap[key].totalPnL += t.pnlUSD;
      if (t.plannedRR) { setupMap[key].totalRR += t.plannedRR; setupMap[key].rrCount++; }
    }
    const setupAnalytics = Object.values(setupMap)
      .map(s => ({
        setup: s.setup,
        tradeCount: s.count,
        winRate: parseFloat(((s.wins / s.count) * 100).toFixed(1)),
        totalPnL: parseFloat(s.totalPnL.toFixed(2)),
        avgPnL: parseFloat((s.totalPnL / s.count).toFixed(2)),
        avgPlannedRR: s.rrCount > 0 ? parseFloat((s.totalRR / s.rrCount).toFixed(2)) : null,
      }))
      .filter(s => s.setup !== 'Untagged')
      .sort((a, b) => b.winRate - a.winRate);

    res.json({
      totalTrades: trades.length,
      earlyExits: {
        count: earlyExitDetails.length,
        totalMissedRR: parseFloat(totalMissedRR.toFixed(2)),
        estimatedMissedUSD: parseFloat(estimatedMissedUSD.toFixed(2)),
        trades: earlyExitDetails.slice(0, 10), // last 10 early exits
      },
      gradeGap: {
        avgAnalysisGrade: gradeAvg(analysisGrades),
        avgExecutionGrade: gradeAvg(executionGrades),
        avgAnalysisScore,
        avgExecutionScore,
        gapScore,
        analysisCount: analysisGrades.length,
        executionCount: executionGrades.length,
      },
      exitReasonBreakdown,
      confidenceVsWinRate,
      planAdherence: {
        score: planAdherenceScore,
        tradesAssessed: tradesWithExecChecklist.length,
        totalRules: execTotal,
        compliedRules: execComplied,
      },
      manualIntervention: {
        interventionCount: intervened.length,
        cleanCount: clean.length,
        untaggedCount: mixedArr.length,
        interventionWinRate: winRateOf(intervened),
        cleanWinRate: winRateOf(clean),
        interventionAvgPnL: avgPnL(intervened),
        cleanAvgPnL: avgPnL(clean),
      },
      demoVsLive: {
        live: buildAccountStats(liveArr),
        demo: buildAccountStats(demoArr),
      },
      setupAnalytics,
    });
  } catch (err) {
    console.error('Coach route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
