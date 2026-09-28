'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, createSeriesMarkers, CandlestickSeries, HistogramSeries, ColorType, LineStyle } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { DrawingManager } from 'lightweight-charts-drawing';
import type { SerializedDrawing } from 'lightweight-charts-drawing';
import { useTheme } from '../ThemeProvider';
import { BacktestTrade, SIM_STARTING_BALANCE, authHeaders, fmtDate, fmtPrice, fmtR, fmtUSD, hashTag, intervalLabel, tagsOf, useBacktest } from './data';
import { Icon } from './BacktestShell';
import { download } from './exporting';
import { Candle, INTERVAL_DAYS } from '../backtest-tools/types';
import DrawingTextOverlay, { paintDrawingLabels } from '../backtest-tools/DrawingTextOverlay';
import { barSeconds, drawingFactory, fillWithOpacity, futureSlotTimes, snapToCandles } from '../chart-drawing/drawingKit';

/** The chart plus its labels as one image (labels are page elements, not chart canvas). */
export type TradeChartShot = () => HTMLCanvasElement | null;
// Look back at most this many bars for drawings made before the trade.
const MAX_DRAWING_LOOKBACK_BARS = 1500;

const DAY = 86_400_000;
const box = 'tw:rounded tw:bg-surface-container tw:border tw:border-surface-container-highest tw:p-3 tw:flex tw:flex-col';
const tile = 'tw:p-2 tw:rounded tw:bg-surface-container-low tw:border tw:border-surface-container-highest/60 tw:flex tw:flex-col';
const capsLabel = 'tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase';
const barBtn = 'tw:px-2.5 tw:py-1 tw:rounded tw:bg-surface-container-high tw:hover:bg-surface-bright tw:text-on-surface tw:border tw:border-surface-container-highest tw:flex tw:items-center tw:gap-1.5 tw:font-label-action tw:text-label-action tw:transition-colors tw:disabled:opacity-40';

interface Excursion { mfe: number; mae: number; bars: number; exitCandle: Candle | null; windowStart: number; windowEnd: number }

