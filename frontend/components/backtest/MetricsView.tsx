'use client';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon } from './BacktestShell';
import { BacktestTrade, fmtR, fmtUSD, tagsOf, useBacktest } from './data';
import { computeStats, profitFactorGrade, sqnGrade, GroupStats } from './stats';

type Range = 'all' | '30' | '90' | 'ytd';
const RANGE_LABEL: Record<Range, string> = { all: 'All Time', '30': 'Last 30 Days', '90': 'Last 90 Days', ytd: 'Year to Date' };

const EW = 400, EH = 160, DH = 80;
// Below this sample size Sharpe/Sortino/Calmar/Kelly swing wildly and mislead.
const MIN_SAMPLE = 30;

function tone(n: number) { return n > 0 ? 'tw:text-secondary' : n < 0 ? 'tw:text-error' : 'tw:text-on-surface-variant'; }
function fmtRatio(n: number) { return Number.isFinite(n) ? n.toFixed(2) : '∞'; }

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

export default function MetricsView() {
  const { trades, loading, error, strategies } = useBacktest();
  const initialStrategy = useSearchParams().get('strategy');
  const [strategy, setStrategy] = useState(initialStrategy || 'ALL');
  const [range, setRange] = useState<Range>('all');
  const [benchmark, setBenchmark] = useState(false);
  const [breakdown, setBreakdown] = useState<'strategy' | 'symbol' | 'timeframe' | 'direction'>('strategy');
  const [hover, setHover] = useState<number | null>(null);
  const [now] = useState(() => Date.now());

  const filtered = useMemo(() => {
    const cutoff = range === '30' ? now - 30 * 864e5 : range === '90' ? now - 90 * 864e5 : range === 'ytd' ? new Date(new Date().getFullYear(), 0, 1).getTime() : 0;
    return trades.filter(t => (strategy === 'ALL' || tagsOf(t).includes(strategy)) && new Date(t.createdAt).getTime() >= cutoff);
  }, [trades, strategy, range, now]);
  const s = useMemo(() => computeStats(filtered), [filtered]);

  // ── Equity + drawdown geometry (viewBox units) ─────────────────────────────
  const geo = useMemo(() => {
    const pts = [{ r: 0, b: 0, dd: 0 }, ...s.curve.map(p => ({ r: p.cumulativeR, b: p.benchmarkR, dd: p.drawdownR }))];
    const values = pts.flatMap(p => (benchmark ? [p.r, p.b] : [p.r]));
    const min = Math.min(0, ...values), max = Math.max(0, ...values);
    const span = max - min || 1;
    const x = (i: number) => (i / Math.max(1, pts.length - 1)) * EW;
    const y = (v: number) => 12 + (1 - (v - min) / span) * (EH - 24);
    const line = (key: 'r' | 'b') => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
    const equity = line('r');
    const minDD = Math.min(-0.0001, ...pts.map(p => p.dd));
    const dy = (v: number) => 2 + (v / minDD) * (DH - 10);
    const dd = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${dy(p.dd).toFixed(1)}`).join(' ');
    return {
      pts, x, y, dy, zeroY: y(0),
      equity, equityArea: `${equity} L${EW},${EH} L0,${EH} Z`,
      bench: line('b'),
      dd, ddArea: `${dd} L${EW},2 L0,2 Z`,
    };
  }, [s.curve, benchmark]);

  // Milestones at ~25/50/80% of the sequence, like the design's T#10/T#25/T#40.
  const milestones = useMemo(() => {
    if (s.n < 4) return [] as number[];
    return Array.from(new Set([0.25, 0.55, 0.85].map(f => Math.max(1, Math.round(s.n * f))))).filter(i => i < s.n);
  }, [s.n]);
  const axisTicks = useMemo(() => {
    if (!s.n) return [0];
    return Array.from(new Set([0, 0.25, 0.5, 0.75, 1].map(f => Math.round(s.n * f))));
  }, [s.n]);

  const pct = (vx: number) => `${(vx / EW) * 100}%`;
  const pctY = (vy: number, h: number) => `${(vy / h) * 100}%`;
  const ddPct = s.maxDrawdownR < 0 && s.peakR > 0 ? (s.maxDrawdownR / (s.peakR || 1)) * 100 : null;

  const exportSummary = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const summary = {
      generatedAt: new Date().toISOString(), filter: { strategy, range: RANGE_LABEL[range] },
      trades: s.n, winRate: s.winRate, expectancyR: s.avgR, totalR: s.totalR, totalPnlUSD: s.totalPnl,
      profitFactor: s.profitFactor, sqn: s.sqn, sharpe: s.sharpe, sortino: s.sortino, calmar: s.calmar,
      halfKellyPct: s.kellyPct / 2, annualizedR: s.annualizedR, volatilityR: s.volatilityR,
      maxDrawdownR: s.maxDrawdownR, maxWinStreak: s.maxWinStreak, maxLossStreak: s.maxLossStreak,
      byStrategy: s.byStrategy, bySymbol: s.bySymbol, byTimeframe: s.byTimeframe, byDirection: s.byDirection,
      log: filtered.map(({ _id, name, symbol, direction, interval, outcome, rMultiple, pnlUSD, createdAt, ...rest }) => ({ _id, name, tags: tagsOf({ tags: rest.tags, strategy: rest.strategy }), symbol, direction, interval, outcome, rMultiple, pnlUSD, createdAt })),
    };
    download(`backtest-quant-summary-${stamp}.json`, JSON.stringify(summary, null, 2), 'application/json');
  };

  const hoverPoint = hover != null ? geo.pts[hover] : null;
  const hoverTrade: BacktestTrade | null = hover != null && hover > 0 ? s.curve[hover - 1]?.trade ?? null : null;
  const onChartMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (geo.pts.length - 1));
    setHover(Math.max(0, Math.min(geo.pts.length - 1, i)));
  };

  const sqn = sqnGrade(s.sqn);
  const selectBox = 'tw:w-full tw:min-h-[38px] tw:appearance-none tw:bg-transparent tw:text-on-surface tw:pl-7 tw:pr-6 tw:focus:outline-none';

  return (
    <div className="tw:flex tw:flex-col tw:w-full tw:gap-space-md tw:p-gutter tw:pb-space-xl">
      {/* Header filter ribbon */}
      <section className="tw:bg-surface-container tw:border tw:border-surface-container-highest tw:rounded-xl tw:p-space-md tw:shadow-md tw:flex tw:flex-col tw:gap-space-sm">
        <div className="tw:flex tw:items-center tw:justify-between">
          <div className="tw:flex tw:items-center tw:gap-space-xs">
            <Icon name="insights" className="tw:text-primary tw:text-[18px] tw:[font-variation-settings:'FILL'_1]" />
            <h1 className="tw:font-headline-md tw:text-headline-md tw:text-on-surface">Quant Analytics</h1>
          </div>
          <div className="tw:flex tw:items-center tw:gap-space-xs tw:bg-surface-container-highest tw:px-space-sm tw:py-1 tw:rounded-full">
            <span className={`tw:w-1.5 tw:h-1.5 tw:rounded-full ${error ? 'tw:bg-error' : 'tw:bg-secondary tw:animate-pulse'}`} />
            <span className={`tw:font-label-caps tw:text-label-caps tw:uppercase tw:tracking-wider ${error ? 'tw:text-error' : 'tw:text-secondary'}`}>{loading ? 'Syncing…' : error ? 'Offline' : `Synced • ${s.n} Trades`}</span>
          </div>
        </div>
        <div className="tw:grid tw:grid-cols-2 tw:gap-space-xs tw:sm:grid-cols-3">
          <label className="tw:relative tw:bg-surface-container tw:rounded tw:flex tw:items-center">
            <Icon name="tune" className="tw:absolute tw:left-space-sm tw:text-on-surface-variant tw:text-[16px] tw:pointer-events-none" />
            <select aria-label="Strategy" className={`${selectBox} tw:font-label-caps tw:text-label-caps`} value={strategy} onChange={e => setStrategy(e.target.value)}>
              <option value="ALL">All Strategies</option>
              {strategies.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
            <Icon name="expand_more" className="tw:absolute tw:right-space-sm tw:text-on-surface-variant tw:text-[14px] tw:pointer-events-none" />
          </label>
          <label className="tw:relative tw:bg-surface-container tw:rounded tw:flex tw:items-center">
            <Icon name="calendar_today" className="tw:absolute tw:left-space-sm tw:text-primary tw:text-[16px] tw:pointer-events-none" />
            <select aria-label="Date range" className={`${selectBox} tw:font-mono-metric-md tw:text-mono-metric-md`} value={range} onChange={e => setRange(e.target.value as Range)}>
              {(Object.keys(RANGE_LABEL) as Range[]).map(k => <option key={k} value={k}>{RANGE_LABEL[k]}</option>)}
            </select>
            <Icon name="arrow_drop_down" className="tw:absolute tw:right-space-sm tw:text-on-surface-variant tw:text-[14px] tw:pointer-events-none" />
          </label>
          <button type="button" onClick={() => setBenchmark(b => !b)} aria-pressed={benchmark}
            title="Compare against the same trades taken as plain longs (buy & hold over each trade's window)"
            className="tw:col-span-2 tw:sm:col-span-1 tw:bg-surface-container tw:hover:bg-surface-container-high tw:text-on-surface tw:font-label-action tw:text-label-action tw:rounded tw:px-space-sm tw:flex tw:items-center tw:justify-center tw:gap-1.5 tw:transition-colors tw:min-h-[38px]">
            <Icon name="compare_arrows" className="tw:text-primary-fixed-dim tw:text-[16px]" />
            <span>Benchmark (Buy &amp; Hold)</span>
            <span className={`tw:w-2 tw:h-2 tw:rounded-full ${benchmark ? 'tw:bg-primary' : 'tw:bg-surface-variant'}`} />
          </button>
        </div>
      </section>

      {/* Curve summary ribbon */}
      <div className="tw:bg-surface-container-lowest tw:rounded-xl tw:p-space-md tw:shadow-sm tw:flex tw:items-center tw:justify-between tw:flex-wrap tw:gap-space-sm">
        <div className="tw:flex tw:flex-col">
          <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Sequence Peak</span>
          <span className={`tw:font-mono-metric-lg tw:text-mono-metric-lg tw:font-bold ${tone(s.peakR)}`}>{fmtR(s.peakR, 1)}</span>
        </div>
        <div className="tw:w-px tw:h-7 tw:bg-surface-variant" />
        <div className="tw:flex tw:flex-col">
          <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Current Status</span>
          <span className="tw:font-mono-metric-lg tw:text-mono-metric-lg tw:text-primary tw:font-bold">{fmtR(s.totalR, 1)}</span>
        </div>
        <div className="tw:w-px tw:h-7 tw:bg-surface-variant" />
        <div className="tw:flex tw:flex-col tw:items-end">
          <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Net Cumulative</span>
          <span className={`tw:font-mono-metric-lg tw:text-mono-metric-lg tw:font-bold ${tone(s.totalPnl)}`}>{fmtUSD(s.totalPnl)}</span>
        </div>
      </div>

      {/* Equity curve */}
      <section className="tw:bg-surface-container tw:border tw:border-surface-container-highest tw:rounded-xl tw:p-space-md tw:shadow-md tw:flex tw:flex-col tw:gap-space-sm">
        <div className="tw:flex tw:items-center tw:justify-between">
          <div className="tw:flex tw:items-center tw:gap-space-xs">
            <Icon name="stacked_line_chart" className="tw:text-secondary tw:text-[18px]" />
            <h2 className="tw:font-label-caps tw:text-label-caps tw:text-on-surface tw:uppercase">Cumulative Equity (R-Multiple)</h2>
          </div>
          <div className="tw:flex tw:items-center tw:gap-space-xs">
            <span className="tw:w-2 tw:h-2 tw:rounded-full tw:bg-secondary" />
            <span className="tw:font-label-caps tw:text-label-caps tw:text-secondary">System</span>
            <span className={`tw:w-2 tw:h-2 tw:rounded-full tw:ml-1 ${benchmark ? 'tw:bg-primary-fixed-dim' : 'tw:bg-surface-variant'}`} />
            <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant">Buy &amp; Hold</span>
          </div>
        </div>
        <div className="tw:relative tw:w-full tw:h-44 tw:bg-surface-container-lowest tw:rounded-lg tw:overflow-hidden tw:p-space-xs" onMouseMove={s.n ? onChartMove : undefined} onMouseLeave={() => setHover(null)}>
          {s.n === 0 ? (
            <div className="tw:h-full tw:flex tw:items-center tw:justify-center tw:text-on-surface-variant tw:font-body-sm tw:text-body-sm">{loading ? 'Loading…' : 'No backtests in this range yet.'}</div>
          ) : (
            <div className="tw:relative tw:w-full tw:h-full">
              <svg className="tw:w-full tw:h-full tw:overflow-visible" preserveAspectRatio="none" viewBox={`0 0 ${EW} ${EH}`} aria-label="Cumulative equity curve">
                <defs>
                  <linearGradient id="btEquityGrad" x1="0%" x2="0%" y1="0%" y2="100%">
                    <stop offset="0%" stopColor="var(--bt-secondary)" stopOpacity="0.38" />
                    <stop offset="70%" stopColor="var(--bt-secondary)" stopOpacity="0.08" />
                    <stop offset="100%" stopColor="var(--bt-secondary)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {[0.125, 0.375, 0.625].map(f => <line key={f} stroke="var(--bt-surface-container-high)" strokeDasharray="3,3" strokeWidth="1" vectorEffect="non-scaling-stroke" x1="0" x2={EW} y1={EH * f} y2={EH * f} />)}
                <line stroke="var(--bt-surface-variant)" strokeWidth="1" vectorEffect="non-scaling-stroke" x1="0" x2={EW} y1={geo.zeroY} y2={geo.zeroY} />
                {benchmark && <path d={geo.bench} fill="none" stroke="var(--bt-primary-fixed-dim)" strokeOpacity="0.7" strokeDasharray="4,4" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
                <path d={geo.equityArea} fill="url(#btEquityGrad)" />
                <path d={geo.equity} fill="none" stroke="var(--bt-secondary)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
                {hover != null && <line x1={geo.x(hover)} x2={geo.x(hover)} y1="0" y2={EH} stroke="var(--bt-outline)" strokeDasharray="2,3" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
              </svg>
              {milestones.map((i, k) => {
                const last = k === milestones.length - 1;
                return (
                  <span key={i} className="tw:absolute tw:w-[9px] tw:h-[9px] tw:-translate-x-1/2 tw:-translate-y-1/2 tw:rounded-full tw:bg-surface-container tw:border-2"
                    style={{ left: pct(geo.x(i)), top: pctY(geo.y(geo.pts[i].r), EH), borderColor: last ? 'var(--bt-primary-fixed-dim)' : 'var(--bt-secondary)' }} />
                );
              })}
              <span className="tw:absolute tw:w-[11px] tw:h-[11px] tw:-translate-x-1/2 tw:-translate-y-1/2 tw:rounded-full tw:bg-secondary tw:border-2 tw:border-surface-container-lowest"
                style={{ left: '100%', top: pctY(geo.y(geo.pts[geo.pts.length - 1].r), EH) }} />
              {hover == null && milestones.map((i, k) => (
                <div key={i} className={`tw:absolute tw:-translate-x-1/2 tw:bg-surface-container-high/90 tw:backdrop-blur-sm tw:px-1.5 tw:py-0.5 tw:rounded tw:text-[10px] tw:font-mono-metric-md tw:shadow tw:whitespace-nowrap ${k === milestones.length - 1 ? 'tw:text-primary' : 'tw:text-on-surface'}`}
                  style={{ left: `clamp(40px, ${pct(geo.x(i))}, calc(100% - 40px))`, top: `max(2px, calc(${pctY(geo.y(geo.pts[i].r), EH)} - 26px))` }}>
                  T#{i} ({fmtR(geo.pts[i].r, 1)})
                </div>
              ))}
              {hoverPoint && (
                <div className="tw:absolute tw:top-1 tw:-translate-x-1/2 tw:bg-surface-container-high/95 tw:backdrop-blur-sm tw:px-1.5 tw:py-0.5 tw:rounded tw:text-[10px] tw:font-mono-metric-md tw:text-on-surface tw:shadow tw:whitespace-nowrap tw:pointer-events-none"
                  style={{ left: `clamp(70px, ${pct(geo.x(hover!))}, calc(100% - 70px))` }}>
                  T#{hover} {fmtR(hoverPoint.r, 1)}{hoverTrade && <> · <span className={tone(hoverTrade.rMultiple)}>{fmtR(hoverTrade.rMultiple)}</span> {hoverTrade.symbol}</>}
                  {benchmark && <> · B&amp;H {fmtR(hoverPoint.b, 1)}</>}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="tw:flex tw:items-center tw:justify-between tw:text-on-surface-variant tw:font-label-caps tw:text-label-caps tw:px-1">
          {axisTicks.map((i, k) => (
            <span key={i}>T#{i}{k === 0 ? ' (0.0R)' : k === axisTicks.length - 1 && s.n ? ` (${fmtR(s.totalR, 1)})` : ''}</span>
          ))}
        </div>
      </section>

      {/* Underwater drawdown */}
      <section className="tw:bg-surface-container tw:border tw:border-surface-container-highest tw:rounded-xl tw:p-space-md tw:shadow-md tw:flex tw:flex-col tw:gap-space-xs">
        <div className="tw:flex tw:items-center tw:justify-between">
          <div className="tw:flex tw:items-center tw:gap-space-xs">
            <Icon name="south_east" className="tw:text-tertiary-container tw:text-[18px]" />
            <h2 className="tw:font-label-caps tw:text-label-caps tw:text-on-surface tw:uppercase">Underwater Peak-to-Trough DD</h2>
          </div>
          <div className="tw:bg-error-container/40 tw:px-space-xs tw:py-0.5 tw:rounded">
            <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-error tw:font-semibold">Max: {fmtR(s.maxDrawdownR, 1)}{ddPct != null && ` (${ddPct.toFixed(1)}% of peak)`}</span>
          </div>
        </div>
        <div className="tw:relative tw:w-full tw:h-20 tw:bg-surface-container-lowest tw:rounded-lg tw:overflow-hidden tw:p-space-xs">
          {s.n > 0 && (
            <div className="tw:relative tw:w-full tw:h-full">
              <svg className="tw:w-full tw:h-full" preserveAspectRatio="none" viewBox={`0 0 ${EW} ${DH}`} aria-label="Drawdown from peak">
                <defs>
                  <linearGradient id="btDrawdownGrad" x1="0%" x2="0%" y1="0%" y2="100%">
                    <stop offset="0%" stopColor="var(--bt-error)" stopOpacity="0.1" />
                    <stop offset="100%" stopColor="var(--bt-error-container)" stopOpacity="0.55" />
                  </linearGradient>
                </defs>
                <line stroke="var(--bt-surface-variant)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" x1="0" x2={EW} y1="2" y2="2" />
                <line stroke="var(--bt-surface-container-high)" strokeDasharray="2,2" strokeWidth="1" vectorEffect="non-scaling-stroke" x1="0" x2={EW} y1={DH / 2} y2={DH / 2} />
                <path d={geo.ddArea} fill="url(#btDrawdownGrad)" />
                <path d={geo.dd} fill="none" stroke="var(--bt-error)" strokeLinejoin="round" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
              </svg>
              {s.maxDrawdownIndex >= 0 && (
                <>
                  <span className="tw:absolute tw:w-[6px] tw:h-[6px] tw:-translate-x-1/2 tw:-translate-y-1/2 tw:rounded-full tw:bg-error"
                    style={{ left: pct(geo.x(s.maxDrawdownIndex + 1)), top: pctY(geo.dy(s.maxDrawdownR), DH) }} />
                  <div className="tw:absolute tw:bottom-0 tw:-translate-x-1/2 tw:bg-surface-container-high/90 tw:px-1 tw:py-0.5 tw:rounded tw:text-[9px] tw:font-mono-metric-md tw:text-error tw:whitespace-nowrap"
                    style={{ left: `clamp(80px, ${pct(geo.x(s.maxDrawdownIndex + 1))}, calc(100% - 80px))` }}>
                    T#{s.maxDrawdownIndex + 1} Drawdown Valley ({fmtR(s.maxDrawdownR, 1)})
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Quant cards */}
      <section className="tw:flex tw:flex-col tw:gap-space-sm">
        <div className="tw:flex tw:items-center tw:justify-between tw:px-space-xs">
          <div className="tw:flex tw:items-center tw:gap-space-xs">
            <Icon name="insights" className="tw:text-primary tw:text-[18px]" />
            <h2 className="tw:font-label-caps tw:text-label-caps tw:text-on-surface tw:uppercase">Statistical Ratios &amp; Edge</h2>
          </div>
          <span className="tw:font-label-caps tw:text-label-caps tw:text-primary tw:uppercase">R-Multiple Basis</span>
        </div>
        <div className="tw:grid tw:grid-cols-2 tw:gap-space-xs tw:sm:grid-cols-3">
          <div className="tw:bg-surface-container tw:border tw:border-surface-container-highest tw:rounded-xl tw:p-space-md tw:flex tw:flex-col tw:justify-between tw:shadow-sm tw:transition-shadow tw:duration-150 tw:hover:shadow-md">
            <div className="tw:flex tw:items-center tw:justify-between">
              <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Profit Factor</span>
              <span className={`tw:text-[10px] tw:font-bold tw:px-1.5 tw:py-0.5 tw:rounded ${s.profitFactor >= 1 ? 'tw:bg-secondary/15 tw:text-secondary' : 'tw:bg-error/15 tw:text-error'}`}>{profitFactorGrade(s.profitFactor)}</span>
            </div>
            <div className="tw:mt-2 tw:flex tw:items-baseline tw:gap-1">
              <span className={`tw:font-mono-metric-lg tw:text-mono-metric-lg tw:font-bold ${s.profitFactor >= 1 ? 'tw:text-secondary' : 'tw:text-error'}`}>{fmtRatio(s.profitFactor)}</span>
              <span className="tw:text-on-surface-variant tw:text-[11px] tw:font-mono-metric-md">G:L</span>
            </div>
          </div>
          <div className="tw:bg-surface-container tw:border tw:border-surface-container-highest tw:rounded-xl tw:p-space-md tw:flex tw:flex-col tw:justify-between tw:shadow-sm tw:transition-shadow tw:duration-150 tw:hover:shadow-md">
            <div className="tw:flex tw:items-center tw:justify-between">
              <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Expectancy</span>
              <Icon name={s.avgR >= 0 ? 'verified' : 'error'} className={`tw:text-[16px] ${tone(s.avgR)}`} />
            </div>
            <div className="tw:mt-2 tw:flex tw:items-baseline tw:gap-1">
              <span className={`tw:font-mono-metric-lg tw:text-mono-metric-lg tw:font-bold ${tone(s.avgR)}`}>{fmtR(s.avgR)}</span>
              <span className="tw:text-on-surface-variant tw:text-[11px] tw:font-mono-metric-md">/trade</span>
            </div>
          </div>
          <div className="tw:bg-surface-container tw:border tw:border-surface-container-highest tw:rounded-xl tw:p-space-md tw:flex tw:flex-col tw:justify-between tw:shadow-sm tw:col-span-2 tw:sm:col-span-1 tw:transition-shadow tw:duration-150 tw:hover:shadow-md">
            <div className="tw:flex tw:items-center tw:justify-between">
              <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">SQN Rating</span>
              <span className="tw:bg-primary/20 tw:text-primary tw:text-[10px] tw:font-bold tw:px-1.5 tw:py-0.5 tw:rounded">{sqn.badge}</span>
            </div>
            <div className="tw:mt-2 tw:flex tw:items-baseline tw:gap-1">
              <span className="tw:font-mono-metric-lg tw:text-mono-metric-lg tw:text-primary tw:font-bold">{s.sqn.toFixed(2)}</span>
              <span className="tw:text-on-surface-variant tw:text-[11px] tw:font-mono-metric-md">{sqn.caption}</span>
            </div>
          </div>
          <div className="tw:bg-surface-container tw:border tw:border-surface-container-highest tw:rounded-xl tw:p-space-md tw:flex tw:flex-col tw:justify-between tw:shadow-sm tw:transition-shadow tw:duration-150 tw:hover:shadow-md">
            <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Avg Win ({s.wins})</span>
            <div className="tw:mt-2">
              <span className="tw:font-mono-metric-lg tw:text-mono-metric-lg tw:text-secondary tw:font-bold">{fmtR(s.avgWinR)}</span>
              <div className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface-variant">{fmtUSD(s.avgWinUSD)}</div>
            </div>
          </div>
          <div className="tw:bg-surface-container tw:border tw:border-surface-container-highest tw:rounded-xl tw:p-space-md tw:flex tw:flex-col tw:justify-between tw:shadow-sm tw:transition-shadow tw:duration-150 tw:hover:shadow-md">
            <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Avg Loss ({s.losses})</span>
            <div className="tw:mt-2">
              <span className="tw:font-mono-metric-lg tw:text-mono-metric-lg tw:text-error tw:font-bold">{fmtR(s.avgLossR)}</span>
              <div className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface-variant">{fmtUSD(s.avgLossUSD)}</div>
            </div>
          </div>
          <div className="tw:bg-surface-container tw:border tw:border-surface-container-highest tw:rounded-xl tw:p-space-md tw:flex tw:flex-col tw:justify-between tw:shadow-sm tw:col-span-2 tw:sm:col-span-1 tw:transition-shadow tw:duration-150 tw:hover:shadow-md">
            <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Best vs Worst Trade</span>
            <div className="tw:mt-2 tw:flex tw:justify-between tw:items-center">
              <div>
                <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-secondary tw:font-bold">{s.best ? fmtR(s.best.rMultiple) : '—'}</span>
                <div className="tw:text-[10px] tw:text-on-surface-variant">{s.best ? fmtUSD(s.best.pnlUSD) : ''}</div>
              </div>
              <span className="tw:text-surface-variant tw:font-mono-metric-md">/</span>
              <div className="tw:text-right">
                <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-error tw:font-bold">{s.worst ? fmtR(s.worst.rMultiple) : '—'}</span>
                <div className="tw:text-[10px] tw:text-on-surface-variant">{s.worst ? fmtUSD(s.worst.pnlUSD) : ''}</div>
              </div>
            </div>
          </div>
        </div>
        {s.n < MIN_SAMPLE && (
          <p className="tw:text-body-sm tw:text-on-surface-variant tw:px-space-xs">
            Advanced ratios below need at least {MIN_SAMPLE} trades to mean anything — {s.n} logged so far, so they&apos;re greyed out.
          </p>
        )}
        <div className={`tw:grid tw:grid-cols-3 tw:gap-space-xs ${s.n < MIN_SAMPLE ? 'tw:opacity-45' : ''}`}>
          {[
            { label: 'Sharpe', value: s.sharpe.toFixed(2), cls: 'tw:text-on-surface', hint: 'Annualized, R-based' },
            { label: 'Sortino', value: s.sortino.toFixed(2), cls: 'tw:text-on-surface', hint: 'Downside-adjusted, annualized' },
            { label: 'Calmar', value: fmtRatio(s.calmar), cls: 'tw:text-on-surface', hint: 'Annualized R / max drawdown' },
            { label: 'Half Kelly', value: `${(s.kellyPct / 2).toFixed(1)}%`, cls: 'tw:text-primary', hint: 'Suggested risk per trade (half of full Kelly)' },
            { label: 'Annualized R', value: fmtR(s.annualizedR, 1), cls: tone(s.annualizedR), hint: 'R per year of market time' },
            { label: 'Volatility', value: `${s.volatilityR.toFixed(2)}R`, cls: 'tw:text-on-surface-variant', hint: 'Std. dev. of R per trade' },
          ].map(m => (
            <div key={m.label} title={m.hint} className="tw:bg-surface-container tw:border tw:border-surface-container-highest tw:rounded-lg tw:p-space-sm tw:flex tw:flex-col tw:transition-colors tw:duration-150 tw:hover:bg-surface-container">
              <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">{m.label}</span>
              <span className={`tw:font-mono-metric-md tw:text-mono-metric-md tw:font-semibold tw:mt-0.5 ${m.cls}`}>{m.value}</span>
            </div>
          ))}
        </div>
        <div className="tw:bg-surface-container tw:border tw:border-surface-container-highest tw:rounded-xl tw:p-space-md tw:flex tw:items-center tw:justify-between">
          <div className="tw:flex tw:items-center tw:gap-space-sm">
            <div className="tw:w-8 tw:h-8 tw:rounded-full tw:bg-secondary/10 tw:flex tw:items-center tw:justify-center tw:text-secondary"><Icon name="bolt" className="tw:text-[18px]" /></div>
            <div className="tw:flex tw:flex-col">
              <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Max Win Streak</span>
              <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-secondary tw:font-bold">{s.maxWinStreak} Consecutive Win{s.maxWinStreak === 1 ? '' : 's'}</span>
            </div>
          </div>
          <div className="tw:w-px tw:h-8 tw:bg-surface-variant" />
          <div className="tw:flex tw:items-center tw:gap-space-sm tw:text-right">
            <div className="tw:flex tw:flex-col tw:items-end">
              <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Max Loss Streak</span>
              <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-error tw:font-bold">{s.maxLossStreak} Consecutive Loss{s.maxLossStreak === 1 ? '' : 'es'}</span>
            </div>
            <div className="tw:w-8 tw:h-8 tw:rounded-full tw:bg-error-container/30 tw:flex tw:items-center tw:justify-center tw:text-error"><Icon name="emergency" className="tw:text-[18px]" /></div>
          </div>
        </div>
      </section>

      {/* Breakdown matrix */}
      <section className="tw:bg-surface-container tw:border tw:border-surface-container-highest tw:rounded-xl tw:p-space-md tw:shadow-md tw:flex tw:flex-col tw:gap-space-md">
        <div className="tw:flex tw:items-center tw:justify-between">
          <div className="tw:flex tw:items-center tw:gap-space-xs tw:bg-surface-container-lowest tw:p-0.5 tw:rounded-lg" role="tablist">
            {(['strategy', 'symbol', 'timeframe', 'direction'] as const).map(k => (
              <button key={k} type="button" role="tab" aria-selected={breakdown === k} onClick={() => setBreakdown(k)}
                className={`tw:px-space-md tw:py-1 tw:rounded tw:font-label-action tw:text-label-action tw:transition-all ${breakdown === k ? 'tw:text-primary tw:bg-surface-container-high' : 'tw:text-on-surface-variant tw:hover:text-on-surface'}`}>
                {`By ${k[0].toUpperCase()}${k.slice(1)}`}
              </button>
            ))}
          </div>
          <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Performance Matrix</span>
        </div>
        <BreakdownTable rows={breakdown === 'strategy' ? s.byStrategy : breakdown === 'symbol' ? s.bySymbol : breakdown === 'timeframe' ? s.byTimeframe : s.byDirection} kind={breakdown} />
      </section>

      {/* Export deck */}
      <section className="tw:bg-surface-container-lowest tw:rounded-xl tw:p-space-md tw:flex tw:items-center tw:justify-between tw:gap-space-md tw:shadow-sm">
        <div className="tw:flex tw:items-center tw:gap-space-sm tw:min-w-0">
          <div className="tw:w-10 tw:h-10 tw:rounded-lg tw:bg-primary-container tw:text-on-primary-container tw:flex tw:items-center tw:justify-center tw:flex-shrink-0"><Icon name="file_download" className="tw:text-[20px]" /></div>
          <div className="tw:flex tw:flex-col tw:min-w-0">
            <span className="tw:font-headline-md tw:text-body-md tw:font-bold tw:text-on-surface tw:truncate">Export Quant Summary</span>
            <span className="tw:font-body-sm tw:text-body-sm tw:text-on-surface-variant tw:truncate">Stats, breakdowns and the filtered backtest log as JSON</span>
          </div>
        </div>
        <button type="button" onClick={exportSummary} disabled={!s.n}
          className="tw:bg-surface-container-high tw:hover:bg-surface-bright tw:text-primary tw:font-label-action tw:text-label-action tw:px-space-md tw:py-1.5 tw:rounded tw:flex tw:items-center tw:gap-1 tw:flex-shrink-0 tw:transition-colors tw:disabled:opacity-40">
          <span>Export</span>
          <Icon name="arrow_forward" className="tw:text-[16px]" />
        </button>
      </section>
    </div>
  );
}

const SYMBOL_DOTS = ['tw:bg-primary', 'tw:bg-secondary', 'tw:bg-primary-fixed-dim', 'tw:bg-error', 'tw:bg-tertiary-container'];

function BreakdownTable({ rows, kind }: { rows: GroupStats[]; kind: 'strategy' | 'symbol' | 'timeframe' | 'direction' }) {
  if (!rows.length) {
    return <p className="tw:text-on-surface-variant tw:font-body-sm tw:text-body-sm tw:px-space-xs">{kind === 'strategy' ? 'Tag backtests with a strategy to compare them here.' : 'No trades in this range.'}</p>;
  }
  return (
    <div className="tw:flex tw:flex-col tw:gap-space-xs" role="table" aria-label={kind === 'strategy' ? 'Performance by strategy' : 'Performance by symbol'}>
      <div role="row" className="tw:grid tw:grid-cols-12 tw:px-space-xs tw:py-1 tw:text-on-surface-variant tw:font-label-caps tw:text-label-caps tw:uppercase">
        <span role="columnheader" className="tw:col-span-5">{kind === 'strategy' ? 'Strategy' : kind === 'symbol' ? 'Ticker' : kind === 'timeframe' ? 'Timeframe' : 'Direction'}</span>
        <span role="columnheader" className="tw:col-span-2 tw:text-center">Trades</span>
        <span role="columnheader" className="tw:col-span-2 tw:text-center">Win%</span>
        <span role="columnheader" className="tw:col-span-3 tw:text-right">Total R</span>
      </div>
      {rows.map((r, i) => (
        <div key={r.key} role="row" className="tw:bg-surface-container-high tw:rounded tw:p-space-sm tw:grid tw:grid-cols-12 tw:items-center tw:hover:bg-surface-bright tw:transition-colors">
          <div role="cell" className="tw:col-span-5 tw:flex tw:flex-col tw:min-w-0 tw:pr-1">
            {kind === 'symbol'
              ? <div className="tw:flex tw:items-center tw:gap-1"><span className={`tw:w-1.5 tw:h-1.5 tw:rounded-full ${SYMBOL_DOTS[i % SYMBOL_DOTS.length]}`} /><span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:font-bold tw:text-on-surface">{r.key}</span></div>
              : <span className="tw:font-headline-md tw:text-body-md tw:font-semibold tw:text-on-surface tw:truncate">{r.key}</span>}
            <span className={`tw:font-mono-metric-md tw:text-[10px] ${tone(r.avgR)}`}>Avg: {fmtR(r.avgR)}</span>
          </div>
          <div role="cell" className="tw:col-span-2 tw:text-center tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface">{r.trades}</div>
          <div role="cell" className={`tw:col-span-2 tw:text-center tw:font-mono-metric-md tw:text-mono-metric-md tw:font-semibold ${r.winRate > 50 ? 'tw:text-secondary' : r.winRate < 50 ? 'tw:text-error' : 'tw:text-on-surface-variant'}`}>{r.winRate.toFixed(1)}%</div>
          <div role="cell" className={`tw:col-span-3 tw:text-right tw:font-mono-metric-md tw:text-mono-metric-md tw:font-bold ${tone(r.totalR)}`}>{fmtR(r.totalR, 1)}</div>
        </div>
      ))}
    </div>
  );
}
