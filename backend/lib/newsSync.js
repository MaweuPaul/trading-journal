// Keeps the economic calendar (NewsEvent) current from the JBlanked News
// API's free "this week" Forex Factory calendar: fetched every hour, so new
// weeks and each release's actual number come in by themselves. History
// before the server started fetching comes from a one-time MT5 export
// (lib/newsImport.js). Runs only when JBLANKED_API_KEY is set.

const NewsEvent = require('../models/NewsEvent');
const { normalizeEvent } = require('./newsCalendar');

const API = 'https://www.jblanked.com/news/api';
const SOURCE = 'forex-factory';
const MINUTE = 60 * 1000;
const status = { configured: false, running: false, lastFetch: null, lastError: '' };

async function fetchWeek(apiKey) {
  const res = await fetch(`${API}/${SOURCE}/calendar/week/`, {
    headers: { 'Authorization': `Api-Key ${apiKey}`, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`News API ${res.status}: ${body?.message || body?.detail || body?.error || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.results) ? body.results : null;
  if (!rows) throw new Error('News API returned an unexpected response');
  return rows.map(row => normalizeEvent(row, SOURCE)).filter(Boolean);
}

async function syncOnce(apiKey) {
  try {
    const events = await fetchWeek(apiKey);
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
  const apiKey = process.env.JBLANKED_API_KEY;
  status.configured = Boolean(apiKey);
  if (!apiKey || status.running) return;
  status.running = true;
  const tick = async () => {
    let wait = 60 * MINUTE;
    try { await syncOnce(apiKey); } catch (err) { if (err.status === 429) wait = 10 * MINUTE; }
    setTimeout(tick, wait).unref?.();
  };
  setTimeout(tick, 10 * 1000).unref?.();
}

module.exports = { startNewsSync, syncOnce, fetchWeek, newsStatus: () => ({ ...status }) };
