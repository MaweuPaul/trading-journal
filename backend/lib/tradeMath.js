// Pure trade-analytics math, extracted out of routes/trades.js so the
// formulas behind /stats and /coach can be unit tested with hand-computed
// fixtures instead of only being exercised implicitly through the live app.
// BUG-2 (an algebraically-dead "missed profit" formula that always returned
// $0.00) shipped and went unnoticed for a long time specifically because none
// of this math had test coverage — see backend/test/tradeMath.test.js.

// pnlUSD alone is only the trade's raw price P&L. commission and swap are
// real money the broker took, so win/loss classification and every P&L total
// need to include them or the journal disagrees with the actual account balance.
function netTradeAmount(trade) {
  return Number(trade?.pnlUSD || 0) + Number(trade?.commission || 0) + Number(trade?.swap || 0);
}

// Win/loss counts, profit factor, expectancy, and related summary stats for
// a set of trades. All classification and sums use netTradeAmount (not raw
// pnlUSD) so results agree with the account's actual running balance.
function summarizeTradeResults(trades) {
  if (!trades.length) {
    return {
      wins: [], losses: [], grossProfit: 0, grossLoss: 0, netPnL: 0, grossPnL: 0,
      winRate: 0, profitFactor: 0, avgWinUSD: 0, avgLossUSD: 0, winLossRatio: 0,
      expectancyUSD: 0, biggestWin: 0, biggestLoss: 0,
    };
  }

  const wins = trades.filter(t => netTradeAmount(t) > 0);
  const losses = trades.filter(t => netTradeAmount(t) < 0);
  const grossProfit = wins.reduce((s, t) => s + netTradeAmount(t), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + netTradeAmount(t), 0));
  const netPnL = trades.reduce((s, t) => s + netTradeAmount(t), 0);
  const grossPnL = trades.reduce((s, t) => s + Number(t.pnlUSD || 0), 0);

  const winRate = (wins.length / trades.length) * 100;
  const lossRate = 100 - winRate;
  const avgWinUSD = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLossUSD = losses.length > 0 ? grossLoss / losses.length : 0;
  // 999 is a "nothing to divide by" sentinel — JSON has no Infinity, and
  // Infinity serializes as null (indistinguishable from a genuine data gap).
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
  const winLossRatio = avgLossUSD > 0 ? avgWinUSD / avgLossUSD : avgWinUSD > 0 ? 999 : 0;
  const expectancyUSD = (winRate / 100 * avgWinUSD) - (lossRate / 100 * avgLossUSD);
  const biggestWin = wins.length > 0 ? Math.max(...wins.map(netTradeAmount)) : 0;
  const biggestLoss = losses.length > 0 ? Math.min(...losses.map(netTradeAmount)) : 0;

  return { wins, losses, grossProfit, grossLoss, netPnL, grossPnL, winRate, profitFactor, avgWinUSD, avgLossUSD, winLossRatio, expectancyUSD, biggestWin, biggestLoss };
}

// Peak-to-trough drawdown on runningBalance. Trades must already be sorted
// chronologically and scoped to a single broker account — runningBalance is
// per-account, so mixing accounts produces a meaningless sawtooth curve.
function calculateDrawdown(trades) {
  let peak = -Infinity;
  let maxDrawdownPct = 0;
  const equityCurve = [];
  for (const t of trades) {
    const bal = Number(t.runningBalance || 0);
    if (bal > peak) peak = bal;
    const dd = peak > 0 ? ((peak - bal) / peak) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    equityCurve.push({ date: t.closeTime, balance: bal, pnl: netTradeAmount(t) });
  }
  const lastBalance = trades[trades.length - 1]?.runningBalance || 0;
  const currentDrawdown = peak > 0 ? ((peak - lastBalance) / peak) * 100 : 0;
  return { equityCurve, maxDrawdownPct, currentDrawdown };
}

// Realized R-multiple for a trade, using the actual stop-based risk MT5 had
// on the order at entry (riskUSD). Returns null when there's no real risk
// data instead of estimating one from pnlPct, which is what produced BUG-2:
// actualRR = pnlPct / (|pnlPct| / plannedRR) algebraically simplifies to
// plannedRR for every winning trade, making "missed profit" always $0.00.
function realizedRMultiple(trade) {
  const riskUSD = Number(trade?.riskUSD);
  if (!Number.isFinite(riskUSD) || riskUSD <= 0) return null;
  return Number(trade?.pnlUSD || 0) / riskUSD;
}

// How much R (and estimated $) was left on the table on trades that closed
// early (plannedRR set, exit wasn't a clean TP/SL). Only trades with real
// risk data (see realizedRMultiple) contribute to the totals; others are
// still listed but flagged so the UI doesn't imply a number that isn't real.
function calculateMissedProfit(trades) {
  const earlyExitTrades = trades.filter(t =>
    t.plannedRR != null &&
    t.exitReason &&
    !['TP', 'SL', ''].includes(t.exitReason)
  );

  let totalMissedRR = 0;
  let estimatedMissedUSD = 0;
  let earlyExitsWithRiskData = 0;

  const earlyExitDetails = earlyExitTrades.map(t => {
    const actualRR = realizedRMultiple(t);
    const hasRiskData = actualRR !== null;
    const missedRR = hasRiskData ? Math.max(0, t.plannedRR - actualRR) : null;
    const missedUSD = hasRiskData ? missedRR * Number(t.riskUSD) : null;
    if (hasRiskData) {
      earlyExitsWithRiskData++;
      totalMissedRR += missedRR;
      estimatedMissedUSD += missedUSD;
    }
    return {
      _id: String(t._id), symbol: t.symbol, direction: t.direction, closeTime: t.closeTime,
      pnlUSD: t.pnlUSD, plannedRR: t.plannedRR, exitReason: t.exitReason,
      actualRR: actualRR === null ? null : parseFloat(actualRR.toFixed(2)),
      hasRiskData,
      missedRR: missedRR === null ? null : parseFloat(missedRR.toFixed(2)),
      estimatedMissedUSD: missedUSD === null ? null : parseFloat(missedUSD.toFixed(2)),
    };
  });

  return {
    count: earlyExitDetails.length,
    withRiskData: earlyExitsWithRiskData,
    totalMissedRR: parseFloat(totalMissedRR.toFixed(2)),
    estimatedMissedUSD: parseFloat(estimatedMissedUSD.toFixed(2)),
    trades: earlyExitDetails,
  };
}

// Average realized R across a set of trades — the metric a $-based Sharpe
// ratio on per-trade P&L is usually standing in for, badly. Only trades with
// real stop-based risk (riskUSD, from sync.py) contribute; trades without it
// are counted but excluded from the average rather than silently treated as
// 0R, which would understate real performance.
function summarizeRMultiples(trades) {
  const withRisk = [];
  for (const t of trades) {
    const r = realizedRMultiple(t);
    if (r !== null) withRisk.push(r);
  }
  const wins = withRisk.filter(r => r > 0);
  const losses = withRisk.filter(r => r < 0);
  const avg = arr => arr.length > 0 ? arr.reduce((s, r) => s + r, 0) / arr.length : null;

  return {
    totalTrades: trades.length,
    tradesWithRiskData: withRisk.length,
    avgR: avg(withRisk),
    avgWinR: avg(wins),
    avgLossR: avg(losses),
  };
}

module.exports = {
  netTradeAmount,
  summarizeTradeResults,
  calculateDrawdown,
  realizedRMultiple,
  calculateMissedProfit,
  summarizeRMultiples,
};
