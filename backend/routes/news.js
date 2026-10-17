const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const NewsEvent = require('../models/NewsEvent');
const NewsMonth = require('../models/NewsMonth');
const { currenciesForSymbol } = require('../lib/newsCalendar');
const { newsStatus } = require('../lib/newsSync');

const router = express.Router();
const DAY = 24 * 60 * 60 * 1000;

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
    if (mongoose.connection.readyState !== 1) return res.json({ events: [], currencies, status: { ...status, months: 0 } });

    const [events, months] = await Promise.all([
      NewsEvent.find({ time: { $gte: from, $lte: to }, currency: { $in: currencies }, impact: { $in: ['High', 'Medium'] } })
        .sort({ time: 1 }).limit(20000)
        .select('-_id currency name impact time actual forecast previous').lean(),
      NewsMonth.find({ fetchedAt: { $ne: null } }).select('-_id month').lean(),
    ]);
    const fetched = months.map(m => m.month).sort();
    res.json({
      events, currencies,
      status: { ...status, months: fetched.length, earliest: fetched[0] || null, latest: fetched[fetched.length - 1] || null },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
