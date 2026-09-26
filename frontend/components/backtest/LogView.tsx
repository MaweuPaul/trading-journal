'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AgentBadge, AgentRunsToggle } from './AgentRuns';
import { Icon } from './BacktestShell';
import { downloadLogCsv, downloadLogJson } from './exporting';
import { useIsDesktop } from './layout';
import {
  BacktestTrade, authHeaders, fmtDate, fmtPrice, fmtR, fmtUSD, hashTag, intervalLabel, tagsOf, useBacktest,
} from './data';

type Outcome = 'ALL' | 'win' | 'loss' | 'breakeven';
type Direction = 'ALL' | 'long' | 'short';
const RANGES = [{ value: 'ALL', label: 'All Time' }, { value: '7', label: 'Past 7 Days' }, { value: '30', label: 'Past 30 Days' }, { value: '90', label: 'Past 90 Days' }, { value: '365', label: 'Past Year' }] as const;
const OPTIONAL_COLS = [['strategy', 'Strategy Tag'], ['tf', 'TF'], ['entry', 'Entry Price'], ['exit', 'Exit Price'], ['pnl', 'Simulated P&L'], ['plan', 'Plan?'], ['date', 'Date Simulated']] as const;
type OptionalCol = typeof OPTIONAL_COLS[number][0];
type SortKey = 'date' | 'r';

// Filters live in the URL (?strategy=ORB&outcome=loss&page=2...), so a refresh,
// the back button or a shared link keeps them. Defaults are left out.
const FILTER_DEFAULTS = { strategy: 'ALL', symbol: 'ALL', outcome: 'ALL', dir: 'ALL', tf: 'ALL', range: 'ALL', q: '', sort: 'date', page: '1', size: '10' } as const;
type FilterKey = keyof typeof FILTER_DEFAULTS;
const oneOf = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);

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


