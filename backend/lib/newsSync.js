// Keeps the economic calendar (NewsEvent) filled from the JBlanked News API:
// one month per request, backfilling from NEWS_HISTORY_FROM (default
// 2024-01) and refreshing the current month hourly. Runs only when
// JBLANKED_API_KEY is set. The free tier is rate limited (their docs say one
// request a second, their library says one every five minutes), so it goes
// slowly and backs off when told to.

const NewsEvent = require('../models/NewsEvent');
const NewsMonth = require('../models/NewsMonth');
const { normalizeEvent, monthRange, nextMonthToFetch } = require('./newsCalendar');

const API = 'https://www.jblanked.com/news/api';
const SOURCE = 'forex-factory';
const MINUTE = 60 * 1000;
const status = { configured: false, running: false, lastFetch: null, lastError: '' };

async function fetchMonth(month, apiKey) {
  const { from, to } = monthRange(month);
  const res = await fetch(`${API}/${SOURCE}/calendar/range/?from=${from}&to=${to}`, {
    headers: { 'Authorization': `Api-Key ${apiKey}`, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`News API ${res.status}: ${body?.detail || body?.message || body?.error || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.results) ? body.results : null;
  if (!rows) throw new Error('News API returned an unexpected response');
  return rows.map(row => normalizeEvent(row, SOURCE)).filter(Boolean);
}

async function syncOnce(apiKey, now = new Date()) {
  const startMonth = process.env.NEWS_HISTORY_FROM || '2024-01';
  const done = await NewsMonth.find({ fetchedAt: { $ne: null } }).select('month fetchedAt').lean();
  const month = nextMonthToFetch(new Map(done.map(d => [d.month, d.fetchedAt])), now, startMonth);
  if (!month) return null;
  try {
    const events = await fetchMonth(month, apiKey);
    if (events.length) {
      await NewsEvent.bulkWrite(events.map(e => ({ updateOne: { filter: { key: e.key }, update: { $set: e }, upsert: true } })), { ordered: false });
    }
    await NewsMonth.updateOne({ month }, { $set: { fetchedAt: new Date(), count: events.length, error: '' } }, { upsert: true });
    status.lastFetch = { month, count: events.length, at: new Date() };
    status.lastError = '';
    console.log(` [NEWS] ${month}: ${events.length} events`);
    return month;
  } catch (err) {
    await NewsMonth.updateOne({ month }, { $set: { error: err.message.slice(0, 300) } }, { upsert: true }).catch(() => {});
    status.lastError = `${month}: ${err.message}`;
    console.warn(` [NEWS] ${month} failed: ${err.message}`);
    throw err;
  }
}

/** Starts the background sync (once the database is connected). */
function startNewsSync() {
  const apiKey = process.env.JBLANKED_API_KEY;
  status.configured = Boolean(apiKey);
  if (!apiKey || status.running) return;
  status.running = true;
  const pace = Math.max(5, Number(process.env.NEWS_SYNC_SECONDS) || 65) * 1000;
  const tick = async () => {
    let wait = pace;
    try {
      const fetched = await syncOnce(apiKey);
      if (!fetched) wait = 15 * MINUTE; // all caught up: check back for the hourly refresh
    } catch (err) {
      // Rate limited: wait out the free tier's window. Bad key or plan: try again much later.
      wait = err.status === 429 ? 6 * MINUTE : err.status === 401 || err.status === 403 ? 60 * MINUTE : 10 * MINUTE;
    }
    setTimeout(tick, wait).unref?.();
  };
  setTimeout(tick, 10 * 1000).unref?.();
}

module.exports = { startNewsSync, syncOnce, fetchMonth, newsStatus: () => ({ ...status }) };
