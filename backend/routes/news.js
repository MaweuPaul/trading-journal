const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const NewsEvent = require('../models/NewsEvent');
const User = require('../models/User');
const { currenciesForSymbol } = require('../lib/newsCalendar');
const { eventsFromExport } = require('../lib/newsImport');
const { newsStatus } = require('../lib/newsSync');

const router = express.Router();
const DAY = 24 * 60 * 60 * 1000;

/**
 * The MT5 export and the Forex Factory feed overlap where history meets the
 * live feed, under different names ("Nonfarm Payrolls" / "Non-Farm
 * Employment Change"). Where Forex Factory has a currency's releases at a
 * minute, the MT5 ones at that minute are dropped.
 */
function mergeSources(events) {
  const ff = new Set(events.filter(e => e.source === 'forex-factory').map(e => `${e.currency}|${new Date(e.time).getTime()}`));
  return events.filter(e => e.source === 'forex-factory' || !ff.has(`${e.currency}|${new Date(e.time).getTime()}`));
}

async function calendarReach() {
  const [first, last] = await Promise.all([
    NewsEvent.findOne().sort({ time: 1 }).select('time -_id').lean(),
    NewsEvent.findOne().sort({ time: -1 }).select('time -_id').lean(),
  ]);
  return { earliest: first?.time || null, latest: last?.time || null };
}

// GET /api/news?from=ISO&to=ISO&symbol=EURUSD
// High and medium impact calendar events for the currencies that move
// `symbol` (or `currencies=USD,EUR`), plus how far the calendar reaches.
router.get('/news', auth, async (req, res) => {
  try {
    let from = new Date(String(req.query.from || ''));
    const to = new Date(String(req.query.to || ''));
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to < from) {
      return res.status(400).json({ error: 'from and to dates are required.' });
    }
    // A zoomed-out weekly chart can span many years: send the latest four.
    if (to - from > 4 * 366 * DAY) from = new Date(to.getTime() - 4 * 366 * DAY);
    const currencies = req.query.currencies
      ? String(req.query.currencies).toUpperCase().split(',').map(s => s.trim()).filter(Boolean).slice(0, 10)
      : currenciesForSymbol(req.query.symbol);
    const status = newsStatus();
    if (mongoose.connection.readyState !== 1) return res.json({ events: [], currencies, status });

    const [events, reach] = await Promise.all([
      NewsEvent.find({ time: { $gte: from, $lte: to }, currency: { $in: currencies }, impact: { $in: ['High', 'Medium'] } })
        .sort({ time: 1 }).limit(20000)
        .select('-_id source currency name impact time actual forecast previous').lean(),
      calendarReach(),
    ]);
    res.json({ events: mergeSources(events), currencies, status: { ...status, ...reach } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/news/import  { csv }
// The one-time history import: the calendar exported from MT5 with
// NewsExport.mq5. The calendar is shared by every account, so only the
// journal's owner (its first account) can import into it.
router.post('/news/import', auth, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'Importing needs the database to be connected.' });
    const owner = await User.findOne({}).sort({ createdAt: 1 }).select('_id').lean();
    if (!owner || String(owner._id) !== String(req.user.userId)) {
      return res.status(403).json({ error: 'Only the journal owner can import the news calendar.' });
    }
    const csv = String(req.body?.csv || '');
    if (!csv.trim()) return res.status(400).json({ error: 'Choose the CSV file NewsExport.mq5 saved.' });
    const { events, clock, rows } = eventsFromExport(csv);
    for (let i = 0; i < events.length; i += 5000) { // ten years is ~56k events: few round trips
      await NewsEvent.bulkWrite(events.slice(i, i + 5000).map(e => ({ updateOne: { filter: { key: e.key }, update: { $set: e }, upsert: true } })), { ordered: false });
    }
    const times = events.map(e => e.time.getTime());
    res.json({
      imported: events.length, rows,
      clock: `${clock.timeZone === 'UTC' ? 'UTC' : clock.timeZone === 'America/New_York' ? 'New York' : 'London'} ${clock.shiftMinutes >= 0 ? '+' : '-'}${Math.abs(clock.shiftMinutes / 60)}h`,
      from: times.length ? new Date(Math.min(...times)) : null,
      to: times.length ? new Date(Math.max(...times)) : null,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
