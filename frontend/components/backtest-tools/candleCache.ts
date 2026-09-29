// Client-side candle cache for backtest charts.
//
// History never changes, so candles fetched once are kept in IndexedDB per
// (symbol, timeframe) together with the list of time ranges already covered.
// A request only goes to the server for the gaps in that coverage; everything
// else is served locally. Ranges that reach into the last few candles before
// "now" are not marked covered, since the newest candle may still be forming.
import type { UTCTimestamp } from 'lightweight-charts';
import type { Candle } from './types';
import { INTERVAL_DAYS } from './types';

type Range = [number, number]; // [fromMs, toMs), sorted, non-overlapping
interface Entry { key: string; ranges: Range[]; candles: Candle[] }

// Renamed when older copies may hold bad history (v2: holes from the old cTrader paging).
const DB_NAME = 'tj-candles-v2';
const STORE = 'series';
const memory = new Map<string, Entry>();

export class ChartFetchError extends Error {
  constructor(message: string, public setup = false) { super(message); }
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  try { indexedDB.deleteDatabase('tj-candles'); } catch { /* the old copy: free the space */ }
  return new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
let dbPromise: Promise<IDBDatabase | null> | null = null;
const db = () => (dbPromise ??= openDb());

async function load(key: string): Promise<Entry> {
  const hit = memory.get(key);
  if (hit) return hit;
  const d = await db();
  const entry = d ? await new Promise<Entry | undefined>(resolve => {
    try {
      const r = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result as Entry | undefined);
      r.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  }) : undefined;
  const e = entry ?? { key, ranges: [], candles: [] };
  memory.set(key, e);
  return e;
}
async function save(e: Entry) {
  memory.set(e.key, e);
  const d = await db(); if (!d) return;
  try { d.transaction(STORE, 'readwrite').objectStore(STORE).put(e); } catch { /* storage full or blocked: memory cache still works */ }
}

/** Parts of [from, to) not yet covered by `ranges`. */
export function missingRanges(ranges: Range[], from: number, to: number): Range[] {
  const gaps: Range[] = [];
  let cursor = from;
  for (const [a, b] of ranges) {
    if (b <= cursor) continue;
    if (a >= to) break;
    if (a > cursor) gaps.push([cursor, Math.min(a, to)]);
    cursor = Math.max(cursor, b);
    if (cursor >= to) break;
  }
  if (cursor < to) gaps.push([cursor, to]);
  return gaps;
}
/** Insert [from, to) and merge touching/overlapping ranges. */
export function addRange(ranges: Range[], from: number, to: number): Range[] {
  const all = [...ranges, [from, to] as Range].sort((x, y) => x[0] - y[0]);
  const out: Range[] = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}
/** Merge two time-sorted candle lists, newer data winning on equal times. */
function mergeCandles(a: Candle[], b: Candle[]): Candle[] {
  const out: Candle[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const ta = i < a.length ? Number(a[i].time) : Infinity, tb = j < b.length ? Number(b[j].time) : Infinity;
    if (ta < tb) out.push(a[i++]);
    else if (tb < ta) out.push(b[j++]);
    else { out.push(b[j++]); i++; }
  }
  return out;
}
/** First index with time >= t (binary search). */
function lowerBound(candles: Candle[], t: number) {
  let lo = 0, hi = candles.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (Number(candles[mid].time) < t) lo = mid + 1; else hi = mid; }
  return lo;
}

async function fetchRange(symbol: string, interval: string, fromMs: number, toMs: number, headers: HeadersInit): Promise<Candle[]> {
  const res = await fetch(`/api/backtest-trades/chart?symbol=${encodeURIComponent(symbol)}&interval=${interval}&fromMs=${Math.floor(fromMs)}&toMs=${Math.floor(toMs)}`, { headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 422) return []; // no candles in this stretch (weekend, holiday)
  if (!res.ok) throw new ChartFetchError(data.error || 'Failed to load chart data', Boolean(data.setup));
  return (data.candles || []).map((c: Candle) => ({ ...c, time: Number(c.time) as UTCTimestamp }));
}

/**
 * Candles for [fromMs, toMs), fetching only what the cache doesn't hold.
 * Gaps are requested in order; each is at most one server call (the server
 * pages cTrader internally).
 */
export async function getCandles(symbol: string, interval: string, fromMs: number, toMs: number, headers: HeadersInit): Promise<Candle[]> {
  const key = `${symbol.toUpperCase()}|${interval}`;
  const entry = await load(key);
  const barMs = (INTERVAL_DAYS[interval] ?? INTERVAL_DAYS['15min']) * 86_400_000;
  // Never treat the still-forming tail as settled history.
  const settledUntil = Date.now() - 2 * barMs;
  let { ranges, candles } = entry;
  for (const [a, b] of missingRanges(ranges, fromMs, toMs)) {
    const fresh = await fetchRange(symbol, interval, a, b, headers);
    candles = mergeCandles(candles, fresh);
    const coveredTo = Math.min(b, settledUntil);
    if (coveredTo > a) ranges = addRange(ranges, a, coveredTo);
  }
  if (candles !== entry.candles || ranges !== entry.ranges) await save({ key, ranges, candles });
  return candles.slice(lowerBound(candles, fromMs / 1000), lowerBound(candles, toMs / 1000));
}
