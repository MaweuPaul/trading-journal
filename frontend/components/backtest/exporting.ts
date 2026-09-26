import { BacktestTrade, tagsOf } from './data';

export function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function toCsv(trades: BacktestTrade[]) {
  const cols = ['name', 'tags', 'symbol', 'interval', 'direction', 'entryPrice', 'exitPrice', 'stopLoss', 'takeProfit', 'rMultiple', 'pnlUSD', 'outcome', 'createdAt', 'notes'] as const;
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...trades.map(t => cols.map(c => esc(c === 'tags' ? tagsOf(t).join('|') : t[c])).join(','))].join('\n');
}

const stamp = () => new Date().toISOString().slice(0, 10);
export function downloadLogCsv(trades: BacktestTrade[]) { download(`backtest-log-${stamp()}.csv`, toCsv(trades), 'text/csv'); }
export function downloadLogJson(trades: BacktestTrade[]) { download(`backtest-log-${stamp()}.json`, JSON.stringify(trades, null, 2), 'application/json'); }
