// Deleting a strategy from the Strategies page removes everything filed under
// it: its definition and rule history, the backtests whose strategy it is,
// agent code runs logged to it, and its agent replay sessions. A backtest filed
// under another strategy that only also carries this tag keeps its own
// strategy and just loses the tag.
const BacktestStrategy = require('../models/BacktestStrategy');
const BacktestTrade = require('../models/BacktestTrade');
const StrategyRun = require('../models/StrategyRun');
const AgentReplaySession = require('../models/AgentReplaySession');
const { strategyAndTags } = require('./backtestTags');

async function purgeStrategy(userId, name) {
  const definition = await BacktestStrategy.deleteOne({ user: userId, name });
  const trades = await BacktestTrade.deleteMany({ user: userId, strategy: name });
  const alsoTagged = await BacktestTrade.find({ user: userId, tags: name }).select('tags strategy').lean();
  const ops = alsoTagged.map(t => ({
    updateOne: {
      filter: { _id: t._id, user: userId },
      update: { $set: strategyAndTags(t.strategy, (t.tags || []).filter(tag => tag && tag !== name)) },
    },
  }));
  if (ops.length) await BacktestTrade.bulkWrite(ops);
  const runIds = (await StrategyRun.find({ user: userId }).select('settings').lean())
    .filter(r => r.settings?.logAs === name).map(r => r._id);
  const runs = runIds.length ? await StrategyRun.deleteMany({ user: userId, _id: { $in: runIds } }) : { deletedCount: 0 };
  const sessions = await AgentReplaySession.deleteMany({ user: userId, strategy: name });
  return {
    deletedDefinition: definition.deletedCount > 0,
    deletedBacktests: trades.deletedCount || 0,
    untagged: ops.length,
    deletedRuns: runs.deletedCount || 0,
    deletedSessions: sessions.deletedCount || 0,
  };
}

module.exports = { purgeStrategy };
