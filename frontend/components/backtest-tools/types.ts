// Shared types, constants, and small pure helpers for the Backtest chart.
// Freehand drawing tools (trend lines, Fibonacci, channels, etc.) are owned
// by the lightweight-charts-drawing library now -- what's left here is the
// backtest-specific stuff it doesn't know about: candle/trade/measure types
// and chart-setup helpers.
import type { UTCTimestamp } from 'lightweight-charts';

export interface Candle { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume?: number; }

export interface MeasureRange { time1: number; price1: number; time2: number; price2: number; }

/** Part of a position closed early, at `price`: `fraction` of the original size. */
export interface PartialClose { time: number; price: number; fraction: number }
export interface OpenTrade {
  direction: 'long' | 'short';
  entryTime: number; entryPrice: number;
  stopLoss: number; takeProfit: number | null;
  riskAmount: number;
  /** Position size in lots, from the symbol's contract size; null when the symbol spec isn't known. */
  lots?: number | null;
  /** The stop when the trade went live: 1R. Moving the stop later (to break-even, trailing) doesn't change it. */
  initialStop?: number;
  /** Profit taken along the way; what's left runs to the stop, target or a manual close. */
  partials?: PartialClose[];
  /** How the entry fills: at once ('market'), or as a pending order once price reaches it. */
  orderType?: OrderType;
  /** A limit/stop order still waiting for price; entryTime is when it was placed until it fills. */
  pending?: boolean;
  /** Second target: at takeProfit (TP1) tp1Fraction of the position closes, the rest runs to here. */
  takeProfit2?: number | null;
  /** Share of the original position closed at TP1 when there's a TP2 (default 0.5). */
  tp1Fraction?: number;
  /** Move the stop to entry when TP1 is hit. */
  beAtTp1?: boolean;
  /**
   * Spread (price) for this trade. Candles are bid prices: buys -- a long's
   * entry, a short's exits -- happen at the ask, bid + spread.
   */
  spread?: number;
}
/** Spread settings of a backtest: fixed, or random between min and max (drawn once per trade). */
export interface SpreadSettings { mode: 'fixed' | 'random'; fixed: number; min: number; max: number }
export const NO_SPREAD: SpreadSettings = { mode: 'fixed', fixed: 0, min: 0, max: 0 };
export function sampleSpread(s: SpreadSettings): number {
  if (s.mode === 'fixed') return Math.max(0, s.fixed || 0);
  const lo = Math.max(0, Math.min(s.min, s.max)), hi = Math.max(0, s.min, s.max);
  return lo + Math.random() * (hi - lo);
}
export type OrderType = 'market' | 'limit' | 'stop';
export interface ClosedTrade extends OpenTrade {
  exitTime: number; exitPrice: number;
  outcome: 'win' | 'loss' | 'breakeven';
  rMultiple: number; pnlUSD: number;
}
export type TradeHandle = 'sl' | 'tp' | 'tp2' | 'entry';

export const DRAWING_COLORS = [
  { value: '#3b82f6', label: 'Blue' }, { value: '#10b981', label: 'Green' },
  { value: '#f59e0b', label: 'Amber' }, { value: '#ef4444', label: 'Red' },
  { value: '#8b5cf6', label: 'Purple' }, { value: '#ec4899', label: 'Pink' },
] as const;

export const CHART_INTERVALS = [
  { value: '1min', label: '1m' }, { value: '5min', label: '5m' }, { value: '15min', label: '15m' },
  { value: '1h', label: '1H' }, { value: '4h', label: '4H' }, { value: '1day', label: '1D' },
  { value: '1week', label: '1W' }, { value: '1month', label: '1M' },
] as const;
export const SPEEDS = [0.5, 1, 3, 5, 10];

// Suggest the finest timeframe that keeps the replay a sensible length
// (~1200 candles to step through); the trader can pick a finer one, up to the
// MAX_CHART_BARS cap below.
export const INTERVAL_DAYS: Record<string, number> = {
  '1min': 1 / 1440, '5min': 5 / 1440, '15min': 15 / 1440, '1h': 1 / 24, '4h': 4 / 24, '1day': 1, '1week': 7,
  '1month': 30, // approximate: use candleEndMs for when a month actually closes
};
/**
 * When a candle opening at `timeSec` closes (ms). Months run 28-31 days, so
 * a monthly candle ends where the next month's opens (broker months open a
 * few hours off UTC midnight; the same offset carries over).
 */
export function candleEndMs(timeSec: number, interval: string): number {
  const open = timeSec * 1000;
  if (interval !== '1month') return open + (INTERVAL_DAYS[interval] ?? INTERVAL_DAYS['15min']) * 86400000;
  const mid = new Date(open + 10 * 86400000);
  const monthStart = Date.UTC(mid.getUTCFullYear(), mid.getUTCMonth(), 1);
  return Date.UTC(mid.getUTCFullYear(), mid.getUTCMonth() + 1, 1) + (open - monthStart);
}
export function suggestInterval(fromDate: string, toDate: string): string {
  const days = (new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86400000;
  const SAFE_BARS = 1200;
  for (const { value } of CHART_INTERVALS) {
    if (days / INTERVAL_DAYS[value] <= SAFE_BARS) return value;
  }
  return '1day';
}

// How far back (in ms) to fetch before the chosen "From" date, so the chart
// opens already showing the lead-up to the setup instead of cutting off
// abruptly right at the date you picked.
export const LOOKBACK_BARS = 100;
// The backend pages through cTrader (1500 bars per request) up to
// MAX_CHART_BARS per chart -- keep in sync with backend/routes/backtestTrades.js.
// The request also covers the lookback bars, so the From..To window itself
// must stay under this.
const MAX_CHART_BARS = 20000;
const MAX_WINDOW_BARS = MAX_CHART_BARS - LOOKBACK_BARS - 50;
/** Longest From..To window (ms) that fits one chart at this timeframe (1m: ~13.8 days). */
export function maxRangeMs(interval: string): number {
  return MAX_WINDOW_BARS * (INTERVAL_DAYS[interval] ?? INTERVAL_DAYS['15min']) * 86400000;
}
export function lookbackMs(fromMs: number, interval: string): number {
  return fromMs - LOOKBACK_BARS * (INTERVAL_DAYS[interval] ?? INTERVAL_DAYS['15min']) * 86400000;
}

export function isoDaysAgo(days: number) {
  const d = new Date(); d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
export function fmtPrice(n: number) { return n.toFixed(n >= 100 ? 2 : 5); }
export function nearestCandleIndex(candles: Candle[], time: number) {
  let lo = 0, hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < time) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Contract facts from the broker (GET /api/backtest-trades/symbol-spec). */
export interface SymbolSpec {
  symbol: string;
  contractSize: number;
  minLots: number;
  maxLots: number | null;
  lotStep: number;
  quoteCurrency: string | null;
  usdPerQuote: number | null;
  /** USD per 1.00 lot for a 1.0 price move; null when the quote currency couldn't be converted. */
  usdPerPointPerLot: number | null;
}
export type SizingMode = 'risk' | 'lots';