function cssVar(el: Element | null, name: string, fallback: string) {
  const v = el ? getComputedStyle(el).getPropertyValue(name).trim() : '';
  return v || fallback;
}
function holdTime(t: BacktestTrade) {
  if (!t.entryTime || !t.exitTime) return '—';
  const mins = Math.max(0, Math.round((t.exitTime - t.entryTime) / 60));
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function grade(t: BacktestTrade) {
  const q = ((t.setupQuality ?? 0) + (t.executionQuality ?? 0)) / 2;
  if (!q && t.planFollowed == null) return null;
  const score = q - (t.planFollowed === false ? 1 : 0);
  return score >= 4.75 ? 'A+' : score >= 4 ? 'A' : score >= 3.5 ? 'B+' : score >= 3 ? 'B' : score >= 2 ? 'C' : 'D';
}
function Stars({ value = 0, onChange, label }: { value?: number; onChange?: (v: number) => void; label: string }) {
  return (
    <div className="tw:flex tw:items-center tw:gap-1 tw:text-primary" role={onChange ? 'radiogroup' : undefined} aria-label={`${label}: ${value} of 5`}>
      {[1, 2, 3, 4, 5].map(n => {
        const star = <span aria-hidden="true" className={`material-symbols-outlined tw:text-[15px] ${n <= value ? 'tw:text-primary' : 'tw:text-outline-variant'}`} style={{ fontVariationSettings: `'FILL' ${n <= value ? 1 : 0}` }}>star</span>;
        return onChange
          ? <button key={n} type="button" role="radio" aria-checked={n === value} aria-label={`${n} star${n === 1 ? '' : 's'}`} onClick={() => onChange(n === value ? 0 : n)}>{star}</button>
          : <span key={n}>{star}</span>;
      })}
      <span className="tw:font-mono-metric-md tw:text-[11px] tw:font-bold tw:ml-1 tw:text-on-surface">{value}/5</span>
    </div>
  );
}

/** Candles around the trade, with its levels drawn on; reports excursion stats back up. */
function TradeChart({ trade, onStats, chartRef, shotRef, showLevels, showVolume }: {
  trade: BacktestTrade; onStats: (s: Excursion | null) => void; chartRef: React.RefObject<IChartApi | null>;
  shotRef: React.RefObject<TradeChartShot | null>; showLevels: boolean; showVolume: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [fetchFailed, setFailed] = useState('');
  const [view, setView] = useState<{ chart: IChartApi; series: ISeriesApi<'Candlestick'>; drawings: SerializedDrawing[] } | null>(null);
  const [labelsRevision, setLabelsRevision] = useState(0);
  const noChart = !trade.entryTime || !trade.interval || trade.source === 'quick';
  const failed = noChart ? 'No chart data recorded for a quick log' : fetchFailed;

  useEffect(() => {
    if (noChart) return;
    const barMs = (INTERVAL_DAYS[trade.interval!] ?? INTERVAL_DAYS['15min']) * DAY;
    const entryMs = trade.entryTime! * 1000, exitMs = (trade.exitTime ?? trade.entryTime!) * 1000;
    // Reach back far enough to show drawings made before the trade (e.g. a higher-timeframe zone).
    const earliestDrawing = Math.min(Infinity, ...(trade.chartAnnotations ?? []).flatMap(d => d.anchors.map(a => Number(a.time) * 1000)));
    const fromMs = Math.max(entryMs - MAX_DRAWING_LOOKBACK_BARS * barMs, Math.min(entryMs - 60 * barMs, earliestDrawing - 10 * barMs));
    const controller = new AbortController();
    fetch(`/api/backtest-trades/chart?symbol=${encodeURIComponent(trade.symbol)}&interval=${trade.interval}&fromMs=${fromMs}&toMs=${exitMs + 25 * barMs}`,
      { headers: authHeaders(), signal: controller.signal })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) { setFailed(data.error || 'Chart data unavailable'); onStats(null); return; }
        setCandles((data.candles || []).map((c: Candle) => ({ ...c, time: Number(c.time) as UTCTimestamp })));
      })
      .catch(e => { if (e?.name !== 'AbortError') { setFailed('Chart data unavailable'); onStats(null); } });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade._id]);

  useEffect(() => {
    if (!candles?.length || !trade.entryTime || trade.entryPrice == null || trade.stopLoss == null) return;
    const exitTime = trade.exitTime ?? trade.entryTime;
    const idxAt = (sec: number) => { let best = 0; candles.forEach((c, i) => { if (Number(c.time) <= sec) best = i; }); return best; };
    const i0 = idxAt(trade.entryTime), i1 = idxAt(exitTime);
    const span = candles.slice(i0, i1 + 1);
    const risk = Math.abs(trade.entryPrice - trade.stopLoss) || 1;
    const long = trade.direction === 'long';
    const hi = Math.max(...span.map(c => c.high)), lo = Math.min(...span.map(c => c.low));
    onStats({
      mfe: (long ? hi - trade.entryPrice : trade.entryPrice - lo) / risk,
      mae: (long ? lo - trade.entryPrice : trade.entryPrice - hi) / risk,
      bars: Math.max(0, i1 - i0), exitCandle: candles[i1] ?? null, windowStart: i0 + 1, windowEnd: i1 + 1,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !candles?.length) return;
    const root = el.closest('.bt-shell');
    const up = cssVar(root, '--bt-secondary', '#4edea3'), down = cssVar(root, '--bt-tertiary', '#ffbcb7');
    const primary = cssVar(root, '--bt-primary-container', '#f59e0b');
    const text = cssVar(root, '--bt-on-surface-variant', '#d8c3ad'), grid = cssVar(root, '--bt-outline-variant', '#534434');
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: text, fontFamily: 'JetBrains Mono, monospace', fontSize: 10, attributionLogo: false },
      grid: { vertLines: { color: `${grid}55`, style: LineStyle.Dotted }, horzLines: { color: `${grid}55`, style: LineStyle.Dotted } },
      rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true },
    });
    chartRef.current = chart;
    const series = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down, priceLineVisible: false });
    // The drawings saved with the trade (locked, so they can't be nudged by
    // accident), anchored onto these candles; ones starting before the first
    // candle start at it. Plus the position's target and stop zones.
    const times = candles.map(c => Number(c.time));
    const first = times[0];
    const saved = snapToCandles((trade.chartAnnotations ?? []).map(d => ({
      ...d,
      anchors: d.anchors.map(a => ({ ...a, time: Math.max(first, Number(a.time)) as typeof a.time })),
      options: { ...d.options, locked: true },
    })), times);
    const exitAt = (trade.exitTime ?? trade.entryTime ?? first) as UTCTimestamp;
    const zone = (id: string, price: number, color: string): SerializedDrawing => ({
      id, type: 'rectangle',
      anchors: [{ time: trade.entryTime as UTCTimestamp, price: trade.entryPrice! }, { time: exitAt, price }],
      style: { lineColor: color, lineWidth: 1, fillColor: fillWithOpacity(color, 0.16), fillOpacity: 0.16 } as SerializedDrawing['style'],
      options: { visible: true, locked: true, filled: true } as SerializedDrawing['options'],
    });
    const positionZones = showLevels && trade.entryTime && trade.entryPrice != null ? [
      ...(trade.takeProfit != null ? [zone('position-target', trade.takeProfit, up)] : []),
      ...(trade.stopLoss != null ? [zone('position-stop', trade.stopLoss, down)] : []),
    ] : [];
    const drawings = [...saved, ...snapToCandles(positionZones, times)];
    // Empty slots after the last candle, so drawings reaching further still show.
    const slots = futureSlotTimes(times[times.length - 1], barSeconds(times), drawings, [], 0);
    series.setData([...candles, ...slots.map(t => ({ time: t as UTCTimestamp }))]);
    const manager = new DrawingManager();
    manager.attach(chart, series, el);
    try { manager.importDrawings(drawings, drawingFactory); } catch { /* skip drawings this version can't read */ }
    if (showVolume) {
      const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vol.setData(candles.map(c => ({ time: c.time, value: c.volume ?? 0, color: `${c.close >= c.open ? up : down}55` })));
    }
    if (showLevels && trade.entryTime && trade.entryPrice != null) {
      const long = trade.direction === 'long';
      series.createPriceLine({ price: trade.entryPrice, color: primary, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: long ? 'BUY' : 'SELL' });
      if (trade.stopLoss != null) series.createPriceLine({ price: trade.stopLoss, color: down, lineStyle: LineStyle.Solid, lineWidth: 1, axisLabelVisible: true, title: 'SL' });
      if (trade.takeProfit != null) series.createPriceLine({ price: trade.takeProfit, color: up, lineStyle: LineStyle.Solid, lineWidth: 1, axisLabelVisible: true, title: 'TP' });
      if (trade.exitPrice != null) series.createPriceLine({ price: trade.exitPrice, color: text, lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: true, title: 'EXIT' });
      const at = (sec: number) => candles.reduce((best, c) => (Number(c.time) <= sec ? c.time : best), candles[0].time);
      createSeriesMarkers(series, [
        { time: at(trade.entryTime), position: long ? 'belowBar' : 'aboveBar', shape: long ? 'arrowUp' : 'arrowDown', color: primary, text: 'Entry' },
        { time: at(trade.exitTime ?? trade.entryTime), position: long ? 'aboveBar' : 'belowBar', shape: 'circle', color: trade.rMultiple >= 0 ? up : down, text: `Exit ${fmtR(trade.rMultiple, 1)}` },
      ]);
    }
    // Fit the candles (and the drawings on them), not the empty slots.
    chart.timeScale().setVisibleLogicalRange({ from: 0, to: candles.length + 3 });
    const bump = () => setLabelsRevision(r => r + 1);
    chart.timeScale().subscribeVisibleLogicalRangeChange(bump);
    setView({ chart, series, drawings: saved });
    shotRef.current = () => {
      const shot = chart.takeScreenshot(true);
      const ctx = shot.getContext('2d');
      if (ctx && saved.length) {
        const css = getComputedStyle(root ?? document.body);
        paintDrawingLabels(ctx, chart, series, saved, shot.width / Math.max(1, el.clientWidth), {
          background: css.getPropertyValue('--bt-surface-container-lowest').trim() || '#ffffff',
          text: css.getPropertyValue('--bt-on-surface').trim() || '#111827',
        });
      }
      return shot;
    };
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(bump);
      shotRef.current = null; setView(null);
      manager.detach(); chartRef.current = null; chart.remove();
    };
  }, [candles, showLevels, showVolume, resolvedTheme, trade, chartRef, shotRef]);

  if (candles?.length) return (
    <div ref={hostRef} className="tw:absolute tw:inset-0">
      {view && <DrawingTextOverlay chart={view.chart} series={view.series} drawings={view.drawings} revision={labelsRevision} />}
    </div>
  );
  return <SnapshotFallback trade={trade} reason={failed} loading={!failed} />;
}

