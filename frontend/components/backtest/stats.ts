import { BacktestTrade, tagsOf } from './data';
import { confidenceFor, type Confidence } from '../confidenceMath';

export interface GroupStats { key: string; trades: number; winRate: number; avgR: number; totalR: number; confidence: Confidence }
export interface CurvePoint { index: number; cumulativeR: number; drawdownR: number; benchmarkR: number; trade: BacktestTrade }

/** Seconds since epoch for when a trade happened (quick logs only have createdAt). */
function tradeTime(t: BacktestTrade, edge: 'entry' | 'exit') {
  const v = edge === 'entry' ? t.entryTime : t.exitTime;
  return Number.isFinite(v) ? Number(v) : new Date(t.createdAt).getTime() / 1000;
}

/** R the same move would have made as a plain long ("buy & hold" over the trade's window). */
function longOnlyR(t: BacktestTrade) {
  if (t.entryPrice == null || t.exitPrice == null || t.stopLoss == null) return 0;
  const risk = Math.abs(t.entryPrice - t.stopLoss);
  return risk > 0 ? (t.exitPrice - t.entryPrice) / risk : 0;
}

function groupBy(trades: BacktestTrade[], keysOf: (t: BacktestTrade) => string[]): GroupStats[] {
  const map = new Map<string, { trades: number; wins: number; totalR: number; rs: number[] }>();
  for (const t of trades) {
    for (const key of keysOf(t)) {
      const e = map.get(key) || { trades: 0, wins: 0, totalR: 0, rs: [] };
      e.trades += 1; if (t.outcome === 'win') e.wins += 1; e.totalR += t.rMultiple; e.rs.push(t.rMultiple);
      map.set(key, e);
    }
  }
  return Array.from(map.entries())
    .map(([key, v]) => ({ key, trades: v.trades, winRate: (v.wins / v.trades) * 100, avgR: v.totalR / v.trades, totalR: v.totalR, confidence: confidenceFor(v.trades, v.wins, v.rs) }))
    .sort((a, b) => b.totalR - a.totalR);
}

/**
 * backtesting.py-style quant stats, adapted to R-multiples. Every backtest
 * trade has an R; riskAmount/pnlUSD are optional. Sharpe/Sortino/Calmar/SQN
 * are the R-based equivalents (there's no daily equity series, only discrete
 * trades), annualized by trades per year of market time the log spans.
 */
