const mongoose = require('mongoose');

const tradeSchema = new mongoose.Schema({
  dealId:     { type: String, required: true }, // MT5 close deal ticket
  positionId: { type: String, default: '' },
  symbol: { type: String, required: true },
  direction: { type: String, enum: ['BUY', 'SELL'], required: true },
  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number, required: true },
  lotSize: { type: Number, required: true },
  pnlUSD: { type: Number, required: true },         // profit in USD
  pnlPct: { type: Number, default: 0 },             // P&L as % of balance at close
  commission: { type: Number, default: 0 },
  swap: { type: Number, default: 0 },
  openTime: { type: Date, required: true },
  closeTime: { type: Date, required: true },
  durationMinutes: { type: Number, default: 0 },
  runningBalance: { type: Number, default: 0 },     // account balance after trade
  notes: { type: String, default: '' },             // trader journal notes
  tags: [{ type: String }],                         // custom tags e.g. #FOMO, #double-top
  emotion: { type: String, enum: ['Calm', 'Anxious', 'Greedy', 'Fearful', 'Disciplined', 'FOMO', ''], default: '' },
  grade: { type: String, enum: ['A', 'B', 'C', 'D', 'F', ''], default: '' }, // legacy - kept for backward compat

  // -- Edge Coach: Grades ---------------------------------------------------
  analysisGrade:    { type: String, enum: ['A', 'B', 'C', 'D', 'F', ''], default: '' }, // quality of setup reading
  executionGrade:   { type: String, enum: ['A', 'B', 'C', 'D', 'F', ''], default: '' }, // quality of execution vs plan

  // -- Edge Coach: Exit Analysis --------------------------------------------
  plannedRR:          { type: Number, default: null },  // planned R:R before entry (e.g. 3.5)
  exitReason:         { type: String, enum: ['TP', 'SL', 'Fear', 'Revenge', 'News', 'ManualClose', 'FOMO', 'PartialClose', 'Other', ''], default: '' },
  manuallyIntervened: { type: Boolean, default: null }, // did you modify SL/TP or close manually after entry?

  // -- Real risk data, synced from MT5 (broker fact, not self-reported) -----
  stopLoss:    { type: Number, default: null },  // SL price set on the order that opened this position
  takeProfit:  { type: Number, default: null },  // TP price set on the order that opened this position
  riskUSD:     { type: Number, default: null },  // account-currency risk for the stop distance (from MT5's own calculator)
  riskPercent: { type: Number, default: null },  // riskUSD as % of balance just before this trade
  exitTrigger: { type: String, enum: ['SL', 'TP', 'StopOut', 'Expert', 'Manual', ''], default: '' }, // objective close reason from MT5 deal.reason — compare against the trader-reported exitReason
  magic:          { type: Number, default: 0 },        // EA magic number; 0/absent means discretionary
  contractSize:   { type: Number, default: null },     // symbol contract size at sync time
  tickValue:      { type: Number, default: null },     // symbol tick value at sync time (account currency)

  // -- Edge Coach: Pre-Trade Self-Assessment --------------------------------
  confidenceRating: { type: Number, min: 1, max: 10, default: null }, // 1-10 pre-trade confidence
  accountType:      { type: String, enum: ['live', 'demo', ''], default: '' }, // demo vs live tracking
  accountKey:       { type: String, default: '', index: true }, // stable server + login identity
  accountLogin:     { type: String, default: '' },
  accountServer:    { type: String, default: '' },
  accountName:      { type: String, default: '' },
  tradingAccount:   { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', default: null, index: true },

  // -- Edge Coach: Setup Builder --------------------------------------------
  isReEntry:          { type: Boolean, default: false }, // was this a re-entry on the same setup/idea?
  parentTradeId:      { type: String, default: '' },     // _id of the parent trade this re-entry is based on
  reEntryReason:      { type: String, default: '' },     // why re-enter -- everything else (playbook, notes, etc.) is inherited from the parent
  tradeGroup:         { type: String, default: '' },     // auto-set to parentTradeId when a parent is chosen (or manual group name)
  primarySetup:       { type: String, default: '' }, // e.g. 'HTF Supply', 'HTF Demand', 'ORB'
  setupConfirmations: [{ type: String }],            // e.g. ['IFVG', 'Liquidity Sweep', 'Trendline Break']

  // -- Immutable strategy audit snapshot -----------------------------------
  playbookId:        { type: String, default: '' },
  playbookVersionId: { type: String, default: '' },
  playbookSnapshot:  { type: mongoose.Schema.Types.Mixed, default: null },
  playbookResponses: { type: mongoose.Schema.Types.Mixed, default: {} },

  // -- Edge Coach: Post-Trade Execution Checklist ---------------------------
  executionChecklist: [{
    ruleId:   { type: String, default: '' },
    rule:     String,   // e.g. 'Entry as planned', 'Stop not moved', 'Target respected'
    complied: Boolean,
  }],

  // -- Pre-trade entry checklist --------------------------------------------
  checklist: [{ ruleId: { type: String, default: '' }, rule: String, complied: Boolean }],

  screenshots: [{
    url:        { type: String, required: true },
    publicId:   { type: String, required: true },
    caption:    { type: String, default: '' },
    playbookRuleId: { type: String, default: '' },
    playbookVersionId: { type: String, default: '' },
    uploadedAt: { type: Date, default: Date.now },
  }],
  synced: { type: Date, default: Date.now },
  // True for a trade typed in by hand on the Trades page rather than synced
  // from a broker -- useful for a trade your broker never recorded (a
  // backtest you want in real history, an OTC fill, etc). Never touched by
  // the MT5/cTrader sync pipeline's dealId matching.
  manualEntry: { type: Boolean, default: false },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
}, { timestamps: true });

tradeSchema.index({ symbol: 1 });
tradeSchema.index({ closeTime: -1 });
tradeSchema.index({ pnlUSD: 1 });
tradeSchema.index({ user: 1, closeTime: -1 });
tradeSchema.index({ user: 1, accountKey: 1, dealId: 1 }, { unique: true });

module.exports = mongoose.model('Trade', tradeSchema);
