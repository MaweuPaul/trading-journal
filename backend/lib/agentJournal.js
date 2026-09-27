// Read-only access to the owner's real trade journal for AI agents (MCP tools
// behind the "journal" access-key scope, see routes/mcp.js). Agents can list
// and read trades with their journal fields, break results down with
// confidence ranges, see the owner's playbooks and pull candles around a
// trade -- but never change anything.
const Trade = require('../models/Trade');
const ReplayJournal = require('../models/ReplayJournal');
const TradingAccount = require('../models/TradingAccount');
const User = require('../models/User');
const KnowledgeEntry = require('../models/KnowledgeEntry');
const PreTradeAnalysis = require('../models/PreTradeAnalysis');
const AccountEvent = require('../models/AccountEvent');
const { netTradeAmount, realizedRMultiple } = require('./tradeMath');
const { confidenceFor } = require('./confidence');
const { getTrendbars } = require('./ctraderReplay');
const { AgentError, throttledFetch } = require('./agentReplay');

// At most this many trades are analysed per call (newest first).
const MAX_TRADES = 5000;
const MAX_CANDLES = 600;
const MAX_SCREENSHOTS = 4;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GROUPS = [
  'symbol', 'direction', 'account', 'accountType', 'setup', 'confirmation', 'tag', 'emotion',
  'exitReason', 'exitTrigger', 'analysisGrade', 'executionGrade', 'confidenceRating', 'playbook',
  'rulesFollowed', 'reEntry', 'manuallyIntervened', 'weekday', 'hour', 'session', 'month', 'holdTime', 'outcome',
];
const round = (v, digits = 2) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(digits)) || 0);
const iso = d => (d ? new Date(d).toISOString() : null);

function parseDate(value, label) {
  if (value == null || value === '') return null;
  const d = new Date(typeof value === 'number' && value < 1e11 ? value * 1000 : value);
  if (Number.isNaN(d.getTime())) throw new AgentError(`${label} is not a valid date.`);
  return d;
}

const outcomeOf = t => {
  const net = netTradeAmount(t);
  return net > 0 ? 'win' : net < 0 ? 'loss' : 'breakeven';
};

function ruleResults(t) {
  const list = [...(t.checklist || []), ...(t.executionChecklist || [])];
  if (!list.length) return null;
  const broken = list.filter(item => item.complied === false).map(item => item.rule);
  return { checked: list.length, broken };
}

// ── Loading and filtering ────────────────────────────────────────────────
async function findTrades(userId, input = {}) {
  const from = parseDate(input.from, 'from');
  const to = parseDate(input.to, 'to');
  const query = { user: userId };
  if (input.symbol) query.symbol = String(input.symbol).toUpperCase();
  if (input.direction) query.direction = String(input.direction).toUpperCase() === 'SHORT' || String(input.direction).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  if (input.accountType) query.accountType = String(input.accountType).toLowerCase();
  if (from || to) query.closeTime = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  let trades = await Trade.find(query).select('-screenshots.publicId').sort({ closeTime: -1 }).limit(MAX_TRADES).lean();
  const truncated = trades.length >= MAX_TRADES;
  const lc = v => String(v || '').toLowerCase();
  // Filters Mongo could do too, repeated here so every field is matched the same way.
  trades = trades.filter(t => {
    if (query.symbol && t.symbol !== query.symbol) return false;
    if (query.direction && t.direction !== query.direction) return false;
    if (query.accountType && t.accountType !== query.accountType) return false;
    if (from && new Date(t.closeTime) < from) return false;
    if (to && new Date(t.closeTime) > to) return false;
    if (input.account) {
      if (input.account === '(unassigned)' ? Boolean(t.accountKey) : lc(t.accountKey) !== lc(input.account)) return false;
    }
    if (input.outcome && outcomeOf(t) !== input.outcome) return false;
    if (input.setup && lc(t.primarySetup) !== lc(input.setup)) return false;
    if (input.tag && !(t.tags || []).some(tag => lc(tag) === lc(input.tag))) return false;
    if (input.emotion && lc(t.emotion) !== lc(input.emotion)) return false;
    if (input.exitReason && lc(t.exitReason) !== lc(input.exitReason)) return false;
    if (input.journaled === true && !(t.notes || '').trim()) return false;
    if (input.journaled === false && (t.notes || '').trim()) return false;
    return true;
  });
  trades.sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));
  trades.truncated = truncated;
  return trades;
}