function SnapshotFallback({ trade, reason, loading }: { trade: BacktestTrade; reason: string; loading: boolean }) {
  const [snapshot, setSnapshot] = useState('');
  useEffect(() => {
    if (!trade.hasSnapshot) return;
    fetch(`/api/backtest-trades/${trade._id}/snapshot`, { headers: authHeaders() })
      .then(r => (r.ok ? r.json() : { snapshot: '' })).then(d => setSnapshot(d.snapshot || '')).catch(() => {});
  }, [trade._id, trade.hasSnapshot]);
  if (snapshot) return <img src={snapshot} alt={`${trade.symbol} backtest snapshot`} className="tw:absolute tw:inset-0 tw:w-full tw:h-full tw:object-contain" />;
  return (
    <div className="tw:absolute tw:inset-0 tw:flex tw:flex-col tw:items-center tw:justify-center tw:gap-2 tw:text-center tw:p-6 tw:text-on-surface-variant">
      <Icon name={loading ? 'progress_activity' : 'candlestick_chart'} className={`tw:text-[40px] tw:text-primary ${loading ? 'tw:animate-spin' : ''}`} />
      <p className="tw:text-body-sm">{loading ? 'Loading the trade window…' : `${reason || 'Chart data unavailable'}${trade.hasSnapshot ? '' : ' — and no snapshot was saved with this backtest.'}`}</p>
    </div>
  );
}

