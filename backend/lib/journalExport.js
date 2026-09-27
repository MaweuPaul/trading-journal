// "Export for AI": the owner's journaled trades, statistics and playbooks as
// one Markdown document to paste or upload into any AI chat (for chats that
// can't connect to the MCP server). Same numbers as the MCP journal tools.
const journal = require('./agentJournal');

const BREAKDOWNS = ['setup', 'session', 'emotion', 'rulesFollowed', 'exitReason', 'executionGrade', 'analysisGrade', 'holdTime', 'weekday', 'direction', 'symbol'];
const LABELS = {
  setup: 'Setup', session: 'Session (UTC open time)', emotion: 'Emotion', rulesFollowed: 'Rules followed (checklists)', exitReason: 'Exit reason (yours)',
  executionGrade: 'Execution grade', analysisGrade: 'Analysis grade', holdTime: 'Hold time', weekday: 'Weekday (UTC)', direction: 'Direction', symbol: 'Symbol',
};
const MAX_TRADES = 1000;

const money = v => (v == null ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
const signed = (v, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`);
const range = r => (r ? `${r[0]}–${r[1]}%` : '—');
const cell = v => String(v ?? '—').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

function statsRow(label, s) {
  const c = s.confidence || {};
  return `| ${cell(label)} | ${s.trades} | ${c.level || '—'} | ${s.winRate}% (${range(c.winRateRange)}) | ${money(s.netUSD)} | ${money(s.avgNetUSD)} | ${s.profitFactor ?? '—'} | ${s.rTrades ? `${signed(s.avgR)} (${s.rTrades})` : '—'} |`;
}
const STATS_HEAD = '| Group | Trades | Sample | Win rate (likely range) | Net P&L | Avg per trade | Profit factor | Avg R (trades with a stop) |\n|---|---|---|---|---|---|---|---|';

function tradeBlock(t) {
  const lines = [];
  const date = (t.openTime || '').slice(0, 16).replace('T', ' ');
  lines.push(`### ${date} UTC · ${t.symbol} ${t.direction} · ${t.outcome.toUpperCase()} ${money(t.netUSD)}${t.r != null ? ` · ${signed(t.r)}R` : ''}`);
  const facts = [
    `Entry ${t.entryPrice} → exit ${t.exitPrice}`,
    t.stopLoss != null ? `stop ${t.stopLoss}` : 'no stop recorded',
    t.takeProfit != null ? `target ${t.takeProfit}` : null,
    `held ${t.durationMinutes ?? '?'} min`,
    t.riskPercent != null ? `risk ${t.riskPercent}%` : null,
    t.plannedRR != null ? `planned R:R ${t.plannedRR}` : null,
    t.account ? `account ${t.account}${t.accountType ? ` (${t.accountType})` : ''}` : null,
  ].filter(Boolean);
  lines.push(facts.join(' · '));
  const journaled = [
    t.setup && `Setup: ${t.setup}`,
    t.confirmations?.length && `Confirmations: ${t.confirmations.join(', ')}`,
    t.tags?.length && `Tags: ${t.tags.join(', ')}`,
    t.emotion && `Emotion: ${t.emotion}`,
    t.confidenceRating != null && `Confidence: ${t.confidenceRating}/10`,
    (t.analysisGrade || t.executionGrade) && `Grades: analysis ${t.analysisGrade || '—'}, execution ${t.executionGrade || '—'}`,
    (t.exitReason || t.exitTrigger) && `Exit: ${t.exitReason || '—'} (broker: ${t.exitTrigger || '—'})`,
    t.manuallyIntervened != null && `Intervened manually: ${t.manuallyIntervened ? 'yes' : 'no'}`,
    t.reEntry && `Re-entry${t.reEntryReason ? `: ${t.reEntryReason}` : ''}`,
  ].filter(Boolean);
  if (journaled.length) lines.push(journaled.join(' · '));
  const checks = [...(t.checklist || []), ...(t.executionChecklist || [])];
  const broken = checks.filter(c => c.complied === false).map(c => c.rule);
  if (checks.length) lines.push(broken.length ? `Rules broken (${broken.length}/${checks.length}): ${broken.join('; ')}` : `Checklist: ${checks.length === 1 ? 'the 1 rule' : `all ${checks.length} rules`} followed`);
  if (t.playbookAnswers?.answers?.length) {
    const answered = t.playbookAnswers.answers.filter(a => a.answer !== null && a.answer !== '' && !(Array.isArray(a.answer) && !a.answer.length));
    if (answered.length) lines.push(`Playbook "${t.playbookAnswers.name}": ${answered.map(a => `${a.rule} = ${typeof a.answer === 'object' ? JSON.stringify(a.answer) : a.answer}`).join('; ')}`);
  }
  if (t.notes && t.notes.trim()) lines.push(`Notes: ${t.notes.trim().replace(/\n+/g, ' / ')}`);
  if (t.screenshots?.length) lines.push(`Screenshots: ${t.screenshots.map(s => `${s.url}${s.caption ? ` (${s.caption})` : ''}`).join(' ; ')}`);
  return lines.join('\n');
}

/** input: filters (account, accountType, symbol, direction, from, to), maxTrades, notes (bool) */
async function buildExport(userId, input = {}) {
  const filters = {
    account: input.account || undefined, accountType: input.accountType || undefined, symbol: input.symbol || undefined,
    direction: input.direction || undefined, from: input.from || undefined, to: input.to || undefined,
  };
  const maxTrades = Math.max(0, Math.min(MAX_TRADES, Math.floor(Number(input.maxTrades ?? 300)) || 0));
  const includeJournal = input.notes !== false;
  const [metrics, playbooks, raw] = await Promise.all([
    journal.getMetrics(userId, { ...filters, groupBy: BREAKDOWNS }),
    journal.getPlaybooks(userId),
    journal.findTrades(userId, filters),
  ]);
  const { breakdowns } = metrics;

  const newest = [...raw].sort((a, b) => new Date(b.closeTime) - new Date(a.closeTime)).slice(0, maxTrades);
  const trades = newest.map(t => journal.publicTrade(t, { full: true }));
  const filterText = Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none (all trades)';
  const o = metrics.overall;

  const md = [];
  md.push('# My trading journal: export for AI review');
  md.push(`Exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · Filters: ${filterText} · ${o.trades} trades in the statistics${trades.length < o.trades ? `, the newest ${trades.length} listed in full` : ''}.`);
  md.push('');
  md.push('## What I want from you');
  md.push('Review my trading as an experienced, honest trading coach. Using the statistics, my playbook and my journaled trades below:');
  md.push('1. Tell me what is going wrong: which setups, sessions, behaviours or exits are costing me money, and whether the problem is the strategy itself or my execution of it (rules broken, emotions, manual interventions, exits).');
  md.push('2. Tell me what is working and should be done more.');
  md.push('3. Back every finding with the number of trades behind it and quote example trades (date and symbol). Groups marked "insufficient" (under 10 trades) or "early" (under 30) are not proof: say so rather than presenting them as fact, and treat differences between groups whose likely ranges overlap as unproven.');
  md.push('4. End with the 3 most important changes to make, in order.');
  md.push('');
  md.push('## How to read the numbers');
  md.push('- P&L is net of commission and swap. A win is a trade with positive net P&L.');
  md.push('- R = result divided by the risk to the stop the broker recorded at entry; trades without a recorded stop have no R.');
  md.push('- "Likely range" is a 95% range for the true win rate given the sample. Sample levels: insufficient under 10 trades, early under 30, developing under 100, reliable after that.');
  md.push('- Sessions, weekdays and hours are by the trade\'s open time in UTC.');
  md.push('');
  md.push('## Overall');
  md.push(STATS_HEAD);
  md.push(statsRow('All trades', o));
  md.push('');
  md.push(`Largest win ${money(o.biggestWinUSD)} · largest loss ${money(o.biggestLossUSD)} · average win ${money(o.avgWinUSD)} · average loss ${money(o.avgLossUSD)} · max drawdown ${money(o.maxDrawdownUSD)} · longest losing streak ${o.maxLossStreak}${o.rTrades ? ` · total ${signed(o.totalR)}R over ${o.rTrades} trades with a stop` : ''}.`);
  md.push('');
  md.push('## Breakdowns');
  for (const by of BREAKDOWNS) {
    const rows = breakdowns[by] || [];
    if (rows.length < 2 && by !== 'setup') continue; // a single group says nothing new
    md.push(`### ${LABELS[by]}`);
    md.push(STATS_HEAD);
    for (const r of rows.slice(0, 25)) md.push(statsRow(r[by], r));
    md.push('');
  }
  md.push('## My playbooks (the rules I am supposed to follow)');
  if (!playbooks.playbooks.length) md.push('No playbook written yet.');
  for (const p of playbooks.playbooks) {
    md.push(`### ${p.name}${p.version ? ` (v${p.version})` : ''}`);
    if (p.description) md.push(p.description);
    for (const b of p.blocks) {
      if (!b.rules.length) continue;
      md.push(`- **${b.name}**: ${b.rules.map(r => r.rule + (r.options ? ` [${r.options.join(' / ')}]` : '')).join('; ')}`);
    }
    md.push('');
  }
  if (trades.length) {
    md.push(`## Trades (newest first${trades.length < o.trades ? `, ${trades.length} of ${o.trades}` : ''})`);
    for (const t of trades) {
      if (!includeJournal) { t.notes = ''; t.screenshots = []; t.playbookAnswers = null; }
      md.push(tradeBlock(t));
      md.push('');
    }
  }
  return { markdown: md.join('\n'), trades: o.trades, listed: trades.length };
}

module.exports = { buildExport, MAX_TRADES };
