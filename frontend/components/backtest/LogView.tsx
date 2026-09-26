'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from './BacktestShell';
import {
  BacktestTrade, authHeaders, fmtDate, fmtPrice, fmtR, fmtUSD, hashTag, intervalLabel, tagsOf, useBacktest,
} from './data';

const PAGE_SIZE = 10;
type Outcome = 'ALL' | 'win' | 'loss' | 'breakeven';
type SortKey = 'date' | 'r';

const chip = 'tw:px-space-xs tw:py-0.5 tw:rounded tw:font-label-caps tw:text-label-caps tw:uppercase tw:font-bold';
const field = 'tw:w-full tw:min-h-[44px] tw:appearance-none tw:bg-surface-container tw:text-on-surface tw:font-body-sm tw:text-body-sm tw:pl-space-md tw:pr-space-lg tw:py-space-xs tw:rounded tw:focus:outline-none tw:focus:bg-surface-container-high';

function directionChip(direction: BacktestTrade['direction']) {
  return direction === 'long' ? 'tw:bg-secondary/15 tw:text-secondary' : 'tw:bg-error/15 tw:text-error';
}
function valueTone(n: number) {
  return n > 0 ? 'tw:text-secondary' : n < 0 ? 'tw:text-error' : 'tw:text-on-surface-variant';
}
function rChip(n: number) {
  return n > 0 ? 'tw:bg-secondary/20 tw:text-secondary' : n < 0 ? 'tw:bg-error/20 tw:text-error' : 'tw:bg-surface-container-highest tw:text-on-surface-variant';
}

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function toCsv(trades: BacktestTrade[]) {
  const cols = ['name', 'tags', 'symbol', 'interval', 'direction', 'entryPrice', 'exitPrice', 'stopLoss', 'takeProfit', 'rMultiple', 'pnlUSD', 'outcome', 'createdAt', 'notes'] as const;
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...trades.map(t => cols.map(c => esc(c === 'tags' ? tagsOf(t).join('|') : t[c])).join(','))].join('\n');
}