export default function BacktestDetail({ id }: { id: string }) {
  const router = useRouter();
  const { allTrades, loading, removeTrade, updateTrade, strategies } = useBacktest();
  const trade = allTrades.find(t => t._id === id);
  const chartRef = useRef<IChartApi | null>(null);
  const shotRef = useRef<TradeChartShot | null>(null);
  const [stats, setStats] = useState<Excursion | null>(null);
  const [showLevels, setShowLevels] = useState(true);
  const [showVolume, setShowVolume] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<BacktestTrade>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const ordered = useMemo(() => [...allTrades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()), [allTrades]);
  const seq = ordered.findIndex(t => t._id === id);
  const prev = seq > 0 ? ordered[seq - 1] : null;
  const next = seq >= 0 && seq < ordered.length - 1 ? ordered[seq + 1] : null;

  if (loading) return <div className="tw:m-auto tw:text-on-surface-variant">Loading case study…</div>;
  if (!trade) return <div className="tw:m-auto tw:text-center tw:p-space-xl"><h1 className="tw:text-headline-lg tw:text-on-surface tw:font-bold">Backtest not found</h1><Link href="/backtest/log" className="tw:text-primary tw:inline-flex tw:mt-space-md">Return to log</Link></div>;

  const tags = tagsOf(trade);
  const id4 = `#BT-${String(seq + 1).padStart(4, '0')}`;
  const win = trade.outcome === 'win', loss = trade.outcome === 'loss';
  const tone = win ? 'tw:text-secondary' : loss ? 'tw:text-error' : 'tw:text-on-surface-variant';
  const resultBox = win ? 'tw:bg-secondary-container/15 tw:border-secondary-container/40' : loss ? 'tw:bg-error/10 tw:border-error/40' : 'tw:bg-surface-container-highest tw:border-outline-variant';
  const plannedRR = trade.takeProfit != null && trade.entryPrice != null && trade.stopLoss != null && trade.entryPrice !== trade.stopLoss
    ? Math.abs(trade.takeProfit - trade.entryPrice) / Math.abs(trade.entryPrice - trade.stopLoss) : null;
  const g = grade(trade);

  const startEdit = () => {
    setDraft({ name: trade.name, tags, notes: trade.notes, lesson: trade.lesson ?? '', planFollowed: trade.planFollowed ?? undefined, setupQuality: trade.setupQuality ?? 0, executionQuality: trade.executionQuality ?? 0, mistakes: trade.mistakes ?? [] });
    setErr(''); setEditing(true);
  };
  const save = async () => {
    setSaving(true); setErr('');
    const res = await updateTrade(trade._id, { ...draft, planFollowed: draft.planFollowed ?? undefined });
    setSaving(false);
    if (res.ok) setEditing(false); else setErr(res.error || 'Could not save changes');
  };
  const del = async () => {
    if (!window.confirm(`Delete "${trade.name || trade.symbol}" from the backtest log? This can't be undone.`)) return;
    if (await removeTrade(trade._id)) router.push('/backtest/log');
  };
  const downloadSnapshot = () => {
    const shot = shotRef.current?.();
    if (!shot) return;
    const a = document.createElement('a'); a.href = shot.toDataURL('image/png'); a.download = `${id4.slice(1)}-${trade.symbol}.png`; a.click();
  };
  const exportMarkdown = () => {
    const lines = [
      `# Case Study ${id4}: ${trade.name || `${trade.symbol} ${trade.direction}`}`, '',
      `- **Result:** ${trade.outcome.toUpperCase()} ${fmtR(trade.rMultiple)} (${fmtUSD(trade.pnlUSD)})`,
      `- **Symbol / TF:** ${trade.symbol} ${intervalLabel(trade.interval)} · ${trade.direction.toUpperCase()}`,
      `- **Strategy:** ${tags.map(hashTag).join(', ') || 'Unclassified'}`,
      `- **Entry / SL / TP / Exit:** ${fmtPrice(trade.entryPrice)} / ${fmtPrice(trade.stopLoss)} / ${fmtPrice(trade.takeProfit)} / ${fmtPrice(trade.exitPrice)}`,
      `- **Initial risk:** ${fmtUSD(trade.riskAmount, false)} · **Hold time:** ${holdTime(trade)}`,
      stats ? `- **MFE / MAE:** ${fmtR(stats.mfe)} / ${fmtR(stats.mae)}` : '',
      `- **Plan followed:** ${trade.planFollowed == null ? 'Not scored' : trade.planFollowed ? 'Yes' : 'No'} · **Setup:** ${trade.setupQuality ?? 0}/5 · **Execution:** ${trade.executionQuality ?? 0}/5`,
      trade.mistakes?.length ? `- **Mistakes:** ${trade.mistakes.join(', ')}` : '', '',
      trade.lesson ? `## Lesson\n\n> ${trade.lesson}\n` : '',
      trade.notes ? `## Notes\n\n${trade.notes}\n` : '',
      `_Simulated ${fmtDate(trade.createdAt)} · exported from TradeJournal Backtest_`,
    ].filter(l => l !== '');
    download(`${id4.slice(1)}-${trade.symbol}.md`, lines.join('\n'), 'text/markdown');
  };
  const set = <K extends keyof BacktestTrade>(k: K, v: BacktestTrade[K]) => setDraft(d => ({ ...d, [k]: v }));
  const input = 'tw:w-full tw:bg-surface-container-lowest tw:border tw:border-outline-variant tw:rounded tw:px-2 tw:py-1 tw:text-body-sm tw:text-on-surface tw:focus:outline-none tw:focus:border-primary';

  return (
    <div className="tw:flex tw:flex-col tw:bg-surface-container-lowest tw:min-[900px]:h-[calc(100dvh-44px)]">
      {/* Breadcrumbs & record pagination */}
      <section className="tw:min-h-9 tw:px-4 tw:py-1 tw:bg-surface-container-low tw:border-b tw:border-surface-container-highest tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-2 tw:shrink-0">
        <div className="tw:flex tw:items-center tw:gap-1.5 tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:min-w-0">
          <Link href="/backtest/log" className="tw:hover:text-primary tw:transition-colors">Backtest Log</Link><span className="tw:text-outline-variant">/</span>
          <span>Case Studies</span><span className="tw:text-outline-variant">/</span>
          <span className="tw:font-semibold tw:text-primary tw:truncate">{id4} - {trade.name || trade.symbol}</span>
        </div>
        <div className="tw:flex tw:items-center tw:gap-2">
          <div className="tw:flex tw:items-center tw:bg-surface-container tw:rounded tw:border tw:border-surface-container-highest tw:px-1 tw:py-0.5">
            <button type="button" disabled={!prev} onClick={() => prev && router.push(`/backtest/${prev._id}`)} className="tw:px-2 tw:py-0.5 tw:rounded tw:text-on-surface tw:hover:bg-surface-container-high tw:transition-colors tw:flex tw:items-center tw:gap-1 tw:font-label-action tw:text-label-action tw:disabled:opacity-40 tw:disabled:cursor-not-allowed">
              <Icon name="arrow_back_ios" className="tw:text-[14px]" /><span>Previous Trade</span>
            </button>
            <div className="tw:h-3.5 tw:w-px tw:bg-surface-container-highest tw:mx-1" />
            <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface-variant tw:px-2">Trade {seq + 1} of {ordered.length}</span>
            <div className="tw:h-3.5 tw:w-px tw:bg-surface-container-highest tw:mx-1" />
            <button type="button" disabled={!next} onClick={() => next && router.push(`/backtest/${next._id}`)} className="tw:px-2 tw:py-0.5 tw:rounded tw:text-on-surface tw:hover:bg-surface-container-high tw:transition-colors tw:flex tw:items-center tw:gap-1 tw:font-label-action tw:text-label-action tw:disabled:opacity-40 tw:disabled:cursor-not-allowed">
              <span>Next Trade</span><Icon name="arrow_forward_ios" className="tw:text-[14px]" />
            </button>
          </div>
          <button type="button" onClick={editing ? () => setEditing(false) : startEdit} className={barBtn}>
            <Icon name={editing ? 'close' : 'edit_note'} className="tw:text-[14px]" /><span>{editing ? 'Cancel Edit' : 'Edit Journal Entry'}</span>
          </button>
          <button type="button" onClick={() => void del()} title="Delete record" aria-label="Delete record" className="tw:w-7 tw:h-7 tw:flex tw:items-center tw:justify-center tw:rounded tw:text-error tw:hover:bg-error/10 tw:border tw:border-surface-container-highest tw:transition-colors">
            <Icon name="delete" className="tw:text-[15px]" />
          </button>
        </div>
      </section>

      {/* Case study header */}
      <section className="tw:px-4 tw:py-2.5 tw:bg-surface-container tw:border-b tw:border-surface-container-highest tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:shrink-0">
        <div className="tw:flex tw:items-center tw:gap-3 tw:min-w-0">
          <div className={`tw:p-1.5 tw:border tw:rounded tw:flex tw:items-center tw:justify-center ${resultBox} ${tone}`}><Icon name={win ? 'verified' : loss ? 'report' : 'remove_circle'} className="tw:text-[20px]" /></div>
          <div className="tw:min-w-0">
            <h1 className="tw:text-headline-md tw:font-headline-md tw:text-on-surface tw:font-semibold tw:tracking-tight tw:truncate">Case Study: {trade.name || `${trade.symbol} ${trade.direction}`}</h1>
            <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2 tw:mt-0.5">
              {tags.map(t => <span key={t} className="tw:px-2 tw:py-0.5 tw:rounded tw:bg-surface-container-highest tw:text-primary tw:font-label-caps tw:text-label-caps">{hashTag(t)}</span>)}
              {trade.interval && <span className="tw:px-2 tw:py-0.5 tw:rounded tw:bg-surface-container-highest tw:text-on-surface-variant tw:font-label-caps tw:text-label-caps">{intervalLabel(trade.interval)} TIMEFRAME</span>}
              <span className="tw:text-on-surface-variant tw:font-mono-metric-md tw:text-body-sm tw:flex tw:items-center tw:gap-1"><Icon name="calendar_today" className="tw:text-outline tw:text-[13px]" />Simulated {fmtDate(trade.createdAt)}</span>
            </div>
          </div>
        </div>
        <div className={`tw:border tw:px-3 tw:py-1.5 tw:rounded tw:flex tw:items-center tw:gap-3 ${resultBox}`}>
          <div className="tw:flex tw:flex-col tw:text-right">
            <span className={`tw:font-label-caps tw:text-label-caps tw:font-bold tw:uppercase tw:tracking-wider ${tone}`}>Result Status</span>
            <span className={`tw:font-mono-metric-lg tw:text-mono-metric-lg tw:font-bold ${tone}`}>[ {trade.outcome === 'breakeven' ? 'BE' : trade.outcome.toUpperCase()}: {fmtR(trade.rMultiple).replace('R', ' R')} / {fmtUSD(trade.pnlUSD)} ]</span>
          </div>
          <Icon name={trade.rMultiple >= 0 ? 'trending_up' : 'trending_down'} className={`tw:text-[26px] ${tone}`} />
        </div>
      </section>

      {/* Chart (left) + metrics & journal (right) */}
      <div className="tw:flex-1 tw:grid tw:grid-cols-1 tw:min-[900px]:grid-cols-[3fr_2fr] tw:min-h-0">
        <section className="tw:flex tw:flex-col tw:border-r tw:border-surface-container-highest tw:bg-surface-dim tw:min-h-[420px]">
          <div className="tw:min-h-9 tw:px-3 tw:py-1 tw:bg-surface-container-low tw:border-b tw:border-surface-container-highest tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-2 tw:shrink-0">
            <div className="tw:flex tw:items-center tw:gap-2">
              <Icon name="analytics" className="tw:text-primary tw:text-[16px]" />
              <span className="tw:text-body-md tw:font-semibold tw:text-on-surface">Execution Chart &amp; Technical Markings{stats ? ` (Bar ${stats.windowStart} - ${stats.windowEnd})` : ''}</span>
              {trade.interval && <span className="tw:px-1.5 tw:rounded tw:bg-surface-container-high tw:text-on-surface-variant tw:font-label-caps tw:text-[9px]">{intervalLabel(trade.interval)} REPLAY BUFFER</span>}
            </div>
            <div className="tw:flex tw:items-center tw:gap-1.5">
              {([['Trade Levels', showLevels, setShowLevels, 'tw:bg-primary'], ['Volume', showVolume, setShowVolume, 'tw:bg-secondary']] as const).map(([label, on, setOn, dot]) => (
                <button key={label} type="button" aria-pressed={on} onClick={() => setOn(v => !v)} disabled={!stats}
                  className={`tw:px-2 tw:py-0.5 tw:rounded tw:bg-surface-container tw:hover:bg-surface-container-high tw:border tw:border-surface-container-highest tw:text-label-caps tw:font-label-caps tw:flex tw:items-center tw:gap-1 tw:transition-colors tw:disabled:opacity-40 ${on ? 'tw:text-on-surface' : 'tw:text-on-surface-variant'}`}>
                  <span className={`tw:w-1.5 tw:h-1.5 tw:rounded-full ${on ? dot : 'tw:bg-outline-variant'}`} /><span>{label}</span>
                </button>
              ))}
              <button type="button" onClick={downloadSnapshot} disabled={!stats} title="Export PNG" className="tw:px-2 tw:py-0.5 tw:rounded tw:bg-surface-container tw:hover:bg-surface-container-high tw:border tw:border-surface-container-highest tw:text-primary tw:text-label-caps tw:font-label-caps tw:flex tw:items-center tw:gap-1 tw:transition-colors tw:disabled:opacity-40">
                <Icon name="download" className="tw:text-[13px]" /><span>Download Snapshot</span>
              </button>
            </div>
          </div>
          <div className="tw:flex-1 tw:relative tw:bg-surface-container-lowest tw:min-h-[360px]">
            <TradeChart trade={trade} onStats={setStats} chartRef={chartRef} shotRef={shotRef} showLevels={showLevels} showVolume={showVolume} />
          </div>
          <div className="tw:min-h-7 tw:px-3 tw:bg-surface-container tw:border-t tw:border-surface-container-highest tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-2 tw:font-mono-metric-md tw:text-[11px] tw:text-on-surface-variant tw:shrink-0">
            {stats?.exitCandle ? (
              <div className="tw:flex tw:items-center tw:gap-3">
                <span>O: <span className="tw:text-on-surface">{fmtPrice(stats.exitCandle.open)}</span></span>
                <span>H: <span className="tw:text-secondary">{fmtPrice(stats.exitCandle.high)}</span></span>
                <span>L: <span className="tw:text-error">{fmtPrice(stats.exitCandle.low)}</span></span>
                <span>C: <span className={stats.exitCandle.close >= stats.exitCandle.open ? 'tw:text-secondary' : 'tw:text-error'}>{fmtPrice(stats.exitCandle.close)}</span></span>
                <span className="tw:text-outline">(exit bar)</span>
              </div>
            ) : <span>Entry {fmtPrice(trade.entryPrice)} → Exit {fmtPrice(trade.exitPrice)}</span>}
            <div className="tw:flex tw:items-center tw:gap-2">
              <span>STOP: <span className="tw:text-error">{fmtPrice(trade.stopLoss)}</span></span>
              <span className="tw:text-outline-variant">|</span>
              <span>TARGET: <span className="tw:text-secondary">{fmtPrice(trade.takeProfit)}</span></span>
            </div>
          </div>
        </section>

        <section className="tw:flex tw:flex-col tw:bg-surface-container-low tw:overflow-y-auto tw:p-3 tw:gap-3">
          {/* Quant metrics matrix */}
          <div className={box}>
            <div className="tw:flex tw:items-center tw:justify-between tw:pb-2 tw:mb-2 tw:border-b tw:border-surface-container-highest">
              <div className="tw:flex tw:items-center tw:gap-1.5"><Icon name="calculate" className="tw:text-primary tw:text-[16px]" /><span className="tw:text-body-md tw:font-semibold tw:text-on-surface">Quant Metrics Matrix</span></div>
              <span className="tw:px-1.5 tw:py-0.5 tw:rounded tw:bg-surface-container-highest tw:font-label-caps tw:text-label-caps tw:text-primary">{trade.source === 'quick' ? 'QUICK LOG' : trade.source === 'agent' ? `AGENT RUN${trade.blind ? ' · BLIND' : ''}` : 'SIM RECORD'}</span>
            </div>
            <div className="tw:grid tw:grid-cols-2 tw:gap-2">
              <div className={tile}><span className={capsLabel}>Direction</span><div className="tw:flex tw:items-center tw:gap-1.5 tw:mt-0.5"><span className={`tw:w-2 tw:h-2 tw:rounded-full ${trade.direction === 'long' ? 'tw:bg-secondary' : 'tw:bg-error'}`} /><span className={`tw:font-mono-metric-md tw:font-bold ${trade.direction === 'long' ? 'tw:text-secondary' : 'tw:text-error'}`}>{trade.direction.toUpperCase()}</span></div></div>
              <div className={tile}><span className={capsLabel}>Initial Risk (1R)</span><span className="tw:font-mono-metric-md tw:text-on-surface tw:font-semibold tw:mt-0.5">{fmtUSD(trade.riskAmount, false)} <span className="tw:text-outline tw:text-[10px] tw:font-normal">({((trade.riskAmount / SIM_STARTING_BALANCE) * 100).toFixed(2)}% of sim)</span></span></div>
              <div className={tile}><span className={capsLabel}>R-Multiple</span><span className={`tw:font-mono-metric-lg tw:text-mono-metric-lg tw:font-bold tw:mt-0.5 ${tone}`}>{fmtR(trade.rMultiple).replace('R', ' R')}</span></div>
              <div className={tile}><span className={capsLabel}>Net Simulated P&amp;L</span><span className={`tw:font-mono-metric-lg tw:text-mono-metric-lg tw:font-bold tw:mt-0.5 ${tone}`}>{fmtUSD(trade.pnlUSD)}</span></div>
              <div className={tile}><span className={capsLabel}>Trade Efficiency (MFE/MAE)</span>
                <div className="tw:flex tw:items-center tw:gap-2 tw:font-mono-metric-md tw:text-body-sm tw:mt-0.5">
                  {stats ? <><span className="tw:text-secondary tw:font-semibold">MFE {fmtR(stats.mfe)}</span><span className="tw:text-outline-variant">/</span><span className="tw:text-error tw:font-semibold">MAE {fmtR(Math.min(0, stats.mae))}</span></> : <span className="tw:text-on-surface-variant">Needs chart data</span>}
                </div>
              </div>
              <div className={tile}><span className={capsLabel}>Hold Time (Duration)</span><span className="tw:font-mono-metric-md tw:text-on-surface tw:font-medium tw:mt-0.5">{holdTime(trade)}{stats && <span className="tw:text-outline tw:text-[10px]"> ({stats.bars ? `${stats.bars} bar${stats.bars === 1 ? '' : 's'}` : 'same bar'})</span>}</span></div>
              <div className={`${tile} tw:col-span-2 tw:flex-row tw:items-center tw:justify-between`}>
                <span className={capsLabel}>Planned Reward : Risk</span>
                <span className="tw:font-mono-metric-md tw:text-body-sm tw:text-primary tw:font-semibold">{plannedRR != null ? `1 : ${plannedRR.toFixed(2)}` : 'No target set'}</span>
              </div>
            </div>
          </div>

          {/* Discipline scorecard */}
          <div className={box}>
            <div className="tw:flex tw:items-center tw:justify-between tw:pb-2 tw:mb-2 tw:border-b tw:border-surface-container-highest">
              <div className="tw:flex tw:items-center tw:gap-1.5"><Icon name="fact_check" className="tw:text-primary tw:text-[16px]" /><span className="tw:text-body-md tw:font-semibold tw:text-on-surface">Strategy &amp; Discipline Scorecard</span></div>
              <span className={`tw:font-label-caps tw:text-label-caps tw:font-bold ${g && g.startsWith('A') ? 'tw:text-secondary' : 'tw:text-primary'}`}>{g ? `GRADE ${g}` : 'NOT SCORED'}</span>
            </div>
            <div className="tw:flex tw:flex-col tw:gap-2.5">
              <div className="tw:flex tw:items-center tw:justify-between tw:p-2 tw:rounded tw:bg-surface-container-low tw:border tw:border-surface-container-highest/60">
                <span className="tw:text-body-sm tw:text-on-surface-variant">Trading Plan Adherence:</span>
                {editing ? (
                  <div className="tw:flex tw:gap-1">
                    {([[true, 'Followed'], [false, 'Broken']] as const).map(([v, l]) => (
                      <button key={l} type="button" aria-pressed={draft.planFollowed === v} onClick={() => set('planFollowed', draft.planFollowed === v ? undefined : v)}
                        className={`tw:px-2 tw:py-0.5 tw:rounded tw:border tw:text-[11px] ${draft.planFollowed === v ? (v ? 'tw:border-secondary tw:text-secondary tw:bg-secondary/10' : 'tw:border-error tw:text-error tw:bg-error/10') : 'tw:border-outline-variant tw:text-on-surface-variant'}`}>{l}</button>
                    ))}
                  </div>
                ) : trade.planFollowed == null ? <span className="tw:text-body-sm tw:text-on-surface-variant">Not scored</span> : (
                  <div className={`tw:flex tw:items-center tw:gap-1.5 tw:font-mono-metric-md tw:text-body-sm tw:font-semibold ${trade.planFollowed ? 'tw:text-secondary' : 'tw:text-error'}`}>
                    <Icon name={trade.planFollowed ? 'check_circle' : 'cancel'} className="tw:text-[16px]" /><span>{trade.planFollowed ? 'Strictly Followed' : 'Plan Broken'}</span>
                  </div>
                )}
              </div>
              <div className="tw:flex tw:items-center tw:justify-between tw:p-2 tw:rounded tw:bg-surface-container-low tw:border tw:border-surface-container-highest/60">
                <span className="tw:text-body-sm tw:text-on-surface-variant">Setup Quality:</span>
                <Stars label="Setup quality" value={editing ? draft.setupQuality : trade.setupQuality} onChange={editing ? v => set('setupQuality', v) : undefined} />
              </div>
              <div className="tw:flex tw:items-center tw:justify-between tw:p-2 tw:rounded tw:bg-surface-container-low tw:border tw:border-surface-container-highest/60">
                <span className="tw:text-body-sm tw:text-on-surface-variant">Execution Quality:</span>
                <Stars label="Execution quality" value={editing ? draft.executionQuality : trade.executionQuality} onChange={editing ? v => set('executionQuality', v) : undefined} />
              </div>
              <div>
                <span className={`${capsLabel} tw:block tw:mb-1.5`}>Discipline Tags &amp; Mistakes:</span>
                {editing ? (
                  <input value={(draft.mistakes ?? []).join(', ')} onChange={e => set('mistakes', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} placeholder="e.g. Moved stop, Early entry" className={input} />
                ) : (
                  <div className="tw:flex tw:flex-wrap tw:gap-1.5">
                    {tags.map(t => <span key={t} className="tw:px-2 tw:py-1 tw:rounded tw:bg-surface-container-highest tw:text-primary tw:font-label-caps tw:text-label-caps">[ &apos;{t}&apos; ]</span>)}
                    {(trade.mistakes ?? []).map(m => <span key={m} className="tw:px-2 tw:py-1 tw:rounded tw:bg-error/10 tw:border tw:border-error/30 tw:text-error tw:font-label-caps tw:text-label-caps">[ &apos;{m}&apos; ]</span>)}
                    {!tags.length && !trade.mistakes?.length && <span className="tw:text-body-sm tw:text-on-surface-variant">None recorded</span>}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Notes & lesson */}
          <div className={`${box} tw:flex-1`}>
            <div className="tw:flex tw:items-center tw:justify-between tw:pb-2 tw:mb-2 tw:border-b tw:border-surface-container-highest">
              <div className="tw:flex tw:items-center tw:gap-1.5"><Icon name="rate_review" className="tw:text-primary tw:text-[16px]" /><span className="tw:text-body-md tw:font-semibold tw:text-on-surface">Trader Notes &amp; Retrospective Lesson</span></div>
              <Icon name={editing ? 'lock_open' : 'lock'} className="tw:text-outline tw:text-[16px]" />
            </div>
            {editing ? (
              <div className="tw:flex tw:flex-col tw:gap-2">
                <label className="tw:flex tw:flex-col tw:gap-1"><span className={capsLabel}>Backtest Name</span><input value={draft.name ?? ''} maxLength={100} onChange={e => set('name', e.target.value)} className={input} /></label>
                <label className="tw:flex tw:flex-col tw:gap-1"><span className={capsLabel}>Strategy Tags (comma separated)</span>
                  <input list="bt-detail-strategies" value={(draft.tags ?? []).join(', ')} onChange={e => set('tags', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} className={input} />
                  <datalist id="bt-detail-strategies">{strategies.map(s => <option key={s} value={s} />)}</datalist>
                </label>
                <label className="tw:flex tw:flex-col tw:gap-1"><span className={capsLabel}>Key Lesson</span><textarea rows={2} maxLength={2000} value={draft.lesson ?? ''} onChange={e => set('lesson', e.target.value)} className={`${input} tw:resize-none`} /></label>
                <label className="tw:flex tw:flex-col tw:gap-1"><span className={capsLabel}>Execution Notes</span><textarea rows={4} maxLength={5000} value={draft.notes ?? ''} onChange={e => set('notes', e.target.value)} className={`${input} tw:resize-none`} /></label>
                {err && <p className="tw:text-error tw:text-body-sm">{err}</p>}
                <div className="tw:flex tw:justify-end tw:gap-2">
                  <button type="button" onClick={() => setEditing(false)} className={barBtn}>Cancel</button>
                  <button type="button" onClick={() => void save()} disabled={saving} className="tw:px-3 tw:py-1 tw:rounded tw:bg-primary-container tw:text-on-primary tw:font-label-action tw:text-label-action tw:font-semibold tw:flex tw:items-center tw:gap-1.5 tw:disabled:opacity-60">
                    <Icon name={saving ? 'progress_activity' : 'save'} className={`tw:text-[15px] ${saving ? 'tw:animate-spin' : ''}`} />{saving ? 'Saving…' : 'Save Journal'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="tw:p-3 tw:rounded tw:bg-surface-container-low tw:border-l-2 tw:border-primary tw:border-y tw:border-r tw:border-y-surface-container-highest tw:border-r-surface-container-highest tw:flex-1 tw:flex tw:flex-col tw:gap-3">
                <div className="tw:flex tw:items-start tw:gap-2">
                  <Icon name="format_quote" className="tw:text-primary tw:text-[18px] tw:mt-0.5" />
                  <p className="tw:text-body-md tw:text-on-surface tw:leading-relaxed tw:whitespace-pre-wrap">{trade.lesson || <span className="tw:text-on-surface-variant">No lesson recorded yet — use Edit Journal Entry to add the one takeaway from this trade.</span>}</p>
                </div>
                {trade.notes && <p className="tw:pt-2 tw:border-t tw:border-surface-container-highest/60 tw:text-body-sm tw:text-on-surface-variant tw:whitespace-pre-wrap">{trade.notes}</p>}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Footer dock */}
      <footer className="tw:min-h-10 tw:px-4 tw:py-1 tw:bg-surface-container tw:border-t tw:border-surface-container-highest tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-2 tw:shrink-0">
        <Link href="/backtest/log" className={barBtn}><Icon name="arrow_back" className="tw:text-[14px]" /><span>Back to Backtest Log</span></Link>
        <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
          <button type="button" onClick={exportMarkdown} className={barBtn}><Icon name="description" className="tw:text-primary tw:text-[15px]" /><span>Export Case Study (Markdown)</span></button>
          {tags[0] ? (
            <Link href={`/backtest/metrics?strategy=${encodeURIComponent(tags[0])}`} className="tw:px-3 tw:py-1 tw:rounded tw:bg-primary-container tw:text-on-primary tw:font-label-action tw:text-label-action tw:font-semibold tw:hover:opacity-95 tw:flex tw:items-center tw:gap-1.5 tw:shadow-sm">
              <Icon name="insights" className="tw:text-[15px]" /><span>Jump to Quant Metrics for this Strategy</span>
            </Link>
          ) : (
            <Link href="/backtest/metrics" className="tw:px-3 tw:py-1 tw:rounded tw:bg-primary-container tw:text-on-primary tw:font-label-action tw:text-label-action tw:font-semibold tw:flex tw:items-center tw:gap-1.5 tw:shadow-sm"><Icon name="insights" className="tw:text-[15px]" /><span>Open Quant Metrics</span></Link>
          )}
        </div>
      </footer>
    </div>
  );
}
