// Shared types, constants, and small pure helpers for the Backtest chart.
// Freehand drawing tools (trend lines, Fibonacci, channels, etc.) are owned
// by the lightweight-charts-drawing library now -- what's left here is the
// backtest-specific stuff it doesn't know about: candle/trade/measure types
// and chart-setup helpers.
import type { UTCTimestamp } from 'lightweight-charts';

export interface Candle { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume?: number; }

export interface MeasureRange { time1: number; price1: number; time2: number; price2: number; }

export interface OpenTrade {
  direction: 'long' | 'short';
  entryTime: number; entryPrice: number;
  stopLoss: number; takeProfit: number | null;
  riskAmount: number;
}
export interface ClosedTrade extends OpenTrade {
  exitTime: number; exitPrice: number;
  outcome: 'win' | 'loss' | 'breakeven';
  rMultiple: number; pnlUSD: number;
}
export type TradeHandle = 'sl' | 'tp' | 'entry';

export const DRAWING_COLORS = [
  { value: '#3b82f6', label: 'Blue' }, { value: '#10b981', label: 'Green' },
  { value: '#f59e0b', label: 'Amber' }, { value: '#ef4444', label: 'Red' },
  { value: '#8b5cf6', label: 'Purple' }, { value: '#ec4899', label: 'Pink' },
] as const;

export const CHART_INTERVALS = [
  { value: '1min', label: '1m' }, { value: '5min', label: '5m' }, { value: '15min', label: '15m' },
  { value: '1h', label: '1H' }, { value: '4h', label: '4H' }, { value: '1day', label: '1D' },
] as const;
export const SPEEDS = [0.5, 1, 3, 5, 10];

// cTrader returns at most 1500 bars per request, no matter how wide the
// requested date range is. Rather than make the trader pick a timeframe that
// happens to fit their date range, pick the finest one that comfortably does
// -- they can still override it from the dropdown.
const INTERVAL_DAYS: Record<string, number> = {
  '1min': 1 / 1440, '5min': 5 / 1440, '15min': 15 / 1440, '1h': 1 / 24, '4h': 4 / 24, '1day': 1,
};
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
// cTrader returns at most 1500 bars per request and the request also covers
// the lookback bars, so the From..To window itself must stay under this.
const MAX_WINDOW_BARS = 1500 - LOOKBACK_BARS - 50;
/** Longest From..To window (ms) that fits one request at this timeframe (1m: ~22h). */
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
