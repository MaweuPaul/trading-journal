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

export default function SecondChart({ symbol, interval, onInterval, clockMs, mainChart, mainSeries, mainCandles, colors, headers, onClose }: {
  symbol: string; interval: string; onInterval: (tf: string) => void; clockMs: number | null;
  mainChart: IChartApi | null; mainSeries: ISeriesApi<'Candlestick'> | null; mainCandles: Candle[] | null;
  colors: { bg: string; text: string; grid: string; up: string; down: string }; headers: () => HeadersInit; onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const dataRef = useRef<Candle[]>([]);
  const [error, setError] = useState('');

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
    const mirror = (p: MouseEventParams<Time>, fromSeries: ISeriesApi<'Candlestick'>, to: IChartApi, toSeries: ISeriesApi<'Candlestick'>, toData: { time: unknown }[]) => {
      if (syncing) return;
      syncing = true;
      try {
        const i = p.time == null || !p.point ? -1 : candleAt(toData, Number(p.time));
        const price = p.point ? fromSeries.coordinateToPrice(p.point.y) : null;
        if (i < 0 || price == null) to.clearCrosshairPosition();
        else to.setCrosshairPosition(Number(price), toData[i].time as Time, toSeries);
      } finally { syncing = false; }
    };
    const fromMain = (p: MouseEventParams<Time>) => mirror(p, mainSeries, chart, series, dataRef.current);
    const fromSecond = (p: MouseEventParams<Time>) => mirror(p, series, mainChart, mainSeries, mainCandles ?? []);
    mainChart.subscribeCrosshairMove(fromMain);
    chart.subscribeCrosshairMove(fromSecond);
    return () => { mainChart.unsubscribeCrosshairMove(fromMain); chart.unsubscribeCrosshairMove(fromSecond); };
  }, [mainChart, mainSeries, mainCandles, colors.bg]);

  return (
    <div className="tw:relative tw:flex-1 tw:min-w-0 tw:border-l tw:border-surface-container-highest">
      <div ref={hostRef} className="tw:absolute tw:inset-0" />
      <div className="tw:absolute tw:top-1 tw:left-1 tw:z-10 tw:flex tw:items-center tw:gap-1 tw:bg-surface-container-high/90 tw:rounded tw:px-1 tw:py-0.5">
        {CHART_INTERVALS.map(tf => (
          <button key={tf.value} type="button" onClick={() => onInterval(tf.value)} aria-pressed={interval === tf.value}
            className={`tw:px-1.5 tw:py-0.5 tw:rounded tw:font-mono-metric-md tw:text-[10px] ${interval === tf.value ? 'tw:bg-primary/20 tw:text-primary' : 'tw:text-on-surface-variant tw:hover:text-on-surface'}`}>
            {tf.label}
          </button>
        ))}
        <button type="button" onClick={onClose} title="Close second chart" aria-label="Close second chart" className="tw:ml-1 tw:px-1 tw:text-on-surface-variant tw:hover:text-error tw:text-[12px]">✕</button>
      </div>
      {error && <div className="tw:absolute tw:inset-x-0 tw:top-10 tw:text-center tw:text-body-sm tw:text-on-surface-variant">{error}</div>}
    </div>
  );
}
