'use client';
// A second chart beside the Workspace chart, on its own timeframe, showing
// only candles already closed at the replay clock (no hindsight). The
// crosshair is synced both ways: same time (the candle it falls in) and price.
import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, ColorType, CrosshairMode } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, MouseEventParams, Time, UTCTimestamp } from 'lightweight-charts';
import { getCandles } from '../backtest-tools/candleCache';
import { CHART_INTERVALS, INTERVAL_DAYS } from '../backtest-tools/types';
import type { Candle } from '../backtest-tools/types';

const BARS = 400;
const barMs = (tf: string) => (INTERVAL_DAYS[tf] ?? INTERVAL_DAYS['15min']) * 86_400_000;
/** Index of the last candle opening at or before `t` (seconds), or -1. */
function candleAt(list: { time: unknown }[], t: number) {
  let lo = 0, hi = list.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (Number(list[mid].time) <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found;
}

export default function SecondChart({ symbol: mainSymbol, interval, onInterval, clockMs, mainChart, mainSeries, mainCandles, colors, headers, onClose }: {
  symbol: string; interval: string; onInterval: (tf: string) => void; clockMs: number | null;
  mainChart: IChartApi | null; mainSeries: ISeriesApi<'Candlestick'> | null; mainCandles: Candle[] | null;
  colors: { bg: string; text: string; grid: string; up: string; down: string }; headers: () => HeadersInit; onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const dataRef = useRef<Candle[]>([]);
  const [error, setError] = useState('');
  // Its own symbol (blank = same as the main chart), remembered per browser.
  const [ownSymbol, setOwnSymbol] = useState('');
  const [symbolDraft, setSymbolDraft] = useState('');
  useEffect(() => { let saved = ''; try { saved = localStorage.getItem('bt-dual-symbol') || ''; } catch { /* private mode */ } if (saved) queueMicrotask(() => { setOwnSymbol(saved); setSymbolDraft(saved); }); }, []);
  const applySymbol = (raw: string) => {
    const next = raw.trim().toUpperCase() === mainSymbol ? '' : raw.trim().toUpperCase().slice(0, 30);
    setOwnSymbol(next); setSymbolDraft(next);
    try { if (next) localStorage.setItem('bt-dual-symbol', next); else localStorage.removeItem('bt-dual-symbol'); } catch { /* private mode */ }
  };
  const symbol = ownSymbol || mainSymbol;
  const sameMarket = !ownSymbol;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Right-click menu, like the main chart: default zoom on the latest candle, or all candles.
  const resetView = () => {
    const n = dataRef.current.length, chart = chartRef.current; if (!chart || !n) return;
    const bars = Math.max(60, Math.min(240, Math.round(chart.chartElement().clientWidth / 8)));
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(-4, n - 1 - bars), to: n - 1 + 4 });
    chart.priceScale('right').applyOptions({ autoScale: true });
  };
  const fitAll = () => {
    const n = dataRef.current.length, chart = chartRef.current; if (!chart || !n) return;
    chart.timeScale().setVisibleLogicalRange({ from: 0, to: n - 1 + 4 });
    chart.priceScale('right').applyOptions({ autoScale: true });
  };

  // The chart itself.
  useEffect(() => {
    const el = hostRef.current; if (!el) return;
    const chart = createChart(el, {
      width: el.clientWidth, height: el.clientHeight,
      layout: { background: { type: ColorType.Solid, color: colors.bg }, textColor: colors.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 10 },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { borderColor: colors.grid, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      rightPriceScale: { borderColor: colors.grid },
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: colors.up, downColor: colors.down, borderVisible: false, wickUpColor: colors.up, wickDownColor: colors.down });
    chartRef.current = chart; seriesRef.current = series;
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, [colors.bg, colors.text, colors.grid, colors.up, colors.down]);

  // Candles closed by the replay clock (refetched as it moves; the cache keeps this cheap).
  const closedBar = clockMs == null ? null : Math.floor(clockMs / barMs(interval));
  const firstLoad = useRef(true);
  useEffect(() => { firstLoad.current = true; }, [interval, symbol]);
  useEffect(() => {
    if (closedBar == null || !symbol) return;
    let cancelled = false;
    const toMs = closedBar * barMs(interval);
    getCandles(symbol, interval, toMs - BARS * barMs(interval), toMs, headers())
      .then(list => {
        if (cancelled || !seriesRef.current) return;
        const closed = list.filter(c => Number(c.time) * 1000 + barMs(interval) <= toMs);
        dataRef.current = closed;
        // Decimals to suit the market: 5 for FX pairs, 2 for gold and indices.
        const last = closed[closed.length - 1]?.close ?? 0;
        const precision = last < 10 ? 5 : last < 200 ? 3 : 2;
        seriesRef.current.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
        seriesRef.current.setData(closed.map(c => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
        if (firstLoad.current && closed.length) {
          chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, closed.length - 120), to: closed.length + 4 });
          firstLoad.current = false;
        }
        setError('');
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Chart data unavailable'); });
    return () => { cancelled = true; };
  }, [symbol, interval, closedBar, headers]);

  // Crosshair sync, both ways.
  useEffect(() => {
    const chart = chartRef.current, series = seriesRef.current;
    if (!chart || !series || !mainChart || !mainSeries) return;
    let syncing = false;
    // Another symbol: sync the time only, and put the crosshair on that candle's close.
    const mirror = (p: MouseEventParams<Time>, fromSeries: ISeriesApi<'Candlestick'>, to: IChartApi, toSeries: ISeriesApi<'Candlestick'>, toData: { time: unknown; close: number }[]) => {
      if (syncing) return;
      syncing = true;
      try {
        const i = p.time == null || !p.point ? -1 : candleAt(toData, Number(p.time));
        const price = !p.point ? null : sameMarket ? fromSeries.coordinateToPrice(p.point.y) : i >= 0 ? toData[i].close : null;
        if (i < 0 || price == null) to.clearCrosshairPosition();
        else to.setCrosshairPosition(Number(price), toData[i].time as Time, toSeries);
      } finally { syncing = false; }
    };
    const fromMain = (p: MouseEventParams<Time>) => mirror(p, mainSeries, chart, series, dataRef.current);
    const fromSecond = (p: MouseEventParams<Time>) => mirror(p, series, mainChart, mainSeries, mainCandles ?? []);
    mainChart.subscribeCrosshairMove(fromMain);
    chart.subscribeCrosshairMove(fromSecond);
    return () => { mainChart.unsubscribeCrosshairMove(fromMain); chart.unsubscribeCrosshairMove(fromSecond); };
  }, [mainChart, mainSeries, mainCandles, colors.bg, sameMarket]);

  return (
    <div className="tw:relative tw:flex-1 tw:min-w-0 tw:border-l tw:border-surface-container-highest"
      onContextMenu={e => { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: e.clientX - r.left, y: e.clientY - r.top }); }}>
      <div ref={hostRef} className="tw:absolute tw:inset-0" />
      <div className="tw:absolute tw:top-1 tw:left-1 tw:z-10 tw:flex tw:items-center tw:gap-1 tw:bg-surface-container-high/90 tw:rounded tw:px-1 tw:py-0.5">
        <input value={symbolDraft} placeholder={mainSymbol} aria-label="Second chart symbol" title="Symbol for this chart (blank = same as the main chart)"
          onChange={e => setSymbolDraft(e.target.value.toUpperCase())}
          onKeyDown={e => { if (e.key === 'Enter') applySymbol(symbolDraft); if (e.key === 'Escape') setSymbolDraft(ownSymbol); e.stopPropagation(); }}
          onBlur={() => applySymbol(symbolDraft)}
          className="tw:w-20 tw:px-1.5 tw:py-0.5 tw:rounded tw:bg-surface-container-lowest tw:border tw:border-outline-variant tw:font-mono-metric-md tw:text-[10px] tw:text-on-surface tw:uppercase" />
        {CHART_INTERVALS.map(tf => (
          <button key={tf.value} type="button" onClick={() => onInterval(tf.value)} aria-pressed={interval === tf.value}
            className={`tw:px-1.5 tw:py-0.5 tw:rounded tw:font-mono-metric-md tw:text-[10px] ${interval === tf.value ? 'tw:bg-primary/20 tw:text-primary' : 'tw:text-on-surface-variant tw:hover:text-on-surface'}`}>
            {tf.label}
          </button>
        ))}
        <button type="button" onClick={onClose} title="Close second chart" aria-label="Close second chart" className="tw:ml-1 tw:px-1 tw:text-on-surface-variant tw:hover:text-error tw:text-[12px]">✕</button>
      </div>
      {menu && (
        <>
          <div className="tw:fixed tw:inset-0 tw:z-40" onMouseDown={() => setMenu(null)} onContextMenu={e => { e.preventDefault(); setMenu(null); }} />
          <div role="menu" aria-label="Second chart" className="tw:absolute tw:z-50 tw:min-w-44 tw:py-1 tw:bg-surface-container tw:border tw:border-outline-variant tw:rounded-lg tw:shadow-lg" style={{ left: menu.x, top: menu.y }}>
            <button type="button" role="menuitem" onClick={() => { resetView(); setMenu(null); }} className="tw:w-full tw:flex tw:items-center tw:gap-2 tw:px-3 tw:py-1.5 tw:text-body-sm tw:text-on-surface tw:hover:bg-surface-container-high tw:text-left">Reset chart</button>
            <button type="button" role="menuitem" onClick={() => { fitAll(); setMenu(null); }} className="tw:w-full tw:flex tw:items-center tw:gap-2 tw:px-3 tw:py-1.5 tw:text-body-sm tw:text-on-surface tw:hover:bg-surface-container-high tw:text-left">Fit all candles</button>
          </div>
        </>
      )}
      {error && <div className="tw:absolute tw:inset-x-0 tw:top-10 tw:text-center tw:text-body-sm tw:text-on-surface-variant">{error}</div>}
    </div>
  );
}