export function computeStats(input: BacktestTrade[]) {
  const trades = [...input].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const n = trades.length;
  let cumulativeR = 0, peakR = 0, maxDrawdownR = 0, maxDrawdownIndex = -1, benchmarkR = 0;
  let winStreak = 0, lossStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
  const curve: CurvePoint[] = [];

  trades.forEach((t, i) => {
    cumulativeR += t.rMultiple;
    benchmarkR += longOnlyR(t);
    peakR = Math.max(peakR, cumulativeR);
    const drawdownR = cumulativeR - peakR;
    if (drawdownR < maxDrawdownR) { maxDrawdownR = drawdownR; maxDrawdownIndex = i; }
    if (t.outcome === 'win') { winStreak += 1; lossStreak = 0; }
    else if (t.outcome === 'loss') { lossStreak += 1; winStreak = 0; }
    else { winStreak = 0; lossStreak = 0; }
    maxWinStreak = Math.max(maxWinStreak, winStreak);
    maxLossStreak = Math.max(maxLossStreak, lossStreak);
    curve.push({ index: i, cumulativeR, drawdownR, benchmarkR, trade: t });
  });

  const wins = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');
  const sum = (arr: BacktestTrade[], f: (t: BacktestTrade) => number) => arr.reduce((s, t) => s + f(t), 0);
  const winRate = n ? (wins.length / n) * 100 : 0;
  const avgR = n ? cumulativeR / n : 0;
  const avgWinR = wins.length ? sum(wins, t => t.rMultiple) / wins.length : 0;
  const avgLossR = losses.length ? sum(losses, t => t.rMultiple) / losses.length : 0;
  const avgWinUSD = wins.length ? sum(wins, t => t.pnlUSD) / wins.length : 0;
  const avgLossUSD = losses.length ? sum(losses, t => t.pnlUSD) / losses.length : 0;
  const grossWinR = sum(wins, t => t.rMultiple);
  const grossLossR = Math.abs(sum(losses, t => t.rMultiple));
  const profitFactor = grossLossR > 0 ? grossWinR / grossLossR : grossWinR > 0 ? Infinity : 0;
  const best = n ? trades.reduce((a, b) => (b.rMultiple > a.rMultiple ? b : a)) : null;
  const worst = n ? trades.reduce((a, b) => (b.rMultiple < a.rMultiple ? b : a)) : null;
  const totalPnl = sum(trades, t => t.pnlUSD);

  let sharpe = 0, sortino = 0, calmar = 0, sqn = 0, kellyPct = 0, annualizedR = 0, volatilityR = 0;
  if (n > 0) {
    const stdR = Math.sqrt(sum(trades, t => (t.rMultiple - avgR) ** 2) / n);
    const downsideStd = Math.sqrt(sum(trades, t => (t.rMultiple < 0 ? t.rMultiple ** 2 : 0)) / n);
    const spanYears = Math.max(
      (Math.max(...trades.map(t => tradeTime(t, 'exit'))) - Math.min(...trades.map(t => tradeTime(t, 'entry')))) / (365.25 * 86400),
      1 / 365.25,
    );
    const tradesPerYear = n / spanYears;
    sharpe = stdR > 0 ? (avgR / stdR) * Math.sqrt(tradesPerYear) : 0;
    sortino = downsideStd > 0 ? (avgR / downsideStd) * Math.sqrt(tradesPerYear) : 0;
    sqn = stdR > 0 ? Math.sqrt(n) * (avgR / stdR) : 0;
    annualizedR = cumulativeR / spanYears;
    volatilityR = stdR;
    calmar = maxDrawdownR < 0 ? annualizedR / Math.abs(maxDrawdownR) : annualizedR > 0 ? Infinity : 0;
    const payoff = avgLossR < 0 ? avgWinR / Math.abs(avgLossR) : 0;
    const w = winRate / 100;
    kellyPct = payoff > 0 ? (w - (1 - w) / payoff) * 100 : 0;
  }

  return {
    // Sample-size level plus 95% ranges for win rate and average R (avgRange is in R here).
    confidence: confidenceFor(n, wins.length, trades.map(t => t.rMultiple)),
    n, curve, winRate, wins: wins.length, losses: losses.length,
    avgR, avgWinR, avgLossR, avgWinUSD, avgLossUSD, profitFactor, best, worst,
    totalR: cumulativeR, peakR, totalPnl, maxDrawdownR, maxDrawdownIndex, benchmarkR,
    maxWinStreak, maxLossStreak, sharpe, sortino, calmar, sqn, kellyPct, annualizedR, volatilityR,
    byStrategy: groupBy(trades, t => { const tags = tagsOf(t); return tags.length ? tags : ['Unclassified']; }),
    bySymbol: groupBy(trades, t => [t.symbol]),
    byTimeframe: groupBy(trades, t => [t.interval || 'Unspecified']),
    byDirection: groupBy(trades, t => [t.direction]),
  };
}
export type BacktestStats = ReturnType<typeof computeStats>;

/** Van Tharp's SQN bands. */
export function sqnGrade(sqn: number) {
  if (sqn >= 7) return { badge: 'Holy Grail', caption: 'Holy Grail Grade' };
  if (sqn >= 5.1) return { badge: 'Superb', caption: 'Superb system' };
  if (sqn >= 3) return { badge: 'Excellent', caption: 'Excellent system' };
  if (sqn >= 2.5) return { badge: 'Good', caption: 'Good system' };
  if (sqn >= 1.6) return { badge: 'Average', caption: 'Average system' };
  return { badge: 'Poor', caption: 'Hard to trade' };
}
export function profitFactorGrade(pf: number) {
  if (pf >= 2) return 'Good';
  if (pf >= 1.5) return 'Solid';
  if (pf >= 1) return 'Thin';
  return 'Losing';
}
