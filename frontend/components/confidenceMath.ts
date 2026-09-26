// How much to trust a statistic, given how many trades it rests on. Same
// maths and scale as backend/lib/confidence.js (which attaches this to the
// /api/stats, /api/performance and /api/coach responses); the Backtest pages
// compute their stats in the browser, so they use this copy.

export type SampleLevel = 'insufficient' | 'early' | 'developing' | 'reliable';
export interface Confidence {
  n: number;
  level: SampleLevel;
  /** 95% range for the win rate, in percent. */
  winRateRange: [number, number] | null;
  /** 95% range for the average per-trade result (P&L, or R on the Backtest pages). */
  avgRange: [number, number] | null;
  /** 95% range for average R, over the trades that have one. */
  avgRRange?: [number, number] | null;
  rTrades?: number;
}

export function sampleLevel(n: number): SampleLevel {
  return n >= 100 ? 'reliable' : n >= 30 ? 'developing' : n >= 10 ? 'early' : 'insufficient';
}

const Z95 = 1.959964;
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131,
  2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
const tCritical = (df: number) => (df >= 1 && df <= 30 ? T95[df - 1] : Z95);
const round = (v: number, d: number) => Number(v.toFixed(d)) || 0;

/** Wilson score interval, as percentages. */
export function winRateRange(wins: number, n: number): [number, number] | null {
  if (!n) return null;
  const p = wins / n, z2 = Z95 * Z95;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z95 / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [round(Math.max(0, centre - half) * 100, 1), round(Math.min(1, centre + half) * 100, 1)];
}

/** 95% Student-t interval for a mean. */
export function meanRange(values: number[]): [number, number] | null {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  const half = tCritical(n - 1) * (sd / Math.sqrt(n));
  return [round(mean - half, 4), round(mean + half, 4)];
}

export function confidenceFor(n: number, wins: number, values: number[] = []): Confidence {
  return { n, level: sampleLevel(n), winRateRange: winRateRange(wins, n), avgRange: meanRange(values) };
}
