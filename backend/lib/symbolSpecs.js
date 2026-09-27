// Position sizing facts for a symbol: contract size and volume limits from
// the owner's cTrader account, plus how many USD one unit of its quote
// currency was worth at a given moment. With these, a stop distance becomes
// lots and a real dollar risk:  USD per lot = distance x contractSize x usdPerQuote.
const { getSymbolSpec, getTrendbars } = require('./ctraderReplay');

const SPEC_TTL_MS = 6 * 60 * 60 * 1000;
const specCache = new Map();  // userId|symbol -> { at, spec }
const rateCache = new Map();  // userId|CCY|hour -> number

async function cachedSpec(userId, symbol) {
  const key = `${userId}|${String(symbol).toUpperCase()}`;
  const hit = specCache.get(key);
  if (hit && Date.now() - hit.at < SPEC_TTL_MS) return hit.spec;
  const spec = await getSymbolSpec({ userId, symbol });
  specCache.set(key, { at: Date.now(), spec });
  return spec;
}

/** Last hourly close at or before atMs, or null. */
async function closeAt(userId, symbol, atMs) {
  try {
    const { candles } = await getTrendbars({ userId, symbol, periodLabel: '1h', fromMs: atMs - 5 * 86400_000, toMs: atMs });
    const c = (candles || []).filter(k => k.time * 1000 <= atMs).pop();
    return c ? Number(c.close) : null;
  } catch {
    return null;
  }
}

/** USD value of 1 unit of `ccy` at atMs (via CCYUSD or USDCCY on the same account). */
async function usdPer(userId, ccy, atMs) {
  if (!ccy || ccy === 'USD') return 1;
  const hour = Math.floor(atMs / 3600_000);
  const key = `${userId}|${ccy}|${hour}`;
  if (rateCache.has(key)) return rateCache.get(key);
  let rate = null;
  const direct = await closeAt(userId, `${ccy}USD`, atMs);
  if (direct) rate = direct;
  else {
    const inverse = await closeAt(userId, `USD${ccy}`, atMs);
    if (inverse) rate = 1 / inverse;
  }
  if (rate != null) rateCache.set(key, rate);
  return rate;
}

async function specWithUsd(userId, symbol, atMs = Date.now()) {
  const spec = await cachedSpec(userId, symbol);
  const usdPerQuote = await usdPer(userId, spec.quoteCurrency, atMs);
  return {
    ...spec,
    usdPerQuote,
    // USD gained or lost per 1.00 lot for a 1.0 move in price.
    usdPerPointPerLot: usdPerQuote == null ? null : spec.contractSize * usdPerQuote,
  };
}

module.exports = { specWithUsd };
