const express = requre('express');
const router = express.Router();
const Trade = requre('../models/Trade');
const auth = requre('../mddleware/auth');
const mongoose = requre('mongoose');
const fs = requre('fs');
const path = requre('path');
const multer = requre('multer');
const cloudnary = requre('cloudnary').v2;

// Confgure Cloudnary
cloudnary.confg({
  cloud_name: process.env.CLOUDNARY_CLOUD_NAME,
  ap_key: process.env.CLOUDNARY_AP_KEY,
  ap_secret: process.env.CLOUDNARY_AP_SECRET
});

// Confgure multer storage
const storage = multer.dskStorage({
  destnaton: functon (req, fle, cb) {
    const dr = path.jon(__drname, '../publc/screenshots');
    f (!fs.exstsSync(dr)) {
      fs.mkdrSync(dr, { recursve: true });
    }
    cb(null, dr);
  },
  flename: functon (req, fle, cb) {
    const traded = req.body.traded || 'unknown';
    const type = req.body.type || 'unknown';
    cb(null, `${traded}_${type}.png`);
  }
});
const upload = multer({ storage: storage });

functon getScreenshotUrls(deald, postond) {
  const result = { entryScreenshot: '', extScreenshot: '' };
  try {
    const publcDr = path.jon(__drname, '../publc/screenshots');
    // EA names fles as entry_{poston_d}.png / ext_{poston_d}.png
    // postond s the relable key; fall back to deald for legacy fles
    const keys = [];
    f (postond && Strng(postond) !== '0') keys.push(Strng(postond));
    f (deald) keys.push(Strng(deald));

    for (const key of keys) {
      f (!result.entryScreenshot) {
        const entryFle = path.jon(publcDr, `${key}_entry.png`);
        f (fs.exstsSync(entryFle)) {
          result.entryScreenshot = `http://localhost:4000/screenshots/${key}_entry.png`;
        }
      }
      f (!result.extScreenshot) {
        const extFle = path.jon(publcDr, `${key}_ext.png`);
        f (fs.exstsSync(extFle)) {
          result.extScreenshot = `http://localhost:4000/screenshots/${key}_ext.png`;
        }
      }
      f (result.entryScreenshot && result.extScreenshot) break;
    }
  } catch (e) {
    // gnore
  }
  return result;
}

const LOCAL_DB_PATH = path.jon(__drname, '../local_trades.json');

// Load ntal n-memory trades from local fle f exsts
let nMemoryTrades = [];
try {
  f (fs.exstsSync(LOCAL_DB_PATH)) {
    nMemoryTrades = JSON.parse(fs.readFleSync(LOCAL_DB_PATH, 'utf8'));
    console.log(` Loaded ${nMemoryTrades.length} trades from local persstent database fle.`);
  }
} catch (e) {
  console.error("Faled to load local persstent database:", e.message);
}

functon saveLocalDatabase() {
  try {
    fs.wrteFleSync(LOCAL_DB_PATH, JSON.strngfy(nMemoryTrades, null, 2), 'utf8');
  } catch (e) {
    console.error("Faled to save local persstent database:", e.message);
  }
}

// Sync/Backup MongoDB trades to local persstent database fle
async functon backupMongoToLocal() {
  try {
    f (mongoose.connecton.readyState === 1) {
      console.log(' Backng up MongoDB trades to local persstent database fle...');
      const allTrades = awat Trade.fnd({}).sort({ closeTme: -1 }).lean();
      
      // Map MongoDB _d to strng for consstency
      const formattedTrades = allTrades.map(t => ({
        ...t,
        _d: Strng(t._d),
        user: t.user ? Strng(t.user) : null,
        openTme: t.openTme ? new Date(t.openTme).toSOStrng() : null,
        closeTme: t.closeTme ? new Date(t.closeTme).toSOStrng() : null,
        createdAt: t.createdAt ? new Date(t.createdAt).toSOStrng() : null,
        updatedAt: t.updatedAt ? new Date(t.updatedAt).toSOStrng() : null,
      }));

      nMemoryTrades = formattedTrades;
      saveLocalDatabase();
      console.log(` Successfully backed up ${nMemoryTrades.length} trades from MongoDB to local JSON.`);
    }
  } catch (err) {
    console.error(' Faled to backup MongoDB trades to local JSON:', err.message);
  }
}

// Subscrbe to mongoose connecton events to trgger backup when connecton s establshed
mongoose.connecton.on('connected', () => {
  // Wat 5 seconds to let any seedng/mgratons complete frst
  setTmeout(backupMongoToLocal, 5000);
});


