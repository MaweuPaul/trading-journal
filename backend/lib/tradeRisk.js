// Risk from a stop: the account money a trade stood to lose had its stop been
// hit, worked out from the trade's own price move and P&L. R-multiples
// (realizedRMultiple in tradeMath.js) need this riskUSD; MT5 sends it, but a
// cTrader trade or a stop typed in by hand only gives the stop price.

// A cTrader trade not yet converted by lib/ctraderPnl.js still holds net P&L.
const holdsNetPnl = trade => String(trade?.accountKey || '').startsWith('ctrader:') && trade?.grossPnl !== true;

/** Price P&L before swap and commission. */
function grossPriceProfit(trade) {
  const pnl = Number(trade?.pnlUSD || 0);
  return holdsNetPnl(trade) ? pnl - Number(trade?.swap || 0) - Number(trade?.commission || 0) : pnl;
}

const sideSign = direction => (String(direction).toUpperCase() === 'SELL' ? -1 : 1);

/** A stop only counts as initial risk when it sits on the losing side of the entry. */
function isLossSideStop(direction, entryPrice, stopLoss) {
  const entry = Number(entryPrice), stop = Number(stopLoss);
  if (!(entry > 0) || !(stop > 0)) return false;
  return sideSign(direction) > 0 ? stop < entry : stop > entry;
}

/** Account money per 1.0 of price for this trade's size, from its own move; null for a flat exit. */
function moneyPerPrice(trade) {
  const move = (Number(trade?.exitPrice) - Number(trade?.entryPrice)) * sideSign(trade?.direction);
  if (!Number.isFinite(move) || Math.abs(move) < 1e-12) return null;
  const value = grossPriceProfit(trade) / move;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Per-symbol money per 1.0 of price per lot, from trades that moved, so a
 * trade that closed flat can still be priced from its siblings.
 */
function moneyPerPricePerLotBySymbol(trades) {
  const samples = new Map();
  for (const t of trades) {
    const value = moneyPerPrice(t);
    const lots = Number(t.lotSize);
    if (value == null || !(lots > 0)) continue;
    if (!samples.has(t.symbol)) samples.set(t.symbol, []);
    samples.get(t.symbol).push(value / lots);
  }
  const out = new Map();
  for (const [symbol, list] of samples) {
    list.sort((a, b) => a - b);
    out.set(symbol, list[Math.floor(list.length / 2)]);
  }
  return out;
}

/** Balance just before the trade closed. */
function balanceBefore(trade) {
  const bal = Number(trade?.runningBalance);
  if (!Number.isFinite(bal)) return null;
  const before = bal - (grossPriceProfit(trade) + Number(trade.commission || 0) + Number(trade.swap || 0));
  return before > 0 ? before : null;
}

/**
 * { riskUSD, riskPercent } for `stopLoss` on `trade`, or nulls when the stop
 * is missing, on the wrong side, or the trade can't be priced.
 */
function riskFromStop(trade, stopLoss, { perLotBySymbol } = {}) {
  const none = { riskUSD: null, riskPercent: null };
  if (!isLossSideStop(trade?.direction, trade?.entryPrice, stopLoss)) return none;
  let value = moneyPerPrice(trade);
  if (value == null && perLotBySymbol?.has(trade.symbol) && Number(trade.lotSize) > 0) value = perLotBySymbol.get(trade.symbol) * Number(trade.lotSize);
  if (value == null) return none;
  const riskUSD = Math.round(Math.abs(Number(trade.entryPrice) - Number(stopLoss)) * value * 100) / 100;
  if (!(riskUSD > 0)) return none;
  const before = balanceBefore(trade);
  const riskPercent = before ? Math.round((riskUSD / before) * 100 * 1000) / 1000 : null;
  return { riskUSD, riskPercent };
}

module.exports = { grossPriceProfit, isLossSideStop, moneyPerPrice, moneyPerPricePerLotBySymbol, riskFromStop };
