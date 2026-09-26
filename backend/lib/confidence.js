// How much to trust a statistic, given how many trades it rests on.
//
// A 75% win rate over 4 trades and 58% over 300 look alike as bare numbers,
// but the first could easily be a coin flip. Every stats response attaches a
// `confidence` object next to its numbers so the UI can show a sample-size
// level and a 95% range ("likely between ...") instead of a lone figure.
//
// Keep in sync with frontend/components/confidence.ts (same maths for the
// Backtest pages, which compute their stats in the browser).

// Minimum trades for each level. One scale, used everywhere.
const LEVELS = [
  { level: 'reliable', min: 100 },
  { level: 'developing', min: 30 },
  { level: 'early', min: 10 },
  { level: 'insufficient', min: 0 },
];
function sampleLevel(n) {
  return LEVELS.find(l => n >= l.min).level;
}

const Z95 = 1.959964;
// Two-sided 95% Student-t critical values for 1..30 degrees of freedom.
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131,
  2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
const tCritical = df => (df >= 1 && df <= 30 ? T95[df - 1] : Z95);

/** Wilson score interval for a proportion, as percentages [low, high]; null without trades. */
function winRateRange(wins, n) {
  if (!n) return null;
  const p = wins / n;
  const z2 = Z95 * Z95;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z95 / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [round(Math.max(0, centre - half) * 100, 1), round(Math.min(1, centre + half) * 100, 1)];
}

/** 95% t-interval for the mean of per-trade values (P&L or R); null below 2 values. */
function meanRange(values) {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  const half = tCritical(n - 1) * (sd / Math.sqrt(n));
  return [round(mean - half, 4), round(mean + half, 4)];
}

function round(v, digits) {
  return Number(v.toFixed(digits)) || 0;
}

/**
 * The confidence object attached to stats.
 * @param {number} n       trades behind the numbers
 * @param {number} wins    winning trades (for the win-rate range)
 * @param {number[]} [values]  per-trade results for the average's range (P&L, or R)
 * @param {number[]} [rValues] per-trade R multiples, when only some trades have one
 */
function confidenceFor(n, wins, values = [], rValues = null) {
  return {
    n,
    level: sampleLevel(n),
    winRateRange: winRateRange(wins, n),
    avgRange: meanRange(values),
    ...(rValues ? { avgRRange: meanRange(rValues), rTrades: rValues.length } : {}),
  };
}

module.exports = { sampleLevel, winRateRange, meanRange, confidenceFor, LEVELS };
