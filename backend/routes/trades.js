const express = require('express');
const router = express.Router();
const Trade = require('../models/Trade');
const SyncRequest = require('../models/SyncRequest');
const ReplayJournal = require('../models/ReplayJournal');
const AccountEvent = require('../models/AccountEvent');
const User = require('../models/User');
const TradingAccount = require('../models/TradingAccount');
const auth = require('../middleware/auth');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { v2: cloudinary } = require('cloudinary');
const { REPLAY_ANNOTATION_INTERVALS, normalizeReplayAnnotations, normalizeReplayEvents, normalizeQuickReview, normalizeReplayDraft } = require('../lib/replayAnnotations');
const {
  cleanAccountField,
  normalizeAccountIdentity,
  summarizeTradeAccounts,
  tradeMatchesAccountFilter,
  findTradesMissingAccountIdentity,
} = require('../lib/tradeAccounts');
const { calculateMissedProfit, summarizeRMultiples, realizedRMultiple } = require('../lib/tradeMath');
const { isLossSideStop, riskFromStop } = require('../lib/tradeRisk');
const { hasJournal, journalCopyUpdate } = require('../lib/journalCopy');
const { confidenceFor } = require('../lib/confidence');
const { getTrendbars: getCTraderTrendbars } = require('../lib/ctraderReplay');
const { importMt5Statement } = require('../lib/mt5StatementImport');

const LOCAL_DB_PATH = path.join(__dirname, '../local_trades.json');
const LOCAL_EVENTS_PATH = path.join(__dirname, '../local_account_events.json');
const LOCAL_RULES_PATH = path.join(__dirname, '../local_user_rules.json');
const LOCAL_PLAYBOOKS_PATH = path.join(__dirname, '../local_playbooks.json');
const LOCAL_REPLAY_JOURNALS_PATH = path.join(__dirname, '../local_replay_journals.json');
const OFFLINE_SCREENSHOTS_DIR = path.join(__dirname, '../public/screenshots');
const MAINTENANCE_BACKUPS_DIR = path.join(__dirname, '../backups');
const CLOUDINARY_READY = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

// Ensure offline screenshots directory exists
if (!fs.existsSync(OFFLINE_SCREENSHOTS_DIR)) {
  fs.mkdirSync(OFFLINE_SCREENSHOTS_DIR, { recursive: true });
}

