// Importing the economic calendar exported from MT5 (NewsExport.mq5).
// MT5 stamps events in the broker's server time, and brokers differ: most
// run New York + 7h, some follow European summer time, some sit on a fixed
// offset. So the clock is worked out from the file itself: US jobless claims,
// payrolls and CPI are always released at 08:30 New York, and the model that
// puts every one of them there is the broker's clock.

const { zoneOffsetMinutes, wallToUtc } = require('./newsCalendar');

const MINUTE = 60 * 1000;
const utcToWall = (utcMs, timeZone) => utcMs + zoneOffsetMinutes(utcMs, timeZone) * MINUTE;

/** "2024.07.05 15:30" (or with seconds / dashes) as a wall-clock ms value, or null. */
function parseWall(value) {
  const m = String(value || '').trim().match(/^(\d{4})[.-](\d{2})[.-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
}

/** Splits one CSV line, honouring "quoted, fields" and "" escapes. */
function splitCsvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const IMPACT = { HIGH: 'High', MODERATE: 'Medium', MEDIUM: 'Medium', LOW: 'Low' };
const value = v => (v === undefined || v === '' ? null : (Number.isFinite(Number(v)) && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v));

/** Rows from the export: { wall, currency, impact, name, actual, forecast, previous }. */
function parseExport(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw Object.assign(new Error('The file is empty.'), { status: 400 });
  const header = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const col = name => header.indexOf(name);
  const need = ['time', 'currency', 'importance', 'name'];
  if (need.some(n => col(n) < 0)) {
    throw Object.assign(new Error('This isn\'t a calendar export from NewsExport.mq5 (expected columns time, currency, importance, name).'), { status: 400 });
  }
  const rows = [];
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const wall = parseWall(f[col('time')]);
    const currency = String(f[col('currency')] || '').toUpperCase().slice(0, 8);
    const name = String(f[col('name')] || '').slice(0, 200);
    if (wall == null || !currency || !name) continue;
    rows.push({
      wall, currency, name,
      impact: IMPACT[String(f[col('importance')] || '').toUpperCase()] || 'None',
      actual: col('actual') >= 0 ? value(f[col('actual')]) : null,
      forecast: col('forecast') >= 0 ? value(f[col('forecast')]) : null,
      previous: col('previous') >= 0 ? value(f[col('previous')]) : null,
    });
  }
  return rows;
}

// US releases that are always at 08:30 New York.
const ANCHOR = /^(initial jobless claims|nonfarm payrolls|non-farm payrolls|cpi m\/m|core cpi m\/m)$/i;
const MODELS = ['America/New_York', 'Europe/London', 'UTC'];

/**
 * The broker clock as { timeZone, shiftMinutes }: server time = wall clock
 * in `timeZone` + shift. Found from the anchor releases; throws when they
 * don't agree on any model (or there are too few to tell).
 */
function detectServerClock(rows) {
  const anchors = rows.filter(r => r.currency === 'USD' && ANCHOR.test(r.name));
  if (anchors.length < 3) {
    throw Object.assign(new Error('The export needs US jobless claims, payrolls or CPI to work out the broker\'s clock; include USD high/medium events.'), { status: 400 });
  }
  for (const timeZone of MODELS) {
    const shifts = anchors.map(r => {
      const d = new Date(r.wall);
      const trueUtc = wallToUtc(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 30), 'America/New_York');
      return Math.round((r.wall - utcToWall(trueUtc, timeZone)) / MINUTE);
    });
    // Allow a stray: a release moved for one day doesn't decide the clock.
    const counts = new Map();
    for (const s of shifts) counts.set(s, (counts.get(s) || 0) + 1);
    const [shift, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n >= anchors.length * 0.95) return { timeZone, shiftMinutes: shift };
  }
  throw Object.assign(new Error('Couldn\'t work out the broker\'s clock from the US releases in this file.'), { status: 400 });
}

/** Stored events from an export, with the clock it was read with. High and medium impact only. */
function eventsFromExport(text) {
  const rows = parseExport(text);
  const clock = detectServerClock(rows);
  const events = rows
    .filter(r => r.impact === 'High' || r.impact === 'Medium')
    .map(r => {
      const time = new Date(wallToUtc(r.wall - clock.shiftMinutes * MINUTE, clock.timeZone));
      return {
        key: `mql5|${r.currency}|${r.name}|${time.toISOString()}`,
        source: 'mql5', currency: r.currency, name: r.name, impact: r.impact, time,
        actual: r.actual, forecast: r.forecast, previous: r.previous,
      };
    });
  return { events, clock, rows: rows.length };
}

module.exports = { parseExport, detectServerClock, eventsFromExport, splitCsvLine };