function publicTrade(t, { full = false } = {}) {
  const r = realizedRMultiple(t);
  const rules = ruleResults(t);
  const out = {
    id: String(t._id),
    symbol: t.symbol,
    direction: t.direction === 'SELL' ? 'short' : 'long',
    openTime: iso(t.openTime), closeTime: iso(t.closeTime), durationMinutes: round(t.durationMinutes, 1),
    entryPrice: t.entryPrice, exitPrice: t.exitPrice,
    stopLoss: t.stopLoss ?? null, takeProfit: t.takeProfit ?? null,
    lots: t.lotSize,
    netUSD: round(netTradeAmount(t)), pnlUSD: round(t.pnlUSD), commission: round(t.commission), swap: round(t.swap),
    outcome: outcomeOf(t),
    r: round(r), riskUSD: round(t.riskUSD), riskPercent: round(t.riskPercent), plannedRR: t.plannedRR ?? null,
    account: t.accountName || t.accountKey || null, accountType: t.accountType || null,
    setup: t.primarySetup || null, confirmations: t.setupConfirmations || [], tags: t.tags || [],
    emotion: t.emotion || null, confidenceRating: t.confidenceRating ?? null,
    analysisGrade: t.analysisGrade || null, executionGrade: t.executionGrade || null,
    exitReason: t.exitReason || null, exitTrigger: t.exitTrigger || null, manuallyIntervened: t.manuallyIntervened ?? null,
    reEntry: Boolean(t.isReEntry), manualEntry: Boolean(t.manualEntry),
    playbook: t.playbookSnapshot?.name || null,
    rulesBroken: rules ? rules.broken.length : null,
  };
  if (!full) {
    out.hasNotes = Boolean((t.notes || '').trim());
    out.screenshots = (t.screenshots || []).length;
    return out;
  }
  return {
    ...out,
    notes: t.notes || '',
    reEntryReason: t.reEntryReason || '', parentTradeId: t.parentTradeId || null,
    checklist: (t.checklist || []).map(c => ({ rule: c.rule, complied: c.complied })),
    executionChecklist: (t.executionChecklist || []).map(c => ({ rule: c.rule, complied: c.complied })),
    playbookAnswers: playbookAnswers(t),
    screenshots: (t.screenshots || []).map(s => ({ id: String(s._id || ''), url: s.url, caption: s.caption || '' })),
  };
}

/** The playbook questions the owner answered on this trade, in playbook order. */
function playbookAnswers(t) {
  const snap = t.playbookSnapshot;
  if (!snap || !Array.isArray(snap.blocks)) return null;
  const responses = t.playbookResponses || {};
  const answers = [];
  for (const block of snap.blocks) {
    for (const rule of block.rules || []) {
      const raw = responses[rule.ruleId];
      const answer = raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw ? raw.value : raw;
      answers.push({ block: block.name, rule: rule.label, answer: answer === undefined ? null : answer });
    }
  }
  return { name: snap.name, version: snap.versionNumber ?? null, answers };
}