// Snapshot this user's trades to disk before an irreversible bulk-delete, so a
// mistaken or malicious wipe can be recovered from the filesystem afterward.
function backupUserTradesBeforeDelete(userId, trades) {
  if (!fs.existsSync(MAINTENANCE_BACKUPS_DIR)) fs.mkdirSync(MAINTENANCE_BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(MAINTENANCE_BACKUPS_DIR, `trades-${userId}-${stamp}.json`);
  fs.writeFileSync(filePath, JSON.stringify(trades, null, 2), 'utf8');
  return filePath;
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
let inMemoryUserRules = {};
let inMemoryPlaybooks = {};
let inMemoryReplayJournals = {};
const inMemorySyncRequests = {};

// ── Trade Replay Cache (in-memory, 30-minute TTL) ──────────────────────────
// Keyed by trade _id. Exact cTrader candles are transient, never journal data.
const replayCache = new Map(); // { tradeId: { ts: number, data: object } }
const REPLAY_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes; candles are never written to a trade

function syncAgentOnly(req, res, next) {
  if (req.user.role !== 'sync_agent') return res.status(403).json({ error: 'Sync agent token required.' });
  next();
}

// Defense in depth: the sync-agent token is also meant to be kept off owner
// journal routes by the URL allowlist in middleware/auth.js. Requiring this
// here too means a bug or future edit to that allowlist can't alone expose
// destructive or read-everything routes to a leaked agent token.
function ownerOnly(req, res, next) {
  if (req.user.role === 'sync_agent') return res.status(403).json({ error: 'Owner session required.' });
  next();
}
try {
  if (fs.existsSync(LOCAL_DB_PATH)) {
    inMemoryTrades = JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf8'));
    console.log(` Loaded ${inMemoryTrades.length} trades from local persistent database file.`);
  }
  if (fs.existsSync(LOCAL_EVENTS_PATH)) {
    inMemoryAccountEvents = JSON.parse(fs.readFileSync(LOCAL_EVENTS_PATH, 'utf8'));
    console.log(` Loaded ${inMemoryAccountEvents.length} account events from local persistent database file.`);
  }
  if (fs.existsSync(LOCAL_RULES_PATH)) {
    inMemoryUserRules = JSON.parse(fs.readFileSync(LOCAL_RULES_PATH, 'utf8'));
  }
  if (fs.existsSync(LOCAL_PLAYBOOKS_PATH)) {
    inMemoryPlaybooks = JSON.parse(fs.readFileSync(LOCAL_PLAYBOOKS_PATH, 'utf8'));
  }
  if (fs.existsSync(LOCAL_REPLAY_JOURNALS_PATH)) {
    inMemoryReplayJournals = JSON.parse(fs.readFileSync(LOCAL_REPLAY_JOURNALS_PATH, 'utf8'));
  }
} catch (e) {
  console.error("Failed to load local persistent database:", e.message);
}

const DEFAULT_TRADING_RULES = [
  { ruleId: 'pre-htf-trend', label: 'HTF Trend Aligned', category: 'pre_trade', enabled: true, order: 0 },
  { ruleId: 'pre-key-level', label: 'Daily/H4 Key Level Tap', category: 'pre_trade', enabled: true, order: 1 },
  { ruleId: 'pre-confirmation', label: 'Confluence / Confirmation Entry', category: 'pre_trade', enabled: true, order: 2 },
  { ruleId: 'pre-risk-reward', label: 'Risk-to-Reward Ratio >= 1:2', category: 'pre_trade', enabled: true, order: 3 },
  { ruleId: 'pre-defined-exits', label: 'Stop Loss and Take Profit Defined', category: 'pre_trade', enabled: true, order: 4 },
  { ruleId: 'exec-entry-plan', label: 'Entry as planned', category: 'execution', enabled: true, order: 0 },
  { ruleId: 'exec-stop', label: 'Stop not moved', category: 'execution', enabled: true, order: 1 },
  { ruleId: 'exec-target', label: 'Target respected', category: 'execution', enabled: true, order: 2 },
  { ruleId: 'exec-size', label: 'Position size correct', category: 'execution', enabled: true, order: 3 },
  { ruleId: 'exec-fear', label: 'No manual close out of fear', category: 'execution', enabled: true, order: 4 },
];

const PLAYBOOK_LIFECYCLE_CATEGORIES = [
  'concept', 'context', 'setup', 'entry', 'risk', 'execution', 'management', 'exit', 'review', 'custom',
];
const PLAYBOOK_SCHEMA_VERSION = 5;
const PLAYBOOK_RULE_TOOLS = new Set(['observation', 'confirmation', 'trigger', 'decision_gate', 'invalidation', 'risk_limit', 'management_action', 'exit_signal', 'review_prompt']);
const PLAYBOOK_RULE_TIMEFRAMES = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1d']);
const PLAYBOOK_FAILURE_ACTIONS = new Set(['none', 'warn', 'skip_trade', 'stop_session']);

// ── Trade Replay Helpers ───────────────────────────────────────────────────

/**
 * Pick the best candle interval and chart padding window
 * based on how long the trade was open.
 */
function selectReplayInterval(durationMinutes) {
  const dm = Number(durationMinutes) || 0;
  if (dm < 30)    return { interval: '1min',  paddingMs: 30  * 60       * 1000 };
  if (dm < 240)   return { interval: '5min',  paddingMs: 2   * 60 * 60  * 1000 };
  if (dm < 1440)  return { interval: '15min', paddingMs: 4   * 60 * 60  * 1000 };
  if (dm < 10080) return { interval: '1h',    paddingMs: 12  * 60 * 60  * 1000 };
  return              { interval: '4h',    paddingMs: 2   * 24 * 60 * 60 * 1000 };
}

const REPLAY_TIMEFRAMES = {
  '1min': 6 * 60 * 60 * 1000,
  '5min': 36 * 60 * 60 * 1000,
  '15min': 5 * 24 * 60 * 60 * 1000,
  '1h': 21 * 24 * 60 * 60 * 1000,
  '4h': 90 * 24 * 60 * 60 * 1000,
  '1day': 540 * 24 * 60 * 60 * 1000,
};

function requestedReplayInterval(value, durationMinutes) {
  const requested = String(value || '');
  return Object.hasOwn(REPLAY_TIMEFRAMES, requested) ? requested : selectReplayInterval(durationMinutes).interval;
}

function replayWindow(trade, requestedInterval) {
  const interval = requestedReplayInterval(requestedInterval, trade.durationMinutes);
  const paddingMs = REPLAY_TIMEFRAMES[interval];
  const openMs = new Date(trade.openTime).getTime();
  const closeMs = new Date(trade.closeTime).getTime();
  return {
    interval,
    openMs,
    closeMs,
    start: new Date(openMs - paddingMs).toISOString(),
    end: new Date(closeMs + paddingMs).toISOString(),
  };
}

function buildReplayResult(trade, candleData, interval) {
  const candles = candleData.candles || [];
  const entryTs = Math.floor(new Date(trade.openTime).getTime() / 1000);
  const exitTs = Math.floor(new Date(trade.closeTime).getTime() / 1000);
  const candleAt = timestamp => {
    const next = candles.findIndex(c => c.time >= timestamp);
    if (next < 0) return Math.max(0, candles.length - 1);
    if (candles[next].time === timestamp || next === 0) return next;
    return next - 1;
  };
  const entryIndex = candleAt(entryTs);
  const exitIndex = candleAt(exitTs);
  return {
    ...candleData,
    interval,
    entryPrice: trade.entryPrice, exitPrice: trade.exitPrice,
    direction: trade.direction, symbol: trade.symbol,
    normalizedSymbol: candleData.normalizedSymbol || candleData.brokerSymbol || trade.symbol,
    openTime: trade.openTime, closeTime: trade.closeTime,
    entryTimestamp: entryTs, exitTimestamp: exitTs, entryIndex, exitIndex,
    pnlUSD: trade.pnlUSD, pnlPct: trade.pnlPct,
    durationMinutes: trade.durationMinutes, lotSize: trade.lotSize,
    existingNotes: trade.notes || '', existingEmotion: trade.emotion || '',
    existingGrade: trade.grade || '', existingTags: trade.tags || [],
    analysisGrade: trade.analysisGrade || '', executionGrade: trade.executionGrade || '',
    plannedRR: trade.plannedRR ?? null, exitReason: trade.exitReason || '',
    manuallyIntervened: trade.manuallyIntervened ?? null, confidenceRating: trade.confidenceRating ?? null,
    accountType: trade.accountType || '', playbookSnapshot: trade.playbookSnapshot || null,
    playbookResponses: trade.playbookResponses || {}, screenshots: trade.screenshots || [],
  };
}

function normalizePlaybookCategory(category) {
  const legacyMap = { pre_trade: 'setup', post_trade: 'review', trade_management: 'management' };
  const normalized = legacyMap[category] || category;
  return PLAYBOOK_LIFECYCLE_CATEGORIES.includes(normalized) ? normalized : 'custom';
}

function id(prefix) {
  return `${prefix}-${new mongoose.Types.ObjectId()}`;
}

function rulesToStarterPlaybook(rules = DEFAULT_TRADING_RULES) {
  const now = new Date().toISOString();
  const playbookId = 'playbook-core-edge';
  const blocks = [
    {
      blockId: 'block-pre-trade',
      name: 'Pre-trade conditions',
      category: 'setup',
      rules: rules.filter(rule => rule.category === 'pre_trade' && rule.enabled !== false).map(rule => ({
        ruleId: rule.ruleId, label: rule.label, inputType: 'boolean', options: [], required: false,
        toolRole: 'confirmation', timeframes: [], failureAction: 'warn', failureMessage: '',
      })),
    },
    {
      blockId: 'block-execution',
      name: 'Execution discipline',
      category: 'execution',
      rules: rules.filter(rule => rule.category === 'execution' && rule.enabled !== false).map(rule => ({
        ruleId: rule.ruleId, label: rule.label, inputType: 'boolean', options: [], required: false,
        toolRole: 'confirmation', timeframes: [], failureAction: 'warn', failureMessage: '',
      })),
    },
  ];
  return {
    playbookId,
    name: 'Core Trading Edge',
    description: 'Your migrated pre-trade and execution rules.',
    archived: false,
    createdAt: now,
    versions: [{ versionId: 'playbook-core-edge-v1', versionNumber: 1, schemaVersion: PLAYBOOK_SCHEMA_VERSION, changeNote: 'Initial playbook', publishedAt: now, blocks }],
  };
}

function normalizePlaybookEvidence(input, ownerLabel, maximum = 20) {
  const evidence = Array.isArray(input) ? input : [];
  if (evidence.length > maximum) throw new Error(`${ownerLabel} can contain at most ${maximum} screenshots`);
  return evidence.map((item, evidenceIndex) => {
    const url = String(item.url || '').trim();
    if (!url || (!url.startsWith('https://') && !url.startsWith('/'))) throw new Error('Every screenshot needs a valid URL');
    const caption = String(item.caption || '').trim();
    if (caption.length < 10) throw new Error(`Screenshot ${evidenceIndex + 1} in "${ownerLabel}" needs a descriptive caption`);
    return {
      evidenceId: String(item.evidenceId || id('evidence')),
      url,
      publicId: String(item.publicId || '').slice(0, 300),
      caption: caption.slice(0, 500),
      kind: ['reference', 'valid', 'invalid'].includes(item.kind) ? item.kind : 'reference',
      linkedRuleId: String(item.linkedRuleId || '').slice(0, 100),
      uploadedAt: item.uploadedAt || new Date().toISOString(),
      order: evidenceIndex,
    };
  });
}

function normalizeBlocks(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 20) throw new Error('A playbook needs 1 to 20 blocks');
  return input.map((block, blockIndex) => {
    const name = String(block.name || '').trim();
    if (!name || name.length > 100) throw new Error('Every block needs a name');
    const rules = Array.isArray(block.rules) ? block.rules : [];
    if (rules.length > 50) throw new Error('A block can contain at most 50 rules');
    return {
      blockId: String(block.blockId || id('block')),
      name,
      category: normalizePlaybookCategory(block.category),
      order: blockIndex,
      evidence: normalizePlaybookEvidence(block.evidence, name, 20),
      rules: rules.map((rule, ruleIndex) => {
        const label = String(rule.label || '').trim();
        if (!label || label.length > 160) throw new Error('Every rule needs a label');
        const inputType = ['boolean', 'single_choice', 'multi_choice', 'number', 'percentage', 'currency', 'price', 'duration', 'risk_reward', 'rating', 'text', 'long_text', 'date', 'time'].includes(rule.inputType) ? rule.inputType : 'boolean';
        const options = ['single_choice', 'multi_choice'].includes(inputType)
          ? (Array.isArray(rule.options) ? rule.options.map(option => String(option).trim()).filter(Boolean).slice(0, 20) : [])
          : [];
        if (['single_choice', 'multi_choice'].includes(inputType) && options.length < 2) throw new Error(`"${label}" needs at least two choices`);
        const validationSource = rule.validation && typeof rule.validation === 'object' && !Array.isArray(rule.validation)
          ? rule.validation
          : {};
        const finiteOrNull = value => value === '' || value === undefined || value === null
          ? null
          : (Number.isFinite(Number(value)) ? Number(value) : null);
        const validation = {
          min: finiteOrNull(validationSource.min),
          max: finiteOrNull(validationSource.max),
          minLength: finiteOrNull(validationSource.minLength),
          maxLength: finiteOrNull(validationSource.maxLength),
        };
        if (validation.min !== null && validation.max !== null && validation.min > validation.max) {
          throw new Error(`Minimum cannot exceed maximum for: ${label}`);
        }
        if (validation.minLength !== null && validation.maxLength !== null && validation.minLength > validation.maxLength) {
          throw new Error(`Minimum length cannot exceed maximum length for: ${label}`);
        }
        const exampleRequirementSource = rule.exampleRequirement && typeof rule.exampleRequirement === 'object' ? rule.exampleRequirement : {};
        const exampleRequirement = {
          required: Boolean(exampleRequirementSource.required),
          minimumImages: Math.max(0, Math.min(12, Number(exampleRequirementSource.minimumImages) || 0)),
          maximumImages: Math.max(1, Math.min(12, Number(exampleRequirementSource.maximumImages) || 6)),
        };
        if (exampleRequirement.required && exampleRequirement.minimumImages < 1) exampleRequirement.minimumImages = 1;
        if (exampleRequirement.minimumImages > exampleRequirement.maximumImages) throw new Error(`Minimum trade screenshots cannot exceed maximum for: ${label}`);
        const examples = normalizePlaybookEvidence(rule.examples, label, exampleRequirement.maximumImages);
        const toolRole = PLAYBOOK_RULE_TOOLS.has(rule.toolRole) ? rule.toolRole : 'observation';
        const timeframes = [...new Set((Array.isArray(rule.timeframes) ? rule.timeframes : [])
          .map(timeframe => String(timeframe).trim().toLowerCase())
          .filter(timeframe => PLAYBOOK_RULE_TIMEFRAMES.has(timeframe)))].slice(0, PLAYBOOK_RULE_TIMEFRAMES.size);
        const failureAction = PLAYBOOK_FAILURE_ACTIONS.has(rule.failureAction) ? rule.failureAction : 'none';
        return {
          ruleId: String(rule.ruleId || id('rule')),
          label,
          inputType,
          options,
          required: Boolean(rule.required),
          helpText: String(rule.helpText || '').trim().slice(0, 500),
          placeholder: String(rule.placeholder || '').trim().slice(0, 160),
          unit: String(rule.unit || '').trim().slice(0, 30),
          defaultValue: rule.defaultValue ?? null,
          validation,
          examples,
          exampleRequirement,
          toolRole,
          timeframes,
          failureAction,
          failureMessage: failureAction === 'none' ? '' : String(rule.failureMessage || '').trim().slice(0, 240),
          order: ruleIndex,
        };
      }),
    };
  });
}

function validatePlaybookResponses(snapshot, input, screenshots = []) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const clean = {};
  for (const block of snapshot?.blocks || []) {
    for (const rule of block.rules || []) {
      if (rule.exampleRequirement?.required) {
        const minimumImages = Math.max(1, Number(rule.exampleRequirement.minimumImages) || 1);
        const confirmations = screenshots.filter(screenshot => String(screenshot.playbookRuleId || '') === String(rule.ruleId) && String(screenshot.playbookVersionId || '') === String(snapshot.versionId));
        if (confirmations.length < minimumImages) throw new Error(`Required trade screenshot confirmation is missing for: ${rule.label}`);
      }
      const value = source[rule.ruleId];
      const missing = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
      if (missing) {
        if (rule.required) throw new Error(`Required playbook field is missing: ${rule.label}`);
        continue;
      }
      if (rule.inputType === 'boolean' && typeof value !== 'boolean') throw new Error(`Invalid Yes/No answer for: ${rule.label}`);
      if (rule.inputType === 'single_choice' && !rule.options.includes(String(value))) throw new Error(`Invalid choice for: ${rule.label}`);
      if (rule.inputType === 'multi_choice' && (!Array.isArray(value) || value.some(item => !rule.options.includes(String(item))))) throw new Error(`Invalid choices for: ${rule.label}`);
      const numericTypes = ['number', 'percentage', 'currency', 'price', 'duration', 'risk_reward'];
      if (numericTypes.includes(rule.inputType) && !Number.isFinite(Number(value))) throw new Error(`Invalid number for: ${rule.label}`);
      if (numericTypes.includes(rule.inputType) && rule.validation?.min !== null && rule.validation?.min !== undefined && Number(value) < rule.validation.min) throw new Error(`${rule.label} must be at least ${rule.validation.min}`);
      if (numericTypes.includes(rule.inputType) && rule.validation?.max !== null && rule.validation?.max !== undefined && Number(value) > rule.validation.max) throw new Error(`${rule.label} must be at most ${rule.validation.max}`);
      if (rule.inputType === 'percentage' && (Number(value) < 0 || Number(value) > 100)) throw new Error(`${rule.label} must be between 0 and 100%`);
      if (rule.inputType === 'risk_reward' && Number(value) < 0) throw new Error(`${rule.label} cannot be negative`);
      if (rule.inputType === 'rating' && (!Number.isFinite(Number(value)) || Number(value) < 1 || Number(value) > 10)) throw new Error(`Rating must be from 1 to 10: ${rule.label}`);
      const textTypes = ['text', 'long_text'];
      if (textTypes.includes(rule.inputType) && rule.validation?.minLength !== null && rule.validation?.minLength !== undefined && String(value).length < rule.validation.minLength) throw new Error(`${rule.label} needs at least ${rule.validation.minLength} characters`);
      if (textTypes.includes(rule.inputType) && rule.validation?.maxLength !== null && rule.validation?.maxLength !== undefined && String(value).length > rule.validation.maxLength) throw new Error(`${rule.label} can contain at most ${rule.validation.maxLength} characters`);
      if (rule.inputType === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error(`Invalid date for: ${rule.label}`);
      if (rule.inputType === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) throw new Error(`Invalid time for: ${rule.label}`);
      clean[rule.ruleId] = textTypes.includes(rule.inputType) ? String(value).slice(0, rule.validation?.maxLength || 5000) : value;
    }
  }
  return clean;
}

function saveLocalPlaybooks() {
  fs.writeFileSync(LOCAL_PLAYBOOKS_PATH, JSON.stringify(inMemoryPlaybooks, null, 2), 'utf8');
}

async function getPlaybooks(userId) {
  let playbooks;
  if (mongoose.connection.readyState === 1) {
    const user = await User.findById(userId).select('playbooks tradingRules').lean();
    if (!user) throw new Error('User not found');
    playbooks = user.playbooks || [];
    if (!playbooks.length) {
      playbooks = [rulesToStarterPlaybook(user.tradingRules?.length ? user.tradingRules : DEFAULT_TRADING_RULES)];
      await User.findByIdAndUpdate(userId, { $set: { playbooks } });
    }
  } else {
    const key = String(userId);
    playbooks = inMemoryPlaybooks[key] || [];
    if (!playbooks.length) {
      playbooks = [rulesToStarterPlaybook(inMemoryUserRules[key] || DEFAULT_TRADING_RULES)];
      inMemoryPlaybooks[key] = playbooks;
      saveLocalPlaybooks();
    }
  }
  return playbooks;
}

async function savePlaybooks(userId, playbooks) {
  if (mongoose.connection.readyState === 1) {
    await User.findByIdAndUpdate(userId, { $set: { playbooks } });
  } else {
    inMemoryPlaybooks[String(userId)] = playbooks;
    saveLocalPlaybooks();
  }
}

router.get('/playbooks', auth, ownerOnly, async (req, res) => {
  try {
    res.json({ playbooks: await getPlaybooks(req.user.userId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/playbooks/evidence', auth, ownerOnly, async (req, res) => {
  try {
    const { imageData, caption = '', kind = 'reference' } = req.body;
    if (!imageData || typeof imageData !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/i.test(imageData)) {
      return res.status(400).json({ error: 'Upload a PNG, JPEG, or WebP screenshot.' });
    }
    if (!CLOUDINARY_READY) return res.status(500).json({ error: 'Cloudinary is not configured on the backend.' });
    const upload = await cloudinary.uploader.upload(imageData, {
      folder: `trade-journal/${req.user.userId}/playbooks`,
      resource_type: 'image',
      context: `content=playbook_evidence|kind=${kind}|caption=${String(caption).replace(/[|=]/g, ' ').slice(0, 180)}`,
      overwrite: false,
    });
    res.status(201).json({ evidence: {
      evidenceId: id('evidence'),
      url: upload.secure_url,
      publicId: upload.public_id,
      caption: String(caption).trim().slice(0, 500),
      kind: ['reference', 'valid', 'invalid'].includes(kind) ? kind : 'reference',
      linkedRuleId: '',
      uploadedAt: new Date().toISOString(),
      order: 0,
    } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/playbooks', auth, ownerOnly, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name || name.length > 100) return res.status(400).json({ error: 'Strategy name is required' });
    const changeNote = String(req.body.changeNote || '').trim();
    if (changeNote.length < 20) return res.status(400).json({ error: 'Explain what changed and why using at least 20 characters' });
    const blocks = normalizeBlocks(req.body.blocks);
    const playbooks = await getPlaybooks(req.user.userId);
    const playbookId = id('playbook');
    const now = new Date().toISOString();
    const playbook = {
      playbookId, name, description: String(req.body.description || '').trim().slice(0, 500), archived: false, createdAt: now,
      versions: [{ versionId: id('version'), versionNumber: 1, schemaVersion: PLAYBOOK_SCHEMA_VERSION, changeNote: changeNote.slice(0, 1000), publishedAt: now, blocks }],
    };
    playbooks.push(playbook);
    await savePlaybooks(req.user.userId, playbooks);
    res.status(201).json({ playbook });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/playbooks/:playbookId', auth, ownerOnly, async (req, res) => {
  try {
    const playbooks = await getPlaybooks(req.user.userId);
    const playbook = playbooks.find(item => item.playbookId === req.params.playbookId);
    if (!playbook) return res.status(404).json({ error: 'Strategy not found' });
    const changeNote = String(req.body.changeNote || '').trim();
    if (changeNote.length < 20) return res.status(400).json({ error: 'Explain what changed and why using at least 20 characters' });
    const blocks = normalizeBlocks(req.body.blocks);
    const latest = playbook.versions[playbook.versions.length - 1];
    const now = new Date().toISOString();
    playbook.name = String(req.body.name || playbook.name).trim().slice(0, 100);
    playbook.description = String(req.body.description || '').trim().slice(0, 500);
    playbook.versions.push({
      versionId: id('version'),
      versionNumber: Number(latest?.versionNumber || 0) + 1,
      schemaVersion: PLAYBOOK_SCHEMA_VERSION,
      changeNote: changeNote.slice(0, 1000),
      publishedAt: now,
      blocks,
    });
    await savePlaybooks(req.user.userId, playbooks);
    res.json({ playbook });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/playbooks/:playbookId', auth, ownerOnly, async (req, res) => {
  try {
    const playbooks = await getPlaybooks(req.user.userId);
    const playbook = playbooks.find(item => item.playbookId === req.params.playbookId);
    if (!playbook) return res.status(404).json({ error: 'Strategy not found' });
    playbook.archived = Boolean(req.body.archived);
    await savePlaybooks(req.user.userId, playbooks);
    res.json({ playbook });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function saveLocalRules() {
  fs.writeFileSync(LOCAL_RULES_PATH, JSON.stringify(inMemoryUserRules, null, 2), 'utf8');
}

function normalizeRules(input) {
  if (!Array.isArray(input) || input.length > 100) throw new Error('Rules must be an array of at most 100 items');
  return input.map((rule, index) => {
    const label = String(rule.label || '').trim();
    if (!label || label.length > 160) throw new Error('Every rule needs a label between 1 and 160 characters');
    if (!['pre_trade', 'execution'].includes(rule.category)) throw new Error('Invalid rule category');
    return {
      ruleId: String(rule.ruleId || new mongoose.Types.ObjectId()),
      label,
      category: rule.category,
      enabled: rule.enabled !== false,
      order: Number.isFinite(Number(rule.order)) ? Number(rule.order) : index,
    };
  });
}

async function getUserRules(userId) {
  if (mongoose.connection.readyState === 1) {
    const user = await User.findById(userId).select('tradingRules').lean();
    return user?.tradingRules?.length ? user.tradingRules : DEFAULT_TRADING_RULES;
  }
  return inMemoryUserRules[String(userId)] || DEFAULT_TRADING_RULES;
}

router.get('/rules', auth, ownerOnly, async (req, res) => {
  try {
    res.json({ rules: await getUserRules(req.user.userId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/rules', auth, ownerOnly, async (req, res) => {
  try {
    const rules = normalizeRules(req.body.rules);
    if (mongoose.connection.readyState === 1) {
      const user = await User.findByIdAndUpdate(req.user.userId, { $set: { tradingRules: rules } }, { new: true });
      if (!user) return res.status(404).json({ error: 'User not found' });
    } else {
      inMemoryUserRules[String(req.user.userId)] = rules;
      saveLocalRules();
    }
    res.json({ rules });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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

function saveLocalReplayJournals() {
  try {
    fs.writeFileSync(LOCAL_REPLAY_JOURNALS_PATH, JSON.stringify(inMemoryReplayJournals, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save local Replay journals:', e.message);
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

// Every analytics/report route below must respect the same accountKey filter
// as GET /api/trades, or a multi-account owner's demo trades, live trades,
// and separate broker accounts silently blend into one equity curve, balance
// and win rate. Mirrors the Trade query fragment used there.
function applyAccountKeyToMongoQuery(query, accountKey) {
  if (accountKey === '__unassigned__') {
    query.$or = [{ accountKey: '' }, { accountKey: null }, { accountKey: { $exists: false } }];
  } else if (accountKey) {
    query.accountKey = String(accountKey).toLowerCase();
  }
  return query;
}

function sameTradeOwnerAndDealId(trade, userId, dealId, accountKey = '') {
  if (!isOfflineTradeVisibleToUser(trade, userId) || String(trade.dealId) !== String(dealId)) return false;
  const existingKey = cleanAccountField(trade.accountKey, 180).toLowerCase();
  return !accountKey || !existingKey || existingKey === accountKey;
}

function sameEventOwnerAndExternalId(event, userId, externalId, accountKey = '') {
  return isOfflineAccountEventVisibleToUser(event, userId)
    && String(event.externalId || '') === String(externalId || '')
    && (!accountKey || String(event.accountKey || '') === String(accountKey));
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
      const [allTrades, allEvents, allReplayJournals] = await Promise.all([
        Trade.find({}).sort({ closeTime: -1 }).lean(),
        AccountEvent.find({}).sort({ occurredAt: -1 }).lean(),
        ReplayJournal.find({}).lean(),
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

      inMemoryReplayJournals = Object.fromEntries(allReplayJournals.map(journal => {
        const formatted = {
          ...journal, _id: String(journal._id), user: String(journal.user), trade: String(journal.trade),
          createdAt: journal.createdAt ? new Date(journal.createdAt).toISOString() : null,
          updatedAt: journal.updatedAt ? new Date(journal.updatedAt).toISOString() : null,
        };
        return [`${formatted.user}:${formatted.trade}`, formatted];
      }));
      saveLocalReplayJournals();
      console.log(` Successfully backed up ${allReplayJournals.length} Replay journals from MongoDB to local JSON.`);
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
}, 24 * 60 * 60 * 1000).unref(); // never keeps the process alive on its own

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
          const evidenceLink = { playbookRuleId: meta.playbookRuleId || '', playbookVersionId: meta.playbookVersionId || '' };
          const contextTags = buildCloudinaryContext(trade, meta.caption, evidenceLink);

          // Upload image from disk to Cloudinary
          const upload = await cloudinary.uploader.upload(imgPath, {
            folder: `trade-journal/${meta.userId}/${meta.tradeId}`,
            resource_type: 'image',
            context: contextTags,
            overwrite: false,
          });

          // Upload sidecar metadata.json to Cloudinary (as raw file)
          const sidecarData = JSON.stringify(buildSidecarMetadata(trade, meta.caption, upload.secure_url, evidenceLink), null, 2);
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
            playbookRuleId: meta.playbookRuleId || '',
            playbookVersionId: meta.playbookVersionId || '',
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
function buildCloudinaryContext(trade, caption, evidenceLink = {}) {
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
    `accountType=${t.accountType || ''}`,
    `accountKey=${t.accountKey || ''}`,
    `accountLogin=${t.accountLogin || ''}`,
    `accountServer=${t.accountServer || ''}`,
    `accountName=${String(t.accountName || '').replace(/[|=]/g, ' ')}`,
    `emotion=${t.emotion || ''}`,
    `grade=${t.grade || ''}`,
    `tags=${(t.tags || []).join(',')}`,
    `caption=${(caption || '').replace(/[|=]/g, ' ').slice(0, 200)}`,
    `playbookRuleId=${evidenceLink.playbookRuleId || ''}`,
    `playbookVersionId=${evidenceLink.playbookVersionId || ''}`,
    `journalVersion=2`,
  ].join('|');
}

// Build sidecar metadata object for the companion metadata.json file
function buildSidecarMetadata(trade, caption, imageUrl, evidenceLink = {}) {
  const t = typeof trade.toObject === 'function' ? trade.toObject() : trade;
  return {
    _schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    imageUrl,
    caption: caption || '',
    playbookRuleId: evidenceLink.playbookRuleId || '',
    playbookVersionId: evidenceLink.playbookVersionId || '',
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
      accountType: t.accountType || '',
      accountKey: t.accountKey || '',
      accountLogin: t.accountLogin || '',
      accountServer: t.accountServer || '',
      accountName: t.accountName || '',
      analysisGrade: t.analysisGrade || '',
      executionGrade: t.executionGrade || '',
      plannedRR: t.plannedRR ?? null,
      exitReason: t.exitReason || '',
      manuallyIntervened: t.manuallyIntervened ?? null,
      confidenceRating: t.confidenceRating ?? null,
      primarySetup: t.primarySetup || '',
      setupConfirmations: t.setupConfirmations || [],
      executionChecklist: t.executionChecklist || [],
      playbookId: t.playbookId || '',
      playbookVersionId: t.playbookVersionId || '',
      playbookSnapshot: t.playbookSnapshot || null,
      playbookResponses: t.playbookResponses || {},
    },
  };
}

function reconstructTradeFromContext(ctx, userId) {
  const required = ['dealId', 'symbol', 'direction', 'entryPrice', 'exitPrice', 'lotSize', 'pnlUSD', 'openTime', 'closeTime'];
  if (required.some(key => ctx[key] === undefined || ctx[key] === '')) return null;
  const direction = String(ctx.direction).toUpperCase();
  if (!['BUY', 'SELL'].includes(direction)) return null;
  const openTime = new Date(ctx.openTime);
  const closeTime = new Date(ctx.closeTime);
  if (Number.isNaN(openTime.getTime()) || Number.isNaN(closeTime.getTime())) return null;
  const number = key => Number(ctx[key] || 0);
  return {
    dealId: String(ctx.dealId),
    positionId: String(ctx.positionId || ''),
    symbol: String(ctx.symbol),
    direction,
    entryPrice: number('entryPrice'),
    exitPrice: number('exitPrice'),
    lotSize: number('lotSize'),
    pnlUSD: number('pnlUSD'),
    pnlPct: number('pnlPct'),
    commission: number('commission'),
    swap: number('swap'),
    openTime,
    closeTime,
    durationMinutes: number('durationMinutes'),
    runningBalance: number('runningBalance'),
    accountType: ['live', 'demo'].includes(String(ctx.accountType).toLowerCase()) ? String(ctx.accountType).toLowerCase() : '',
    accountKey: cleanAccountField(ctx.accountKey, 180).toLowerCase(),
    accountLogin: cleanAccountField(ctx.accountLogin, 40),
    accountServer: cleanAccountField(ctx.accountServer, 120),
    accountName: cleanAccountField(ctx.accountName, 120),
    emotion: ctx.emotion || '',
    grade: ctx.grade || '',
    tags: String(ctx.tags || '').split(',').map(tag => tag.trim()).filter(Boolean),
    user: userId,
    synced: new Date(),
  };
}

// POST /api/maintenance/resync-request  ask the local MT5 sync script to run a full sync
router.post('/maintenance/resync-request', auth, ownerOnly, async (req, res) => {
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
router.get('/maintenance/resync-request', auth, syncAgentOnly, async (req, res) => {
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
router.post('/maintenance/resync-complete', auth, syncAgentOnly, async (req, res) => {
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
// Irreversible: requires an explicit confirmation phrase and writes a JSON
// backup to backend/backups/ before deleting anything.
router.delete('/maintenance/trades', auth, ownerOnly, async (req, res) => {
  try {
    if (String(req.body?.confirm || '') !== 'DELETE ALL TRADES') {
      return res.status(400).json({ error: 'This permanently deletes every trade. Resend with { "confirm": "DELETE ALL TRADES" }.' });
    }

    if (mongoose.connection.readyState !== 1) {
      const toDelete = inMemoryTrades.filter(t => isOfflineTradeVisibleToUser(t, req.user.userId));
      const backupPath = backupUserTradesBeforeDelete(req.user.userId, toDelete);
      inMemoryTrades = inMemoryTrades.filter(t => !isOfflineTradeVisibleToUser(t, req.user.userId));
      saveLocalDatabase();
      return res.json({ deleted: toDelete.length, backupPath });
    }

    const toDelete = await Trade.find({ user: req.user.userId }).lean();
    const backupPath = backupUserTradesBeforeDelete(req.user.userId, toDelete);
    const result = await Trade.deleteMany({ user: req.user.userId });
    inMemoryTrades = inMemoryTrades.filter(t => String(t.user) !== String(req.user.userId));
    saveLocalDatabase();
    res.json({ deleted: result.deletedCount || 0, backupPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/maintenance/dedupe-trades  remove repeated deal IDs for this user
// Deleted rows may carry their own journal notes/screenshots, so this is
// irreversible too: require confirmation and back up first.
router.post('/maintenance/dedupe-trades', auth, ownerOnly, async (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'This permanently removes duplicate trade rows. Resend with { "confirm": true }.' });
    }
    const currentTrades = mongoose.connection.readyState === 1
      ? await Trade.find({ user: req.user.userId }).lean()
      : inMemoryTrades.filter(t => isOfflineTradeVisibleToUser(t, req.user.userId));
    const backupPath = backupUserTradesBeforeDelete(req.user.userId, currentTrades);

    if (mongoose.connection.readyState !== 1) {
      const seen = new Set();
      const deduped = [];
      let removed = 0;
      for (const trade of inMemoryTrades) {
        if (!isOfflineTradeVisibleToUser(trade, req.user.userId)) {
          deduped.push(trade);
          continue;
        }
        // MT5 deal tickets are only unique inside one broker account — two
        // different accounts can (and, in practice, do) reuse the same
        // ticket number. Keying on dealId alone would treat two genuinely
        // different trades as duplicates and delete one of them.
        const key = `${String(trade.user || req.user.userId)}:${cleanAccountField(trade.accountKey, 180).toLowerCase()}:${String(trade.dealId)}`;
        if (seen.has(key)) {
          removed++;
          continue;
        }
        seen.add(key);
        deduped.push(trade);
      }
      inMemoryTrades = deduped;
      if (removed > 0) saveLocalDatabase();
      return res.json({ removed, backupPath });
    }

    const duplicateGroups = await Trade.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(req.user.userId) } },
      { $sort: { createdAt: 1, _id: 1 } },
      {
        $group: {
          // Same reasoning as above: group by account + dealId, not dealId
          // alone, or trades from different accounts sharing a ticket
          // number get merged and one is permanently deleted.
          _id: { accountKey: { $ifNull: ['$accountKey', ''] }, dealId: '$dealId' },
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

    res.json({ removed, backupPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/maintenance/recalculate-balances
// Re-derive each trade's runningBalance from the known current balance and P&L history.
// This fixes incorrect balances stored by old versions of sync.py without losing journal data.
// runningBalance is per broker account, and deposits/withdrawals move it too —
// reconstructing it from trade P&L alone (ignoring AccountEvent cash flow, and
// merging every account into one anchor balance) silently offsets every
// historical balance by however much cash moved between trades. Requires an
// accountKey when more than one account exists, and folds AccountEvent rows
// into the same chronological walk as the trades.
router.post('/maintenance/recalculate-balances', auth, ownerOnly, async (req, res) => {
  try {
    const currentBalance = req.body.currentBalance != null ? Number(req.body.currentBalance) : null;
    const requestedAccountKey = cleanAccountField(req.body.accountKey, 180).toLowerCase();

    if (mongoose.connection.readyState !== 1) {
      const ownerTrades = inMemoryTrades.filter(t => isOfflineTradeVisibleToUser(t, req.user.userId));
      const distinctAccountKeys = [...new Set(ownerTrades.map(t => String(t.accountKey || '')).filter(Boolean))];
      if (!requestedAccountKey && distinctAccountKeys.length > 1) {
        return res.status(400).json({
          error: 'This owner has more than one trading account. Specify accountKey to recalculate one account at a time.',
          accountKeys: distinctAccountKeys,
        });
      }
      const accountKey = requestedAccountKey || distinctAccountKeys[0] || '';
      const userTrades = ownerTrades
        .filter(t => !accountKey || tradeMatchesAccountFilter(t, accountKey))
        .sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));

      if (userTrades.length === 0) return res.json({ updated: 0, accountKey });

      const events = inMemoryAccountEvents.filter(e => {
        if (!isOfflineAccountEventVisibleToUser(e, req.user.userId)) return false;
        // Manual entries aren't tied to a broker account, so include them for
        // any single-account recalculation too.
        return !accountKey || !e.accountKey || tradeMatchesAccountFilter(e, accountKey);
      });

      const latestBal = currentBalance != null
        ? currentBalance
        : Number(userTrades[userTrades.length - 1].runningBalance || 0);

      const timeline = [
        ...userTrades.map(t => ({
          time: new Date(t.closeTime).getTime(),
          delta: Number(t.pnlUSD || 0) + Number(t.commission || 0) + Number(t.swap || 0),
          tradeId: String(t._id),
        })),
        ...events.map(e => ({ time: new Date(e.occurredAt || e.createdAt).getTime(), delta: accountEventNetAmount(e), tradeId: null })),
      ].sort((a, b) => a.time - b.time);

      const totalNet = timeline.reduce((s, entry) => s + entry.delta, 0);
      let runBal = latestBal - totalNet;
      let updated = 0;
      const tradeBalances = new Map();
      for (const entry of timeline) {
        runBal += entry.delta;
        if (entry.tradeId) tradeBalances.set(entry.tradeId, runBal);
      }

      for (const trade of userTrades) {
        const newBal = Math.round((tradeBalances.get(String(trade._id)) ?? Number(trade.runningBalance)) * 100) / 100;
        const idx = inMemoryTrades.findIndex(t => String(t._id) === String(trade._id));
        if (idx !== -1 && Math.abs(Number(inMemoryTrades[idx].runningBalance) - newBal) > 0.001) {
          inMemoryTrades[idx].runningBalance = newBal;
          updated++;
        }
      }

      if (updated > 0) saveLocalDatabase();
      return res.json({ updated, latestBalance: latestBal, accountKey });
    }

    // MongoDB mode
    const distinctAccountKeys = requestedAccountKey ? [] : await Trade.distinct('accountKey', { user: req.user.userId, accountKey: { $nin: ['', null] } });
    if (!requestedAccountKey && distinctAccountKeys.length > 1) {
      return res.status(400).json({
        error: 'This owner has more than one trading account. Specify accountKey to recalculate one account at a time.',
        accountKeys: distinctAccountKeys,
      });
    }
    const accountKey = requestedAccountKey || distinctAccountKeys[0] || '';
    const tradeQuery = { user: req.user.userId };
    if (accountKey) applyAccountKeyToMongoQuery(tradeQuery, accountKey);
    const userTrades = await Trade.find(tradeQuery)
      .sort({ closeTime: 1 })
      .select('_id pnlUSD commission swap runningBalance closeTime accountKey');

    if (userTrades.length === 0) return res.json({ updated: 0, accountKey });

    const eventQuery = { user: req.user.userId };
    if (accountKey) eventQuery.$or = [{ accountKey: { $in: ['', null] } }, { accountKey }];
    const events = await AccountEvent.find(eventQuery).select('occurredAt createdAt type amount').lean();

    const latestBal = currentBalance != null
      ? currentBalance
      : Number(userTrades[userTrades.length - 1].runningBalance || 0);

    const timeline = [
      ...userTrades.map(t => ({
        time: new Date(t.closeTime).getTime(),
        delta: Number(t.pnlUSD || 0) + Number(t.commission || 0) + Number(t.swap || 0),
        tradeId: String(t._id),
      })),
      ...events.map(e => ({ time: new Date(e.occurredAt || e.createdAt).getTime(), delta: accountEventNetAmount(e), tradeId: null })),
    ].sort((a, b) => a.time - b.time);

    const totalNet = timeline.reduce((s, entry) => s + entry.delta, 0);
    let runBal = latestBal - totalNet;
    let updated = 0;
    const tradeBalances = new Map();
    for (const entry of timeline) {
      runBal += entry.delta;
      if (entry.tradeId) tradeBalances.set(entry.tradeId, runBal);
    }

    const bulkOps = [];
    for (const trade of userTrades) {
      const newBal = Math.round((tradeBalances.get(String(trade._id)) ?? Number(trade.runningBalance)) * 100) / 100;
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

    res.json({ updated, latestBalance: latestBal, accountKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/maintenance/recover-screenshots
// Re-attach Cloudinary screenshots by dealId. If the trade is missing entirely,
// reconstruct its core MT5 record from the metadata embedded on the image asset.
router.post('/maintenance/recover-screenshots', auth, ownerOnly, async (req, res) => {
  if (!CLOUDINARY_READY) {
    return res.status(400).json({ error: 'Cloudinary is not configured on this server.' });
  }

  try {
    const userId = String(req.user.userId);
    const prefix = `trade-journal/${userId}/`;

    // Collect all image resources for this user from Cloudinary (paginate with next_cursor)
    let allResources = [];
    let nextCursor = null;
    do {
      const params = {
        type: 'upload',
        prefix,
        max_results: 500,
        context: true,       // include context metadata (dealId lives here)
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
      };
      const result = await cloudinary.api.resources(params);
      allResources = allResources.concat(result.resources || []);
      nextCursor = result.next_cursor || null;
    } while (nextCursor);

    if (allResources.length === 0) {
      return res.json({ recovered: 0, tradesReconstructed: 0, skipped: 0, errors: 0, total: 0, message: 'No images found in Cloudinary for this account.' });
    }

    let recovered = 0;
    let tradesReconstructed = 0;
    let skipped = 0;
    let errors = 0;

    for (const resource of allResources) {
      try {
        // Extract dealId from context tags (stored as `dealId=xxx` pipe-separated string)
        const ctx = resource.context?.custom || {};
        const dealId = ctx.dealId || null;
        if (!dealId) { skipped++; continue; }

        const imageUrl = resource.secure_url;
        const publicId = resource.public_id;
        const caption = ctx.caption || '';

        if (mongoose.connection.readyState !== 1) {
          // Offline mode: update inMemoryTrades
          let idx = inMemoryTrades.findIndex(
            t => isOfflineTradeVisibleToUser(t, userId) && String(t.dealId) === String(dealId)
          );
          if (idx === -1) {
            const reconstructed = reconstructTradeFromContext(ctx, userId);
            if (!reconstructed) { skipped++; continue; }
            inMemoryTrades.push({ ...reconstructed, _id: `recovered-${dealId}`, openTime: reconstructed.openTime.toISOString(), closeTime: reconstructed.closeTime.toISOString(), synced: new Date().toISOString(), screenshots: [] });
            idx = inMemoryTrades.length - 1;
            tradesReconstructed++;
          }

          if (!Array.isArray(inMemoryTrades[idx].screenshots)) inMemoryTrades[idx].screenshots = [];
          const alreadyLinked = inMemoryTrades[idx].screenshots.some(s => s.publicId === publicId);
          if (alreadyLinked) { skipped++; continue; }

          inMemoryTrades[idx].screenshots.push({
            url: imageUrl,
            publicId,
            caption,
            uploadedAt: resource.created_at || new Date().toISOString(),
          });
          recovered++;
        } else {
          // MongoDB mode
          let trade = await Trade.findOne({ user: req.user.userId, dealId: String(dealId) });
          if (!trade) {
            const reconstructed = reconstructTradeFromContext(ctx, req.user.userId);
            if (!reconstructed) { skipped++; continue; }
            trade = await Trade.create(reconstructed);
            tradesReconstructed++;
          }

          const alreadyLinked = trade.screenshots.some(s => s.publicId === publicId);
          if (alreadyLinked) { skipped++; continue; }

          trade.screenshots.push({
            url: imageUrl,
            publicId,
            caption,
            uploadedAt: resource.created_at ? new Date(resource.created_at) : new Date(),
          });
          await trade.save();
          syncLocalTrade(trade);
          recovered++;
        }
      } catch (itemErr) {
        console.error('[RecoverScreenshots] Error processing resource:', resource.public_id, itemErr.message);
        errors++;
      }
    }

    if (recovered > 0 && mongoose.connection.readyState !== 1) saveLocalDatabase();

    const message = recovered > 0
      ? `Recovered ${recovered} screenshot(s) and reconstructed ${tradesReconstructed} missing trade(s). ${skipped} skipped. ${errors > 0 ? `${errors} error(s).` : ''}`
      : `No screenshots needed recovery. ${skipped} already linked or no matching trade found.`;

    res.json({ recovered, tradesReconstructed, skipped, errors, total: allResources.length, message });
  } catch (err) {
    console.error('[RecoverScreenshots] Fatal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/account-events  deposits, withdrawals, and account adjustments
router.get('/account-events', auth, ownerOnly, async (req, res) => {
  try {
    const { range, limit = 25, accountKey } = req.query;
    const fromDate = getRangeStart(range);
    const max = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);

    if (mongoose.connection.readyState !== 1) {
      let events = inMemoryAccountEvents.filter(e => isOfflineAccountEventVisibleToUser(e, req.user.userId));
      if (fromDate) events = events.filter(e => new Date(e.occurredAt) >= fromDate);
      if (accountKey) events = events.filter(e => tradeMatchesAccountFilter(e, accountKey));
      events.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
      return res.json({
        events: events.slice(0, max),
        summary: summarizeAccountEvents(events),
      });
    }

    const query = { user: req.user.userId };
    if (fromDate) query.occurredAt = { $gte: fromDate };
    if (accountKey) applyAccountKeyToMongoQuery(query, accountKey);
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
router.post('/account-events', auth, ownerOnly, async (req, res) => {
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
router.delete('/account-events/:id', auth, ownerOnly, async (req, res) => {
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
router.post('/sync-account-events', auth, syncAgentOnly, async (req, res) => {
  try {
    const { events } = req.body;
    if (!Array.isArray(events)) {
      return res.status(400).json({ error: 'events array is required' });
    }

    let inserted = 0;
    let skipped = 0;
    let accountTypesUpdated = 0;

    if (mongoose.connection.readyState !== 1) {
      for (const e of events) {
        const externalId = String(e.externalId || '');
        const accountKey = cleanAccountField(e.accountKey, 180).toLowerCase();
        if (!externalId || !accountKey || inMemoryAccountEvents.some(x => sameEventOwnerAndExternalId(x, req.user.userId, externalId, accountKey))) {
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
          accountKey,
          tradingAccount: mongoose.Types.ObjectId.isValid(String(e.tradingAccountId || '')) ? String(e.tradingAccountId) : null,
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

      const accountKey = cleanAccountField(e.accountKey, 180).toLowerCase();
      if (!accountKey) {
        skipped++;
        continue;
      }
      const existing = await AccountEvent.findOne({ user: req.user.userId, accountKey, externalId }).select('_id');
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
        accountKey,
        tradingAccount: mongoose.Types.ObjectId.isValid(String(e.tradingAccountId || '')) ? e.tradingAccountId : null,
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
router.get('/performance', auth, ownerOnly, async (req, res) => {
  try {
    const { range, accountKey } = req.query;

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
      if (accountKey) applyAccountKeyToMongoQuery(q, accountKey);
      trades = await Trade.find(q)
        .sort({ closeTime: 1 })
        .select('closeTime openTime pnlUSD runningBalance symbol direction lotSize commission swap accountKey');
    } else {
      trades = inMemoryTrades
        .filter(t => {
          if (!isOfflineTradeVisibleToUser(t, req.user.userId)) return false;
          if (fromDate && new Date(t.closeTime) < fromDate) return false;
          if (accountKey && !tradeMatchesAccountFilter(t, accountKey)) return false;
          return true;
        })
        .sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));
    }

    // runningBalance is per broker account. Without an accountKey filter,
    // trades from multiple accounts interleave into one equity curve and the
    // resulting drawdown/balance figures are not meaningful — surface that
    // instead of silently reporting a blended number as if it were real.
    const distinctAccountKeys = [...new Set(trades.map(t => String(t.accountKey || '')).filter(Boolean))];
    const mixedAccounts = !accountKey && distinctAccountKeys.length > 1;

    // Optional grouping by trade setup
    const groupBySetup = req.query.groupBySetup === 'true';
    if (groupBySetup) {
      const groups = new Map();
      for (const t of trades) {
        const plain = typeof t.toObject === 'function' ? t.toObject() : t;
        const key = plain.tradeGroup || String(plain._id);
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key).push(plain);
      }

      const groupedTrades = [];
      for (const [key, items] of groups.entries()) {
        items.sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));
        const first = items[0];
        const last = items[items.length - 1];

        const totalPnl = items.reduce((s, x) => s + (x.pnlUSD || 0), 0);
        const totalComm = items.reduce((s, x) => s + (x.commission || 0), 0);
        const totalSwap = items.reduce((s, x) => s + (x.swap || 0), 0);
        const totalDuration = items.reduce((s, x) => s + (x.durationMinutes || 0), 0);

        groupedTrades.push({
          _id: key,
          dealId: first.dealId,
          symbol: first.symbol,
          direction: first.direction,
          entryPrice: first.entryPrice,
          exitPrice: last.exitPrice,
          lotSize: items.reduce((s, x) => s + (x.lotSize || 0), 0),
          pnlUSD: totalPnl,
          commission: totalComm,
          swap: totalSwap,
          openTime: first.openTime,
          closeTime: last.closeTime,
          durationMinutes: totalDuration,
          runningBalance: last.runningBalance, // Final balance after the whole setup closes
        });
      }
      groupedTrades.sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));
      trades = groupedTrades;
    }

    if (trades.length === 0) {
      return res.json({ equityCurve: [], drawdownCurve: [], stats: null, mixedAccounts: false, accountKeys: [] });
    }

    //  Equity curve + drawdown 
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

    //  Risk stats
    // pnlUSD alone excludes commission and swap, which is real money the
    // broker took — win/loss, profit factor and every total here need to
    // match runningBalance (which already includes both).
    const netAmount = t => Number(t.pnlUSD || 0) + Number(t.commission || 0) + Number(t.swap || 0);
    const wins   = trades.filter(t => netAmount(t) > 0);
    const losses = trades.filter(t => netAmount(t) < 0);

    const grossProfit = wins.reduce((s, t)   => s + netAmount(t), 0);
    const grossLoss   = Math.abs(losses.reduce((s, t) => s + netAmount(t), 0));
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
      if (netAmount(t) > 0) { curW++; curL = 0; maxConsecW = Math.max(maxConsecW, curW); }
      else                   { curL++; curW = 0; maxConsecL = Math.max(maxConsecL, curL); }
    }

    // Largest single wn / loss
    const largestWin  = wins.length   > 0 ? Math.max(...wins.map(t => netAmount(t))) : 0;
    const largestLoss = losses.length > 0 ? Math.min(...losses.map(t => netAmount(t))) : 0;

    // Net P&L and overall account growth
    const startBal   = Number(trades[0].runningBalance) - netAmount(trades[0]);
    const currentBal = Number(trades[trades.length - 1].runningBalance);
    const netPnL     = currentBal - startBal;
    const growthPct  = startBal > 0 ? (netPnL / startBal) * 100 : 0;

    res.json({
      equityCurve,
      stats: {
        confidence:     confidenceFor(trades.length, wins.length, trades.map(netAmount), trades.map(realizedRMultiple).filter(r => r !== null)),
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
      mixedAccounts,
      accountKeys: distinctAccountKeys,
    });
  } catch (err) {
    console.error('Performance route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});



// GET /api/trade-accounts  account identities represented in this owner's trades
router.get('/trade-accounts', auth, ownerOnly, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      const trades = inMemoryTrades.filter(trade => isOfflineTradeVisibleToUser(trade, req.user.userId));
      return res.json(summarizeTradeAccounts(trades));
    }
    const [accounts, counts, unassignedCount] = await Promise.all([
      TradingAccount.find({ user: req.user.userId }).select('accountKey label actualAccountType archivedAt').sort({ createdAt: 1 }).lean(),
      Trade.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(req.user.userId), accountKey: { $nin: ['', null] } } },
        { $group: { _id: '$accountKey', count: { $sum: 1 } } },
      ]),
      Trade.countDocuments({ user: req.user.userId, $or: [{ accountKey: '' }, { accountKey: null }, { accountKey: { $exists: false } }] }),
    ]);
    const countMap = new Map(counts.map(item => [item._id, item.count]));
    res.json({
      accounts: accounts.map(account => ({
        accountKey: account.accountKey,
        accountLogin: '',
        accountServer: '',
        accountName: account.label,
        accountType: account.actualAccountType || '',
        label: `${account.label}${account.archivedAt ? ' — archived' : ''}`,
        count: countMap.get(account.accountKey) || 0,
      })).filter(account => account.count > 0),
      unassignedCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trades/latest-close  latest trade for one broker account
router.get('/trades/latest-close', auth, async (req, res) => {
  try {
    const accountKey = cleanAccountField(req.query.accountKey, 180).toLowerCase();
    if (mongoose.connection.readyState !== 1) {
      const latest = inMemoryTrades
        .filter(trade => isOfflineTradeVisibleToUser(trade, req.user.userId))
        .filter(trade => !accountKey || cleanAccountField(trade.accountKey, 180).toLowerCase() === accountKey)
        .sort((a, b) => new Date(b.closeTime) - new Date(a.closeTime))[0];
      return res.json({ closeTime: latest?.closeTime || null, accountKey });
    }
    const query = { user: req.user.userId };
    if (accountKey) query.accountKey = accountKey;
    const latest = await Trade.findOne(query).sort({ closeTime: -1 }).select('closeTime').lean();
    res.json({ closeTime: latest?.closeTime || null, accountKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/trades/import/mt5-statement  { content, target, commit }
// An MT5 report (History → Report → HTML) for traders without the Windows
// sync app (MT5 on a Mac). commit:false previews what would be added.
router.post('/trades/import/mt5-statement', auth, ownerOnly, async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'Importing needs a connected database. Unavailable while running offline.' });
  }
  try {
    let checklist = [], executionChecklist = [];
    if (req.body.commit) {
      try {
        const rules = await getUserRules(req.user.userId);
        const snap = category => rules.filter(rule => rule.category === category && rule.enabled !== false)
          .sort((a, b) => a.order - b.order).map(rule => ({ ruleId: rule.ruleId, rule: rule.label, complied: false }));
        checklist = snap('pre_trade'); executionChecklist = snap('execution');
      } catch { /* trades still import without the checklist snapshot */ }
    }
    const result = await importMt5Statement({
      userId: req.user.userId,
      content: req.body.content,
      target: typeof req.body.target === 'string' ? req.body.target : 'auto',
      commit: Boolean(req.body.commit),
      checklist, executionChecklist,
    });
    res.status(req.body.commit ? 201 : 200).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not import this report.' });
  }
});

// POST /api/trades/manual  hand-entered trade, e.g. one your broker never
// recorded. Only the computed fields (duration, running balance) are
// derived here; everything else is exactly what the trader typed in.
router.post('/trades/manual', auth, ownerOnly, async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'Manual trade entry needs a connected database. Unavailable while running offline.' });
  }
  try {
    const { symbol, direction, entryPrice, exitPrice, lotSize, pnlUSD, openTime, closeTime, notes, accountType } = req.body;

    if (!symbol || typeof symbol !== 'string') return res.status(400).json({ error: 'Symbol is required' });
    if (direction !== 'BUY' && direction !== 'SELL') return res.status(400).json({ error: 'Direction must be BUY or SELL' });
    const entry = Number(entryPrice), exit = Number(exitPrice), lots = Number(lotSize), pnl = Number(pnlUSD);
    if (!Number.isFinite(entry) || entry <= 0) return res.status(400).json({ error: 'Entry price must be a positive number' });
    if (!Number.isFinite(exit) || exit <= 0) return res.status(400).json({ error: 'Exit price must be a positive number' });
    if (!Number.isFinite(lots) || lots <= 0) return res.status(400).json({ error: 'Lot size must be a positive number' });
    if (!Number.isFinite(pnl)) return res.status(400).json({ error: 'P&L must be a number' });
    const openDate = new Date(openTime);
    const closeDate = new Date(closeTime);
    if (Number.isNaN(openDate.getTime())) return res.status(400).json({ error: 'Open time is required' });
    if (Number.isNaN(closeDate.getTime())) return res.status(400).json({ error: 'Close time is required' });
    if (closeDate < openDate) return res.status(400).json({ error: 'Close time cannot be before open time' });

    // Best-effort running balance: chain off whichever trade most recently
    // closed before this one. Unlike a broker sync, a manual insert doesn't
    // shift every later trade's balance -- Fix Balances can re-anchor from a
    // real account balance later if this drifts.
    const priorTrade = await Trade.findOne({ user: req.user.userId, closeTime: { $lte: closeDate } }).sort({ closeTime: -1 }).select('runningBalance').lean();
    const runningBalance = (priorTrade?.runningBalance || 0) + pnl;

    const trade = await Trade.create({
      dealId: `manual-${new mongoose.Types.ObjectId().toString()}`,
      symbol: symbol.trim().toUpperCase(),
      direction,
      entryPrice: entry,
      exitPrice: exit,
      lotSize: lots,
      pnlUSD: pnl,
      openTime: openDate,
      closeTime: closeDate,
      durationMinutes: Math.max(0, Math.round((closeDate - openDate) / 60000)),
      runningBalance,
      notes: String(notes || '').slice(0, 2000),
      accountType: accountType === 'live' || accountType === 'demo' ? accountType : '',
      manualEntry: true,
      user: req.user.userId,
    });
    res.status(201).json(trade);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not save manual trade' });
  }
});

// GET /api/trades  all trades, newest frst, wth optonal flters
// Symbols are matched whatever their capitals: cTrader names like "Nasdaq100"
// are stored as the broker spells them.
const escapeRegex = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const symbolQuery = symbol => ({ $regex: `^${escapeRegex(String(symbol).trim())}$`, $options: 'i' });
const sameSymbol = (a, b) => String(a || '').toLowerCase() === String(b || '').trim().toLowerCase();
// from/to: a date (YYYY-MM-DD, the whole day; "to" includes that day) or an
// exact time (ISO, sent by the Trades page for the visitor's own time zone).
function dateRange(from, to) {
  const dayOnly = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const valid = d => (Number.isFinite(d.getTime()) ? d : null);
  const start = from ? valid(new Date(from)) : null;
  let end = to ? valid(new Date(to)) : null;
  if (end && dayOnly(to)) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  else if (end) end = new Date(end.getTime() + 1); // inclusive of the exact time given
  return { from: start, to: end };
}

router.get('/trades', auth, ownerOnly, async (req, res) => {
  try {
    const { symbol, direction, accountType, accountKey, from, to, page = 1, limit = 50 } = req.query;

    // Database Offlne Fallback
    if (mongoose.connection.readyState !== 1) {
      let filtered = inMemoryTrades.filter(t => isOfflineTradeVisibleToUser(t, req.user.userId));
      if (symbol) filtered = filtered.filter(t => sameSymbol(t.symbol, symbol));
      if (direction) filtered = filtered.filter(t => t.direction === direction.toUpperCase());
      if (accountType) filtered = filtered.filter(t => t.accountType === String(accountType).toLowerCase());
      if (accountKey) filtered = filtered.filter(t => tradeMatchesAccountFilter(t, accountKey));
      const range = dateRange(from, to);
      if (range.from) filtered = filtered.filter(t => new Date(t.closeTime) >= range.from);
      if (range.to) filtered = filtered.filter(t => new Date(t.closeTime) < range.to);

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
    if (symbol) query.symbol = symbolQuery(symbol);
    if (direction) query.direction = query.direction = direction.toUpperCase();
    if (accountType) query.accountType = String(accountType).toLowerCase();
    if (accountKey === '__unassigned__') query.$or = [{ accountKey: '' }, { accountKey: null }, { accountKey: { $exists: false } }];
    else if (accountKey) query.accountKey = String(accountKey).toLowerCase();
    if (from || to) {
      const range = dateRange(from, to);
      query.closeTime = {};
      if (range.from) query.closeTime.$gte = range.from;
      if (range.to) query.closeTime.$lt = range.to;
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

async function findReplayTrade(tradeId, userId) {
  if (mongoose.connection.readyState === 1) {
    if (!mongoose.isValidObjectId(tradeId)) return null;
    return Trade.findOne({ _id: tradeId, user: userId }).select('_id playbookSnapshot').lean();
  }
  return inMemoryTrades.find(trade => String(trade._id) === String(tradeId) && isOfflineTradeVisibleToUser(trade, userId)) || null;
}

// GET /api/trades/:id/replay-journal?interval=15min
router.get('/trades/:id/replay-journal', auth, ownerOnly, async (req, res) => {
  try {
    const interval = String(req.query.interval || '');
    if (!REPLAY_ANNOTATION_INTERVALS.has(interval)) return res.status(400).json({ error: 'Unsupported Replay annotation timeframe' });
    if (!await findReplayTrade(req.params.id, req.user.userId)) return res.status(404).json({ error: 'Trade not found' });
    let journal;
    if (mongoose.connection.readyState === 1) {
      journal = await ReplayJournal.findOne({ user: req.user.userId, trade: req.params.id }).lean();
    } else {
      journal = inMemoryReplayJournals[`${req.user.userId}:${req.params.id}`] || null;
    }
    res.json({
      schemaVersion: journal?.schemaVersion || 1,
      revision: journal?.revision || 0,
      interval,
      annotations: journal?.annotationsByInterval?.[interval] || [],
      events: journal?.events || [],
      quickReview: journal?.quickReview || {},
      draft: journal?.draft || {},
      updatedAt: journal?.updatedAt || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/trades/:id/replay-journal/draft saves unfinished journal and playback state.
router.put('/trades/:id/replay-journal/draft', auth, ownerOnly, async (req, res) => {
  try {
    const draft = normalizeReplayDraft(req.body.draft);
    if (!await findReplayTrade(req.params.id, req.user.userId)) return res.status(404).json({ error: 'Trade not found' });
    let journal;
    if (mongoose.connection.readyState === 1) {
      journal = await ReplayJournal.findOne({ user: req.user.userId, trade: req.params.id });
      if (!journal) journal = new ReplayJournal({ user: req.user.userId, trade: req.params.id, annotationsByInterval: {}, events: [] });
      journal.draft = draft; journal.revision = Number(journal.revision || 0) + 1;
      journal.markModified('draft'); await journal.save();
    } else {
      const key = `${req.user.userId}:${req.params.id}`;
      const current = inMemoryReplayJournals[key] || { user: String(req.user.userId), trade: String(req.params.id), schemaVersion: 1, revision: 0, annotationsByInterval: {}, events: [] };
      journal = { ...current, draft, revision: Number(current.revision || 0) + 1, updatedAt: new Date().toISOString() };
      inMemoryReplayJournals[key] = journal; saveLocalReplayJournals();
    }
    res.json({ revision: journal.revision, draft, updatedAt: journal.updatedAt || new Date().toISOString() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/trades/:id/replay-journal/quick-review saves a draft or completed fast review.
router.put('/trades/:id/replay-journal/quick-review', auth, ownerOnly, async (req, res) => {
  try {
    const quickReview = normalizeQuickReview(req.body.quickReview);
    if (!await findReplayTrade(req.params.id, req.user.userId)) return res.status(404).json({ error: 'Trade not found' });
    let journal;
    if (mongoose.connection.readyState === 1) {
      journal = await ReplayJournal.findOne({ user: req.user.userId, trade: req.params.id });
      if (!journal) journal = new ReplayJournal({ user: req.user.userId, trade: req.params.id, annotationsByInterval: {}, events: [] });
      journal.quickReview = quickReview; journal.revision = Number(journal.revision || 0) + 1;
      journal.markModified('quickReview'); await journal.save();
    } else {
      const key = `${req.user.userId}:${req.params.id}`;
      const current = inMemoryReplayJournals[key] || { user: String(req.user.userId), trade: String(req.params.id), schemaVersion: 1, revision: 0, annotationsByInterval: {}, events: [] };
      journal = { ...current, quickReview, revision: Number(current.revision || 0) + 1, updatedAt: new Date().toISOString() };
      inMemoryReplayJournals[key] = journal; saveLocalReplayJournals();
    }
    res.json({ revision: journal.revision, quickReview, updatedAt: journal.updatedAt || new Date().toISOString() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/trades/:id/replay-journal/events replaces the ordered event timeline.
router.put('/trades/:id/replay-journal/events', auth, ownerOnly, async (req, res) => {
  try {
    const events = normalizeReplayEvents(req.body.events);
    const trade = await findReplayTrade(req.params.id, req.user.userId);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    const snapshot = trade.playbookSnapshot || null;
    const snapshotRuleIds = new Set(snapshot?.blocks?.flatMap(block => block.rules || []).map(rule => String(rule.ruleId)) || []);
    const invalidLink = events.find(event => event.playbookRuleId && (!snapshot || event.playbookVersionId !== String(snapshot.versionId) || !snapshotRuleIds.has(event.playbookRuleId)));
    if (invalidLink) return res.status(400).json({ error: `Timeline event cannot link to rule ${invalidLink.playbookRuleId} outside this trade's playbook snapshot` });
    let journal;
    if (mongoose.connection.readyState === 1) {
      journal = await ReplayJournal.findOne({ user: req.user.userId, trade: req.params.id });
      if (!journal) journal = new ReplayJournal({ user: req.user.userId, trade: req.params.id, annotationsByInterval: {}, events: [] });
      journal.events = events;
      journal.revision = Number(journal.revision || 0) + 1;
      await journal.save();
    } else {
      const key = `${req.user.userId}:${req.params.id}`;
      const current = inMemoryReplayJournals[key] || { user: String(req.user.userId), trade: String(req.params.id), schemaVersion: 1, revision: 0, annotationsByInterval: {}, events: [] };
      journal = { ...current, events, revision: Number(current.revision || 0) + 1, updatedAt: new Date().toISOString() };
      inMemoryReplayJournals[key] = journal;
      saveLocalReplayJournals();
    }
    res.json({ revision: journal.revision, events, updatedAt: journal.updatedAt || new Date().toISOString() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/trades/:id/replay-journal/annotations replaces one timeframe only.
router.put('/trades/:id/replay-journal/annotations', auth, ownerOnly, async (req, res) => {
  try {
    const interval = String(req.body.interval || '');
    const annotations = normalizeReplayAnnotations(interval, req.body.annotations);
    if (!await findReplayTrade(req.params.id, req.user.userId)) return res.status(404).json({ error: 'Trade not found' });
    let journal;
    if (mongoose.connection.readyState === 1) {
      journal = await ReplayJournal.findOne({ user: req.user.userId, trade: req.params.id });
      if (!journal) journal = new ReplayJournal({ user: req.user.userId, trade: req.params.id, annotationsByInterval: {} });
      journal.annotationsByInterval = { ...(journal.annotationsByInterval || {}), [interval]: annotations };
      journal.revision = Number(journal.revision || 0) + 1;
      journal.markModified('annotationsByInterval');
      await journal.save();
    } else {
      const key = `${req.user.userId}:${req.params.id}`;
      const current = inMemoryReplayJournals[key] || { user: String(req.user.userId), trade: String(req.params.id), schemaVersion: 1, revision: 0, annotationsByInterval: {} };
      journal = {
        ...current,
        revision: Number(current.revision || 0) + 1,
        annotationsByInterval: { ...(current.annotationsByInterval || {}), [interval]: annotations },
        updatedAt: new Date().toISOString(),
      };
      inMemoryReplayJournals[key] = journal;
      saveLocalReplayJournals();
    }
    res.json({ revision: journal.revision, interval, annotations, updatedAt: journal.updatedAt || new Date().toISOString() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/trades/:id/replay  requests MT5 first; ?fallback=twelve uses Twelve Data
router.get('/trades/:id/replay', auth, ownerOnly, async (req, res) => {
  try {
    // ── Find the trade ──────────────────────────────────────────────────────
    let trade;
    if (mongoose.connection.readyState === 1) {
      trade = await Trade.findOne({ _id: req.params.id, user: req.user.userId })
        .select('symbol direction entryPrice exitPrice openTime closeTime durationMinutes lotSize pnlUSD pnlPct notes emotion grade tags analysisGrade executionGrade plannedRR exitReason manuallyIntervened confidenceRating accountType accountKey playbookSnapshot playbookResponses screenshots')
        .lean();
    } else {
      trade = inMemoryTrades.find(
        t => String(t._id) === String(req.params.id) && isOfflineTradeVisibleToUser(t, req.user.userId)
      );
    }
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    const selectedInterval = requestedReplayInterval(req.query.interval, trade.durationMinutes);

    const cacheKey = `${req.params.id}:${selectedInterval}`;
    const cached = replayCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < REPLAY_CACHE_TTL_MS && Array.isArray(cached.data?.candles)) return res.json(cached.data);
    if (cached) replayCache.delete(cacheKey);

    const window = replayWindow(trade, selectedInterval);
    let candleData;
    try {
      candleData = await getCTraderTrendbars({
        userId: req.user.userId,
        symbol: trade.symbol,
        periodLabel: window.interval,
        fromMs: new Date(window.start).getTime(),
        toMs: new Date(window.end).getTime(),
        // Prefer the connection matching where this trade actually came from
        // (its symbol universe/host are consistent with it), falling back to
        // any connected account for MT5 trades or trades with no accountKey.
        preferredCtidTraderAccountId: String(trade.accountKey || '').startsWith('ctrader:')
          ? trade.accountKey.slice('ctrader:'.length)
          : undefined,
      });
    } catch (err) {
      const setupCodes = new Set(['NOT_CONNECTED', 'NO_ACCOUNT_SELECTED']);
      const status = setupCodes.has(err.code) ? 503 : err.code === 'SYMBOL_NOT_FOUND' ? 422 : 502;
      return res.status(status).json({ error: err.message, code: err.code || 'CTRADER_ERROR', setup: setupCodes.has(err.code) });
    }

    if (!candleData.candles.length) {
      return res.status(422).json({ error: `cTrader returned no candles for ${trade.symbol} (${window.interval}).` });
    }

    const result = buildReplayResult(trade, candleData, window.interval);
    replayCache.set(cacheKey, { ts: Date.now(), data: result });
    res.json(result);

  } catch (err) {
    console.error('[Replay]', err.message);
    res.status(500).json({ error: err.message || 'Failed to load replay data' });
  }
});

// PUT /api/trades/:id  update journal data (notes, tags, emotion, grade, checklist + Edge Coach fields)
router.put('/trades/:id', auth, ownerOnly, async (req, res) => {
  try {
    const {
      notes, tags, emotion, grade, checklist,
      // Edge Coach fields
      analysisGrade, executionGrade,
      plannedRR, exitReason, manuallyIntervened,
      confidenceRating, accountType,
      isReEntry, parentTradeId, tradeGroup, reEntryReason,
      primarySetup, setupConfirmations,
      executionChecklist,
      playbookId, playbookVersionId, playbookResponses,
      stopLoss, takeProfit,
    } = req.body;

    // A stop typed in by hand: blank clears it, anything else must be a price.
    const priceInput = value => (value === null || value === '' ? null : Number(value));
    for (const [label, value] of [['Stop loss', stopLoss], ['Take profit', takeProfit]]) {
      if (value === undefined) continue;
      const n = priceInput(value);
      if (n !== null && !(Number.isFinite(n) && n > 0)) return res.status(400).json({ error: `${label} must be a price above 0.` });
    }
    // The stop's risk (and so the trade's R) is worked out from the trade itself.
    const stopFields = t => {
      const out = {};
      if (takeProfit !== undefined) out.takeProfit = priceInput(takeProfit);
      if (stopLoss === undefined) return out;
      const stop = priceInput(stopLoss);
      if (stop !== null && !isLossSideStop(t.direction, t.entryPrice, stop)) {
        const err = new Error(`A ${t.direction === 'SELL' ? 'sell' : 'buy'}'s stop loss has to be ${t.direction === 'SELL' ? 'above' : 'below'} its entry price (${t.entryPrice}).`);
        err.status = 400;
        throw err;
      }
      return { ...out, stopLoss: stop, ...(stop === null ? { riskUSD: null, riskPercent: null } : riskFromStop(t, stop)) };
    };

    let canonicalPlaybookSnapshot;
    let validatedPlaybookResponses;
    let lockedPlaybookSnapshot = null;
    let existingTrade;
    if (playbookId !== undefined || playbookResponses !== undefined) {
      if (mongoose.connection.readyState === 1) {
        existingTrade = await Trade.findOne({ _id: req.params.id, user: req.user.userId }).select('playbookSnapshot screenshots').lean();
      } else {
        existingTrade = inMemoryTrades.find(t => String(t._id) === String(req.params.id) && isOfflineTradeVisibleToUser(t, req.user.userId));
      }
      if (!existingTrade) return res.status(404).json({ error: 'Trade not found' });
      lockedPlaybookSnapshot = existingTrade.playbookSnapshot || null;
      if (playbookId !== undefined && lockedPlaybookSnapshot && (
        String(playbookId || '') !== String(lockedPlaybookSnapshot.playbookId || '')
        || String(playbookVersionId || '') !== String(lockedPlaybookSnapshot.versionId || '')
      )) {
        return res.status(409).json({ error: `This journal is permanently attached to ${lockedPlaybookSnapshot.name} v${lockedPlaybookSnapshot.versionNumber}. Its playbook version cannot be replaced.` });
      }
    }
    if (lockedPlaybookSnapshot) {
      canonicalPlaybookSnapshot = lockedPlaybookSnapshot;
      validatedPlaybookResponses = validatePlaybookResponses(canonicalPlaybookSnapshot, playbookResponses, existingTrade?.screenshots || []);
    } else if (playbookId !== undefined && playbookId) {
      const playbooks = await getPlaybooks(req.user.userId);
      const playbook = playbooks.find(item => item.playbookId === String(playbookId));
      if (!playbook) return res.status(400).json({ error: 'Strategy not found' });
      const version = playbook.versions.find(item => item.versionId === String(playbookVersionId))
        || playbook.versions[playbook.versions.length - 1];
      if (!version) return res.status(400).json({ error: 'Strategy has no published version' });
      canonicalPlaybookSnapshot = {
        playbookId: playbook.playbookId,
        name: playbook.name,
        description: playbook.description,
        versionId: version.versionId,
        versionNumber: version.versionNumber,
        schemaVersion: version.schemaVersion || 1,
        publishedAt: version.publishedAt,
        blocks: version.blocks,
      };
      validatedPlaybookResponses = validatePlaybookResponses(canonicalPlaybookSnapshot, playbookResponses, existingTrade?.screenshots || []);
    }

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
      if (parentTradeId !== undefined) {
        t.parentTradeId = String(parentTradeId || '');
        // Auto-group under parentTradeId if set, otherwise fallback to own _id if isReEntry is true
        t.tradeGroup = t.parentTradeId ? t.parentTradeId : (t.isReEntry ? String(t._id) : '');
      } else if (tradeGroup !== undefined) {
        t.tradeGroup = String(tradeGroup || '').trim().slice(0, 60);
      }
      if (reEntryReason !== undefined) t.reEntryReason = String(reEntryReason || '').slice(0, 500);
      if (primarySetup !== undefined) t.primarySetup = primarySetup;
      if (setupConfirmations !== undefined) t.setupConfirmations = Array.isArray(setupConfirmations) ? setupConfirmations : [];
      if (executionChecklist !== undefined) t.executionChecklist = Array.isArray(executionChecklist) ? executionChecklist : [];
      if (playbookId !== undefined) {
        t.playbookId = canonicalPlaybookSnapshot?.playbookId || '';
        t.playbookVersionId = canonicalPlaybookSnapshot?.versionId || '';
        t.playbookSnapshot = canonicalPlaybookSnapshot || null;
        t.playbookResponses = validatedPlaybookResponses || {};
      } else if (playbookResponses !== undefined && t.playbookSnapshot) {
        t.playbookResponses = validatedPlaybookResponses || {};
      }
      return t;
    }

    // Database Offline Fallback
    if (mongoose.connection.readyState !== 1) {
      const tradeIdx = inMemoryTrades.findIndex(t => t._id === req.params.id);
      if (tradeIdx === -1) return res.status(404).json({ error: 'Trade not found' });
      Object.assign(inMemoryTrades[tradeIdx], stopFields(inMemoryTrades[tradeIdx]));
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
    if (parentTradeId !== undefined) {
      update.parentTradeId = String(parentTradeId || '');
      // Auto-group under parentTradeId if set, otherwise fallback to own ID if isReEntry is true
      update.tradeGroup = update.parentTradeId ? update.parentTradeId : (isReEntry ? String(req.params.id) : '');
    } else if (tradeGroup !== undefined) {
      update.tradeGroup = String(tradeGroup || '').trim().slice(0, 60);
    }
    if (reEntryReason !== undefined) update.reEntryReason = String(reEntryReason || '').slice(0, 500);
    if (primarySetup !== undefined) update.primarySetup = primarySetup;
    if (setupConfirmations !== undefined) update.setupConfirmations = Array.isArray(setupConfirmations) ? setupConfirmations : [];
    if (executionChecklist !== undefined) update.executionChecklist = Array.isArray(executionChecklist) ? executionChecklist : [];
    if (playbookId !== undefined) {
      update.playbookId = canonicalPlaybookSnapshot?.playbookId || '';
      update.playbookVersionId = canonicalPlaybookSnapshot?.versionId || '';
      update.playbookSnapshot = canonicalPlaybookSnapshot || null;
      update.playbookResponses = validatedPlaybookResponses || {};
    } else if (playbookResponses !== undefined) {
      update.playbookResponses = validatedPlaybookResponses || {};
    }

    if (stopLoss !== undefined || takeProfit !== undefined) {
      const current = await Trade.findOne({ _id: req.params.id, user: req.user.userId })
        .select('direction entryPrice exitPrice lotSize pnlUSD swap commission runningBalance symbol accountKey grossPnl').lean();
      if (!current) return res.status(404).json({ error: 'Trade not found' });
      Object.assign(update, stopFields(current));
    }

    const updated = await Trade.findOneAndUpdate(
      { _id: req.params.id, user: req.user.userId },
      update,
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: 'Trade not found' });

    // Mirror to inMemoryTrades and local JSON
    const tradeIdx = inMemoryTrades.findIndex(t => String(t._id) === String(req.params.id));
    if (tradeIdx !== -1) {
      for (const key of ['stopLoss', 'takeProfit', 'riskUSD', 'riskPercent']) if (key in update) inMemoryTrades[tradeIdx][key] = update[key];
      inMemoryTrades[tradeIdx] = applyFields(inMemoryTrades[tradeIdx]);
      saveLocalDatabase();
    }

    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/trades/:id/copy-journal  { fromTradeId }
// Copies another trade's journal (grades, notes, playbook answers,
// screenshots...) onto this one -- the same trade taken on another account.
router.post('/trades/:id/copy-journal', auth, ownerOnly, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'Copying a journal requires the database to be connected.' });
    }
    const fromTradeId = String(req.body?.fromTradeId || '');
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(fromTradeId)) {
      return res.status(400).json({ error: 'Both trades are required.' });
    }
    if (fromTradeId === req.params.id) return res.status(400).json({ error: 'Pick a different trade to copy from.' });
    const [source, target] = await Promise.all([
      Trade.findOne({ _id: fromTradeId, user: req.user.userId }).lean(),
      Trade.findOne({ _id: req.params.id, user: req.user.userId }).lean(),
    ]);
    if (!source || !target) return res.status(404).json({ error: 'Trade not found' });
    if (!hasJournal(source)) return res.status(400).json({ error: 'That trade has no journal to copy yet.' });

    const updated = await Trade.findOneAndUpdate(
      { _id: target._id, user: req.user.userId },
      { $set: journalCopyUpdate(source, target) },
      { new: true },
    );
    syncLocalTrade(updated);
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/trades/:id/screenshots  upload a manually captured chart screenshot
router.post('/trades/:id/screenshots', auth, ownerOnly, async (req, res) => {
  try {
    const { imageData, caption = '', playbookRuleId = '', playbookVersionId = '' } = req.body;
    const linkedRuleId = String(playbookRuleId || '').trim().slice(0, 100);
    const linkedVersionId = String(playbookVersionId || '').trim().slice(0, 100);
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
        playbookRuleId: linkedRuleId,
        playbookVersionId: linkedVersionId,
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
          playbookRuleId: linkedRuleId,
          playbookVersionId: linkedVersionId,
          uploadedAt: new Date().toISOString(),
          offlinePending: true,
        });
        saveLocalDatabase();
      }

      return res.json({
        ...offlineTrade,
        screenshots: inMemoryTrades[tradeIdx]?.screenshots || [],
        _offlineScreenshot: true,
        _message: 'Screenshot saved locally. Will be uploaded to Cloudinary once the database reconnects.',
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
    const evidenceLink = { playbookRuleId: linkedRuleId, playbookVersionId: linkedVersionId };
    const contextTags = buildCloudinaryContext(trade, caption, evidenceLink);

    const upload = await cloudinary.uploader.upload(imageData, {
      folder: `trade-journal/${req.user.userId}/${trade._id}`,
      resource_type: 'image',
      context: contextTags,
      overwrite: false,
    });

    // Upload sidecar metadata.json to Cloudinary alongside the image (as raw)
    const sidecarData = JSON.stringify(buildSidecarMetadata(trade, caption, upload.secure_url, evidenceLink), null, 2);
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
      playbookRuleId: linkedRuleId,
      playbookVersionId: linkedVersionId,
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
router.patch('/trades/:id/screenshots/:screenshotId', auth, ownerOnly, async (req, res) => {
  try {
    const { caption = '' } = req.body;

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'Screenshot captions require the database to be connected.' });
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
router.delete('/trades/:id/screenshots/:screenshotId', auth, ownerOnly, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'Screenshot deletes require the database to be connected.' });
    }

    const trade = await Trade.findOne({ _id: req.params.id, user: req.user.userId });
    if (!trade) {
      return res.status(404).json({ error: 'Trade not found' });
    }

    const screenshot = trade.screenshots.id(req.params.screenshotId);
    if (!screenshot) {
      return res.status(404).json({ error: 'Screenshot not found' });
    }

    // A copied journal shares the image with another trade: keep the file until no trade uses it.
    const sharedElsewhere = screenshot.publicId && await Trade.exists({
      _id: { $ne: trade._id }, user: req.user.userId, 'screenshots.publicId': screenshot.publicId,
    });
    if (CLOUDINARY_READY && screenshot.publicId && !sharedElsewhere) {
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
router.post('/sync', auth, syncAgentOnly, async (req, res) => {
  try {
    const { trades } = req.body;
    if (!Array.isArray(trades) || trades.length === 0) {
      return res.status(400).json({ error: 'trades array is required' });
    }

    const tradesMissingAccount = findTradesMissingAccountIdentity(trades);
    if (tradesMissingAccount.length > 0) {
      return res.status(400).json({
        error: 'Every synced trade must include an MT5 account login and server (or accountKey). Update and restart sync.py.',
        missingAccountDealIds: tradesMissingAccount.slice(0, 20),
        missingAccountCount: tradesMissingAccount.length,
      });
    }

    const requestedAccountIds = [...new Set(trades.map(trade => String(trade.tradingAccountId || '')).filter(Boolean))];
    const managedAccounts = mongoose.connection.readyState === 1 && requestedAccountIds.length
      ? await TradingAccount.find({ _id: { $in: requestedAccountIds }, user: req.user.userId, archivedAt: null }).lean()
      : [];
    const managedAccountMap = new Map(managedAccounts.map(account => [String(account._id), account]));
    if (requestedAccountIds.some(accountId => !managedAccountMap.has(accountId))) {
      return res.status(400).json({ error: 'One or more synced trades reference an unknown trading account.' });
    }

    const identityForTrade = trade => {
      const base = normalizeAccountIdentity(trade);
      const managed = managedAccountMap.get(String(trade.tradingAccountId || ''));
      if (!managed) return base;
      return {
        ...base,
        accountKey: managed.accountKey,
        accountName: managed.label,
        accountType: managed.actualAccountType || base.accountType,
        tradingAccount: managed._id,
      };
    };

    const EXIT_TRIGGERS = new Set(['SL', 'TP', 'StopOut', 'Expert', 'Manual']);
    // Fields the MT5 sync agent reads directly off the broker (order sl/tp,
    // deal.reason, magic number, contract/tick info) rather than anything the
    // trader typed in — these power real R-multiple math.
    const riskFieldsForTrade = t => ({
      stopLoss: Number.isFinite(Number(t.stopLoss)) && Number(t.stopLoss) > 0 ? Number(t.stopLoss) : null,
      takeProfit: Number.isFinite(Number(t.takeProfit)) && Number(t.takeProfit) > 0 ? Number(t.takeProfit) : null,
      riskUSD: Number.isFinite(Number(t.riskUSD)) ? Number(t.riskUSD) : null,
      riskPercent: Number.isFinite(Number(t.riskPercent)) ? Number(t.riskPercent) : null,
      exitTrigger: EXIT_TRIGGERS.has(t.exitTrigger) ? t.exitTrigger : '',
      magic: Number.isFinite(Number(t.magic)) ? Number(t.magic) : 0,
      contractSize: Number.isFinite(Number(t.contractSize)) && Number(t.contractSize) > 0 ? Number(t.contractSize) : null,
      tickValue: Number.isFinite(Number(t.tickValue)) && Number(t.tickValue) > 0 ? Number(t.tickValue) : null,
    });

    let inserted = 0;
    let skipped = 0;
    let accountTypesUpdated = 0;
    let accountMetadataUpdated = 0;
    const userRules = await getUserRules(req.user.userId);
    const checklistSnapshot = userRules
      .filter(rule => rule.category === 'pre_trade' && rule.enabled !== false)
      .sort((a, b) => a.order - b.order)
      .map(rule => ({ ruleId: rule.ruleId, rule: rule.label, complied: false }));
    const executionChecklistSnapshot = userRules
      .filter(rule => rule.category === 'execution' && rule.enabled !== false)
      .sort((a, b) => a.order - b.order)
      .map(rule => ({ ruleId: rule.ruleId, rule: rule.label, complied: false }));

    // Database Offlne Fallback
    if (mongoose.connection.readyState !== 1) {
      for (const t of trades) {
        const accountIdentity = identityForTrade(t);
        const existingIndex = inMemoryTrades.findIndex(x => sameTradeOwnerAndDealId(x, req.user.userId, t.dealId, accountIdentity.accountKey));
        if (existingIndex !== -1) {
          const existingTrade = inMemoryTrades[existingIndex];
          const metadataChanged = Object.entries(accountIdentity).some(([key, value]) => value && existingTrade[key] !== value);
          if (metadataChanged) {
            Object.entries(accountIdentity).forEach(([key, value]) => { if (value) existingTrade[key] = value; });
            accountMetadataUpdated++;
            if (accountIdentity.accountType) accountTypesUpdated++;
          }
          skipped++;
          continue;
        }

        const newTrade = {
          _id: accountIdentity.accountKey ? `${accountIdentity.accountKey}:${t.dealId}` : String(t.dealId),
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
          ...riskFieldsForTrade(t),
          ...accountIdentity,
          checklist: checklistSnapshot.map(rule => ({ ...rule })),
          executionChecklist: executionChecklistSnapshot.map(rule => ({ ...rule })),
          user: req.user.userId,
          synced: new Date().toISOString()
        };

        inMemoryTrades.push(newTrade);
        inserted++;
      } if (inserted > 0 || accountMetadataUpdated > 0) {
        saveLocalDatabase();
      }

      return res.json({ inserted, skipped, accountTypesUpdated, accountMetadataUpdated, total: trades.length });
    }

    for (const t of trades) {
      try {
        const accountIdentity = identityForTrade(t);
        let existing = await Trade.findOne({
          user: req.user.userId,
          dealId: String(t.dealId),
          ...(accountIdentity.accountKey ? { accountKey: accountIdentity.accountKey } : {}),
        }).select('_id accountKey accountLogin accountServer accountName accountType');
        if (!existing && accountIdentity.accountKey) {
          existing = await Trade.findOne({
            user: req.user.userId,
            dealId: String(t.dealId),
            $or: [{ accountKey: '' }, { accountKey: null }, { accountKey: { $exists: false } }],
          }).select('_id accountKey accountLogin accountServer accountName accountType');
        }

        if (existing) {
          const metadata = Object.fromEntries(Object.entries(accountIdentity).filter(([, value]) => value));
          const metadataChanged = Object.entries(metadata).some(([key, value]) => existing[key] !== value);
          if (metadataChanged) {
            await Trade.updateOne({ _id: existing._id, user: req.user.userId }, { $set: metadata });
            const memoryIndex = inMemoryTrades.findIndex(item => String(item._id) === String(existing._id));
            if (memoryIndex !== -1) Object.assign(inMemoryTrades[memoryIndex], metadata);
            accountMetadataUpdated++;
            if (accountIdentity.accountType) accountTypesUpdated++;
          }
          skipped++;
          continue;
        }
        // Already imported from an uploaded MT5 report (one trade per position).
        if (t.positionId && accountIdentity.accountKey && await Trade.findOne({
          user: req.user.userId, accountKey: accountIdentity.accountKey, positionId: String(t.positionId), importSource: 'mt5-statement',
        }).select('_id')) {
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
          ...riskFieldsForTrade(t),
          ...accountIdentity,
          checklist: checklistSnapshot.map(rule => ({ ...rule })),
          executionChecklist: executionChecklistSnapshot.map(rule => ({ ...rule })),
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
    } if (inserted > 0 || accountMetadataUpdated > 0) {
      saveLocalDatabase();
    }

    res.json({ inserted, skipped, accountTypesUpdated, accountMetadataUpdated, total: trades.length });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats  aggregated performance metrics
router.get('/stats', auth, ownerOnly, async (req, res) => {
  try {
    const { range, accountKey } = req.query;
    let trades;

    // Database Offlne Fallback
    if (mongoose.connection.readyState !== 1) {
      let filtered = inMemoryTrades.filter(t => isOfflineTradeVisibleToUser(t, req.user.userId));
      if (accountKey) filtered = filtered.filter(t => tradeMatchesAccountFilter(t, accountKey));
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
      if (accountKey) applyAccountKeyToMongoQuery(query, accountKey);
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
    }

    // Optional grouping by trade setup
    const groupBySetup = req.query.groupBySetup === 'true';
    if (groupBySetup) {
      const groups = new Map();
      for (const t of trades) {
        const plain = typeof t.toObject === 'function' ? t.toObject() : t;
        // Group trades by their tradeGroup ID, fallback to using their own _id
        const key = plain.tradeGroup || String(plain._id);
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key).push(plain);
      }

      const groupedTrades = [];
      for (const [key, items] of groups.entries()) {
        // Sort items inside group chronologically
        items.sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));
        const first = items[0];
        const last = items[items.length - 1];

        // Sum values across group
        const totalPnl = items.reduce((s, x) => s + (x.pnlUSD || 0), 0);
        const totalComm = items.reduce((s, x) => s + (x.commission || 0), 0);
        const totalSwap = items.reduce((s, x) => s + (x.swap || 0), 0);
        const totalDuration = items.reduce((s, x) => s + (x.durationMinutes || 0), 0);

        // Group acts as a single combined trade setup
        groupedTrades.push({
          _id: key,
          dealId: first.dealId,
          symbol: first.symbol,
          direction: first.direction,
          entryPrice: first.entryPrice,
          exitPrice: last.exitPrice,
          lotSize: items.reduce((s, x) => s + (x.lotSize || 0), 0),
          pnlUSD: totalPnl,
          commission: totalComm,
          swap: totalSwap,
          openTime: first.openTime,
          closeTime: last.closeTime,
          durationMinutes: totalDuration,
          runningBalance: last.runningBalance,
          notes: first.notes,
          grade: first.grade,
          analysisGrade: first.analysisGrade,
          executionGrade: first.executionGrade,
          tags: Array.from(new Set(items.flatMap(x => x.tags || []))),
          emotion: first.emotion,
          checklist: first.checklist,
        });
      }
      // Re-sort chronologically by latest closeTime in each group
      groupedTrades.sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));
      trades = groupedTrades;
    }

    // Every downstream metric below divides by trades.length; return zeros
    // instead of NaN (which JSON serializes as null, indistinguishable from
    // a real "no data" gap) when the selected range has no trades.
    if (trades.length === 0) {
      return res.json({
        totalTrades: 0, winRate: 0, profitFactor: 0, netPnL: 0,
        biggestWin: 0, biggestLoss: 0, currentDrawdown: 0, maxDrawdownPct: 0,
        equityCurve: [], bySymbol: [], byDayOfWeek: [], byMonth: [],
        avgDurationMin: 0, avgWinUSD: 0, avgLossUSD: 0, winLossRatio: 0,
        expectancyUSD: 0, maxWinStreak: 0, maxLossStreak: 0, sharpeRatio: 0,
        bySession: [], byDirection: [], byTag: [], byEmotion: [], byGrade: [], globalComplianceRate: null, tradesWithPlaybookData: 0,
        mixedAccounts: false, accountKeys: [],
        avgR: null, avgWinR: null, avgLossR: null, tradesWithRiskData: 0,
      });
    }

    // runningBalance/drawdown are per broker account; flag when trades from
    // more than one account are blended into this response (see /performance).
    const distinctAccountKeys = [...new Set(trades.map(t => String(t.accountKey || '')).filter(Boolean))];
    const mixedAccounts = !accountKey && distinctAccountKeys.length > 1;

    // pnlUSD alone is only the trade's raw price P&L. commission and swap are
    // real money the broker actually took, so runningBalance (and therefore
    // win/loss, profit factor, and every P&L total below) has to include them
    // — otherwise this journal's numbers disagree with the account balance.
    const netAmount = t => Number(t.pnlUSD || 0) + Number(t.commission || 0) + Number(t.swap || 0);

    const wins = trades.filter(t => netAmount(t) > 0);
    const losses = trades.filter(t => netAmount(t) < 0);
    const grossProfit = wins.reduce((s, t) => s + netAmount(t), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + netAmount(t), 0));
    const netPnL = trades.reduce((s, t) => s + netAmount(t), 0);
    const grossPnL = trades.reduce((s, t) => s + Number(t.pnlUSD || 0), 0); // pre-cost, for comparison

    // Equity curve (running balance over time)
    const equityCurve = trades.map(t => ({
      date: t.closeTime,
      balance: t.runningBalance,
      pnl: netAmount(t),
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

    // Advanced Metrics
    const avgWinUSD = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLossUSD = losses.length > 0 ? grossLoss / losses.length : 0;
    // 999 is a "no losses to divide by" sentinel, not a real ratio — JSON has
    // no Infinity, and Infinity serializes as null (indistinguishable from a
    // genuine gap in the data). Matches the convention already used in /performance.
    const winLossRatio = avgLossUSD > 0 ? avgWinUSD / avgLossUSD : avgWinUSD > 0 ? 999 : 0;
    
    const winRate = (wins.length / trades.length) * 100;
    const lossRate = 100 - winRate;
    const expectancyUSD = (winRate / 100 * avgWinUSD) - (lossRate / 100 * avgLossUSD);

    // Win/Loss Streaks
    let currentWinStreak = 0;
    let currentLossStreak = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    for (const t of trades) {
      if (netAmount(t) > 0) {
        currentWinStreak++;
        currentLossStreak = 0;
        if (currentWinStreak > maxWinStreak) maxWinStreak = currentWinStreak;
      } else if (netAmount(t) < 0) {
        currentLossStreak++;
        currentWinStreak = 0;
        if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
      }
    }

    // Sharpe Ratio
    const meanPnL = netPnL / trades.length;
    const variance = trades.reduce((s, t) => s + Math.pow(netAmount(t) - meanPnL, 2), 0) / trades.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? meanPnL / stdDev : 0;

    // P&L by symbol
    const symbolMap = {};
    for (const t of trades) {
      if (!symbolMap[t.symbol]) symbolMap[t.symbol] = { symbol: t.symbol, pnl: 0, trades: 0, wins: 0 };
      symbolMap[t.symbol].pnl += netAmount(t);
      symbolMap[t.symbol].trades++;
      if (netAmount(t) > 0) symbolMap[t.symbol].wins++;
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
      dayMap[day].pnl += netAmount(t);
      dayMap[day].trades++;
    }
    const byDayOfWeek = days.map(d => dayMap[d] || { day: d, pnl: 0, trades: 0 });

    // Monthly P&L
    const monthMap = {};
    for (const t of trades) {
      const d = new Date(t.closeTime);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!monthMap[key]) monthMap[key] = { month: key, pnl: 0, trades: 0, wins: 0 };
      monthMap[key].pnl += netAmount(t);
      monthMap[key].trades++;
      if (netAmount(t) > 0) monthMap[key].wins++;
    }
    const byMonth = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));

    const avgDurationMin = trades.reduce((s, t) => s + (t.durationMinutes || 0), 0) / trades.length;

    // Session analytics based on closeTime UTC hour
    const bySessionMap = {
      Tokyo: { session: 'Tokyo (Asian)', pnl: 0, trades: 0, wins: 0 },
      London: { session: 'London (Europe)', pnl: 0, trades: 0, wins: 0 },
      Overlap: { session: 'London/NY Overlap', pnl: 0, trades: 0, wins: 0 },
      NewYork: { session: 'New York (US)', pnl: 0, trades: 0, wins: 0 },
      Pacific: { session: 'Pacific/Late NY', pnl: 0, trades: 0, wins: 0 },
    };
    for (const t of trades) {
      const utcHour = new Date(t.closeTime).getUTCHours();
      let sess = 'Pacific';
      if (utcHour >= 0 && utcHour < 8) sess = 'Tokyo';
      else if (utcHour >= 8 && utcHour < 13) sess = 'London';
      else if (utcHour >= 13 && utcHour < 16) sess = 'Overlap';
      else if (utcHour >= 16 && utcHour < 21) sess = 'NewYork';

      bySessionMap[sess].pnl += netAmount(t);
      bySessionMap[sess].trades++;
      if (netAmount(t) > 0) bySessionMap[sess].wins++;
    }
    const bySession = Object.values(bySessionMap).map(s => ({
      ...s,
      winRate: s.trades > 0 ? (s.wins / s.trades) * 100 : 0
    }));

    // Buy vs Sell profitability
    const byDirectionMap = {
      BUY: { direction: 'BUY', pnl: 0, trades: 0, wins: 0 },
      SELL: { direction: 'SELL', pnl: 0, trades: 0, wins: 0 },
    };
    for (const t of trades) {
      const dir = byDirectionMap[t.direction] ? t.direction : null;
      if (!dir) continue;
      byDirectionMap[dir].pnl += netAmount(t);
      byDirectionMap[dir].trades++;
      if (netAmount(t) > 0) byDirectionMap[dir].wins++;
    }
    const byDirection = Object.values(byDirectionMap).map(d => ({
      ...d,
      winRate: d.trades > 0 ? (d.wins / d.trades) * 100 : 0,
      avgPnL: d.trades > 0 ? d.pnl / d.trades : 0,
    }));

    // Performance by Tag
    const tagMap = {};
    for (const t of trades) {
      if (t.tags && t.tags.length > 0) {
        for (const tag of t.tags) {
          const trimmed = tag.trim();
          if (!trimmed) continue;
          if (!tagMap[trimmed]) tagMap[trimmed] = { tag: trimmed, pnl: 0, trades: 0, wins: 0 };
          tagMap[trimmed].pnl += netAmount(t);
          tagMap[trimmed].trades++;
          if (netAmount(t) > 0) tagMap[trimmed].wins++;
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
        emotionMap[emo].pnl += netAmount(t);
        emotionMap[emo].trades++;
        if (netAmount(t) > 0) emotionMap[emo].wins++;
      }
    }
    const byEmotion = Object.values(emotionMap).map(em => ({
      ...em,
      winRate: em.trades > 0 ? (em.wins / em.trades) * 100 : 0
    })).sort((a, b) => b.pnl - a.pnl);

    // Global Playbook compliance -- % of a trade's own required playbook
    // fields (and required screenshot confirmations) actually filled in.
    // Re-entries are excluded: they don't carry their own playbook (see the
    // re-entry journal simplification), so they'd otherwise drag this down
    // for a reason that has nothing to do with anyone's discipline.
    const isAnswered = value => !(value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0));
    let totalRequiredItems = 0;
    let completedRequiredItems = 0;
    let tradesWithPlaybookData = 0;
    for (const t of trades) {
      if (t.isReEntry || !t.playbookSnapshot) continue;
      tradesWithPlaybookData++;
      const responses = t.playbookResponses || {};
      for (const block of t.playbookSnapshot.blocks || []) {
        for (const rule of block.rules || []) {
          if (rule.required) {
            totalRequiredItems++;
            if (isAnswered(responses[rule.ruleId])) completedRequiredItems++;
          }
          if (rule.exampleRequirement?.required) {
            totalRequiredItems++;
            const minimum = rule.exampleRequirement.minimumImages || 1;
            const confirmations = (t.screenshots || []).filter(s => s.playbookRuleId === rule.ruleId && s.playbookVersionId === t.playbookSnapshot.versionId);
            if (confirmations.length >= minimum) completedRequiredItems++;
          }
        }
      }
    }
    const globalComplianceRate = totalRequiredItems > 0 ? (completedRequiredItems / totalRequiredItems) * 100 : null;

    // Performance by Grade
    const gradeMap = {};
    for (const t of trades) {
      if (t.grade) {
        const grd = t.grade;
        if (!gradeMap[grd]) gradeMap[grd] = { grade: grd, pnl: 0, trades: 0, wins: 0 };
        gradeMap[grd].pnl += netAmount(t);
        gradeMap[grd].trades++;
        if (netAmount(t) > 0) gradeMap[grd].wins++;
      }
    }
    const byGrade = Object.values(gradeMap).map(g => ({
      ...g,
      winRate: g.trades > 0 ? (g.wins / g.trades) * 100 : 0
    })).sort((a, b) => a.grade.localeCompare(b.grade));

    const rStats = summarizeRMultiples(trades);

    // How far to trust each number: sample-size level plus 95% ranges for
    // win rate and average result, for the headline and every breakdown row.
    const confidenceOf = list => confidenceFor(
      list.length,
      list.filter(t => netAmount(t) > 0).length,
      list.map(netAmount),
      list.map(realizedRMultiple).filter(r => r !== null),
    );
    const sessionOf = t => {
      const h = new Date(t.closeTime).getUTCHours();
      return bySessionMap[h < 8 ? 'Tokyo' : h < 13 ? 'London' : h < 16 ? 'Overlap' : h < 21 ? 'NewYork' : 'Pacific'].session;
    };
    const monthOf = t => { const d = new Date(t.closeTime); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
    const withConfidence = (rows, rowKey, keysOf) => {
      const buckets = new Map();
      for (const t of trades) for (const key of [].concat(keysOf(t))) {
        if (key == null || key === '') continue;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(t);
      }
      return rows.map(row => ({ ...row, confidence: confidenceOf(buckets.get(row[rowKey]) || []) }));
    };

    res.json({
      confidence: confidenceOf(trades),
      totalTrades: trades.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
      netPnL,
      grossPnL, // pre-commission/swap total, for comparison against netPnL
      biggestWin: wins.length > 0 ? Math.max(...wins.map(t => netAmount(t))) : 0,
      biggestLoss: losses.length > 0 ? Math.min(...losses.map(t => netAmount(t))) : 0,
      currentDrawdown,
      maxDrawdownPct,
      equityCurve,
      bySymbol: withConfidence(bySymbol, 'symbol', t => t.symbol),
      byDayOfWeek: withConfidence(byDayOfWeek, 'day', t => days[new Date(t.closeTime).getDay()]),
      byMonth: withConfidence(byMonth, 'month', monthOf),
      avgDurationMin,
      avgWinUSD,
      avgLossUSD,
      winLossRatio,
      expectancyUSD,
      maxWinStreak,
      maxLossStreak,
      sharpeRatio,
      bySession: withConfidence(bySession, 'session', sessionOf),
      byDirection: withConfidence(byDirection, 'direction', t => t.direction),
      byTag: withConfidence(byTag, 'tag', t => (t.tags || []).map(tag => tag.trim())),
      byEmotion: withConfidence(byEmotion, 'emotion', t => t.emotion),
      byGrade: withConfidence(byGrade, 'grade', t => t.grade),
      globalComplianceRate,
      tradesWithPlaybookData,
      mixedAccounts,
      accountKeys: distinctAccountKeys,
      avgR: rStats.avgR,
      avgWinR: rStats.avgWinR,
      avgLossR: rStats.avgLossR,
      tradesWithRiskData: rStats.tradesWithRiskData,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calendar  aggregate closed trades daly net P&L and stats
router.get('/calendar', auth, ownerOnly, async (req, res) => {
  try {
    const { symbol, grade, accountKey } = req.query;
    const netAmount = t => Number(t.pnlUSD || 0) + Number(t.commission || 0) + Number(t.swap || 0);

    // Database Offlne Fallback
    if (mongoose.connection.readyState !== 1) {
      const ownerTrades = inMemoryTrades.filter(t => isOfflineTradeVisibleToUser(t, req.user.userId));
      const distinctAccountKeys = [...new Set(ownerTrades.map(t => String(t.accountKey || '')).filter(Boolean))];
      const mixedAccounts = !accountKey && distinctAccountKeys.length > 1;
      let filtered = ownerTrades;
      if (symbol) filtered = filtered.filter(t => sameSymbol(t.symbol, symbol));
      if (grade) filtered = filtered.filter(t => t.grade === grade.toUpperCase());
      if (accountKey) filtered = filtered.filter(t => tradeMatchesAccountFilter(t, accountKey));

      const calendarData = {};
      for (const t of filtered) {
        const dateStr = t.closeTime.split('T')[0];
        if (!calendarData[dateStr]) {
          calendarData[dateStr] = {
            pnl: 0,
            tradesCount: 0,
            wins: 0,
            date: dateStr,
            _rSum: 0, _rCount: 0,
          };
        }
        calendarData[dateStr].pnl += netAmount(t);
        calendarData[dateStr].tradesCount++;
        if (netAmount(t) > 0) calendarData[dateStr].wins++;
        const r = realizedRMultiple(t);
        if (r !== null) { calendarData[dateStr]._rSum += r; calendarData[dateStr]._rCount++; }
      }
      for (const day of Object.values(calendarData)) {
        day.avgR = day._rCount > 0 ? day._rSum / day._rCount : null;
        day.winRate = day.tradesCount > 0 ? (day.wins / day.tradesCount) * 100 : 0;
        delete day._rSum; delete day._rCount;
      }
      return res.json({ days: calendarData, mixedAccounts, accountKeys: distinctAccountKeys });
    }

    const distinctAccountKeys = accountKey ? [] : await Trade.distinct('accountKey', { user: req.user.userId, accountKey: { $nin: ['', null] } });
    const mixedAccounts = !accountKey && distinctAccountKeys.length > 1;

    const query = { user: req.user.userId };
    if (symbol) query.symbol = symbolQuery(symbol);
    if (grade) query.grade = grade.toUpperCase();
    if (accountKey) applyAccountKeyToMongoQuery(query, accountKey);

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
          date: dateStr,
          _rSum: 0, _rCount: 0,
        };
      }
      calendarData[dateStr].pnl += netAmount(t);
      calendarData[dateStr].tradesCount++;
      if (netAmount(t) > 0) calendarData[dateStr].wins++;
      const r = realizedRMultiple(t);
      if (r !== null) { calendarData[dateStr]._rSum += r; calendarData[dateStr]._rCount++; }
    }
    for (const day of Object.values(calendarData)) {
      day.avgR = day._rCount > 0 ? day._rSum / day._rCount : null;
      day.winRate = day.tradesCount > 0 ? (day.wins / day.tradesCount) * 100 : 0;
      delete day._rSum; delete day._rCount;
    }
    res.json({ days: calendarData, mixedAccounts, accountKeys: distinctAccountKeys });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/balance  latest running balance
router.get('/balance', auth, ownerOnly, async (req, res) => {
  try {
    const { accountKey } = req.query;

    // Database Offlne Fallback
    if (mongoose.connection.readyState !== 1) {
      const ownerTrades = inMemoryTrades.filter(t => isOfflineTradeVisibleToUser(t, req.user.userId));
      const distinctAccountKeys = [...new Set(ownerTrades.map(t => String(t.accountKey || '')).filter(Boolean))];
      const mixedAccounts = !accountKey && distinctAccountKeys.length > 1;
      const scoped = accountKey ? ownerTrades.filter(t => tradeMatchesAccountFilter(t, accountKey)) : ownerTrades;
      const sorted = scoped.sort((a, b) => new Date(b.closeTime) - new Date(a.closeTime));
      const latest = sorted[0];
      const latestBalanceSyncTime = latest?.synced || latest?.updatedAt || latest?.createdAt || latest?.closeTime || null;
      const latestBalanceTime = latestBalanceSyncTime ? new Date(latestBalanceSyncTime) : null;
      const laterEvents = inMemoryAccountEvents.filter(e => {
        if (!isOfflineAccountEventVisibleToUser(e, req.user.userId)) return false;
        if (e.source !== 'manual') return false;
        // Manual entries aren't tied to a broker account; only exclude ones
        // explicitly recorded against a different account than the one asked for.
        if (accountKey && e.accountKey && !tradeMatchesAccountFilter(e, accountKey)) return false;
        if (!latestBalanceTime) return true;
        return new Date(e.createdAt || e.occurredAt) > latestBalanceTime;
      });
      const eventsNet = laterEvents.reduce((sum, e) => sum + accountEventNetAmount(e), 0);
      const latestEvent = laterEvents.sort((a, b) => new Date(b.createdAt || b.occurredAt) - new Date(a.createdAt || a.occurredAt))[0];
      return res.json({
        balance: (latest?.runningBalance || 0) + eventsNet,
        asOf: latestEvent?.createdAt || latest?.synced || latest?.updatedAt || latest?.closeTime || null,
        tradeAsOf: latest?.closeTime || null,
        mixedAccounts,
        accountKeys: distinctAccountKeys,
      });
    }

    const distinctAccountKeys = accountKey ? [] : await Trade.distinct('accountKey', { user: req.user.userId, accountKey: { $nin: ['', null] } });
    const mixedAccounts = !accountKey && distinctAccountKeys.length > 1;
    const tradeQuery = { user: req.user.userId };
    if (accountKey) applyAccountKeyToMongoQuery(tradeQuery, accountKey);
    const latest = await Trade.findOne(tradeQuery).sort({ closeTime: -1 }).lean();
    const latestBalanceSyncTime = latest?.synced || latest?.updatedAt || latest?.createdAt || latest?.closeTime || null;
    const eventQuery = { user: req.user.userId, source: 'manual' };
    if (latestBalanceSyncTime) eventQuery.createdAt = { $gt: latestBalanceSyncTime };
    if (accountKey) eventQuery.$or = [{ accountKey: { $in: ['', null] } }, { accountKey: String(accountKey).toLowerCase() }];
    const laterEvents = await AccountEvent.find(eventQuery).sort({ createdAt: -1 }).lean();
    const eventsNet = laterEvents.reduce((sum, e) => sum + accountEventNetAmount(e), 0);
    const latestEvent = laterEvents[0];
    res.json({
      balance: (latest?.runningBalance || 0) + eventsNet,
      asOf: latestEvent?.createdAt || latest?.synced || latest?.updatedAt || latest?.closeTime || null,
      tradeAsOf: latest?.closeTime || null,
      mixedAccounts,
      accountKeys: distinctAccountKeys,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── EXPORT ROUTES ─────────────────────────────────────────────────────────

// GET /api/export/json  Full backup download: trades, account events, and Replay annotations
// accountKey is intentionally optional here and defaults to everything: this
// endpoint is the disaster-recovery backup, and a backup that silently drops
// other accounts by default would be worse than one that isn't filterable.
router.get('/export/json', auth, ownerOnly, async (req, res) => {
  try {
    const { accountKey } = req.query;
    let trades, events, replayJournals;

    if (mongoose.connection.readyState === 1) {
      const tradeQuery = { user: req.user.userId };
      const eventQuery = { user: req.user.userId };
      if (accountKey) {
        applyAccountKeyToMongoQuery(tradeQuery, accountKey);
        applyAccountKeyToMongoQuery(eventQuery, accountKey);
      }
      [trades, events, replayJournals] = await Promise.all([
        Trade.find(tradeQuery).sort({ closeTime: -1 }).lean(),
        AccountEvent.find(eventQuery).sort({ occurredAt: -1 }).lean(),
        ReplayJournal.find({ user: req.user.userId }).lean(),
      ]);
    } else {
      trades = inMemoryTrades.filter(t => isOfflineTradeVisibleToUser(t, req.user.userId));
      events = inMemoryAccountEvents.filter(e => isOfflineAccountEventVisibleToUser(e, req.user.userId));
      if (accountKey) {
        trades = trades.filter(t => tradeMatchesAccountFilter(t, accountKey));
        events = events.filter(e => tradeMatchesAccountFilter(e, accountKey));
      }
      replayJournals = Object.values(inMemoryReplayJournals).filter(journal => String(journal.user) === String(req.user.userId));
    }

    const payload = {
      _schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      source: mongoose.connection.readyState === 1 ? 'cloud' : 'local_cache',
      tradeCount: trades.length,
      accountEventCount: events.length,
      replayJournalCount: replayJournals.length,
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
      replayJournals: replayJournals.map(journal => ({
        ...journal,
        _id: journal._id ? String(journal._id) : undefined,
        user: String(journal.user),
        trade: String(journal.trade),
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
router.get('/export/csv', auth, ownerOnly, async (req, res) => {
  try {
    const { accountKey } = req.query;
    let trades;

    if (mongoose.connection.readyState === 1) {
      const query = { user: req.user.userId };
      if (accountKey) applyAccountKeyToMongoQuery(query, accountKey);
      trades = await Trade.find(query).sort({ closeTime: -1 }).lean();
    } else {
      trades = inMemoryTrades
        .filter(t => isOfflineTradeVisibleToUser(t, req.user.userId))
        .filter(t => !accountKey || tradeMatchesAccountFilter(t, accountKey))
        .sort((a, b) => new Date(b.closeTime) - new Date(a.closeTime));
    }

    // Broker fields alone are replaceable — they can be re-downloaded from MT5
    // any time. The journal fields below (playbook, grades, notes, risk data)
    // exist nowhere else, so a CSV that drops them exports the disposable half.
    const CSV_HEADERS = [
      'dealId', 'positionId', 'symbol', 'direction',
      'entryPrice', 'exitPrice', 'lotSize',
      'pnlUSD', 'pnlPct', 'commission', 'swap',
      'openTime', 'closeTime', 'durationMinutes', 'runningBalance',
      'accountKey', 'accountType', 'accountLogin', 'accountServer', 'accountName',
      'stopLoss', 'takeProfit', 'riskUSD', 'riskPercent', 'exitTrigger', 'magic',
      'plannedRR', 'exitReason', 'confidenceRating', 'manuallyIntervened',
      'analysisGrade', 'executionGrade', 'emotion', 'grade',
      'isReEntry', 'tradeGroup', 'primarySetup', 'setupConfirmations',
      'playbookId', 'playbookVersionId',
      'tags', 'notes',
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
      escapeCsv(t.accountKey || ''),
      escapeCsv(t.accountType || ''),
      escapeCsv(t.accountLogin || ''),
      escapeCsv(t.accountServer || ''),
      escapeCsv(t.accountName || ''),
      escapeCsv(t.stopLoss ?? ''),
      escapeCsv(t.takeProfit ?? ''),
      escapeCsv(t.riskUSD ?? ''),
      escapeCsv(t.riskPercent ?? ''),
      escapeCsv(t.exitTrigger || ''),
      escapeCsv(t.magic || ''),
      escapeCsv(t.plannedRR ?? ''),
      escapeCsv(t.exitReason || ''),
      escapeCsv(t.confidenceRating ?? ''),
      escapeCsv(t.manuallyIntervened == null ? '' : t.manuallyIntervened),
      escapeCsv(t.analysisGrade || ''),
      escapeCsv(t.executionGrade || ''),
      escapeCsv(t.emotion || ''),
      escapeCsv(t.grade || ''),
      escapeCsv(t.isReEntry ? 'true' : 'false'),
      escapeCsv(t.tradeGroup || ''),
      escapeCsv(t.primarySetup || ''),
      escapeCsv((t.setupConfirmations || []).join('; ')),
      escapeCsv(t.playbookId || ''),
      escapeCsv(t.playbookVersionId || ''),
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
// GET /api/export/ai -- journaled trades, stats and playbooks as Markdown for any AI chat.
router.get('/export/ai', auth, ownerOnly, async (req, res) => {
  if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'The AI export needs the database connection.' });
  try {
    const { symbol, direction, accountType, accountKey, from, to, maxTrades, notes } = req.query;
    const { buildExport } = require('../lib/journalExport');
    const result = await buildExport(req.user.userId, {
      symbol, accountType, from, to, maxTrades,
      direction: direction ? (String(direction).toUpperCase() === 'SELL' ? 'short' : String(direction).toUpperCase() === 'BUY' ? 'long' : direction) : undefined,
      account: accountKey === '__unassigned__' ? '(unassigned)' : accountKey,
      notes: notes !== '0' && notes !== 'false',
    });
    res.json(result);
  } catch (err) {
    res.status(err.code === 'BAD_REQUEST' ? 400 : 500).json({ error: err.message || 'Could not build the export' });
  }
});

router.get('/export/status', auth, ownerOnly, async (req, res) => {
  try {
    let tradeCount = 0;
    let eventCount = 0;
    let oldestTrade = null;
    let newestTrade = null;
    let dbMode = 'offline';

    if (mongoose.connection.readyState === 1) {
      dbMode = 'cloud';
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
        const dirPath = path.join(OFFLINE_SCREENSHOTS_DIR, d);
        if (!fs.statSync(dirPath).isDirectory()) continue;
        const files = fs.readdirSync(dirPath);
        pendingOfflineScreenshots += files.filter(f => !f.endsWith('.meta.json')).length;
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
router.get('/coach', auth, ownerOnly, async (req, res) => {
  try {
    const { range, accountKey } = req.query;
    const fromDate = getRangeStart(range);
    let trades;

    if (mongoose.connection.readyState === 1) {
      const q = { user: req.user.userId };
      if (fromDate) q.closeTime = { $gte: fromDate };
      if (accountKey) applyAccountKeyToMongoQuery(q, accountKey);
      trades = await Trade.find(q).sort({ closeTime: -1 }).lean();
    } else {
      trades = inMemoryTrades
        .filter(t => {
          if (!isOfflineTradeVisibleToUser(t, req.user.userId)) return false;
          if (fromDate && new Date(t.closeTime) < fromDate) return false;
          if (accountKey && !tradeMatchesAccountFilter(t, accountKey)) return false;
          return true;
        })
        .sort((a, b) => new Date(b.closeTime) - new Date(a.closeTime));
    }

    if (trades.length === 0) {
      return res.json({
        earlyExits: { count: 0, withRiskData: 0, totalMissedRR: 0, estimatedMissedUSD: 0, trades: [] },
        gradeGap: { avgAnalysisGrade: null, avgExecutionGrade: null, gapScore: 0 },
        exitReasonBreakdown: [],
        confidenceVsWinRate: [],
        planAdherence: { score: null, trades: 0 },
        manualIntervention: { interventionCount: 0, cleanCount: 0, interventionAvgPnL: 0, cleanAvgPnL: 0, interventionAvgRR: 0, cleanAvgRR: 0 },
        demoVsLive: { demo: null, live: null },
        setupAnalytics: [],
        playbookAnalytics: [],
        ruleEffectiveness: [],
        stageCompliance: [],
        numericFieldAnalytics: [],
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
    // Realized R needs real risk (riskUSD, from the stop MT5 had on the order
    // at entry — see sync.py). See lib/tradeMath.js (and its test suite) for
    // why this can't be estimated from pnlPct: that approach algebraically
    // collapses to "missed profit is always $0.00" (BUG-2).
    const missedProfit = calculateMissedProfit(trades);
    const earlyExitDetails = missedProfit.trades;
    const totalMissedRR = missedProfit.totalMissedRR;
    const estimatedMissedUSD = missedProfit.estimatedMissedUSD;
    const earlyExitsWithRiskData = missedProfit.withRiskData;

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
    // Realized R = pnlUSD / riskUSD, using the actual stop distance MT5 had
    // recorded at entry. Only meaningful for trades with real risk data.
    const avgRROf = arr => {
      const valid = arr.filter(t => Number.isFinite(Number(t.riskUSD)) && Number(t.riskUSD) > 0);
      return valid.length > 0
        ? parseFloat((valid.reduce((s, t) => s + (Number(t.pnlUSD) / Number(t.riskUSD)), 0) / valid.length).toFixed(2))
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

    // ── 9. Versioned Playbook & Rule Effectiveness ──────────────────────────
    const playbookMap = {};
    const ruleMap = {};
    const stageMap = {};
    const numericFieldMap = {};
    for (const trade of trades) {
      const snapshot = trade.playbookSnapshot;
      if (!snapshot?.playbookId || !snapshot?.versionId) continue;
      const versionKey = `${snapshot.playbookId}:${snapshot.versionId}`;
      if (!playbookMap[versionKey]) {
        playbookMap[versionKey] = {
          playbookId: snapshot.playbookId,
          playbookName: snapshot.name,
          versionId: snapshot.versionId,
          versionNumber: snapshot.versionNumber,
          tradeCount: 0,
          wins: 0,
          totalPnL: 0,
        };
      }
      const versionStats = playbookMap[versionKey];
      versionStats.tradeCount++;
      versionStats.totalPnL += Number(trade.pnlUSD || 0);
      if (trade.pnlUSD > 0) versionStats.wins++;

      const responses = trade.playbookResponses || {};
      for (const block of snapshot.blocks || []) {
        const requiredRules = (block.rules || []).filter(rule => rule.required);
        const requiredAnswered = requiredRules.filter(rule => {
          const answer = responses[rule.ruleId];
          return answer !== undefined && answer !== null && answer !== '' && (!Array.isArray(answer) || answer.length > 0);
        }).length;
        const stageComplete = requiredRules.length === 0 || requiredAnswered === requiredRules.length;
        const stageKey = `${versionKey}:${block.blockId}`;
        if (!stageMap[stageKey]) stageMap[stageKey] = { playbookName: snapshot.name, versionNumber: snapshot.versionNumber, category: block.category, stageName: block.name, requiredFieldCount: requiredRules.length, tradeCount: 0, completeCount: 0, completeWins: 0, completePnL: 0, incompleteCount: 0, incompleteWins: 0, incompletePnL: 0 };
        const stageStats = stageMap[stageKey];
        stageStats.tradeCount++;
        if (stageComplete) {
          stageStats.completeCount++; stageStats.completePnL += Number(trade.pnlUSD || 0); if (trade.pnlUSD > 0) stageStats.completeWins++;
        } else {
          stageStats.incompleteCount++; stageStats.incompletePnL += Number(trade.pnlUSD || 0); if (trade.pnlUSD > 0) stageStats.incompleteWins++;
        }
        for (const rule of block.rules || []) {
          const value = responses[rule.ruleId];
          if (value === undefined || value === null || value === '') continue;
          const answers = Array.isArray(value) ? value : [value];
          if (['number', 'percentage', 'currency', 'price', 'duration', 'risk_reward', 'rating'].includes(rule.inputType) && Number.isFinite(Number(value))) {
            const numericKey = `${versionKey}:${rule.ruleId}`;
            if (!numericFieldMap[numericKey]) numericFieldMap[numericKey] = { playbookName: snapshot.name, versionNumber: snapshot.versionNumber, ruleId: rule.ruleId, ruleLabel: rule.label, blockName: block.name, inputType: rule.inputType, unit: rule.unit || '', tradeCount: 0, valueTotal: 0, winningValueTotal: 0, winningCount: 0, losingValueTotal: 0, losingCount: 0, totalPnL: 0 };
            const numericStats = numericFieldMap[numericKey];
            numericStats.tradeCount++; numericStats.valueTotal += Number(value); numericStats.totalPnL += Number(trade.pnlUSD || 0);
            if (trade.pnlUSD > 0) { numericStats.winningCount++; numericStats.winningValueTotal += Number(value); }
            else { numericStats.losingCount++; numericStats.losingValueTotal += Number(value); }
          }
          for (const answer of answers) {
            if (!['boolean', 'single_choice', 'multi_choice', 'rating'].includes(rule.inputType)) continue;
            const answerLabel = typeof answer === 'boolean' ? (answer ? 'Yes' : 'No') : String(answer);
            const key = `${rule.ruleId}:${answerLabel}`;
            if (!ruleMap[key]) {
              ruleMap[key] = {
                ruleId: rule.ruleId,
                ruleLabel: rule.label,
                blockName: block.name,
                inputType: rule.inputType,
                answer: answerLabel,
                tradeCount: 0,
                wins: 0,
                totalPnL: 0,
                pnls: [],
              };
            }
            ruleMap[key].tradeCount++;
            ruleMap[key].totalPnL += Number(trade.pnlUSD || 0);
            ruleMap[key].pnls.push(Number(trade.pnlUSD || 0));
            if (trade.pnlUSD > 0) ruleMap[key].wins++;
          }
        }
      }
    }
    const playbookAnalytics = Object.values(playbookMap).map(item => ({
      ...item,
      winRate: item.tradeCount ? parseFloat(((item.wins / item.tradeCount) * 100).toFixed(1)) : 0,
      avgPnL: item.tradeCount ? parseFloat((item.totalPnL / item.tradeCount).toFixed(2)) : 0,
    })).sort((a, b) => b.avgPnL - a.avgPnL);
    // Evidence strength uses the app-wide sample scale (lib/confidence.js):
    // strong = 30+ trades, developing = 10-29, insufficient = under 10.
    const sampleStatusOf = n => (n >= 30 ? 'strong' : n >= 10 ? 'developing' : 'insufficient');
    const ruleEffectiveness = Object.values(ruleMap).map(({ pnls, ...item }) => ({
      ...item,
      winRate: item.tradeCount ? parseFloat(((item.wins / item.tradeCount) * 100).toFixed(1)) : 0,
      avgPnL: item.tradeCount ? parseFloat((item.totalPnL / item.tradeCount).toFixed(2)) : 0,
      sampleStatus: sampleStatusOf(item.tradeCount),
      confidence: confidenceFor(item.tradeCount, item.wins, pnls),
    })).sort((a, b) => b.tradeCount - a.tradeCount);
    const stageCompliance = Object.values(stageMap).map(item => ({
      ...item,
      complianceRate: item.tradeCount ? parseFloat(((item.completeCount / item.tradeCount) * 100).toFixed(1)) : 0,
      completeWinRate: item.completeCount ? parseFloat(((item.completeWins / item.completeCount) * 100).toFixed(1)) : null,
      incompleteWinRate: item.incompleteCount ? parseFloat(((item.incompleteWins / item.incompleteCount) * 100).toFixed(1)) : null,
      completeAvgPnL: item.completeCount ? parseFloat((item.completePnL / item.completeCount).toFixed(2)) : null,
      incompleteAvgPnL: item.incompleteCount ? parseFloat((item.incompletePnL / item.incompleteCount).toFixed(2)) : null,
    })).sort((a, b) => b.tradeCount - a.tradeCount);
    const numericFieldAnalytics = Object.values(numericFieldMap).map(item => ({
      ...item,
      averageValue: parseFloat((item.valueTotal / item.tradeCount).toFixed(2)),
      averageWinningValue: item.winningCount ? parseFloat((item.winningValueTotal / item.winningCount).toFixed(2)) : null,
      averageLosingValue: item.losingCount ? parseFloat((item.losingValueTotal / item.losingCount).toFixed(2)) : null,
      avgPnL: parseFloat((item.totalPnL / item.tradeCount).toFixed(2)),
      sampleStatus: sampleStatusOf(item.tradeCount),
    })).sort((a, b) => b.tradeCount - a.tradeCount);

    res.json({
      totalTrades: trades.length,
      earlyExits: {
        count: earlyExitDetails.length,
        withRiskData: earlyExitsWithRiskData,
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
        interventionAvgRR: avgRROf(intervened),
        cleanAvgRR: avgRROf(clean),
      },
      demoVsLive: {
        live: buildAccountStats(liveArr),
        demo: buildAccountStats(demoArr),
      },
      setupAnalytics,
      playbookAnalytics,
      ruleEffectiveness,
      stageCompliance,
      numericFieldAnalytics,
    });
  } catch (err) {
    console.error('Coach route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Exposed for routes/investor.js, which needs the exact same interval
// selection and cTrader window logic for its own scoped, sanitized replay
// endpoint rather than reusing this route's owner-only response shape
// (which includes private journal fields like notes/emotion/grade).
router.requestedReplayInterval = requestedReplayInterval;
router.replayWindow = replayWindow;
// Shared with routes/preTradeAnalyses.js so a playbook snapshot locks the
// same way there as it does here, without duplicating the lookup logic.
router.getPlaybooks = getPlaybooks;

module.exports = router;