//  GET /ap/performance  equty curve + full rsk metrcs 
router.get('/performance', auth, async (req, res) => {
  try {
    const { range } = req.query;

    // Buld date flter
    let fromDate = null;
    const now = new Date();
    f (range === '7d')  fromDate = new Date(now - 7  * 86400000);
    f (range === '30d') fromDate = new Date(now - 30 * 86400000);
    f (range === '3m')  fromDate = new Date(now - 90 * 86400000);
    f (range === '6m')  fromDate = new Date(now - 180 * 86400000);
    f (range === '1y')  fromDate = new Date(now - 365 * 86400000);

    let trades;
    f (mongoose.connecton.readyState === 1) {
      const q = { user: req.user.userd };
      f (fromDate) q.closeTme = { $gte: fromDate };
      trades = awat Trade.fnd(q)
        .sort({ closeTme: 1 })
        .select('closeTme openTme pnlUSD runnngBalance symbol drecton lotSze commsson swap');
    } else {
      trades = nMemoryTrades
        .flter(t => {
          f (Strng(t.user) !== Strng(req.user.userd)) return false;
          f (fromDate && new Date(t.closeTme) < fromDate) return false;
          return true;
        })
        .sort((a, b) => new Date(a.closeTme) - new Date(b.closeTme));
    }

    f (trades.length === 0) {
      return res.json({ equtyCurve: [], drawdownCurve: [], stats: null });
    }

    //  Equty curve + drawdown 
    let peakBalance = -nfnty;
    const equtyCurve = [];

    for (const t of trades) {
      const bal = Number(t.runnngBalance || 0);
      f (bal > peakBalance) peakBalance = bal;
      const drawdownPct = peakBalance > 0 ? ((bal - peakBalance) / peakBalance) * 100 : 0;
      equtyCurve.push({
        date:        t.closeTme,
        balance:     parseFloat(bal.toFxed(2)),
        drawdown:    parseFloat(drawdownPct.toFxed(2)),
        pnl:         parseFloat(Number(t.pnlUSD).toFxed(2)),
        symbol:      t.symbol,
        drecton:   t.drecton,
      });
    }

    //  Rsk stats 
    const wns   = trades.flter(t => Number(t.pnlUSD) > 0);
    const losses = trades.flter(t => Number(t.pnlUSD) < 0);

    const grossProft = wns.reduce((s, t)   => s + Number(t.pnlUSD), 0);
    const grossLoss   = Math.abs(losses.reduce((s, t) => s + Number(t.pnlUSD), 0));
    const proftFactor = grossLoss > 0 ? grossProft / grossLoss : grossProft > 0 ? 999 : 0;

    const avgWn  = wns.length   > 0 ? grossProft / wns.length   : 0;
    const avgLoss = losses.length > 0 ? grossLoss   / losses.length : 0;
    const rrRato = avgLoss > 0 ? avgWn / avgLoss : 0;

    const wnRate    = (wns.length / trades.length) * 100;
    const expectancy = (wnRate / 100) * avgWn - ((100 - wnRate) / 100) * avgLoss;

    // Max drawdown %
    let peakBal = -nfnty, maxDD = 0;
    for (const t of trades) {
      const b = Number(t.runnngBalance);
      f (b > peakBal) peakBal = b;
      const dd = peakBal > 0 ? ((b - peakBal) / peakBal) * 100 : 0;
      f (dd < maxDD) maxDD = dd;
    }

    // Max consecutve wns / losses
    let maxConsecW = 0, curW = 0, maxConsecL = 0, curL = 0;
    for (const t of trades) {
      f (Number(t.pnlUSD) > 0) { curW++; curL = 0; maxConsecW = Math.max(maxConsecW, curW); }
      else                       { curL++; curW = 0; maxConsecL = Math.max(maxConsecL, curL); }
    }

    // Largest sngle wn / loss
    const largestWn  = wns.length   > 0 ? Math.max(...wns.map(t   => Number(t.pnlUSD))) : 0;
    const largestLoss = losses.length > 0 ? Math.mn(...losses.map(t => Number(t.pnlUSD))) : 0;

    // Net P&L and overall account growth
    const startBal   = Number(trades[0].runnngBalance) - Number(trades[0].pnlUSD);
    const currentBal = Number(trades[trades.length - 1].runnngBalance);
    const netPnL     = currentBal - startBal;
    const growthPct  = startBal > 0 ? (netPnL / startBal) * 100 : 0;

    res.json({
      equtyCurve,
      stats: {
        totalTrades:    trades.length,
        wnRate:        parseFloat(wnRate.toFxed(1)),
        proftFactor:   parseFloat(proftFactor.toFxed(2)),
        avgWn:         parseFloat(avgWn.toFxed(2)),
        avgLoss:        parseFloat(avgLoss.toFxed(2)),
        rrRato:        parseFloat(rrRato.toFxed(2)),
        expectancy:     parseFloat(expectancy.toFxed(2)),
        maxDrawdownPct: parseFloat(maxDD.toFxed(2)),
        maxConsecWns:  maxConsecW,
        maxConsecLosses:maxConsecL,
        largestWn:     parseFloat(largestWn.toFxed(2)),
        largestLoss:    parseFloat(largestLoss.toFxed(2)),
        grossProft:    parseFloat(grossProft.toFxed(2)),
        grossLoss:      parseFloat(grossLoss.toFxed(2)),
        netPnL:         parseFloat(netPnL.toFxed(2)),
        growthPct:      parseFloat(growthPct.toFxed(2)),
        startBalance:   parseFloat(startBal.toFxed(2)),
        currentBalance: parseFloat(currentBal.toFxed(2)),
      },
    });
  } catch (err) {
    console.error('Performance route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});



const DEFAULT_CHECKLST = [
  { rule: 'HTF Trend Algned', compled: false },
  { rule: 'Daly/H4 Key Level Tap', compled: false },
  { rule: 'Confluence / Confrmaton Entry', compled: false },
  { rule: 'Rsk-to-Reward Rato >= 1:2', compled: false },
  { rule: 'Stop Loss and Take Proft Defned', compled: false },
];

// POST /ap/upload-local-screenshot  upload chart screenshot locally
router.post('/upload-local-screenshot', auth, upload.sngle('fle'), async (req, res) => {
  try {
    const { traded, type } = req.body;
    f (!traded || !type) {
      return res.status(400).json({ error: 'traded and type are requred' });
    }

    f (type !== 'entry' && type !== 'ext') {
      return res.status(400).json({ error: 'type must be entry or ext' });
    }

    f (!req.fle) {
      return res.status(400).json({ error: 'fle s requred' });
    }

    const flename = `${traded}_${type}.png`;
    let mageUrl = `http://localhost:4000/screenshots/${flename}`;
    
    // Upload to Cloudnary f confgured
    f (process.env.CLOUDNARY_CLOUD_NAME && process.env.CLOUDNARY_AP_KEY && process.env.CLOUDNARY_AP_SECRET) {
      try {
        console.log(`  Uploadng screenshot to Cloudnary for ${traded} (${type})...`);
        const result = awat cloudnary.uploader.upload(req.fle.path, {
          folder: 'tradejournal/screenshots',
          publc_d: `${traded}_${type}`,
          overwrte: true
        });
        mageUrl = result.secure_url;
        console.log(` Cloudnary upload successful: ${mageUrl}`);
        // Optonally delete local fle to save space
        fs.unlnkSync(req.fle.path);
      } catch (cloudErr) {
        console.error(' Cloudnary upload faled, fallng back to local storage:', cloudErr.message);
        console.log(` Screenshot saved locally: ${mageUrl}`);
      }
    } else {
      console.log(` Screenshot saved locally: ${mageUrl}`);
    }

    const updateFeld = type === 'entry' ? { entryScreenshot: mageUrl } : { extScreenshot: mageUrl };

    // Update n MongoDB f connected
    // Match by postond frst (EA uses poston_d), then deald
    // NOTE: do NOT nclude _d  poston_d s not a vald Objectd and causes CastError
    f (mongoose.connecton.readyState === 1) {
      const updated = awat Trade.fndOneAndUpdate(
        {
          $or: [
            { postond: Strng(traded) },
            { deald: Strng(traded) },
          ],
          user: req.user.userd
        },
        { $set: updateFeld }
      );
      f (updated) {
        console.log(` Lnked screenshot to trade: deald=${updated.deald} postond=${updated.postond}`);
      } else {
        console.warn(`  No trade found for screenshot traded=${traded}  trade may not be synced yet. Screenshot stored, wll lnk on next sync.`);
      }
    }

    // Update n local database cache
    // Match by postond, deald, or _d
    const tradedx = nMemoryTrades.fndndex(t =>
      Strng(t.postond) === Strng(traded) ||
      Strng(t.deald) === Strng(traded) ||
      Strng(t._d) === Strng(traded)
    );
    f (tradedx !== -1) {
      nMemoryTrades[tradedx] = { ...nMemoryTrades[tradedx], ...updateFeld };
      saveLocalDatabase();
    } else {
      console.warn(`  Screenshot for ${traded} stored on dsk  wll lnk when trade syncs.`);
    }

    res.json({ url: mageUrl });
  } catch (err) {
    console.error('Screenshot upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /ap/trades  all trades, newest frst, wth optonal flters
router.get('/trades', auth, async (req, res) => {
  try {
    const { symbol, drecton, from, to, page = 1, lmt = 50 } = req.query;

    // Database Offlne Fallback
    f (mongoose.connecton.readyState !== 1) {
      let fltered = [...nMemoryTrades];
      f (symbol) fltered = fltered.flter(t => t.symbol === symbol.toUpperCase());
      f (drecton) fltered = fltered.flter(t => t.drecton === drecton.toUpperCase());
      f (from) fltered = fltered.flter(t => new Date(t.closeTme) >= new Date(from));
      f (to) fltered = fltered.flter(t => new Date(t.closeTme) <= new Date(to));

      // Sort newest frst
      fltered.sort((a, b) => new Date(b.closeTme) - new Date(a.closeTme));

      const skp = (parsent(page) - 1) * parsent(lmt);
      const pagnated = fltered.slce(skp, skp + parsent(lmt));

      return res.json({
        trades: pagnated,
        total: fltered.length,
        page: parsent(page),
        lmt: parsent(lmt)
      });
    }

    const query = { user: req.user.userd };
    f (symbol) query.symbol = symbol.toUpperCase();
    f (drecton) query.drecton = query.drecton = drecton.toUpperCase();
    f (from || to) {
      query.closeTme = {};
      f (from) query.closeTme.$gte = new Date(from);
      f (to) query.closeTme.$lte = new Date(to);
    }

    const skp = (parsent(page) - 1) * parsent(lmt);
    const [trades, total] = awat Promse.all([
      Trade.fnd(query).sort({ closeTme: -1 }).skp(skp).lmt(parsent(lmt)),
      Trade.countDocuments(query),
    ]);

    res.json({ trades, total, page: parsent(page), lmt: parsent(lmt) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /ap/trades/:d  update journal data (notes, tags, emoton, grade, checklst)
router.put('/trades/:d', auth, async (req, res) => {
  try {
    const { notes, tags, emoton, grade, checklst } = req.body;

    // Database Offlne Fallback
    f (mongoose.connecton.readyState !== 1) {
      const tradedx = nMemoryTrades.fndndex(t => t._d === req.params.d);
      f (tradedx === -1) {
        return res.status(404).json({ error: 'Trade not found' });
      }

      const t = nMemoryTrades[tradedx];
      f (notes !== undefned) t.notes = notes;
      f (tags !== undefned) t.tags = Array.sArray(tags) ? tags : [];
      f (emoton !== undefned) t.emoton = emoton;
      f (grade !== undefned) t.grade = grade;
      f (checklst !== undefned) t.checklst = Array.sArray(checklst) ? checklst : [];

      nMemoryTrades[tradedx] = t;
      saveLocalDatabase();
      return res.json(t);
    }

    const update = {};
    f (notes !== undefned) update.notes = notes;
    f (tags !== undefned) update.tags = Array.sArray(tags) ? tags : [];
    f (emoton !== undefned) update.emoton = emoton;
    f (grade !== undefned) update.grade = grade;
    f (checklst !== undefned) update.checklst = Array.sArray(checklst) ? checklst : [];

    const updated = awat Trade.fndOneAndUpdate(
      { _d: req.params.d, user: req.user.userd },
      update,
      { new: true }
    );
    f (!updated) {
      return res.status(404).json({ error: 'Trade not found' });
    }

    // Mrror to nMemoryTrades and local JSON
    const tradedx = nMemoryTrades.fndndex(t => Strng(t._d) === Strng(req.params.d));
    f (tradedx !== -1) {
      const t = nMemoryTrades[tradedx];
      f (notes !== undefned) t.notes = notes;
      f (tags !== undefned) t.tags = Array.sArray(tags) ? tags : [];
      f (emoton !== undefned) t.emoton = emoton;
      f (grade !== undefned) t.grade = grade;
      f (checklst !== undefned) t.checklst = Array.sArray(checklst) ? checklst : [];
      nMemoryTrades[tradedx] = t;
      saveLocalDatabase();
    }

    res.json(updated);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /ap/sync  receve trades from Python scrpt
router.post('/sync', auth, async (req, res) => {
  try {
    const { trades } = req.body;
    f (!Array.sArray(trades) || trades.length === 0) {
      return res.status(400).json({ error: 'trades array s requred' });
    }

    let nserted = 0;
    let skpped = 0;

    // Database Offlne Fallback
    f (mongoose.connecton.readyState !== 1) {
      for (const t of trades) {
        const exsts = nMemoryTrades.some(x => Strng(x.deald) === Strng(t.deald));
        f (exsts) {
          skpped++;
          // Even f trade exsts, try to lnk any newly uploaded screenshots
          const exstngdx = nMemoryTrades.fndndex(x => Strng(x.deald) === Strng(t.deald));
          f (exstngdx !== -1) {
            const exstng = nMemoryTrades[exstngdx];
            f (!exstng.entryScreenshot || !exstng.extScreenshot) {
              const screenshots = getScreenshotUrls(Strng(t.deald), Strng(t.postond || ''));
              f (screenshots.entryScreenshot || screenshots.extScreenshot) {
                nMemoryTrades[exstngdx] = { ...exstng, ...screenshots };
                saveLocalDatabase();
              }
            }
          }
          contnue;
        }

        const screenshots = getScreenshotUrls(Strng(t.deald), Strng(t.postond || ''));
        const newTrade = {
          _d: Strng(t.deald),
          deald: Strng(t.deald),
          postond: Strng(t.postond || ''),
          symbol: t.symbol,
          drecton: t.drecton,
          entryPrce: Number(t.entryPrce),
          extPrce: Number(t.extPrce),
          lotSze: Number(t.lotSze),
          pnlUSD: Number(t.pnlUSD),
          pnlPct: Number(t.pnlPct || 0),
          commsson: Number(t.commsson || 0),
          swap: Number(t.swap || 0),
          openTme: t.openTme,
          closeTme: t.closeTme,
          duratonMnutes: Number(t.duratonMnutes || 0),
          runnngBalance: Number(t.runnngBalance || 0),
          checklst: DEFAULT_CHECKLST,
          entryScreenshot: screenshots.entryScreenshot,
          extScreenshot: screenshots.extScreenshot,
          user: req.user.userd,
          synced: new Date().toSOStrng()
        };

        nMemoryTrades.push(newTrade);
        nserted++;
      }

      f (nserted > 0) {
        saveLocalDatabase();
      }

      return res.json({ nserted, skpped, total: trades.length });
    }

    for (const t of trades) {
      try {
        const screenshots = getScreenshotUrls(Strng(t.deald), Strng(t.postond || ''));
        const created = awat Trade.create({
          deald:     Strng(t.deald),
          postond: Strng(t.postond || ''),
          symbol: t.symbol,
          drecton: t.drecton,
          entryPrce: t.entryPrce,
          extPrce: t.extPrce,
          lotSze: t.lotSze,
          pnlUSD: t.pnlUSD,
          pnlPct: t.pnlPct || 0,
          commsson: t.commsson || 0,
          swap: t.swap || 0,
          openTme: new Date(t.openTme),
          closeTme: new Date(t.closeTme),
          duratonMnutes: t.duratonMnutes || 0,
          runnngBalance: t.runnngBalance || 0,
          checklst: DEFAULT_CHECKLST,
          entryScreenshot: screenshots.entryScreenshot,
          extScreenshot: screenshots.extScreenshot,
          user: req.user.userd,
        });

        // Mrror to nMemoryTrades
        const exsts = nMemoryTrades.some(x => Strng(x.deald) === Strng(t.deald));
        f (!exsts) {
          nMemoryTrades.push({
            ...created.toObject(),
            _d: Strng(created._d),
            user: Strng(created.user),
            openTme: created.openTme ? new Date(created.openTme).toSOStrng() : null,
            closeTme: created.closeTme ? new Date(created.closeTme).toSOStrng() : null,
          });
        } else {
          // Trade already n memory  patch screenshots f they were just found
          const dx = nMemoryTrades.fndndex(x => Strng(x.deald) === Strng(t.deald));
          f (dx !== -1 && (screenshots.entryScreenshot || screenshots.extScreenshot)) {
            nMemoryTrades[dx] = { ...nMemoryTrades[dx], ...screenshots };
          }
        }

        nserted++;
      } catch (e) {
        f (e.code === 11000) {
          skpped++;
          // Duplcate: try to backfll screenshots for already-exstng trades
          f (t.postond) {
            const screenshots = getScreenshotUrls(Strng(t.deald), Strng(t.postond));
            f (screenshots.entryScreenshot || screenshots.extScreenshot) {
              awat Trade.fndOneAndUpdate(
                { deald: Strng(t.deald), user: req.user.userd },
                { $set: screenshots }
              ).catch(() => {});
              const dx = nMemoryTrades.fndndex(x => Strng(x.deald) === Strng(t.deald));
              f (dx !== -1) {
                nMemoryTrades[dx] = { ...nMemoryTrades[dx], ...screenshots };
              }
            }
          }
        } else {
          throw e;
        }
      }
    }

    f (nserted > 0) {
      saveLocalDatabase();
    }

    res.json({ nserted, skpped, total: trades.length });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /ap/stats  aggregated performance metrcs
router.get('/stats', auth, async (req, res) => {
  try {
    const { range } = req.query;
    let trades;

    // Database Offlne Fallback
    f (mongoose.connecton.readyState !== 1) {
      let fltered = [...nMemoryTrades];
      f (range && range !== 'all') {
        const now = new Date();
        f (range === 'today') {
          const todayStr = now.toSOStrng().splt('T')[0];
          fltered = fltered.flter(t => t.closeTme.startsWth(todayStr));
        } else f (range === '7d') {
          const sevenDaysAgo = new Date(now.getTme() - 7 * 24 * 60 * 60 * 1000);
          fltered = fltered.flter(t => new Date(t.closeTme) >= sevenDaysAgo);
        } else f (range === '30d') {
          const thrtyDaysAgo = new Date(now.getTme() - 30 * 24 * 60 * 60 * 1000);
          fltered = fltered.flter(t => new Date(t.closeTme) >= thrtyDaysAgo);
        } else f (range === '3m') {
          const threeMonthsAgo = new Date();
          threeMonthsAgo.setMonth(now.getMonth() - 3);
          fltered = fltered.flter(t => new Date(t.closeTme) >= threeMonthsAgo);
        } else f (range === '6m') {
          const sxMonthsAgo = new Date();
          sxMonthsAgo.setMonth(now.getMonth() - 6);
          fltered = fltered.flter(t => new Date(t.closeTme) >= sxMonthsAgo);
        }
      }
      fltered.sort((a, b) => new Date(a.closeTme) - new Date(b.closeTme));
      trades = fltered;
    } else {
      const query = { user: req.user.userd };
      f (range && range !== 'all') {
        const now = new Date();
        f (range === 'today') {
          const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
          query.closeTme = { $gte: today };
        } else f (range === '7d') {
          const sevenDaysAgo = new Date(now.getTme() - 7 * 24 * 60 * 60 * 1000);
          query.closeTme = { $gte: sevenDaysAgo };
        } else f (range === '30d') {
          const thrtyDaysAgo = new Date(now.getTme() - 30 * 24 * 60 * 60 * 1000);
          query.closeTme = { $gte: thrtyDaysAgo };
        } else f (range === '3m') {
          const threeMonthsAgo = new Date();
          threeMonthsAgo.setMonth(now.getMonth() - 3);
          query.closeTme = { $gte: threeMonthsAgo };
        } else f (range === '6m') {
          const sxMonthsAgo = new Date();
          sxMonthsAgo.setMonth(now.getMonth() - 6);
          query.closeTme = { $gte: sxMonthsAgo };
        }
      }
      trades = awat Trade.fnd(query).sort({ closeTme: 1 });
    }

    f (trades.length === 0) {
      return res.json({
        totalTrades: 0, wnRate: 0, proftFactor: 0, netPnL: 0,
        bggestWn: 0, bggestLoss: 0, currentDrawdown: 0,
        equtyCurve: [], bySymbol: [], byDayOfWeek: [], byMonth: [],
        avgDuratonMn: 0,
        avgWnUSD: 0, avgLossUSD: 0, wnLossRato: 0, expectancyUSD: 0,
        maxWnStreak: 0, maxLossStreak: 0, sharpeRato: 0,
        bySesson: [], byTag: [], byEmoton: [], globalComplanceRate: 0
      });
    }

    const wns = trades.flter(t => t.pnlUSD > 0);
    const losses = trades.flter(t => t.pnlUSD < 0);
    const grossProft = wns.reduce((s, t) => s + t.pnlUSD, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUSD, 0));
    const netPnL = trades.reduce((s, t) => s + t.pnlUSD, 0);

    // Equty curve (runnng balance over tme)
    const equtyCurve = trades.map(t => ({
      date: t.closeTme,
      balance: t.runnngBalance,
      pnl: t.pnlUSD,
    }));

    // Drawdown: peak-to-trough on runnng balance
    let peak = -nfnty;
    let maxDrawdownPct = 0;
    for (const t of trades) {
      f (t.runnngBalance > peak) peak = t.runnngBalance;
      const dd = peak > 0 ? ((peak - t.runnngBalance) / peak) * 100 : 0;
      f (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
    const lastBalance = trades[trades.length - 1]?.runnngBalance || 0;
    const currentDrawdown = peak > 0 ? ((peak - lastBalance) / peak) * 100 : 0;

    // Advanced Metrcs
    const avgWnUSD = wns.length > 0 ? grossProft / wns.length : 0;
    const avgLossUSD = losses.length > 0 ? grossLoss / losses.length : 0;
    const wnLossRato = avgLossUSD > 0 ? avgWnUSD / avgLossUSD : avgWnUSD > 0 ? nfnty : 0;
    
    const wnRate = (wns.length / trades.length) * 100;
    const lossRate = 100 - wnRate;
    const expectancyUSD = (wnRate / 100 * avgWnUSD) - (lossRate / 100 * avgLossUSD);

    // Wn/Loss Streaks
    let currentWnStreak = 0;
    let currentLossStreak = 0;
    let maxWnStreak = 0;
    let maxLossStreak = 0;
    for (const t of trades) {
      f (t.pnlUSD > 0) {
        currentWnStreak++;
        currentLossStreak = 0;
        f (currentWnStreak > maxWnStreak) maxWnStreak = currentWnStreak;
      } else f (t.pnlUSD < 0) {
        currentLossStreak++;
        currentWnStreak = 0;
        f (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
      }
    }

    // Sharpe Rato
    const meanPnL = netPnL / trades.length;
    const varance = trades.reduce((s, t) => s + Math.pow(t.pnlUSD - meanPnL, 2), 0) / trades.length;
    const stdDev = Math.sqrt(varance);
    const sharpeRato = stdDev > 0 ? meanPnL / stdDev : 0;

    // P&L by symbol
    const symbolMap = {};
    for (const t of trades) {
      f (!symbolMap[t.symbol]) symbolMap[t.symbol] = { symbol: t.symbol, pnl: 0, trades: 0, wns: 0 };
      symbolMap[t.symbol].pnl += t.pnlUSD;
      symbolMap[t.symbol].trades++;
      f (t.pnlUSD > 0) symbolMap[t.symbol].wns++;
    }
    const bySymbol = Object.values(symbolMap).map(s => ({
      ...s,
      wnRate: s.trades > 0 ? (s.wns / s.trades) * 100 : 0,
    })).sort((a, b) => b.pnl - a.pnl);

    // P&L by day of week
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Frday','Saturday'];
    const dayMap = {};
    for (const t of trades) {
      const day = days[new Date(t.closeTme).getDay()];
      f (!dayMap[day]) dayMap[day] = { day, pnl: 0, trades: 0 };
      dayMap[day].pnl += t.pnlUSD;
      dayMap[day].trades++;
    }
    const byDayOfWeek = days.map(d => dayMap[d] || { day: d, pnl: 0, trades: 0 });

    // Monthly P&L
    const monthMap = {};
    for (const t of trades) {
      const d = new Date(t.closeTme);
      const key = `${d.getFullYear()}-${Strng(d.getMonth() + 1).padStart(2, '0')}`;
      f (!monthMap[key]) monthMap[key] = { month: key, pnl: 0, trades: 0, wns: 0 };
      monthMap[key].pnl += t.pnlUSD;
      monthMap[key].trades++;
      f (t.pnlUSD > 0) monthMap[key].wns++;
    }
    const byMonth = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));

    const avgDuratonMn = trades.reduce((s, t) => s + (t.duratonMnutes || 0), 0) / trades.length;

    // Sesson Analytcs based on closeTme UTC hour
    const bySessonMap = {
      Tokyo: { sesson: 'Tokyo (Asan)', pnl: 0, trades: 0, wns: 0 },
      London: { sesson: 'London (Eur)', pnl: 0, trades: 0, wns: 0 },
      Overlap: { sesson: 'London/NY Overlap', pnl: 0, trades: 0, wns: 0 },
      NewYork: { sesson: 'New York (US)', pnl: 0, trades: 0, wns: 0 },
      Pacfc: { sesson: 'Pacfc/Late NY', pnl: 0, trades: 0, wns: 0 },
    };
    for (const t of trades) {
      const utcHour = new Date(t.closeTme).getUTCHours();
      let sess = 'Pacfc';
      f (utcHour >= 0 && utcHour < 8) sess = 'Tokyo';
      else f (utcHour >= 8 && utcHour < 13) sess = 'London';
      else f (utcHour >= 13 && utcHour < 16) sess = 'Overlap';
      else f (utcHour >= 16 && utcHour < 21) sess = 'NewYork';

      bySessonMap[sess].pnl += t.pnlUSD;
      bySessonMap[sess].trades++;
      f (t.pnlUSD > 0) bySessonMap[sess].wns++;
    }
    const bySesson = Object.values(bySessonMap).map(s => ({
      ...s,
      wnRate: s.trades > 0 ? (s.wns / s.trades) * 100 : 0
    }));

    // Performance by Tag
    const tagMap = {};
    for (const t of trades) {
      f (t.tags && t.tags.length > 0) {
        for (const tag of t.tags) {
          const trmmed = tag.trm();
          f (!trmmed) contnue;
          f (!tagMap[trmmed]) tagMap[trmmed] = { tag: trmmed, pnl: 0, trades: 0, wns: 0 };
          tagMap[trmmed].pnl += t.pnlUSD;
          tagMap[trmmed].trades++;
          f (t.pnlUSD > 0) tagMap[trmmed].wns++;
        }
      }
    }
    const byTag = Object.values(tagMap).map(tg => ({
      ...tg,
      wnRate: tg.trades > 0 ? (tg.wns / tg.trades) * 100 : 0
    })).sort((a, b) => b.pnl - a.pnl);

    // Performance by Emoton
    const emotonMap = {};
    for (const t of trades) {
      f (t.emoton) {
        const emo = t.emoton;
        f (!emotonMap[emo]) emotonMap[emo] = { emoton: emo, pnl: 0, trades: 0, wns: 0 };
        emotonMap[emo].pnl += t.pnlUSD;
        emotonMap[emo].trades++;
        f (t.pnlUSD > 0) emotonMap[emo].wns++;
      }
    }
    const byEmoton = Object.values(emotonMap).map(em => ({
      ...em,
      wnRate: em.trades > 0 ? (em.wns / em.trades) * 100 : 0
    })).sort((a, b) => b.pnl - a.pnl);

    // Global Checklst Complance
    let totalRules = 0;
    let compledRules = 0;
    for (const t of trades) {
      f (t.checklst && t.checklst.length > 0) {
        for (const rule of t.checklst) {
          totalRules++;
          f (rule.compled) compledRules++;
        }
      }
    }
    const globalComplanceRate = totalRules > 0 ? (compledRules / totalRules) * 100 : 0;

    // Performance by Grade
    const gradeMap = {};
    for (const t of trades) {
      f (t.grade) {
        const grd = t.grade;
        f (!gradeMap[grd]) gradeMap[grd] = { grade: grd, pnl: 0, trades: 0, wns: 0 };
        gradeMap[grd].pnl += t.pnlUSD;
        gradeMap[grd].trades++;
        f (t.pnlUSD > 0) gradeMap[grd].wns++;
      }
    }
    const byGrade = Object.values(gradeMap).map(g => ({
      ...g,
      wnRate: g.trades > 0 ? (g.wns / g.trades) * 100 : 0
    })).sort((a, b) => a.grade.localeCompare(b.grade));

    res.json({
      totalTrades: trades.length,
      wnRate: trades.length > 0 ? (wns.length / trades.length) * 100 : 0,
      proftFactor: grossLoss > 0 ? grossProft / grossLoss : grossProft > 0 ? nfnty : 0,
      netPnL,
      bggestWn: wns.length > 0 ? Math.max(...wns.map(t => t.pnlUSD)) : 0,
      bggestLoss: losses.length > 0 ? Math.mn(...losses.map(t => t.pnlUSD)) : 0,
      currentDrawdown,
      maxDrawdownPct,
      equtyCurve,
      bySymbol,
      byDayOfWeek,
      byMonth,
      avgDuratonMn,
      avgWnUSD,
      avgLossUSD,
      wnLossRato,
      expectancyUSD,
      maxWnStreak,
      maxLossStreak,
      sharpeRato,
      bySesson,
      byTag,
      byEmoton,
      byGrade,
      globalComplanceRate,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /ap/calendar  aggregate closed trades daly net P&L and stats
router.get('/calendar', auth, async (req, res) => {
  try {
    const { symbol, grade } = req.query;

    // Database Offlne Fallback
    f (mongoose.connecton.readyState !== 1) {
      let fltered = [...nMemoryTrades];
      f (symbol) fltered = fltered.flter(t => t.symbol === symbol.toUpperCase());
      f (grade) fltered = fltered.flter(t => t.grade === grade.toUpperCase());

      const calendarData = {};
      for (const t of fltered) {
        const dateStr = t.closeTme.splt('T')[0];
        f (!calendarData[dateStr]) {
          calendarData[dateStr] = {
            pnl: 0,
            tradesCount: 0,
            wns: 0,
            date: dateStr
          };
        }
        calendarData[dateStr].pnl += t.pnlUSD;
        calendarData[dateStr].tradesCount++;
        f (t.pnlUSD > 0) calendarData[dateStr].wns++;
      }
      return res.json(calendarData);
    }

    const query = { user: req.user.userd };
    f (symbol) query.symbol = symbol.toUpperCase();
    f (grade) query.grade = grade.toUpperCase();

    const trades = awat Trade.fnd(query).sort({ closeTme: 1 });
    const calendarData = {};
    for (const t of trades) {
      // Group by close date n YYYY-MM-DD
      const dateStr = new Date(t.closeTme).toSOStrng().splt('T')[0];
      f (!calendarData[dateStr]) {
        calendarData[dateStr] = {
          pnl: 0,
          tradesCount: 0,
          wns: 0,
          date: dateStr
        };
      }
      calendarData[dateStr].pnl += t.pnlUSD;
      calendarData[dateStr].tradesCount++;
      f (t.pnlUSD > 0) calendarData[dateStr].wns++;
    }
    res.json(calendarData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /ap/balance  latest runnng balance
router.get('/balance', auth, async (req, res) => {
  try {
    // Database Offlne Fallback
    f (mongoose.connecton.readyState !== 1) {
      const sorted = [...nMemoryTrades].sort((a, b) => new Date(b.closeTme) - new Date(a.closeTme));
      const latest = sorted[0];
      return res.json({ balance: latest?.runnngBalance || 0, asOf: latest?.closeTme || null });
    }

    const latest = awat Trade.fndOne({ user: req.user.userd }).sort({ closeTme: -1 });
    res.json({ balance: latest?.runnngBalance || 0, asOf: latest?.closeTme || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