// ── Tools ────────────────────────────────────────────────────────────────
async function listAccounts(userId) {
  const trades = await Trade.find({ user: userId }).select('accountKey accountName accountType closeTime pnlUSD commission swap').limit(50000).lean();
  const accounts = new Map();
  for (const t of trades) {
    const key = t.accountKey || '(unassigned)';
    const a = accounts.get(key) || { account: key, name: t.accountName || null, type: t.accountType || null, trades: 0, netUSD: 0, first: null, last: null };
    a.trades++;
    a.netUSD += netTradeAmount(t);
    const close = new Date(t.closeTime);
    if (!a.first || close < a.first) a.first = close;
    if (!a.last || close > a.last) a.last = close;
    accounts.set(key, a);
  }
  const linked = await TradingAccount.find({ user: userId }).select('accountKey label provider archivedAt').lean();
  for (const l of linked) {
    const a = accounts.get(l.accountKey);
    if (a) Object.assign(a, { name: l.label || a.name, provider: l.provider, archived: Boolean(l.archivedAt) });
  }
  return {
    accounts: [...accounts.values()].map(a => ({ ...a, netUSD: round(a.netUSD), first: iso(a.first), last: iso(a.last) })).sort((a, b) => b.trades - a.trades),
    note: 'Pass an account value as account on list_trades or get_journal_metrics. Balances differ per account, so compare accounts in R where you can.',
  };
}

const SORTS = {
  newest: (a, b) => new Date(b.closeTime) - new Date(a.closeTime),
  oldest: (a, b) => new Date(a.closeTime) - new Date(b.closeTime),
  best: (a, b) => netTradeAmount(b) - netTradeAmount(a),
  worst: (a, b) => netTradeAmount(a) - netTradeAmount(b),
};
async function listTrades(userId, input = {}) {
  const trades = await findTrades(userId, input);
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit) || 50));
  const offset = Math.max(0, Math.floor(input.offset) || 0);
  const sorted = [...trades].sort(SORTS[input.sort || 'newest'] || SORTS.newest);
  return {
    total: trades.length,
    offset,
    trades: sorted.slice(offset, offset + limit).map(t => publicTrade(t)),
    ...(trades.truncated ? { note: `Only the newest ${MAX_TRADES} trades are searched; narrow with from/to.` } : {}),
  };
}

