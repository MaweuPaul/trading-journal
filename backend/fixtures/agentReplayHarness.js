// Test harness for the MCP agent replay: the real engine, routes and Mongoose
// documents, with in-memory persistence and a synthetic cTrader feed, so the
// tests need neither MongoDB nor a cTrader connection. Require it before
// lib/agentReplay or routes/mcp.
const mongoose = require('mongoose');

// ── Synthetic 1-minute feed (weekdays, Jan-Mar 2024), aggregated upwards ───
const TF = { '1min': 60, '5min': 300, '15min': 900, '1h': 3600, '4h': 14400, '1day': 86400 };
const START = Date.UTC(2024, 0, 1) / 1000;
const END = Date.UTC(2024, 3, 1) / 1000;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const m1 = [];
let px = 2000;
for (let t = START; t < END; t += 60) {
  const day = new Date(t * 1000).getUTCDay();
  if (day === 0 || day === 6) continue;
  const open = px, close = open + (rnd() - 0.5) * 1.2;
  m1.push({ time: t, open, high: Math.max(open, close) + rnd() * 0.4, low: Math.min(open, close) - rnd() * 0.4, close, volume: 10 });
  px = close;
}
const series = { '1min': m1 };
for (const tf of Object.keys(TF).filter(tf => tf !== '1min')) {
  const out = [];
  let cur = null;
  for (const c of m1) {
    const bucket = Math.floor(c.time / TF[tf]) * TF[tf];
    if (!cur || cur.time !== bucket) { cur = { ...c, time: bucket }; out.push(cur); }
    else { cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low); cur.close = c.close; cur.volume += c.volume; }
  }
  series[tf] = out;
}

const fetchLog = [];
require.cache[require.resolve('../lib/ctraderReplay')] = {
  id: require.resolve('../lib/ctraderReplay'), loaded: true,
  exports: {
    getTrendbars: async ({ symbol, periodLabel, fromMs, toMs, maxPages = 1 }) => {
      if (!['XAUUSD', 'XAUEUR'].includes(symbol)) { // XAUEUR: the same feed, for multi-symbol runs
        const err = new Error(`cTrader does not have a symbol matching "${symbol}" on this account.`);
        err.code = 'SYMBOL_NOT_FOUND';
        throw err;
      }
      fetchLog.push([periodLabel, fromMs, toMs]);
      // Like cTrader: 1500 bars per page, newest first, `maxPages` pages at most.
      const inWindow = series[periodLabel].filter(c => c.time >= fromMs / 1000 && c.time <= toMs / 1000);
      return { candles: inWindow.slice(-1500 * Math.max(1, Math.min(14, Math.floor(maxPages)))).map(c => ({ ...c })) };
    },
    listAccountSymbols: async () => ['EURUSD', 'GBPUSD', 'XAUUSD'],
  },
};

