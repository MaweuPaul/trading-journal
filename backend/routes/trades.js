const express = require('express');
const router = express.Router();
const Trade = require('../models/Trade');
const auth = require('../middleware/auth');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const LOCAL_DB_PATH = path.join(__dirname, '../local_trades.json');

// Load initial n-memory trades from local file f exists
let inMemoryTrades = [];
try {
  if (fs.existsSync(LOCAL_DB_PATH)) {
    inMemoryTrades = JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf8'));
    console.log(` Loaded ${inMemoryTrades.length} trades from local persistent database file.`);
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

function isOfflineTradeVisibleToUser(trade, userId) {
  if (String(userId) === 'mocked_admin_user_id') return true;
  if (!trade.user) return true;
  return String(trade.user) === String(userId);
}

// Sync/Backup MongoDB trades to local persistent database file
async function backupMongoToLocal() {
  try {
    if (mongoose.connection.readyState === 1) {
      console.log(' Backing up MongoDB trades to local persistent database file...');
      const allTrades = await Trade.find({}).sort({ closeTime: -1 }).lean();
      
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
    }
  } catch (err) {
    console.error(' Failed to backup MongoDB trades to local JSON:', err.message);
  }
}

// Subscrbe to mongoose connection events to trgger backup when connection is establshed
mongoose.connection.on('connected', () => {
  // Wat 5 seconds to let any seedng/mgratons complete frst
  setTimeout(backupMongoToLocal, 5000);
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

// PUT /api/trades/:d  update journal data (notes, tags, emotion, grade, checklist)
router.put('/trades/:id', auth, async (req, res) => {
  try {
    const { notes, tags, emotion, grade, checklist } = req.body;

    // Database Offlne Fallback
    if (mongoose.connection.readyState !== 1) {
      const tradeIdx = inMemoryTrades.findIndex(t => t._id === req.params.id);
      if (tradeIdx === -1) {
        return res.status(404).json({ error: 'Trade not found' });
      }

      const t = inMemoryTrades[tradeIdx];
      if (notes !== undefined) t.notes = notes;
      if (tags !== undefined) t.tags = Array.isArray(tags) ? tags : [];
      if (emotion !== undefined) t.emotion = emotion;
      if (grade !== undefined) t.grade = grade;
      if (checklist !== undefined) t.checklist = Array.isArray(checklist) ? checklist : [];

      inMemoryTrades[tradeIdx] = t;
      saveLocalDatabase();
      return res.json(t);
    }

    const update = {};
    if (notes !== undefined) update.notes = notes;
    if (tags !== undefined) update.tags = Array.isArray(tags) ? tags : [];
    if (emotion !== undefined) update.emotion = emotion;
    if (grade !== undefined) update.grade = grade;
    if (checklist !== undefined) update.checklist = Array.isArray(checklist) ? checklist : [];

    const updated = await Trade.findOneAndUpdate(
      { _id: req.params.id, user: req.user.userId },
      update,
      { new: true }
    );
    if (!updated) {
      return res.status(404).json({ error: 'Trade not found' });
    }

    // Mrror to inMemoryTrades and local JSON
    const tradeIdx = inMemoryTrades.findIndex(t => String(t._id) === String(req.params.id));
    if (tradeIdx !== -1) {
      const t = inMemoryTrades[tradeIdx];
      if (notes !== undefined) t.notes = notes;
      if (tags !== undefined) t.tags = Array.isArray(tags) ? tags : [];
      if (emotion !== undefined) t.emotion = emotion;
      if (grade !== undefined) t.grade = grade;
      if (checklist !== undefined) t.checklist = Array.isArray(checklist) ? checklist : [];
      inMemoryTrades[tradeIdx] = t;
      saveLocalDatabase();
    }

    res.json(updated);

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
        const exists = inMemoryTrades.some(x => String(x.dealId) === String(t.dealId));
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
        const exists = inMemoryTrades.some(x => String(x.dealId) === String(t.dealId));
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
      return res.json({ balance: latest?.runningBalance || 0, asOf: latest?.closeTime || null });
    }

    const latest = await Trade.findOne({ user: req.user.userId }).sort({ closeTime: -1 });
    res.json({ balance: latest?.runningBalance || 0, asOf: latest?.closeTime || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