export default function LogView() {
  const router = useRouter();
  const { trades, allTrades, loading, error, removeTrade, addTrade, strategies, setActiveSymbol } = useBacktest();
  const params = useSearchParams();
  const pathname = usePathname();
  const initial = (key: FilterKey) => params.get(key) ?? FILTER_DEFAULTS[key];
  const [strategy, setStrategy] = useState(() => initial('strategy'));
  const [symbol, setSymbol] = useState(() => initial('symbol'));
  const [outcome, setOutcome] = useState<Outcome>(() => oneOf(params.get('outcome'), ['ALL', 'win', 'loss', 'breakeven'] as const, 'ALL'));
  const [search, setSearch] = useState(() => initial('q'));
  const [sort, setSort] = useState<SortKey>(() => oneOf(params.get('sort'), ['date', 'r'] as const, 'date'));
  const [direction, setDirection] = useState<Direction>(() => oneOf(params.get('dir'), ['ALL', 'long', 'short'] as const, 'ALL'));
  const [tf, setTf] = useState(() => initial('tf'));
  const [range, setRange] = useState<string>(() => oneOf(params.get('range'), RANGES.map(r => r.value), 'ALL'));
  const [page, setPage] = useState(() => Math.max(1, Math.floor(Number(params.get('page'))) || 1));
  const [pageSize, setPageSize] = useState(() => Number(oneOf(params.get('size'), ['10', '25', '50', '100'] as const, '10')));
  const [compact, setCompact] = useState(false);
  const [showCols, setShowCols] = useState(false);
  const [hiddenCols, setHiddenCols] = useState<Set<OptionalCol>>(() => new Set());
  const isDesktop = useIsDesktop();
  const [inspect, setInspect] = useState<BacktestTrade | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  // Mirror the filters into the URL (replace, not push, so Back leaves the Log
  // rather than stepping through every filter change).
  useEffect(() => {
    const values: Record<FilterKey, string> = { strategy, symbol, outcome, dir: direction, tf, range, q: search, sort, page: String(page), size: String(pageSize) };
    const next = new URLSearchParams(params.toString());
    for (const key of Object.keys(FILTER_DEFAULTS) as FilterKey[]) {
      if (values[key] === FILTER_DEFAULTS[key]) next.delete(key); else next.set(key, values[key]);
    }
    const query = next.toString();
    if (query !== params.toString()) router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [strategy, symbol, outcome, direction, tf, range, search, sort, page, pageSize, params, pathname, router]);

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
      && (direction === 'ALL' || t.direction === direction)
      && (tf === 'ALL' || t.interval === tf)
      && (range === 'ALL' || Date.now() - new Date(t.createdAt).getTime() <= Number(range) * 86_400_000)
      && (!q || [t.name, t.symbol, t.notes, ...tagsOf(t), hashTag(tagsOf(t)[0] ?? '')].some(v => v?.toLowerCase().includes(q))));
    return [...rows].sort((a, b) => sort === 'r'
      ? b.rMultiple - a.rMultiple
      : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [trades, strategy, symbol, outcome, direction, tf, range, search, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const intervals = useMemo(() => Array.from(new Set(trades.map(t => t.interval).filter(Boolean))), [trades]);
  // Stable "#BT-0007" ids: numbered in the order backtests were logged.
  const seqById = useMemo(() => {
    const ordered = [...allTrades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return new Map(ordered.map((t, i) => [t._id, `#BT-${String(i + 1).padStart(4, '0')}`]));
  }, [allTrades]);
  const thisWeek = useMemo(() => trades.filter(t => Date.now() - new Date(t.createdAt).getTime() < 7 * 86_400_000).length, [trades]);

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

  const resetFilters = () => { setStrategy('ALL'); setSymbol('ALL'); setOutcome('ALL'); setDirection('ALL'); setTf('ALL'); setRange('ALL'); setSearch(''); setSort('date'); setPage(1); };
  const onDelete = async (e: React.MouseEvent, t: BacktestTrade) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${t.name || t.symbol}" from the backtest log?`)) return;
    if (await removeTrade(t._id)) { setToast('Backtest deleted'); if (inspect?._id === t._id) setInspect(null); }
    else setToast('Could not delete that backtest');
  };
  const exportData = (kind: 'CSV' | 'JSON') => {
    if (kind === 'CSV') downloadLogCsv(filtered);
    else downloadLogJson(filtered);
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

  // ── Desktop terminal table (Stitch "Desktop Backtest Log", >= 900px) ───────
  const show = (col: OptionalCol) => !hiddenCols.has(col);
  const toggleCol = (col: OptionalCol) => setHiddenCols(cur => { const next = new Set(cur); if (next.has(col)) next.delete(col); else next.add(col); return next; });
  const cell = compact ? 'tw:py-1' : 'tw:py-2';
  const th = 'tw:py-2 tw:border-r tw:border-outline-variant tw:font-semibold';
  const toolBtn = 'tw:bg-surface-container-high tw:hover:bg-surface-container-highest tw:border tw:border-outline-variant tw:rounded tw:px-2 tw:py-1 tw:text-body-sm tw:font-label-action tw:text-on-surface tw:flex tw:items-center tw:gap-1 tw:transition-colors';
  const filterSel = (label: string, value: string, onChange: (v: string) => void, options: [string, string][]) => (
    <label className="tw:relative tw:bg-surface-container-high tw:hover:bg-surface-container-highest tw:border tw:border-outline-variant tw:rounded tw:pl-2 tw:pr-6 tw:py-1 tw:text-body-sm tw:font-label-action tw:text-on-surface tw:flex tw:items-center tw:gap-1.5 tw:transition-colors">
      <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant">{label}</span>
      <select value={value} onChange={e => { onChange(e.target.value); setPage(1); }} className="tw:appearance-none tw:bg-transparent tw:focus:outline-none tw:cursor-pointer">
        {options.map(([v, l]) => <option key={v} value={v} className="tw:bg-surface-container">{l}</option>)}
      </select>
      <Icon name="arrow_drop_down" className="tw:absolute tw:right-1 tw:text-sm tw:text-on-surface-variant tw:pointer-events-none" />
    </label>
  );
  const kpi = (label: string, value: React.ReactNode, aside: React.ReactNode, icon: string, iconCls: string) => (
    <div className="tw:bg-surface-container tw:border tw:border-outline-variant tw:rounded tw:p-2.5 tw:flex tw:items-center tw:justify-between tw:shadow-sm">
      <div>
        <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase tw:tracking-wider tw:block">{label}</span>
        <div className="tw:flex tw:items-baseline tw:gap-2 tw:mt-0.5">{value}{aside}</div>
      </div>
      <div className={`tw:w-8 tw:h-8 tw:rounded tw:bg-surface-container-high tw:border tw:border-outline-variant tw:flex tw:items-center tw:justify-center ${iconCls}`}><Icon name={icon} className="tw:text-lg" /></div>
    </div>
  );
  const fresh = (t: BacktestTrade) => Date.now() - new Date(t.createdAt).getTime() < 86_400_000;

  const desktopView = (
    <div className="tw:flex tw:flex-col tw:bg-background tw:min-h-[calc(100dvh-44px)]">
      {/* KPI summary bar */}
      <section className="tw:p-3 tw:bg-surface-container-low tw:border-b tw:border-outline-variant">
        <div className="tw:grid tw:grid-cols-2 tw:xl:grid-cols-4 tw:gap-2.5">
          {kpi('Total Logged Sessions',
            <span className="tw:font-mono-metric-lg tw:text-mono-metric-lg tw:text-on-surface tw:font-bold">{stats.n}</span>,
            thisWeek > 0 && <span className="tw:text-secondary tw:font-label-caps tw:text-label-caps tw:flex tw:items-center tw:font-medium tw:bg-secondary-container/20 tw:px-1 tw:rounded"><Icon name="arrow_upward" className="tw:text-xs" />+{thisWeek} this week</span>,
            'folder_open', 'tw:text-on-surface-variant')}
          {kpi('Win Rate',
            <span className={`tw:font-mono-metric-lg tw:text-mono-metric-lg tw:font-bold ${stats.winRate >= 50 ? 'tw:text-secondary' : stats.n ? 'tw:text-error' : 'tw:text-on-surface'}`}>{stats.n ? `${stats.winRate.toFixed(1)}%` : '—'}</span>,
            <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant">{stats.wins} Wins / {stats.losses} Losses</span>,
            'pie_chart', 'tw:text-secondary')}
          {kpi('Cumulative Simulated Return',
            <span className={`tw:font-mono-metric-lg tw:text-mono-metric-lg tw:font-bold ${valueTone(stats.totalR)}`}>{fmtR(stats.totalR).replace('R', ' R')}</span>,
            <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-primary tw:font-medium">({fmtUSD(stats.totalPnl)} SIM)</span>,
            stats.totalR >= 0 ? 'trending_up' : 'trending_down', 'tw:text-primary')}
          {kpi('Average R Multiple',
            <span className="tw:font-mono-metric-lg tw:text-mono-metric-lg tw:text-on-surface tw:font-bold">{fmtR(stats.avgR).replace('R', ' R')}</span>,
            <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:bg-surface-container-high tw:px-1.5 tw:py-0.5 tw:rounded tw:border tw:border-outline-variant">WIN {fmtR(stats.avgWin, 1)} / LOSS {fmtR(stats.avgLoss, 1)}</span>,
            'calculate', 'tw:text-on-surface-variant')}
        </div>
      </section>

      {/* Filter & search controls */}
      <section className="tw:p-2.5 tw:bg-surface-container tw:border-b tw:border-outline-variant tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-2.5">
        <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2 tw:flex-1">
          <div className="tw:relative tw:flex-1 tw:min-w-[200px] tw:max-w-xs">
            <Icon name="search" className="tw:absolute tw:left-2.5 tw:top-1/2 tw:-translate-y-1/2 tw:text-on-surface-variant tw:text-base" />
            <input aria-label="Search backtests" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search by backtest name, tag, or notes..." type="text"
              className="tw:w-full tw:bg-surface-container-lowest tw:border tw:border-outline-variant tw:rounded tw:pl-8 tw:pr-2.5 tw:py-1 tw:text-body-sm tw:text-on-surface tw:placeholder:text-on-surface-variant/60 tw:focus:outline-none tw:focus:border-primary tw:transition-colors" />
          </div>
          {filterSel('STRATEGY:', strategy, setStrategy, [['ALL', `All Strategies (${strategies.length})`], ...strategies.map(s => [s, s] as [string, string])])}
          {filterSel('SYMBOL:', symbol, setSymbol, [['ALL', 'All Symbols'], ...symbols.map(s => [s, s] as [string, string])])}
          {filterSel('DIR:', direction, v => setDirection(v as Direction), [['ALL', 'All Directions'], ['long', 'Long'], ['short', 'Short']])}
          {filterSel('OUTCOME:', outcome, v => setOutcome(v as Outcome), [['ALL', 'All Outcomes'], ['win', `Wins (${counts.win})`], ['loss', `Losses (${counts.loss})`], ['breakeven', `Break Evens (${counts.breakeven})`]])}
          {filterSel('TF:', tf, setTf, [['ALL', 'All Timeframes'], ...intervals.map(i => [i, intervalLabel(i)] as [string, string])])}
          <label className="tw:relative tw:bg-surface-container-high tw:hover:bg-surface-container-highest tw:border tw:border-outline-variant tw:rounded tw:pl-2 tw:pr-6 tw:py-1 tw:text-body-sm tw:font-label-action tw:text-on-surface tw:flex tw:items-center tw:gap-1.5 tw:transition-colors">
            <Icon name="calendar_today" className="tw:text-sm tw:text-primary" />
            <select aria-label="Date range" value={range} onChange={e => { setRange(e.target.value); setPage(1); }} className="tw:appearance-none tw:bg-transparent tw:focus:outline-none tw:cursor-pointer">
              {RANGES.map(r => <option key={r.value} value={r.value} className="tw:bg-surface-container">{r.label}</option>)}
            </select>
            <Icon name="arrow_drop_down" className="tw:absolute tw:right-1 tw:text-sm tw:text-on-surface-variant tw:pointer-events-none" />
          </label>
          <button type="button" onClick={() => setSort(s => (s === 'date' ? 'r' : 'date'))} className={toolBtn} title={sort === 'date' ? 'Sort by R-Multiple' : 'Sort by date'}>
            <Icon name="swap_vert" className="tw:text-sm tw:text-on-surface-variant" /><span>Sort: {sort === 'date' ? 'Date' : 'R'}</span>
          </button>
          <button type="button" onClick={resetFilters} className={toolBtn} title="Reset filters" aria-label="Reset filters"><Icon name="restart_alt" className="tw:text-sm tw:text-on-surface-variant" /></button>
        </div>
        <div className="tw:flex tw:items-center tw:gap-2">
          <Link href="/backtest/strategies" className={toolBtn}><Icon name="rule" className="tw:text-sm tw:text-primary" /><span>Strategies</span></Link>
          <button type="button" onClick={() => setShowNew(true)} className={toolBtn} title="Log a trade without replaying it"><Icon name="add" className="tw:text-sm tw:text-primary" /><span>Quick Log</span></button>
          <button type="button" onClick={() => exportData('CSV')} disabled={!filtered.length} className={`${toolBtn} tw:disabled:opacity-40`} title="Export to CSV"><Icon name="file_download" className="tw:text-sm tw:text-on-surface-variant" /><span>Export CSV</span></button>
          <div className="tw:relative">
            <button type="button" onClick={() => setShowCols(v => !v)} aria-expanded={showCols} className={toolBtn} title="Toggle column display"><Icon name="view_column" className="tw:text-sm tw:text-on-surface-variant" /><span>Columns</span></button>
            {showCols && (
              <div className="tw:absolute tw:right-0 tw:top-full tw:mt-1 tw:z-30 tw:w-48 tw:bg-surface-container-high tw:border tw:border-outline-variant tw:rounded tw:shadow-xl tw:p-1.5 tw:flex tw:flex-col">
                {OPTIONAL_COLS.map(([key, label]) => (
                  <label key={key} className="tw:flex tw:items-center tw:justify-between tw:gap-2 tw:px-2 tw:py-1 tw:rounded tw:hover:bg-surface-bright tw:cursor-pointer tw:text-body-sm">
                    <span>{label}</span>
                    <input type="checkbox" checked={show(key)} onChange={() => toggleCol(key)} className="tw:accent-primary" />
                  </label>
                ))}
              </div>
            )}
          </div>
          <button type="button" onClick={() => setCompact(c => !c)} aria-pressed={compact} className={`${toolBtn} ${compact ? 'tw:border-primary tw:text-primary' : ''}`} title="Compact table view"><Icon name="density_small" className="tw:text-sm tw:text-on-surface-variant" /><span>Compact</span></button>
        </div>
      </section>

      {/* Dense backtest table */}
      <div className="tw:flex-1 tw:overflow-x-auto">
        {loading ? (
          <div className="tw:py-12 tw:flex tw:justify-center tw:text-on-surface-variant"><Icon name="progress_activity" className="tw:text-[28px] tw:animate-spin" /></div>
        ) : error ? (
          <div className="tw:m-3 tw:p-3 tw:rounded tw:bg-error/10 tw:text-error tw:text-body-sm">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="tw:flex tw:flex-col tw:items-center tw:justify-center tw:py-16 tw:text-center">
            <Icon name="manage_search" className="tw:text-[36px] tw:text-primary" />
            <h3 className="tw:mt-2 tw:text-headline-md tw:font-semibold tw:text-on-surface">{trades.length ? 'No backtests match these filters' : 'No backtests logged yet'}</h3>
            <p className="tw:mt-1 tw:text-body-sm tw:text-on-surface-variant tw:max-w-sm">{trades.length ? 'Loosen a filter or clear the search to see more simulated trades.' : 'Replay a chart in the workspace, or quick-log a trade.'}</p>
            {trades.length > 0
              ? <button type="button" onClick={resetFilters} className={`${toolBtn} tw:mt-3 tw:text-primary`}>Clear All Filters</button>
              : <Link href="/backtest/new" className={`${toolBtn} tw:mt-3 tw:text-primary`}>Start New Backtest</Link>}
          </div>
        ) : (
          <table className="tw:w-full tw:text-left tw:border-collapse">
            <thead className="tw:bg-surface-container-low tw:text-on-surface-variant tw:font-label-caps tw:text-label-caps tw:uppercase tw:border-b tw:border-outline-variant tw:shadow-sm">
              <tr>
                <th className={`${th} tw:px-3`}>ID / Backtest Name</th>
                {show('strategy') && <th className={`${th} tw:px-3`}>Strategy Tag</th>}
                <th className={`${th} tw:px-2.5`}>Symbol</th>
                {show('tf') && <th className={`${th} tw:px-2 tw:text-center`}>TF</th>}
                <th className={`${th} tw:px-2.5 tw:text-center`}>Direction</th>
                {show('entry') && <th className={`${th} tw:px-3 tw:text-right`}>Entry Price</th>}
                {show('exit') && <th className={`${th} tw:px-3 tw:text-right`}>Exit Price</th>}
                <th className={`${th} tw:px-2.5 tw:text-center`}>Outcome</th>
                <th className={`${th} tw:px-3 tw:text-right`}>Realized R</th>
                {show('pnl') && <th className={`${th} tw:px-3 tw:text-right`}>Simulated P&amp;L</th>}
                {show('plan') && <th className={`${th} tw:px-2.5 tw:text-center`}>Plan?</th>}
                {show('date') && <th className={`${th} tw:px-3`}>Date Simulated</th>}
                <th className="tw:py-2 tw:px-3 tw:font-semibold tw:text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="tw:divide-y tw:divide-outline-variant tw:text-body-sm">
              {pageRows.map(t => {
                const tag = tagsOf(t)[0];
                const isNew = fresh(t);
                const long = t.direction === 'long';
                const outcomeCls = t.outcome === 'win' ? 'tw:bg-secondary-container/20 tw:text-secondary tw:border-secondary/30' : t.outcome === 'loss' ? 'tw:bg-error/20 tw:text-error tw:border-error/30' : 'tw:bg-surface-container-highest tw:text-on-surface-variant tw:border-outline-variant';
                return (
                  <tr key={t._id} onClick={() => router.push(`/backtest/${t._id}`)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') router.push(`/backtest/${t._id}`); }}
                    className={`tw:transition-colors tw:cursor-pointer tw:group tw:focus:outline-none tw:focus:bg-surface-container-high ${isNew ? 'tw:bg-surface-container-high/90 tw:hover:bg-surface-container-high tw:border-l-2 tw:border-l-primary tw:shadow-[inset_0_0_12px_rgba(245,158,11,0.06)]' : 'tw:hover:bg-surface-container'}`}>
                    <td className={`${cell} tw:px-3 tw:border-r tw:border-outline-variant`}>
                      <div className="tw:flex tw:items-center tw:gap-1.5">
                        {isNew && <span className="tw:w-1.5 tw:h-1.5 tw:rounded-full tw:bg-primary tw:animate-pulse" title="Logged in the last 24h" />}
                        <span className={`tw:font-mono-metric-md tw:text-mono-metric-md tw:font-semibold ${isNew ? 'tw:text-primary' : 'tw:text-on-surface-variant'}`}>{seqById.get(t._id)}</span>
                        <span className="tw:text-on-surface tw:font-medium tw:truncate tw:max-w-[220px]" title={t.name}>{t.name || 'Untitled setup'}</span>
                        <AgentBadge trade={t} />
                      </div>
                    </td>
                    {show('strategy') && (
                      <td className={`${cell} tw:px-3 tw:border-r tw:border-outline-variant`}>
                        {tag ? <span className="tw:font-label-caps tw:text-label-caps tw:bg-primary-container/15 tw:text-primary tw:border tw:border-primary/30 tw:px-1.5 tw:py-0.5 tw:rounded tw:whitespace-nowrap">{hashTag(tag)}</span> : <span className="tw:text-on-surface-variant">—</span>}
                      </td>
                    )}
                    <td className={`${cell} tw:px-2.5 tw:border-r tw:border-outline-variant tw:font-mono-metric-md tw:text-mono-metric-md tw:font-semibold tw:text-on-surface`}>{t.symbol}</td>
                    {show('tf') && <td className={`${cell} tw:px-2 tw:border-r tw:border-outline-variant tw:text-center tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface-variant`}>{t.interval ? intervalLabel(t.interval) : '—'}</td>}
                    <td className={`${cell} tw:px-2.5 tw:border-r tw:border-outline-variant tw:text-center`}>
                      <span className={`tw:font-label-caps tw:text-label-caps tw:px-2 tw:py-0.5 tw:rounded tw:font-bold tw:border tw:flex tw:items-center tw:justify-center tw:gap-0.5 tw:mx-auto tw:w-fit ${long ? 'tw:border-secondary/40 tw:text-secondary tw:bg-secondary/10' : 'tw:border-error/40 tw:text-error tw:bg-error/10'}`}>
                        <Icon name={long ? 'arrow_upward' : 'arrow_downward'} className="tw:text-xs" />{long ? 'LONG' : 'SHORT'}
                      </span>
                    </td>
                    {show('entry') && <td className={`${cell} tw:px-3 tw:border-r tw:border-outline-variant tw:text-right tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface`}>{t.source === 'quick' ? '—' : fmtPrice(t.entryPrice)}</td>}
                    {show('exit') && <td className={`${cell} tw:px-3 tw:border-r tw:border-outline-variant tw:text-right tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface`}>{t.source === 'quick' ? '—' : fmtPrice(t.exitPrice)}</td>}
                    <td className={`${cell} tw:px-2.5 tw:border-r tw:border-outline-variant tw:text-center`}>
                      <span className={`tw:font-label-caps tw:text-label-caps tw:px-1.5 tw:py-0.5 tw:rounded tw:font-bold tw:border ${outcomeCls}`}>{t.outcome === 'breakeven' ? 'BE' : t.outcome.toUpperCase()}</span>
                    </td>
                    <td className={`${cell} tw:px-3 tw:border-r tw:border-outline-variant tw:text-right tw:font-mono-metric-md tw:text-mono-metric-md tw:font-bold ${valueTone(t.rMultiple)}`}>{fmtR(t.rMultiple).replace('R', ' R')}</td>
                    {show('pnl') && <td className={`${cell} tw:px-3 tw:border-r tw:border-outline-variant tw:text-right tw:font-mono-metric-md tw:text-mono-metric-md tw:font-semibold ${valueTone(t.pnlUSD)}`}>{t.riskAmount > 0 || t.pnlUSD ? fmtUSD(t.pnlUSD) : '—'}</td>}
                    {show('plan') && (
                      <td className={`${cell} tw:px-2.5 tw:border-r tw:border-outline-variant tw:text-center`}>
                        {t.planFollowed == null ? <span className="tw:text-on-surface-variant" title="Not reviewed">—</span>
                          : t.planFollowed ? <Icon name="check_circle" className="tw:text-secondary tw:text-base" />
                            : <Icon name="warning" className="tw:text-primary tw:text-base" />}
                        <span className="tw:sr-only">{t.planFollowed == null ? 'Not reviewed' : t.planFollowed ? 'Plan followed' : 'Plan not followed'}</span>
                      </td>
                    )}
                    {show('date') && <td className={`${cell} tw:px-3 tw:border-r tw:border-outline-variant tw:text-on-surface-variant tw:font-mono-metric-md tw:text-mono-metric-md tw:whitespace-nowrap`}>{fmtDate(t.createdAt)}</td>}
                    <td className={`${cell} tw:px-3 tw:text-center`}>
                      <div className="tw:flex tw:items-center tw:justify-center tw:gap-1.5">
                        <Link href={`/backtest/${t._id}`} onClick={e => e.stopPropagation()} className="tw:bg-primary-container/20 tw:hover:bg-primary-container tw:text-primary tw:hover:text-on-primary-container tw:border tw:border-primary/40 tw:px-2 tw:py-0.5 tw:rounded tw:font-label-action tw:text-[11px] tw:transition-all tw:whitespace-nowrap">Case Study →</Link>
                        <button type="button" onClick={e => void onDelete(e, t)} className="tw:text-on-surface-variant tw:hover:text-error tw:transition-colors tw:p-1" title="Delete record" aria-label={`Delete ${t.name || t.symbol}`}><Icon name="delete" className="tw:text-sm" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination footer */}
      {filtered.length > 0 && (
        <footer className="tw:h-9 tw:px-4 tw:bg-surface-container-low tw:border-t tw:border-outline-variant tw:flex tw:items-center tw:justify-between tw:text-body-sm">
          <div className="tw:flex tw:items-center tw:gap-4 tw:text-on-surface-variant tw:font-mono-metric-md tw:text-xs">
            <span>Showing <strong className="tw:text-on-surface">{(currentPage - 1) * pageSize + 1}-{Math.min(currentPage * pageSize, filtered.length)}</strong> of <strong className="tw:text-primary">{filtered.length}</strong> simulated trades</span>
            <span className="tw:text-outline-variant">|</span>
            <label className="tw:flex tw:items-center tw:gap-1">
              <span>Rows per page:</span>
              <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }} className="tw:bg-surface-container tw:border tw:border-outline-variant tw:rounded tw:px-1.5 tw:py-0.5 tw:text-xs tw:text-on-surface tw:focus:outline-none tw:focus:border-primary">
                {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <div className="tw:flex tw:items-center tw:gap-2">
            {([['first_page', 1, currentPage === 1, 'First page'], ['chevron_left', currentPage - 1, currentPage === 1, 'Previous page']] as const).map(([icon, target, disabled, label]) => (
              <button key={icon} type="button" aria-label={label} disabled={disabled} onClick={() => setPage(target)} className="tw:w-6 tw:h-6 tw:flex tw:items-center tw:justify-center tw:rounded tw:bg-surface-container tw:border tw:border-outline-variant tw:text-on-surface-variant tw:hover:text-on-surface tw:disabled:opacity-40 tw:disabled:cursor-not-allowed tw:transition-colors"><Icon name={icon} className="tw:text-sm" /></button>
            ))}
            <span className="tw:font-mono-metric-md tw:text-xs tw:px-2 tw:text-on-surface">Page <strong className="tw:text-primary">{currentPage}</strong> of {pageCount}</span>
            {([['chevron_right', currentPage + 1, currentPage === pageCount, 'Next page'], ['last_page', pageCount, currentPage === pageCount, 'Last page']] as const).map(([icon, target, disabled, label]) => (
              <button key={icon} type="button" aria-label={label} disabled={disabled} onClick={() => setPage(target)} className="tw:w-6 tw:h-6 tw:flex tw:items-center tw:justify-center tw:rounded tw:bg-surface-container tw:border tw:border-outline-variant tw:text-on-surface-variant tw:hover:text-on-surface tw:disabled:opacity-40 tw:disabled:cursor-not-allowed tw:transition-colors"><Icon name={icon} className="tw:text-sm" /></button>
            ))}
          </div>
        </footer>
      )}
    </div>
  );


  return (
    <div className="tw:flex tw:flex-col tw:w-full">
      {toast && (
        <div role="status" className="tw:fixed tw:top-16 tw:left-1/2 tw:-translate-x-1/2 tw:z-50 tw:flex tw:items-center tw:gap-space-sm tw:bg-surface-bright tw:text-on-surface tw:px-space-md tw:py-space-sm tw:rounded tw:shadow-xl">
          <Icon name="check_circle" className="tw:text-[16px] tw:text-secondary" />
          <span className="tw:font-body-sm tw:text-body-sm tw:font-medium">{toast}</span>
        </div>
      )}

      {isDesktop ? desktopView : (<>
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
            <Link href="/backtest/strategies" className="tw:min-h-[44px] tw:px-space-md tw:flex tw:items-center tw:gap-space-xs tw:rounded tw:bg-surface-container-high tw:hover:bg-surface-variant tw:text-on-surface tw:font-label-action tw:text-label-action tw:transition-colors">
              <Icon name="rule" className="tw:text-[18px] tw:text-primary" />
              <span className="tw:hidden tw:sm:inline">Strategies</span>
            </Link>
            <Link href="/backtest/new" className="tw:min-h-[44px] tw:px-space-md tw:flex tw:items-center tw:gap-space-xs tw:rounded tw:bg-primary-container tw:hover:bg-primary-fixed-dim tw:text-on-primary-container tw:font-label-action tw:text-label-action tw:font-semibold tw:shadow-md tw:active:scale-95 tw:transition-all">
              <Icon name="add_circle" className="tw:text-[18px]" />
              <span>New Backtest</span>
            </Link>
          </div>
        </div>

        {/* On desktop this sits in the Backtest header instead. */}
        <AgentRunsToggle size="lg" />
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
              <div key={t._id} role="button" tabIndex={0} onClick={() => router.push(`/backtest/${t._id}`)} onKeyDown={e => { if (e.key === 'Enter') router.push(`/backtest/${t._id}`); }}
                className="tw:group tw:p-space-md tw:rounded tw:bg-surface-container tw:hover:bg-surface-container-high tw:transition-all tw:cursor-pointer tw:flex tw:flex-col tw:gap-space-xs tw:shadow-sm">
                <div className="tw:flex tw:items-center tw:justify-between tw:gap-space-sm tw:min-w-0">
                  <div className="tw:flex tw:items-center tw:gap-space-xs tw:min-w-0">
                    <span className={`${chip} ${directionChip(t.direction)}`}>{t.direction === 'long' ? 'LONG' : 'SHORT'}</span>
                    <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:font-bold tw:text-on-surface">{t.symbol}</span>
                    {t.interval && <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase tw:bg-surface-container-highest tw:px-space-xs tw:py-0.5 tw:rounded">{intervalLabel(t.interval)}</span>}
                    <span className="tw:font-body-md tw:text-body-md tw:font-semibold tw:text-on-surface tw:truncate">{t.name || 'Untitled setup'}</span>
                    <AgentBadge trade={t} />
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
            Showing {(currentPage - 1) * pageSize + 1}-{Math.min(currentPage * pageSize, filtered.length)} of {filtered.length}
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
      </>)}

      {inspect && <InspectDrawer trade={inspect} onClose={() => setInspect(null)} onLoad={() => loadInWorkspace(inspect)} />}
      {showNew && (
        <QuickLogModal symbols={symbols} strategies={strategies} onClose={() => setShowNew(false)}
          onSaved={t => { addTrade(t); setShowNew(false); setToast('Trade recorded to backtest log'); }} />
      )}
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
