// One-time fix for cTrader trades synced before October 2026: their pnlUSD
// held the net result (after commission and swap) while commission and swap
// were also stored, so every stat (which adds those to pnlUSD, as for MT5)
// took them off twice. This turns pnlUSD back into the price profit and
// pnlPct into that profit over the balance before the trade, like MT5.
// Converted trades are marked grossPnl: true, so it runs once per trade.
const Trade = require('../models/Trade');

/** The gross pnlUSD and pnlPct for a trade that holds net P&L. */
function grossFromNet(trade) {
  const net = Number(trade.pnlUSD || 0);
  const pnlUSD = Math.round((net - Number(trade.commission || 0) - Number(trade.swap || 0)) * 100) / 100;
  const before = Number(trade.runningBalance || 0) - net;
  const pnlPct = before > 0 ? (pnlUSD / before) * 100 : 0;
  return { pnlUSD, pnlPct };
}

/** Convert every unconverted cTrader trade (optionally one user's). Returns how many changed. */
async function convertCTraderPnlToGross({ userId } = {}) {
  const filter = { accountKey: /^ctrader:/, grossPnl: { $ne: true } };
  if (userId) filter.user = userId;
  const trades = await Trade.find(filter).select('_id pnlUSD commission swap runningBalance').lean();
  if (!trades.length) return 0;
  await Trade.bulkWrite(trades.map(t => ({
    updateOne: {
      // grossPnl in the filter too, so a second run racing this one can't convert a trade twice.
      filter: { _id: t._id, grossPnl: { $ne: true } },
      update: { $set: { ...grossFromNet(t), grossPnl: true } },
    },
  })), { ordered: false });
  return trades.length;
}

module.exports = { grossFromNet, convertCTraderPnlToGross };
