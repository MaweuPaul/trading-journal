// Economic calendar helpers: turning JBlanked News API rows into stored
// events, which currencies move which symbol, and which month the
// background sync should fetch next.

const HOUR = 60 * 60 * 1000;

/** Minutes New York is ahead of UTC at `utcMs` (-300 in winter, -240 in summer). */
function nyOffsetMinutes(utcMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - utcMs) / 60000);
}

/** A New York wall-clock time (given as if it were UTC) to the real UTC instant. */
function nyWallToUtc(wallMs) {
  let utc = wallMs - nyOffsetMinutes(wallMs) * 60000;
  utc = wallMs - nyOffsetMinutes(utc) * 60000; // settle across a DST change
  return utc;
}

/**
 * JBlanked dates ("2024.02.08 15:30:00") are in broker server time: New York
 * time + 7 hours, so they follow US daylight saving (US CPI at 08:30 New York
 * shows as 15:30). Returns a UTC Date, or null when unreadable.
 */
function parseCalendarDate(value) {
  const m = String(value || '').match(/^(\d{4})[.-](\d{2})[.-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const serverWall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return new Date(nyWallToUtc(serverWall - 7 * HOUR));
}

const IMPACTS = { high: 'High', medium: 'Medium', low: 'Low' };
const cleanValue = v => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** A stored event from one API row, or null when it's missing what the chart needs. */
function normalizeEvent(row, source = 'forex-factory') {
  const time = parseCalendarDate(row?.Date);
  const currency = String(row?.Currency || '').trim().toUpperCase().slice(0, 8);
  const name = String(row?.Name || '').trim().slice(0, 200);
  if (!time || !currency || !name) return null;
  return {
    key: `${source}|${currency}|${name}|${time.toISOString()}`,
    source, currency, name,
    impact: IMPACTS[String(row?.Impact || '').trim().toLowerCase()] || 'None',
    time,
    actual: cleanValue(row?.Actual), forecast: cleanValue(row?.Forecast), previous: cleanValue(row?.Previous),
  };
}

const INDEX_CURRENCY = [
  [/^(US30|DJ30|DOW|NAS100|US100|USTEC|NDX|SPX500|US500|SPX|USOIL|WTI|UKOIL|BRENT|XAU|XAG|GOLD|SILVER|BTC|ETH)/, ['USD']],
  [/^(GER40|DE40|DAX|EU50|STOXX|FRA40)/, ['EUR']],
  [/^(UK100|FTSE)/, ['GBP']],
  [/^(JP225|JPN225|NIKKEI)/, ['JPY']],
  [/^(AUS200|ASX)/, ['AUD']],
];
const FX = new Set(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'CNY']);

/** The currencies whose news moves `symbol`: both sides of an FX pair, USD for US indices and metals. */
function currenciesForSymbol(symbol) {
  const s = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pair = [s.slice(0, 3), s.slice(3, 6)];
  if (s.length >= 6 && FX.has(pair[0]) && FX.has(pair[1])) return pair;
  for (const [pattern, list] of INDEX_CURRENCY) if (pattern.test(s)) return list;
  return ['USD'];
}

const monthKey = date => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
const monthStart = month => Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1, 1);
const nextMonth = month => monthKey(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)));

/** 'YYYY-MM' -> { from, to } as the API's YYYY-MM-DD bounds. */
function monthRange(month) {
  const last = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0));
  return { from: `${month}-01`, to: `${month}-${String(last.getUTCDate()).padStart(2, '0')}` };
}

/**
 * The month to fetch next, or null when everything is current:
 * this month once an hour (actuals come in through the day), last month
 * once more after it ended, then any month since `startMonth` never fetched,
 * oldest first. `fetched` maps 'YYYY-MM' -> Date of its last good fetch.
 */
function nextMonthToFetch(fetched, now = new Date(), startMonth = '2024-01') {
  const current = monthKey(now);
  const at = month => fetched.get(month)?.getTime?.() ?? null;
  if (at(current) == null || now - at(current) > HOUR) return current;
  const previous = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  if (previous >= startMonth && (at(previous) == null || at(previous) < monthStart(current) + 6 * HOUR)) return previous;
  for (let m = startMonth; m < current; m = nextMonth(m)) if (at(m) == null) return m;
  return null;
}

module.exports = { parseCalendarDate, normalizeEvent, currenciesForSymbol, monthRange, nextMonthToFetch, nyOffsetMinutes };