async function fetchImage(url) {
  if (!/^https:\/\//.test(url || '')) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const type = (res.headers.get('content-type') || '').split(';')[0];
    if (!res.ok || !/^image\/(png|jpeg|webp|gif)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return null;
    return { mimeType: type, data: buf.toString('base64') };
  } catch {
    return null;
  }
}

async function getTrade(userId, id, { includeScreenshots = false } = {}) {
  if (!/^[a-f0-9]{24}$/i.test(String(id || ''))) throw new AgentError('Trade not found.', 'NOT_FOUND');
  const trade = await Trade.findOne({ _id: id, user: userId }).lean();
  if (!trade) throw new AgentError('Trade not found.', 'NOT_FOUND');
  const out = publicTrade(trade, { full: true });
  const journal = await ReplayJournal.findOne({ user: userId, trade: id }).lean();
  if (journal) {
    out.replayReview = {
      quickReview: journal.quickReview || {},
      events: (journal.events || []).slice(0, 100),
      draft: journal.draft || {},
    };
  }
  let images = [];
  if (includeScreenshots) {
    images = (await Promise.all((trade.screenshots || []).slice(0, MAX_SCREENSHOTS).map(s => fetchImage(s.url)))).filter(Boolean);
    out.screenshotsAttached = images.length;
  }
  return { trade: out, images };
}

function holdBucket(minutes) {
  const m = Number(minutes) || 0;
  if (m < 5) return '<5m';
  if (m < 30) return '5-30m';
  if (m < 120) return '30m-2h';
  if (m < 480) return '2-8h';
  if (m < 1440) return '8-24h';
  return '1d+';
}
// Trading session by UTC open hour, same boundaries as the Stats page (which uses close time).
function sessionOf(date) {
  const h = new Date(date).getUTCHours();
  return h < 8 ? 'Tokyo' : h < 13 ? 'London' : h < 16 ? 'London/NY Overlap' : h < 21 ? 'New York' : 'Pacific';
}
const orNone = v => (v === null || v === undefined || v === '' ? '(none)' : String(v));

function groupKeys(t, by) {
  switch (by) {
    case 'symbol': return [t.symbol];
    case 'direction': return [t.direction === 'SELL' ? 'short' : 'long'];
    case 'account': return [t.accountName || t.accountKey || '(unassigned)'];
    case 'accountType': return [orNone(t.accountType)];
    case 'setup': return [orNone(t.primarySetup)];
    case 'confirmation': return t.setupConfirmations?.length ? t.setupConfirmations : ['(none)'];
    case 'tag': return t.tags?.length ? t.tags : ['(none)'];
    case 'emotion': return [orNone(t.emotion)];
    case 'exitReason': return [orNone(t.exitReason)];
    case 'exitTrigger': return [orNone(t.exitTrigger)];
    case 'analysisGrade': return [orNone(t.analysisGrade)];
    case 'executionGrade': return [orNone(t.executionGrade)];
    case 'confidenceRating': return [orNone(t.confidenceRating)];
    case 'playbook': return [orNone(t.playbookSnapshot?.name)];
    case 'rulesFollowed': {
      const r = ruleResults(t);
      return [!r ? '(no checklist)' : r.broken.length ? 'broke a rule' : 'followed all'];
    }
    case 'reEntry': return [t.isReEntry ? 're-entry' : 'first entry'];
    case 'manuallyIntervened': return [t.manuallyIntervened == null ? '(none)' : t.manuallyIntervened ? 'intervened' : 'left alone'];
    case 'weekday': return [WEEKDAYS[new Date(t.openTime).getUTCDay()]];
    case 'hour': return [`${String(new Date(t.openTime).getUTCHours()).padStart(2, '0')}:00 UTC`];
    case 'session': return [sessionOf(t.openTime)];
    case 'month': return [new Date(t.closeTime).toISOString().slice(0, 7)];
    case 'holdTime': return [holdBucket(t.durationMinutes)];
    case 'outcome': return [outcomeOf(t)];
    default: return [];
  }
}

function statsOf(trades) {
  const n = trades.length;
  const nets = trades.map(netTradeAmount);
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const winNets = nets.filter(v => v > 0), lossNets = nets.filter(v => v < 0);
  const grossWin = sum(winNets), grossLoss = -sum(lossNets);
  const rs = trades.map(realizedRMultiple).filter(r => r != null);
  let equity = 0, peak = 0, maxDrawdownUSD = 0, streak = 0, maxLossStreak = 0;
  for (const v of nets) {
    equity += v;
    peak = Math.max(peak, equity);
    maxDrawdownUSD = Math.max(maxDrawdownUSD, peak - equity);
    streak = v < 0 ? streak + 1 : 0;
    maxLossStreak = Math.max(maxLossStreak, streak);
  }
  const netUSD = sum(nets);
  return {
    trades: n, wins: winNets.length, losses: lossNets.length, breakevens: n - winNets.length - lossNets.length,
    winRate: n ? round((winNets.length / n) * 100, 1) : 0,
    netUSD: round(netUSD), avgNetUSD: n ? round(netUSD / n) : 0,
    avgWinUSD: winNets.length ? round(grossWin / winNets.length) : null,
    avgLossUSD: lossNets.length ? round(-grossLoss / lossNets.length) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    biggestWinUSD: winNets.length ? round(Math.max(...winNets)) : null,
    biggestLossUSD: lossNets.length ? round(Math.min(...lossNets)) : null,
    maxDrawdownUSD: round(maxDrawdownUSD), maxLossStreak,
    rTrades: rs.length, avgR: rs.length ? round(sum(rs) / rs.length, 3) : null, totalR: rs.length ? round(sum(rs), 2) : null,
    confidence: confidenceFor(n, winNets.length, nets, rs),
  };
}

async function getMetrics(userId, input = {}) {
  const trades = await findTrades(userId, input);
  const groupBy = Array.isArray(input.groupBy) ? input.groupBy : input.groupBy ? [input.groupBy] : [];
  for (const g of groupBy) if (!GROUPS.includes(g)) throw new AgentError(`groupBy must be any of ${GROUPS.join(', ')}.`);
  const breakdowns = {};
  for (const by of groupBy) {
    const groups = new Map();
    for (const t of trades) for (const key of groupKeys(t, by)) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    breakdowns[by] = [...groups].map(([key, list]) => ({ [by]: key, ...statsOf(list) })).sort((a, b) => b.trades - a.trades);
  }
  const filters = Object.fromEntries(['account', 'accountType', 'symbol', 'direction', 'from', 'to', 'outcome', 'setup', 'tag', 'emotion', 'exitReason'].filter(k => input[k] != null).map(k => [k, input[k]]));
  return {
    filters,
    overall: statsOf(trades),
    breakdowns,
    notes: [
      'USD figures are net of commission and swap. R uses the real stop risk synced from the broker (riskUSD), so rTrades can be fewer than trades.',
      'confidence.level is insufficient under 10 trades, early under 30, developing under 100, reliable after that; winRateRange and avgRange are 95% ranges. Treat differences between groups whose ranges overlap as unproven.',
      ...(trades.truncated ? [`Only the newest ${MAX_TRADES} trades were analysed; narrow with from/to.`] : []),
    ],
  };
}

async function getPlaybooks(userId) {
  const user = await User.findOne({ _id: userId }).select('playbooks').lean();
  const playbooks = (user?.playbooks || []).filter(p => !p.archived).map(p => {
    const latest = (p.versions || [])[p.versions.length - 1] || {};
    return {
      name: p.name, description: p.description || '', version: latest.versionNumber ?? null,
      blocks: (latest.blocks || []).map(b => ({
        name: b.name, category: b.category,
        rules: (b.rules || []).map(r => ({ rule: r.label, input: r.inputType, ...(r.options?.length ? { options: r.options } : {}), ...(r.required ? { required: true } : {}) })),
      })),
    };
  });
  return { playbooks, note: playbooks.length ? 'These are the owner\'s written rules. Compare them with playbookAnswers, checklists and notes on get_trade.' : 'The owner has not written a playbook yet.' };
}

// Candle window around a trade: the interval follows how long it was open.
const CANDLE_TF = [
  { max: 30, interval: '1min', sec: 60 },
  { max: 240, interval: '5min', sec: 300 },
  { max: 1440, interval: '15min', sec: 900 },
  { max: 10080, interval: '1h', sec: 3600 },
  { max: Infinity, interval: '4h', sec: 14400 },
];
const TF_SEC = { '1min': 60, '5min': 300, '15min': 900, '1h': 3600, '4h': 14400, '1day': 86400 };
async function getTradeCandles(userId, id, { interval, barsBefore = 100, barsAfter = 30 } = {}) {
  if (!/^[a-f0-9]{24}$/i.test(String(id || ''))) throw new AgentError('Trade not found.', 'NOT_FOUND');
  const trade = await Trade.findOne({ _id: id, user: userId }).select('symbol direction openTime closeTime durationMinutes entryPrice exitPrice stopLoss takeProfit accountKey').lean();
  if (!trade) throw new AgentError('Trade not found.', 'NOT_FOUND');
  const tf = interval || CANDLE_TF.find(x => (Number(trade.durationMinutes) || 0) < x.max).interval;
  const sec = TF_SEC[tf];
  if (!sec) throw new AgentError(`interval must be one of ${Object.keys(TF_SEC).join(', ')}.`);
  const openSec = Math.floor(new Date(trade.openTime).getTime() / 1000);
  const closeSec = Math.floor(new Date(trade.closeTime).getTime() / 1000);
  const before = Math.min(400, Math.max(0, Math.floor(barsBefore)));
  const after = Math.min(200, Math.max(0, Math.floor(barsAfter)));
  // Weekends and closed hours have no bars, so ask for extra time and trim by count.
  const fromMs = (openSec - before * sec * 3 - 3 * 86400) * 1000;
  const toMs = Math.min(Date.now(), (closeSec + after * sec * 3 + 3 * 86400) * 1000);
  // The padded window can hold several thousand bars on short intervals, past
  // cTrader's 1500-bar page, so page back far enough to reach the entry.
  const maxPages = Math.ceil((toMs - fromMs) / 1000 / sec / 1500) + 1;
  const data = await throttledFetch(userId, () => getTrendbars({
    userId, symbol: trade.symbol, periodLabel: tf, fromMs, toMs, maxPages,
    preferredCtidTraderAccountId: String(trade.accountKey || '').startsWith('ctrader:') ? trade.accountKey.slice('ctrader:'.length) : undefined,
  }));
  const all = (data.candles || []).sort((a, b) => a.time - b.time);
  // Never pass off candles from after the trade as the ones around it.
  if (!all.length || all[0].time > openSec) {
    throw new AgentError(`cTrader returned no ${tf} candles reaching back to this trade's entry; try a higher interval.`, 'NO_DATA');
  }
  const entryIdx = all.findIndex(c => c.time + sec > openSec);
  const exitIdx = all.findIndex(c => c.time + sec > closeSec);
  const start = Math.max(0, (entryIdx < 0 ? all.length : entryIdx) - before);
  const end = Math.min(all.length, (exitIdx < 0 ? all.length - 1 : exitIdx) + 1 + after);
  let candles = all.slice(start, end);
  let trimmed = false;
  if (candles.length > MAX_CANDLES) {
    // Keep the bars before entry and around the exit; drop the middle of a long trade.
    const keepBefore = Math.min(before + 50, Math.floor(MAX_CANDLES / 2));
    candles = [...candles.slice(0, keepBefore), ...candles.slice(candles.length - (MAX_CANDLES - keepBefore))];
    trimmed = true;
  }
  const p = v => round(v, 5);
  return {
    symbol: trade.symbol, interval: tf,
    trade: {
      direction: trade.direction === 'SELL' ? 'short' : 'long',
      openTime: iso(trade.openTime), closeTime: iso(trade.closeTime),
      entryPrice: trade.entryPrice, exitPrice: trade.exitPrice, stopLoss: trade.stopLoss ?? null, takeProfit: trade.takeProfit ?? null,
    },
    columns: ['time', 'open', 'high', 'low', 'close'],
    candles: candles.map(c => [new Date(c.time * 1000).toISOString().replace(':00.000Z', 'Z'), p(c.open), p(c.high), p(c.low), p(c.close)]),
    ...(trimmed ? { note: `The middle of this long trade was left out to stay under ${MAX_CANDLES} candles; ask for a higher interval to see all of it.` } : {}),
  };
}

// ── The rest of the journal: knowledge base, pre-trade analyses, cash flows ──
const validId = id => /^[a-f0-9]{24}$/i.test(String(id || ''));
const shots = list => (list || []).map(x => ({ url: x.url, caption: x.caption || '' }));

async function listKnowledge(userId, { search, tag, limit = 50 } = {}) {
  let entries = await KnowledgeEntry.find({ user: userId }).sort({ createdAt: -1 }).limit(1000).lean();
  const q = String(search || '').toLowerCase();
  if (q) entries = entries.filter(e => `${e.title} ${e.content}`.toLowerCase().includes(q));
  if (tag) entries = entries.filter(e => (e.tags || []).some(t => t.toLowerCase() === String(tag).toLowerCase()));
  return {
    total: entries.length,
    entries: entries.slice(0, Math.min(100, limit)).map(e => ({ id: String(e._id), title: e.title, tags: e.tags || [], preview: (e.content || '').slice(0, 200), screenshots: (e.screenshots || []).length, updatedAt: e.updatedAt })),
  };
}
async function getKnowledgeEntry(userId, id, { includeScreenshots = false } = {}) {
  const e = validId(id) && await KnowledgeEntry.findOne({ _id: id, user: userId }).lean();
  if (!e) throw new AgentError('Knowledge entry not found.', 'NOT_FOUND');
  const images = includeScreenshots ? (await Promise.all((e.screenshots || []).slice(0, MAX_SCREENSHOTS).map(x => fetchImage(x.url)))).filter(Boolean) : [];
  return { entry: { id: String(e._id), title: e.title, content: e.content, tags: e.tags || [], screenshots: shots(e.screenshots), createdAt: e.createdAt, updatedAt: e.updatedAt }, images };
}

async function listPreTradeAnalyses(userId, { status, symbol, limit = 50 } = {}) {
  let list = await PreTradeAnalysis.find({ user: userId }).sort({ createdAt: -1 }).limit(1000).lean();
  if (status) list = list.filter(a => a.status === status);
  if (symbol) list = list.filter(a => (a.symbol || '').toUpperCase() === String(symbol).toUpperCase());
  return {
    total: list.length,
    analyses: list.slice(0, Math.min(100, limit)).map(a => ({ id: String(a._id), symbol: a.symbol || null, direction: a.direction || null, status: a.status, playbook: a.playbookSnapshot?.name || null, linkedTradeId: a.linkedTradeId || null, notes: (a.notes || '').slice(0, 200), createdAt: a.createdAt })),
  };
}
async function getPreTradeAnalysis(userId, id, { includeScreenshots = false } = {}) {
  const a = validId(id) && await PreTradeAnalysis.findOne({ _id: id, user: userId }).lean();
  if (!a) throw new AgentError('Pre-trade analysis not found.', 'NOT_FOUND');
  const images = includeScreenshots ? (await Promise.all((a.screenshots || []).slice(0, MAX_SCREENSHOTS).map(x => fetchImage(x.url)))).filter(Boolean) : [];
  return {
    analysis: {
      id: String(a._id), symbol: a.symbol || null, direction: a.direction || null, status: a.status, linkedTradeId: a.linkedTradeId || null,
      notes: a.notes || '', playbookAnswers: playbookAnswers({ playbookSnapshot: a.playbookSnapshot, playbookResponses: a.responses }),
      chart: { symbol: a.chartSymbol || null, interval: a.chartInterval || null, annotations: a.chartAnnotations || [] },
      screenshots: shots(a.screenshots), createdAt: a.createdAt, updatedAt: a.updatedAt,
    },
    images,
  };
}

async function getAccountEvents(userId, { account, from, to } = {}) {
  const f = parseDate(from, 'from'), t = parseDate(to, 'to');
  let events = await AccountEvent.find({ user: userId }).sort({ occurredAt: -1 }).limit(5000).lean();
  if (account) events = events.filter(e => (e.accountKey || '(unassigned)').toLowerCase() === String(account).toLowerCase());
  if (f) events = events.filter(e => new Date(e.occurredAt) >= f);
  if (t) events = events.filter(e => new Date(e.occurredAt) <= t);
  const sum = type => round(events.filter(e => e.type === type).reduce((a, e) => a + Math.abs(Number(e.amount) || 0), 0));
  return {
    totals: { deposits: sum('deposit'), withdrawals: sum('withdrawal'), adjustments: round(events.filter(e => e.type === 'adjustment').reduce((a, e) => a + (Number(e.amount) || 0), 0)) },
    events: events.slice(0, 500).map(e => ({ type: e.type, amount: e.amount, currency: e.currency, occurredAt: iso(e.occurredAt), note: e.note || '', account: e.accountKey || null, balanceAfter: e.balanceAfter ?? null })),
  };
}

module.exports = {
  GROUPS, findTrades, listAccounts, listTrades, getTrade, getMetrics, getPlaybooks, getTradeCandles, publicTrade,
  listKnowledge, getKnowledgeEntry, listPreTradeAnalyses, getPreTradeAnalysis, getAccountEvents,
};