export default function LogView() {
  const router = useRouter();
  const { trades, loading, error, removeTrade, addTrade, strategies, strategyInfo, createStrategy, setActiveSymbol } = useBacktest();
  const [strategy, setStrategy] = useState('ALL');
  const [symbol, setSymbol] = useState('ALL');
  const [outcome, setOutcome] = useState<Outcome>('ALL');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('date');
  const [page, setPage] = useState(1);
  const [inspect, setInspect] = useState<BacktestTrade | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showNewStrategy, setShowNewStrategy] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  const symbols = useMemo(() => Array.from(new Set(trades.map(t => t.symbol))).sort(), [trades]);
  const counts = useMemo(() => ({
    win: trades.filter(t => t.outcome === 'win').length,
    loss: trades.filter(t => t.outcome === 'loss').length,
    breakeven: trades.filter(t => t.outcome === 'breakeven').length,
  }), [trades]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/^#/, '');
    const rows = trades.filter(t =>
      (strategy === 'ALL' || tagsOf(t).includes(strategy))
      && (symbol === 'ALL' || t.symbol === symbol)
      && (outcome === 'ALL' || t.outcome === outcome)
      && (!q || [t.name, t.symbol, ...tagsOf(t), hashTag(tagsOf(t)[0] ?? '')].some(v => v?.toLowerCase().includes(q))));
    return [...rows].sort((a, b) => sort === 'r'
      ? b.rMultiple - a.rMultiple
      : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [trades, strategy, symbol, outcome, search, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // KPIs follow the strategy/symbol/outcome filters, like the trade list.
  const stats = useMemo(() => {
    const n = filtered.length;
    const wins = filtered.filter(t => t.outcome === 'win');
    const losses = filtered.filter(t => t.outcome === 'loss');
    const totalR = filtered.reduce((s, t) => s + t.rMultiple, 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.rMultiple, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.rMultiple, 0) / losses.length : 0;
    const sessions = new Set(filtered.map(t => new Date(t.createdAt).toDateString())).size;
    // Sparkline of cumulative R in logged order.
    const chrono = [...filtered].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const points = chrono.reduce<number[]>((acc, t) => [...acc, acc[acc.length - 1] + t.rMultiple], [0]);
    const min = Math.min(...points), max = Math.max(...points);
    const spark = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / Math.max(1, points.length - 1)) * 100).toFixed(2)} ${(18 - ((v - min) / (max - min || 1)) * 16).toFixed(2)}`).join(' ');
    return {
      n, wins: wins.length, losses: losses.length, winRate: n ? (wins.length / n) * 100 : 0,
      avgR: n ? totalR / n : 0, avgWin, avgLoss, totalR, totalPnl: filtered.reduce((s, t) => s + t.pnlUSD, 0), sessions, spark,
    };
  }, [filtered]);

  const resetFilters = () => { setStrategy('ALL'); setSymbol('ALL'); setOutcome('ALL'); setSearch(''); setSort('date'); setPage(1); };
  const onDelete = async (e: React.MouseEvent, t: BacktestTrade) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${t.name || t.symbol}" from the backtest log?`)) return;
    if (await removeTrade(t._id)) { setToast('Backtest deleted'); if (inspect?._id === t._id) setInspect(null); }
    else setToast('Could not delete that backtest');
  };
  const exportData = (kind: 'CSV' | 'JSON') => {
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === 'CSV') download(`backtest-log-${stamp}.csv`, toCsv(filtered), 'text/csv');
    else download(`backtest-log-${stamp}.json`, JSON.stringify(filtered, null, 2), 'application/json');
    setToast(`Exported ${filtered.length} trades as ${kind}`);
  };
  const loadInWorkspace = (t: BacktestTrade) => {
    if (!t.entryTime) return;
    const day = 86_400_000;
    const from = new Date(t.entryTime * 1000 - 3 * day).toISOString().slice(0, 10);
    const to = new Date((t.exitTime ?? t.entryTime) * 1000 + 3 * day).toISOString().slice(0, 10);
    setActiveSymbol(t.symbol);
    router.push(`/backtest/workspace?symbol=${encodeURIComponent(t.symbol)}&interval=${encodeURIComponent(t.interval)}&from=${from}&to=${to}`);
  };

  const ringOffset = 88 * (1 - stats.winRate / 100);

  return (
    <div className="tw:flex tw:flex-col tw:w-full">
      {toast && (
        <div role="status" className="tw:fixed tw:top-16 tw:left-1/2 tw:-translate-x-1/2 tw:z-50 tw:flex tw:items-center tw:gap-space-sm tw:bg-surface-bright tw:text-on-surface tw:px-space-md tw:py-space-sm tw:rounded tw:shadow-xl">
          <Icon name="check_circle" className="tw:text-[16px] tw:text-secondary" />
          <span className="tw:font-body-sm tw:text-body-sm tw:font-medium">{toast}</span>
        </div>
      )}

      {/* Header & actions deck */}
      <section className="tw:p-gutter tw:flex tw:flex-col tw:gap-space-md tw:bg-surface-container-lowest">
        <div className="tw:flex tw:items-center tw:justify-between tw:gap-space-sm">
          <div className="tw:flex tw:items-center tw:gap-space-sm">
            <h1 className="tw:font-headline-md tw:text-headline-md tw:font-bold tw:text-on-surface tw:tracking-tight">Backtest Log</h1>
            <span className="tw:inline-flex tw:items-center tw:px-space-sm tw:py-0.5 tw:rounded tw:bg-surface-container-high tw:text-primary tw:font-mono-metric-md tw:text-mono-metric-md tw:font-semibold">{trades.length} Trades</span>
          </div>
          <div className="tw:flex tw:items-center tw:gap-space-xs">
            <Link href="/backtest/metrics" className="tw:min-h-[44px] tw:px-space-md tw:flex tw:items-center tw:gap-space-xs tw:rounded tw:bg-surface-container-high tw:hover:bg-surface-variant tw:text-on-surface tw:font-label-action tw:text-label-action tw:transition-colors">
              <Icon name="analytics" className="tw:text-[18px] tw:text-primary" />
              <span className="tw:hidden tw:sm:inline">View Metrics</span>
            </Link>
            <button type="button" onClick={() => setShowNewStrategy(true)} className="tw:min-h-[44px] tw:px-space-md tw:flex tw:items-center tw:gap-space-xs tw:rounded tw:bg-surface-container-high tw:hover:bg-surface-variant tw:text-on-surface tw:font-label-action tw:text-label-action tw:transition-colors">
              <Icon name="rule" className="tw:text-[18px] tw:text-primary" />
              <span className="tw:hidden tw:sm:inline">New Strategy</span>
            </button>
            <button type="button" onClick={() => setShowNew(true)} className="tw:min-h-[44px] tw:px-space-md tw:flex tw:items-center tw:gap-space-xs tw:rounded tw:bg-primary-container tw:hover:bg-primary-fixed-dim tw:text-on-primary-container tw:font-label-action tw:text-label-action tw:font-semibold tw:shadow-md tw:active:scale-95 tw:transition-all">
              <Icon name="add_circle" className="tw:text-[18px]" />
              <span>+ New Backtest</span>
            </button>
          </div>
        </div>

        {/* Filter ribbon */}
        <div className="tw:grid tw:grid-cols-2 tw:sm:grid-cols-4 tw:gap-space-xs">
          <div className="tw:relative">
            <select aria-label="Filter by strategy" className={field} value={strategy} onChange={e => { setStrategy(e.target.value); setPage(1); }}>
              <option value="ALL">All Strategies ({strategies.length})</option>
              {strategies.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <Icon name="expand_more" className="tw:absolute tw:right-space-sm tw:top-1/2 tw:-translate-y-1/2 tw:pointer-events-none tw:text-on-surface-variant tw:text-[18px]" />
          </div>
          <div className="tw:relative">
            <select aria-label="Filter by symbol" className={field} value={symbol} onChange={e => { setSymbol(e.target.value); setPage(1); }}>
              <option value="ALL">All Symbols ({symbols.length})</option>
              {symbols.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <Icon name="expand_more" className="tw:absolute tw:right-space-sm tw:top-1/2 tw:-translate-y-1/2 tw:pointer-events-none tw:text-on-surface-variant tw:text-[18px]" />
          </div>
          <div className="tw:relative">
            <select aria-label="Filter by outcome" className={field} value={outcome} onChange={e => { setOutcome(e.target.value as Outcome); setPage(1); }}>
              <option value="ALL">All Outcomes</option>
              <option value="win">Wins Only ({counts.win})</option>
              <option value="loss">Losses Only ({counts.loss})</option>
              <option value="breakeven">Break Evens ({counts.breakeven})</option>
            </select>
            <Icon name="tune" className="tw:absolute tw:right-space-sm tw:top-1/2 tw:-translate-y-1/2 tw:pointer-events-none tw:text-on-surface-variant tw:text-[18px]" />
          </div>
          <div className="tw:flex tw:items-center tw:gap-space-xs">
            {(['CSV', 'JSON'] as const).map(kind => (
              <button key={kind} type="button" onClick={() => exportData(kind)} disabled={!filtered.length}
                className="tw:flex-1 tw:min-h-[44px] tw:flex tw:items-center tw:justify-center tw:gap-space-xs tw:bg-surface-container tw:hover:bg-surface-container-high tw:text-on-surface-variant tw:hover:text-on-surface tw:rounded tw:font-label-action tw:text-label-action tw:active:scale-95 tw:transition-all tw:disabled:opacity-40">
                <Icon name={kind === 'CSV' ? 'file_download' : 'data_object'} className="tw:text-[16px]" />
                <span>{kind}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* KPI cards */}
      <section className="tw:p-gutter tw:grid tw:grid-cols-2 tw:lg:grid-cols-4 tw:gap-space-sm">
        <div className="tw:bg-surface-container-low tw:rounded tw:p-space-md tw:flex tw:flex-col tw:justify-between tw:shadow-sm tw:relative tw:overflow-hidden">
          <div className="tw:flex tw:items-center tw:justify-between tw:mb-space-xs">
            <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Trades Logged</span>
            <Icon name="inventory_2" className="tw:text-[18px] tw:text-primary" />
          </div>
          <div>
            <div className="tw:font-mono-metric-lg tw:text-mono-metric-lg tw:text-on-surface tw:font-bold">{stats.n}</div>
            <div className="tw:font-body-sm tw:text-body-sm tw:text-on-surface-variant tw:flex tw:items-center tw:gap-space-xs tw:mt-0.5">
              <span className="tw:w-1.5 tw:h-1.5 tw:rounded-full tw:bg-primary-container" />
              <span>{stats.sessions} Active Session{stats.sessions === 1 ? '' : 's'}</span>
            </div>
          </div>
          <div className="tw:absolute tw:-right-2 tw:-bottom-2 tw:opacity-5 tw:pointer-events-none"><Icon name="candlestick_chart" className="tw:text-[64px]" /></div>
        </div>
        <div className="tw:bg-surface-container-low tw:rounded tw:p-space-md tw:flex tw:items-center tw:justify-between tw:shadow-sm">
          <div className="tw:flex tw:flex-col tw:justify-between">
            <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Win Rate</span>
            <div className="tw:font-mono-metric-lg tw:text-mono-metric-lg tw:text-secondary tw:font-bold tw:mt-space-xs">{stats.winRate.toFixed(1)}%</div>
            <div className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface-variant tw:mt-0.5">{stats.wins}W <span>/</span> {stats.losses}L</div>
          </div>
          <div className="tw:relative tw:w-12 tw:h-12 tw:flex tw:items-center tw:justify-center tw:flex-shrink-0">
            <svg className="tw:w-12 tw:h-12 tw:-rotate-90" viewBox="0 0 36 36" aria-hidden="true">
              <circle className="tw:stroke-surface-container-highest" cx="18" cy="18" fill="none" r="14" strokeWidth="3" />
              <circle className="tw:stroke-secondary" cx="18" cy="18" fill="none" r="14" strokeDasharray="88" strokeDashoffset={ringOffset} strokeLinecap="round" strokeWidth="3" />
            </svg>
            <span className="tw:absolute tw:font-label-caps tw:text-label-caps tw:text-secondary tw:font-bold">{Math.round(stats.winRate)}%</span>
          </div>
        </div>
        <div className="tw:bg-surface-container-low tw:rounded tw:p-space-md tw:flex tw:flex-col tw:justify-between tw:shadow-sm">
          <div className="tw:flex tw:items-center tw:justify-between tw:mb-space-xs">
            <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Expected Value</span>
            <Icon name={stats.avgR >= 0 ? 'trending_up' : 'trending_down'} className={`tw:text-[18px] ${stats.avgR >= 0 ? 'tw:text-secondary' : 'tw:text-error'}`} />
          </div>
          <div>
            <div className="tw:font-mono-metric-lg tw:text-mono-metric-lg tw:text-on-surface tw:font-bold">{fmtR(stats.avgR)}</div>
            <div className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface-variant tw:flex tw:items-center tw:gap-space-xs tw:mt-0.5">
              <span className="tw:text-secondary tw:font-medium">{fmtR(stats.avgWin, 1)}</span>
              <span>/</span>
              <span className="tw:text-error tw:font-medium">{fmtR(stats.avgLoss, 1)}</span>
            </div>
          </div>
        </div>
        <div className="tw:bg-surface-container-low tw:rounded tw:p-space-md tw:flex tw:flex-col tw:justify-between tw:shadow-sm tw:relative tw:overflow-hidden">
          <div className="tw:flex tw:items-center tw:justify-between tw:mb-space-xs">
            <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Total Realized P&amp;L</span>
            <Icon name="payments" className={`tw:text-[18px] ${valueTone(stats.totalPnl)}`} />
          </div>
          <div>
            <div className={`tw:font-mono-metric-lg tw:text-mono-metric-lg tw:font-bold ${valueTone(stats.totalPnl)}`}>{fmtUSD(stats.totalPnl)}</div>
            <div className={`tw:font-mono-metric-md tw:text-mono-metric-md tw:font-medium tw:mt-0.5 ${valueTone(stats.totalR)}`}>{fmtR(stats.totalR, 1)} Sim Equity</div>
          </div>
          <div className="tw:w-full tw:h-4 tw:mt-space-xs tw:opacity-70">
            <svg className="tw:w-full tw:h-full" preserveAspectRatio="none" viewBox="0 0 100 20" aria-hidden="true">
              <path className={stats.totalR >= 0 ? 'tw:stroke-secondary' : 'tw:stroke-error'} d={stats.spark} fill="none" strokeLinecap="round" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
        </div>
      </section>

      {/* Search & table controls */}
      <section className="tw:px-gutter tw:pt-space-xs tw:pb-space-sm tw:flex tw:items-center tw:justify-between tw:gap-space-sm">
        <div className="tw:relative tw:flex-1 tw:max-w-md">
          <Icon name="search" className="tw:absolute tw:left-space-sm tw:top-1/2 tw:-translate-y-1/2 tw:text-on-surface-variant tw:text-[18px]" />
          <input aria-label="Search backtests" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search setup, tag, or symbol..." type="text"
            className="tw:w-full tw:min-h-[44px] tw:pl-8 tw:pr-space-md tw:py-space-xs tw:bg-surface-container tw:text-on-surface tw:font-body-sm tw:text-body-sm tw:rounded tw:focus:outline-none tw:focus:bg-surface-container-high tw:transition-colors" />
        </div>
        <div className="tw:flex tw:items-center tw:gap-space-xs">
          <button type="button" onClick={() => setSort(s => (s === 'date' ? 'r' : 'date'))} title={sort === 'date' ? 'Sort by R-Multiple' : 'Sort by date'}
            className="tw:min-h-[44px] tw:px-space-sm tw:flex tw:items-center tw:gap-space-xs tw:rounded tw:bg-surface-container tw:text-on-surface-variant tw:hover:text-on-surface tw:font-label-action tw:text-label-action tw:active:scale-95">
            <Icon name="swap_vert" className="tw:text-[18px]" />
            <span className="tw:hidden tw:sm:inline">Sort: {sort === 'date' ? 'Date' : 'R-Multiple'}</span>
          </button>
          <button type="button" onClick={resetFilters} title="Reset filters" aria-label="Reset filters"
            className="tw:min-h-[44px] tw:min-w-[44px] tw:flex tw:items-center tw:justify-center tw:rounded tw:bg-surface-container tw:text-on-surface-variant tw:hover:text-primary tw:active:scale-95">
            <Icon name="restart_alt" className="tw:text-[18px]" />
          </button>
        </div>
      </section>

      {/* Trade feed */}
      {loading ? (
        <div className="tw:py-12 tw:flex tw:justify-center tw:text-on-surface-variant"><Icon name="progress_activity" className="tw:text-[28px] tw:animate-spin" /></div>
      ) : error ? (
        <div className="tw:mx-gutter tw:p-space-md tw:rounded tw:bg-error/10 tw:text-error tw:font-body-sm tw:text-body-sm">{error}</div>
      ) : (
        <section className="tw:px-gutter tw:flex tw:flex-col tw:gap-space-xs">
          {pageRows.map(t => {
            const tag = tagsOf(t)[0];
            return (
              <div key={t._id} role="button" tabIndex={0} onClick={() => setInspect(t)} onKeyDown={e => { if (e.key === 'Enter') setInspect(t); }}
                className="tw:group tw:p-space-md tw:rounded tw:bg-surface-container tw:hover:bg-surface-container-high tw:transition-all tw:cursor-pointer tw:flex tw:flex-col tw:gap-space-xs tw:shadow-sm">
                <div className="tw:flex tw:items-center tw:justify-between tw:gap-space-sm tw:min-w-0">
                  <div className="tw:flex tw:items-center tw:gap-space-xs tw:min-w-0">
                    <span className={`${chip} ${directionChip(t.direction)}`}>{t.direction === 'long' ? 'LONG' : 'SHORT'}</span>
                    <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:font-bold tw:text-on-surface">{t.symbol}</span>
                    {t.interval && <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase tw:bg-surface-container-highest tw:px-space-xs tw:py-0.5 tw:rounded">{intervalLabel(t.interval)}</span>}
                    <span className="tw:font-body-md tw:text-body-md tw:font-semibold tw:text-on-surface tw:truncate">{t.name || 'Untitled setup'}</span>
                  </div>
                  <div className="tw:flex tw:items-center tw:gap-space-sm tw:flex-shrink-0">
                    <span className={`tw:px-space-xs tw:py-0.5 tw:rounded tw:font-mono-metric-md tw:text-mono-metric-md tw:font-bold ${rChip(t.rMultiple)}`}>{fmtR(t.rMultiple)}</span>
                    <span className={`tw:font-mono-metric-md tw:text-mono-metric-md tw:font-semibold ${valueTone(t.pnlUSD)}`}>{t.riskAmount > 0 || t.pnlUSD ? fmtUSD(t.pnlUSD) : '—'}</span>
                    <button type="button" onClick={e => void onDelete(e, t)} title="Delete record" aria-label={`Delete ${t.name || t.symbol}`}
                      className="tw:min-h-[44px] tw:min-w-[44px] tw:-mr-space-sm tw:flex tw:items-center tw:justify-center tw:text-on-surface-variant tw:hover:text-error tw:transition-colors">
                      <Icon name="delete" className="tw:text-[18px]" />
                    </button>
                  </div>
                </div>
                <div className="tw:flex tw:items-center tw:justify-between tw:text-on-surface-variant tw:font-body-sm tw:text-body-sm tw:pt-space-xs">
                  <div className="tw:flex tw:items-center tw:gap-space-sm tw:font-mono-metric-md tw:text-mono-metric-md tw:min-w-0">
                    {t.source === 'quick'
                      ? <span>Quick log</span>
                      : <><span>In: <strong className="tw:text-on-surface">{fmtPrice(t.entryPrice)}</strong></span><span>•</span><span>Out: <strong className="tw:text-on-surface">{fmtPrice(t.exitPrice)}</strong></span></>}
                    {tag && <><span className="tw:hidden tw:sm:inline">•</span><span className="tw:hidden tw:sm:inline tw:px-space-xs tw:rounded tw:bg-surface-container-highest tw:text-primary tw:font-label-caps tw:text-label-caps tw:truncate">{hashTag(tag)}</span></>}
                  </div>
                  <div className="tw:flex tw:items-center tw:gap-space-xs tw:flex-shrink-0">
                    <span className="tw:font-body-sm tw:text-body-sm tw:text-on-surface-variant">{fmtDate(t.createdAt)}</span>
                    <Icon name="chevron_right" className="tw:text-[16px] tw:text-on-surface-variant tw:group-hover:translate-x-0.5 tw:transition-transform" />
                  </div>
                </div>
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="tw:flex tw:flex-col tw:items-center tw:justify-center tw:py-12 tw:px-gutter tw:text-center">
              <div className="tw:w-16 tw:h-16 tw:rounded-full tw:bg-surface-container-high tw:flex tw:items-center tw:justify-center tw:mb-space-md tw:text-primary">
                <Icon name="manage_search" className="tw:text-[32px]" />
              </div>
              <h3 className="tw:font-headline-md tw:text-headline-md tw:text-on-surface tw:font-semibold">{trades.length ? 'No backtest trades found' : 'No backtests logged yet'}</h3>
              <p className="tw:font-body-sm tw:text-body-sm tw:text-on-surface-variant tw:max-w-xs tw:mt-space-xs">
                {trades.length ? 'Try tweaking your strategy filter or search keywords to locate simulated trades.' : 'Replay a chart in the Workspace, or quick-log a trade with + New Backtest.'}
              </p>
              {trades.length > 0
                ? <button type="button" onClick={resetFilters} className="tw:mt-space-md tw:min-h-[44px] tw:px-space-lg tw:rounded tw:bg-surface-container-highest tw:text-primary tw:font-label-action tw:text-label-action tw:font-semibold tw:active:scale-95 tw:transition-all">Clear All Filters</button>
                : <Link href="/backtest/workspace" className="tw:mt-space-md tw:min-h-[44px] tw:px-space-lg tw:flex tw:items-center tw:rounded tw:bg-surface-container-highest tw:text-primary tw:font-label-action tw:text-label-action tw:font-semibold">Open Workspace</Link>}
            </div>
          )}
        </section>
      )}

      {/* Pagination */}
      {filtered.length > 0 && (
        <section className="tw:p-gutter tw:flex tw:items-center tw:justify-between tw:bg-surface-container-lowest tw:mt-space-sm">
          <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface-variant">
            Showing {(currentPage - 1) * PAGE_SIZE + 1}-{Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div className="tw:flex tw:items-center tw:gap-space-xs">
            <button type="button" aria-label="Previous page" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}
              className="tw:min-h-[44px] tw:min-w-[44px] tw:flex tw:items-center tw:justify-center tw:rounded tw:bg-surface-container tw:text-on-surface-variant tw:hover:text-on-surface tw:disabled:opacity-40 tw:disabled:cursor-not-allowed">
              <Icon name="chevron_left" className="tw:text-[20px]" />
            </button>
            <div className="tw:flex tw:items-center tw:gap-1">
              {Array.from({ length: pageCount }, (_, i) => i + 1).filter(p => p === 1 || p === pageCount || Math.abs(p - currentPage) <= 1).map((p, i) => (
                <button key={p} type="button" onClick={() => setPage(p)} aria-current={p === currentPage ? 'page' : undefined}
                  className={`tw:min-h-[44px] tw:min-w-[44px] tw:rounded tw:font-mono-metric-md tw:text-mono-metric-md ${i > 1 ? 'tw:hidden tw:sm:block' : ''} ${p === currentPage ? 'tw:bg-primary-container tw:text-on-primary-container tw:font-bold' : 'tw:bg-surface-container tw:text-on-surface-variant tw:hover:text-on-surface'}`}>{p}</button>
              ))}
            </div>
            <button type="button" aria-label="Next page" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}
              className="tw:min-h-[44px] tw:min-w-[44px] tw:flex tw:items-center tw:justify-center tw:rounded tw:bg-surface-container tw:text-on-surface-variant tw:hover:text-on-surface tw:disabled:opacity-40 tw:disabled:cursor-not-allowed">
              <Icon name="chevron_right" className="tw:text-[20px]" />
            </button>
          </div>
        </section>
      )}

      {inspect && <InspectDrawer trade={inspect} onClose={() => setInspect(null)} onLoad={() => loadInWorkspace(inspect)} />}
      {showNew && (
        <QuickLogModal symbols={symbols} strategies={strategies} onClose={() => setShowNew(false)}
          onSaved={t => { addTrade(t); setShowNew(false); setToast('Trade recorded to backtest log'); }} />
      )}
      {showNewStrategy && (
        <NewStrategyModal existing={strategyInfo} onClose={() => setShowNewStrategy(false)}
          onCreated={name => { setShowNewStrategy(false); setToast(`Strategy "${name}" created`); setStrategy(name); }} />
      )}
    </div>
  );
}

function NewStrategyModal({ existing, onClose, onCreated }: {
  existing: { name: string }[]; onClose: () => void; onCreated: (name: string) => void;
}) {
  const { createStrategy } = useBacktest();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const input = 'tw:min-h-[44px] tw:px-space-md tw:bg-surface-container-low tw:text-on-surface tw:rounded tw:focus:outline-none tw:focus:bg-surface-container-high';
  const label = 'tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase';

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setErr('Strategy name is required.'); return; }
    if (existing.some(s => s.name.toLowerCase() === trimmed.toLowerCase())) { setErr('A strategy with that name already exists.'); return; }
    setSaving(true); setErr('');
    const result = await createStrategy(trimmed, description.trim());
    if (result.ok) onCreated(trimmed);
    else { setErr(result.error || 'Could not create strategy'); setSaving(false); }
  };

  return (
    <div className="tw:fixed tw:inset-0 tw:z-50" role="dialog" aria-modal="true" aria-label="New Strategy">
      <div className="tw:absolute tw:inset-0 tw:bg-surface-container-lowest/85 tw:backdrop-blur-sm" onClick={onClose} />
      <div className="tw:absolute tw:top-1/2 tw:left-1/2 tw:-translate-x-1/2 tw:-translate-y-1/2 tw:w-[90%] tw:max-w-md tw:bg-surface-container tw:p-gutter tw:rounded-xl tw:shadow-2xl tw:flex tw:flex-col tw:gap-space-md">
        <div className="tw:flex tw:items-center tw:justify-between">
          <div className="tw:flex tw:items-center tw:gap-space-xs">
            <Icon name="rule" className="tw:text-primary tw:text-[20px]" />
            <h3 className="tw:font-headline-md tw:text-headline-md tw:font-bold tw:text-on-surface">New Strategy</h3>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="tw:min-h-[44px] tw:min-w-[44px] tw:flex tw:items-center tw:justify-center tw:text-on-surface-variant tw:hover:text-on-surface">
            <Icon name="close" className="tw:text-[20px]" />
          </button>
        </div>
        <p className="tw:font-body-sm tw:text-body-sm tw:text-on-surface-variant">
          Name it once here, then pick it from the Strategy field whenever you log a backtest -- so you can compare edge across strategies on the Metrics page.
        </p>
        <label className="tw:flex tw:flex-col tw:gap-1">
          <span className={label}>Strategy Name</span>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. ICT Silver Bullet" maxLength={60} className={input} />
        </label>
        <label className="tw:flex tw:flex-col tw:gap-1">
          <span className={label}>Rules / Notes (optional)</span>
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What's the setup? Entry/exit rules, session, timeframe..."
            rows={3} className={`${input} tw:min-h-0 tw:py-space-xs tw:resize-none`} />
        </label>
        {err && <div className="tw:bg-error-container/40 tw:text-error tw:font-body-sm tw:text-body-sm tw:px-space-sm tw:py-space-xs tw:rounded">{err}</div>}
        <button type="button" onClick={submit} disabled={saving} className="tw:min-h-[44px] tw:bg-primary tw:text-on-primary tw:rounded tw:font-label-action tw:text-label-action tw:font-semibold tw:shadow-md tw:disabled:opacity-60">
          {saving ? 'Creating…' : 'Create Strategy'}
        </button>
      </div>
    </div>
  );
}

function InspectDrawer({ trade: t, onClose, onLoad }: { trade: BacktestTrade; onClose: () => void; onLoad: () => void }) {
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const hasSnapshot = (t as BacktestTrade & { hasSnapshot?: boolean }).hasSnapshot;
  useEffect(() => {
    if (!hasSnapshot) return;
    let cancelled = false;
    fetch(`/api/backtest-trades/${t._id}/snapshot`, { headers: authHeaders() })
      .then(r => (r.ok ? r.json() : { snapshot: '' }))
      .then(d => { if (!cancelled) setSnapshot(d.snapshot || ''); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [t._id, hasSnapshot]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const outcomeChip = t.outcome === 'win' ? 'tw:bg-secondary/20 tw:text-secondary' : t.outcome === 'loss' ? 'tw:bg-error/20 tw:text-error' : 'tw:bg-surface-container-highest tw:text-on-surface-variant';
  return (
    <div className="tw:fixed tw:inset-0 tw:z-50" role="dialog" aria-modal="true" aria-label={t.name || 'Backtest trade'}>
      <div className="tw:absolute tw:inset-0 tw:bg-surface-container-lowest/80 tw:backdrop-blur-sm" onClick={onClose} />
      <div className="tw:absolute tw:bottom-0 tw:inset-x-0 tw:sm:inset-y-0 tw:sm:right-0 tw:sm:left-auto tw:sm:w-96 tw:bg-surface-container-low tw:p-gutter tw:flex tw:flex-col tw:justify-between tw:shadow-2xl tw:max-h-[90dvh] tw:sm:max-h-none tw:overflow-y-auto tw:rounded-t-xl tw:sm:rounded-none">
        <div className="tw:flex tw:flex-col tw:gap-space-md">
          <div className="tw:w-12 tw:h-1 tw:bg-surface-container-highest tw:rounded-full tw:mx-auto tw:sm:hidden tw:mb-space-xs" />
          <div className="tw:flex tw:items-center tw:justify-between">
            <div className="tw:flex tw:items-center tw:gap-space-xs">
              <span className={`${chip} ${directionChip(t.direction)}`}>{t.direction === 'long' ? 'LONG' : 'SHORT'}</span>
              <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:font-bold tw:text-on-surface">{t.symbol}</span>
              <span className={`${chip} ${outcomeChip}`}>{t.outcome === 'breakeven' ? 'BE' : t.outcome.toUpperCase()}</span>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="tw:min-h-[44px] tw:min-w-[44px] tw:flex tw:items-center tw:justify-center tw:rounded tw:bg-surface-container tw:text-on-surface-variant tw:hover:text-on-surface">
              <Icon name="close" className="tw:text-[20px]" />
            </button>
          </div>
          <div>
            <h2 className="tw:font-headline-md tw:text-headline-md tw:font-bold tw:text-on-surface">{t.name || 'Untitled setup'}</h2>
            <span className="tw:font-body-sm tw:text-body-sm tw:text-on-surface-variant">{fmtDate(t.createdAt)}</span>
          </div>
          <div className="tw:grid tw:grid-cols-2 tw:gap-space-xs tw:bg-surface-container tw:rounded tw:p-space-sm">
            <div className="tw:flex tw:flex-col">
              <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Entry Price</span>
              <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface tw:font-semibold">{fmtPrice(t.entryPrice)}</span>
            </div>
            <div className="tw:flex tw:flex-col">
              <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Exit Price</span>
              <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface tw:font-semibold">{fmtPrice(t.exitPrice)}</span>
            </div>
            <div className="tw:flex tw:flex-col tw:pt-space-xs">
              <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Realized R</span>
              <span className={`tw:font-mono-metric-md tw:text-mono-metric-md tw:font-bold ${valueTone(t.rMultiple)}`}>{fmtR(t.rMultiple)}</span>
            </div>
            <div className="tw:flex tw:flex-col tw:pt-space-xs">
              <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">P&amp;L Amount</span>
              <span className={`tw:font-mono-metric-md tw:text-mono-metric-md tw:font-bold ${valueTone(t.pnlUSD)}`}>{fmtUSD(t.pnlUSD)}</span>
            </div>
          </div>
          {tagsOf(t).length > 0 && (
            <div className="tw:flex tw:flex-wrap tw:gap-space-xs">
              {tagsOf(t).map(tag => <span key={tag} className="tw:px-space-xs tw:py-0.5 tw:rounded tw:bg-surface-container-highest tw:text-primary tw:font-label-caps tw:text-label-caps">{hashTag(tag)}</span>)}
            </div>
          )}
          <div className="tw:flex tw:flex-col tw:gap-space-xs">
            <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Setup Snapshot</span>
            <div className="tw:w-full tw:h-36 tw:rounded tw:bg-surface-container tw:overflow-hidden tw:relative tw:flex tw:items-center tw:justify-center">
              {snapshot
                // eslint-disable-next-line @next/next/no-img-element
                ? <img className="tw:w-full tw:h-full tw:object-cover" alt={`${t.symbol} chart at the time this backtest was saved`} src={snapshot} />
                : <span className="tw:text-on-surface-variant tw:font-body-sm tw:text-body-sm tw:flex tw:items-center tw:gap-space-xs"><Icon name="hide_image" className="tw:text-[18px]" />{hasSnapshot && snapshot === null ? 'Loading snapshot…' : 'No snapshot saved'}</span>}
              {t.interval && (
                <div className="tw:absolute tw:bottom-2 tw:left-2 tw:px-space-xs tw:py-0.5 tw:rounded tw:bg-surface-container-lowest/80 tw:text-primary tw:font-label-caps tw:text-label-caps tw:backdrop-blur-xs">
                  {intervalLabel(t.interval)} TIMEFRAME
                </div>
              )}
            </div>
          </div>
          <div className="tw:flex tw:flex-col tw:gap-space-xs">
            <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Execution Observations</span>
            <p className="tw:font-body-md tw:text-body-md tw:text-on-surface tw:bg-surface-container tw:p-space-sm tw:rounded tw:leading-relaxed tw:whitespace-pre-wrap">{t.notes || 'No notes recorded for this backtest.'}</p>
          </div>
        </div>
        <div className="tw:flex tw:items-center tw:gap-space-xs tw:pt-space-lg">
          <button type="button" onClick={onLoad} disabled={!t.entryTime} title={t.entryTime ? undefined : 'Quick logs have no chart to replay'}
            className="tw:flex-1 tw:min-h-[44px] tw:flex tw:items-center tw:justify-center tw:gap-space-xs tw:rounded tw:bg-surface-container-high tw:hover:bg-surface-variant tw:text-on-surface tw:font-label-action tw:text-label-action tw:disabled:opacity-40">
            <Icon name="replay" className="tw:text-[18px]" />
            <span>Load in Workspace</span>
          </button>
          <button type="button" onClick={onClose} className="tw:min-h-[44px] tw:px-space-md tw:rounded tw:bg-primary-container tw:text-on-primary-container tw:font-label-action tw:text-label-action tw:font-semibold">Done</button>
        </div>
      </div>
    </div>
  );
}

function QuickLogModal({ symbols, strategies, onClose, onSaved }: {
  symbols: string[]; strategies: string[]; onClose: () => void; onSaved: (t: BacktestTrade) => void;
}) {
  const { activeSymbol } = useBacktest();
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState(activeSymbol);
  const [direction, setDirection] = useState<'long' | 'short'>('long');
  const [pnl, setPnl] = useState('');
  const [r, setR] = useState('');
  const [tag, setTag] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const input = 'tw:min-h-[44px] tw:px-space-md tw:bg-surface-container-low tw:text-on-surface tw:rounded tw:focus:outline-none tw:focus:bg-surface-container-high';
  const label = 'tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase';

  const submit = async () => {
    const rValue = Number(r);
    if (!symbol.trim()) { setErr('Symbol is required.'); return; }
    if (r.trim() === '' || !Number.isFinite(rValue)) { setErr('Enter the R multiple (e.g. 2.5 or -1).'); return; }
    const pnlValue = pnl.trim() === '' ? 0 : Number(pnl);
    if (!Number.isFinite(pnlValue)) { setErr('P&L must be a number.'); return; }
    setSaving(true); setErr('');
    try {
      const res = await fetch('/api/backtest-trades', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          source: 'quick', name: name.trim(), symbol: symbol.trim().toUpperCase(), direction,
          outcome: rValue > 0 ? 'win' : rValue < 0 ? 'loss' : 'breakeven',
          rMultiple: rValue, pnlUSD: pnlValue, riskAmount: rValue !== 0 && pnlValue ? Math.abs(pnlValue / rValue) : 0,
          tags: tag.trim() ? [tag.trim()] : [],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not record trade');
      onSaved(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not record trade');
      setSaving(false);
    }
  };

  return (
    <div className="tw:fixed tw:inset-0 tw:z-50" role="dialog" aria-modal="true" aria-label="Quick Trade Log">
      <div className="tw:absolute tw:inset-0 tw:bg-surface-container-lowest/85 tw:backdrop-blur-sm" onClick={onClose} />
      <div className="tw:absolute tw:top-1/2 tw:left-1/2 tw:-translate-x-1/2 tw:-translate-y-1/2 tw:w-[90%] tw:max-w-md tw:bg-surface-container tw:p-gutter tw:rounded-xl tw:shadow-2xl tw:flex tw:flex-col tw:gap-space-md">
        <div className="tw:flex tw:items-center tw:justify-between">
          <div className="tw:flex tw:items-center tw:gap-space-xs">
            <Icon name="add_box" className="tw:text-primary tw:text-[20px]" />
            <h3 className="tw:font-headline-md tw:text-headline-md tw:font-bold tw:text-on-surface">Quick Trade Log</h3>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="tw:min-h-[44px] tw:min-w-[44px] tw:flex tw:items-center tw:justify-center tw:text-on-surface-variant tw:hover:text-on-surface">
            <Icon name="close" className="tw:text-[20px]" />
          </button>
        </div>
        <label className="tw:flex tw:flex-col tw:gap-space-xs">
          <span className={label}>Setup Label</span>
          <input className={`${input} tw:font-body-sm tw:text-body-sm`} value={name} onChange={e => setName(e.target.value)} maxLength={100} placeholder="e.g. Asia Liquidity Sweep" type="text" autoFocus />
        </label>
        <div className="tw:grid tw:grid-cols-2 tw:gap-space-xs">
          <label className="tw:flex tw:flex-col tw:gap-space-xs">
            <span className={label}>Symbol</span>
            <input className={`${input} tw:font-body-sm tw:text-body-sm tw:uppercase`} list="bt-quick-symbols" value={symbol} onChange={e => setSymbol(e.target.value)} maxLength={40} />
            <datalist id="bt-quick-symbols">{symbols.map(s => <option key={s} value={s} />)}</datalist>
          </label>
          <label className="tw:flex tw:flex-col tw:gap-space-xs">
            <span className={label}>Direction</span>
            <select className={`${input} tw:font-body-sm tw:text-body-sm`} value={direction} onChange={e => setDirection(e.target.value as 'long' | 'short')}>
              <option value="long">LONG</option>
              <option value="short">SHORT</option>
            </select>
          </label>
        </div>
        <div className="tw:grid tw:grid-cols-2 tw:gap-space-xs">
          <label className="tw:flex tw:flex-col tw:gap-space-xs">
            <span className={label}>P&amp;L ($)</span>
            <input className={`${input} tw:font-mono-metric-md tw:text-mono-metric-md`} value={pnl} onChange={e => setPnl(e.target.value)} placeholder="+250.00" type="number" step="any" />
          </label>
          <label className="tw:flex tw:flex-col tw:gap-space-xs">
            <span className={label}>R Multiple</span>
            <input className={`${input} tw:font-mono-metric-md tw:text-mono-metric-md`} value={r} onChange={e => setR(e.target.value)} placeholder="2.5" step="0.1" type="number" />
          </label>
        </div>
        <label className="tw:flex tw:flex-col tw:gap-space-xs">
          <span className={label}>Strategy Tag</span>
          <input className={`${input} tw:font-body-sm tw:text-body-sm`} list="bt-quick-tags" value={tag} onChange={e => setTag(e.target.value)} maxLength={40} placeholder="e.g. ICT Silver Bullet" />
          <datalist id="bt-quick-tags">{strategies.map(s => <option key={s} value={s} />)}</datalist>
        </label>
        {err && <p className="tw:text-error tw:font-body-sm tw:text-body-sm">{err}</p>}
        <button type="button" onClick={() => void submit()} disabled={saving}
          className="tw:w-full tw:min-h-[44px] tw:mt-space-xs tw:rounded tw:bg-primary-container tw:hover:bg-primary-fixed-dim tw:text-on-primary-container tw:font-label-action tw:text-label-action tw:font-semibold tw:active:scale-95 tw:transition-all tw:disabled:opacity-60">
          {saving ? 'Recording…' : 'Record to Backtest Database'}
        </button>
      </div>
    </div>
  );
}