// ── In-memory persistence for the models the agent code uses ─────────────
function memoryModel(Model) {
  const store = new Map();
  const matches = (doc, query) => Object.entries(query).every(([key, want]) => {
    if (key === '$or') return want.some(q => matches(doc, q));
    const val = doc[key];
    if (want && typeof want === 'object' && !(want instanceof mongoose.Types.ObjectId)) {
      if ('$in' in want) return want.$in.some(x => (x === null ? val == null : String(val) === String(x)));
      if ('$ne' in want) return String(val) !== String(want.$ne);
      if ('$regex' in want) return new RegExp(want.$regex, want.$options || '').test(String(val ?? ''));
      if ('$gte' in want || '$lte' in want || '$lt' in want) {
        const v = new Date(val).getTime();
        return (!('$gte' in want) || v >= new Date(want.$gte).getTime()) && (!('$lte' in want) || v <= new Date(want.$lte).getTime())
          && (!('$lt' in want) || v < new Date(want.$lt).getTime());
      }
    }
    if (want === null) return val == null;
    if (Array.isArray(val)) return val.map(String).includes(String(want));
    return String(val) === String(want);
  });
  const find = query => [...store.values()].filter(doc => matches(doc, query));
  const hydrate = doc => doc && Model.hydrate(JSON.parse(JSON.stringify(doc)));
  const chain = docs => {
    const c = { sort: () => c, select: () => c, lean: () => c, skip: n => { docs = docs.slice(n); return c; }, limit: n => { docs = docs.slice(0, n); return c; }, then: (ok, fail) => Promise.resolve(docs).then(ok, fail) };
    return c;
  };
  Model.prototype.save = async function save() {
    if (!this.createdAt) this.createdAt = new Date();
    this.updatedAt = new Date();
    store.set(String(this._id), this.toObject());
    return this;
  };
  Model.findOne = query => {
    const doc = find(query)[0];
    const p = Promise.resolve(doc ? hydrate(doc) : null);
    p.lean = () => Promise.resolve(doc || null);
    p.select = () => p;
    return p;
  };
  Model.find = query => chain(find(query).map(doc => ({ ...doc })));
  Model.countDocuments = async query => find(query).length;
  Model.updateOne = async (query, update) => { const doc = find(query)[0]; if (doc) Object.assign(doc, update.$set || update); return {}; };
  Model.create = async data => { const doc = new Model(data); await doc.validate(); await doc.save(); return doc; };
  Model.insertMany = async list => Promise.all(list.map(data => Model.create(data)));
  Model.updateMany = async () => ({});
  Model.findOneAndUpdate = async (query, update, opts) => {
    const doc = find(query)[0];
    if (!doc) {
      if (!opts?.upsert) return null;
      const created = new Model({ ...update.$setOnInsert, ...update.$set });
      await created.save();
      return created;
    }
    // Like Mongoose, an update with no operators is a $set.
    Object.assign(doc, update.$set || (Object.keys(update).some(k => k.startsWith('$')) ? {} : update));
    return hydrate(doc);
  };
  Model.aggregate = async () => [];
  Model.bulkWrite = async ops => {
    for (const { updateOne } of ops) { const doc = find(updateOne.filter)[0]; if (doc) Object.assign(doc, updateOne.update.$set); }
    return {};
  };
  Model.deleteOne = async query => { const doc = find(query)[0]; if (doc) store.delete(String(doc._id)); return { deletedCount: doc ? 1 : 0 }; };
  Model.deleteMany = async query => { const docs = find(query); for (const doc of docs) store.delete(String(doc._id)); return { deletedCount: docs.length }; };
  Model.store = store;
  return Model;
}

const models = {
  Session: memoryModel(require('../models/AgentReplaySession')),
  Trade: memoryModel(require('../models/BacktestTrade')),
  Strategy: memoryModel(require('../models/BacktestStrategy')),
  ApiKey: memoryModel(require('../models/ApiKey')),
  // The real trade journal (lib/agentJournal).
  JournalTrade: memoryModel(require('../models/Trade')),
  ReplayJournal: memoryModel(require('../models/ReplayJournal')),
  TradingAccount: memoryModel(require('../models/TradingAccount')),
  User: memoryModel(require('../models/User')),
  StrategyRun: memoryModel(require('../models/StrategyRun')),
  KnowledgeEntry: memoryModel(require('../models/KnowledgeEntry')),
  PreTradeAnalysis: memoryModel(require('../models/PreTradeAnalysis')),
  AccountEvent: memoryModel(require('../models/AccountEvent')),
  OAuthClient: memoryModel(require('../models/OAuthClient')),
  OAuthCode: memoryModel(require('../models/OAuthCode')),
};
// Only after the models are compiled: routes check this before touching the DB.
Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1 });

/** Brute force: which level the 1-minute data reaches first after `fromSec` (both in one minute -> stop). */
function firstLevelOn1m(trade, fromSec, untilSec) {
  const long = trade.direction === 'long';
  for (const c of m1) {
    if (c.time < fromSec || c.time >= untilSec) continue;
    if (long ? c.low <= trade.stopLoss : c.high >= trade.stopLoss) return 'stop';
    if (trade.takeProfit != null && (long ? c.high >= trade.takeProfit : c.low <= trade.takeProfit)) return 'target';
  }
  return null;
}

module.exports = { TF, series, fetchLog, models, firstLevelOn1m, newUserId: () => new mongoose.Types.ObjectId().toString() };
