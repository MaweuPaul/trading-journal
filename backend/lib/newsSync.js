// Keeps the economic calendar (NewsEvent) current from Forex Factory's own
// public weekly calendar feed (the JSON their site widgets use; no key
// needed), fetched every hour. It has forecast and previous but no actual
// numbers. History before the server started fetching comes from a one-time
// MT5 export (lib/newsImport.js), which does have actuals.

const NewsEvent = require('../models/NewsEvent');

const FEED = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const SOURCE = 'forex-factory';
const MINUTE = 60 * 1000;
const status = { configured: true, running: false, lastFetch: null, lastError: '' };
const IMPACTS = { high: 'High', medium: 'Medium', low: 'Low' };
const clean = v => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

/** A stored event from one feed row ({ title, country, date, impact, forecast, previous }), or null. */
function eventFromFeed(row) {
  const time = new Date(String(row?.date || ''));
  const currency = String(row?.country || '').trim().toUpperCase().slice(0, 8);
  const name = String(row?.title || '').trim().slice(0, 200);
  if (!Number.isFinite(time.getTime()) || !/^[A-Z]{3}$/.test(currency) || currency === 'ALL' || !name) return null;
  return {
    key: `${SOURCE}|${currency}|${name}|${time.toISOString()}`,
    source: SOURCE, currency, name,
    impact: IMPACTS[String(row?.impact || '').trim().toLowerCase()] || 'None',
    time, forecast: clean(row?.forecast), previous: clean(row?.previous),
  };
}

async function fetchWeek() {
  const res = await fetch(FEED, { headers: { 'User-Agent': 'TradeJournal news sync (hourly)' } });
  if (!res.ok) {
    const err = new Error(`Forex Factory calendar feed ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const rows = await res.json().catch(() => null);
  if (!Array.isArray(rows)) throw new Error('Forex Factory calendar feed returned an unexpected response');
  return rows.map(eventFromFeed).filter(Boolean);
}

async function syncOnce() {
  try {
    const events = await fetchWeek();
    if (events.length) {
      await NewsEvent.bulkWrite(events.map(e => ({ updateOne: { filter: { key: e.key }, update: { $set: e }, upsert: true } })), { ordered: false });
    }
    status.lastFetch = { count: events.length, at: new Date() };
    status.lastError = '';
    console.log(` [NEWS] This week: ${events.length} events`);
  } catch (err) {
    status.lastError = err.message;
    console.warn(` [NEWS] This week failed: ${err.message}`);
    throw err;
  }
}

/** Starts the hourly fetch (once the database is connected). */
function startNewsSync() {
  if (status.running) return;
  status.running = true;
  const tick = async () => {
    let wait = 60 * MINUTE;
    try { await syncOnce(); } catch (err) { if (err.status === 429) wait = 2 * 60 * MINUTE; }
    setTimeout(tick, wait).unref?.();
  };
  setTimeout(tick, 10 * 1000).unref?.();
}

module.exports = { startNewsSync, syncOnce, fetchWeek, eventFromFeed, newsStatus: () => ({ ...status }) };
