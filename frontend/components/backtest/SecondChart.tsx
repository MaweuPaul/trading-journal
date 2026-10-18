'use client';
// A second chart beside the Workspace chart: its own timeframe and symbol,
// the shared drawing tools, and the crosshair synced both ways (same time --
// the candle it falls in -- and, on the same symbol, the same price). Nothing
// past the replay clock: closed candles, plus the still-forming candle built
// from the main chart's revealed candles when both show the same symbol.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, CandlestickSeries, ColorType, CrosshairMode } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, MouseEventParams, Time, UTCTimestamp } from 'lightweight-charts';
import type { SerializedDrawing } from 'lightweight-charts-drawing';
import { getCandles } from '../backtest-tools/candleCache';
import { CHART_INTERVALS, INTERVAL_DAYS, candleEndMs } from '../backtest-tools/types';
import type { Candle } from '../backtest-tools/types';
import { useChartDrawings } from '../chart-drawing/useChartDrawings';
import ChartDrawingToolbar from '../chart-drawing/ChartDrawingToolbar';
import ChartDrawingLayer from '../chart-drawing/ChartDrawingLayer';
import { futureSlotTimes, snapToCandles } from '../chart-drawing/drawingKit';

const BARS = 400;
const barMs = (tf: string) => (INTERVAL_DAYS[tf] ?? INTERVAL_DAYS['15min']) * 86_400_000;
/** Index of the last candle opening at or before `t` (seconds), or -1. */
function candleAt(list: { time: unknown }[], t: number) {
  let lo = 0, hi = list.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (Number(list[mid].time) <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found;
}
const AHEAD = 300;
/**
 * Candles of `symbol` from `back` bars before the clock to well past it
 * (never past now). A new block loads only once the clock nears the end of
 * the one held; a late answer still lands unless the symbol or timeframe changed.
 */
function useCandleWindow(symbol: string, interval: string, clockMs: number | null, back: number, headers: () => HeadersInit, onError: (msg: string) => void) {
  const [held, setHeld] = useState<{ key: string; from: number; to: number; latest: boolean; candles: Candle[] }>({ key: '', from: 0, to: 0, latest: false, candles: [] });
  const loading = useRef('');
  const key = `${symbol}|${interval}`;
  const bar = barMs(interval);
  const covered = held.key === key && clockMs != null && clockMs - back * bar >= held.from && (clockMs + 20 * bar <= held.to || held.latest);
  useEffect(() => {
    if (!symbol || clockMs == null || covered) return;
    const from = Math.floor(clockMs / bar) * bar - back * bar;
    const now = Math.ceil(Date.now() / bar) * bar;
    const to = Math.min(Math.floor(clockMs / bar) * bar + AHEAD * bar, now);
    const ask = `${key}|${from}`;
    if (loading.current.startsWith(`${key}|`)) return; // one block at a time per market
    loading.current = ask;
    getCandles(symbol, interval, from, to, headers())
      .then(candles => { if (loading.current === ask) { setHeld({ key, from, to, latest: to >= now, candles }); onError(''); } })
      .catch(err => { if (loading.current === ask) onError(err instanceof Error ? err.message : 'Chart data unavailable'); })
      .finally(() => { if (loading.current === ask) loading.current = ''; });
  }, [symbol, interval, clockMs, covered, key, bar, back, headers, onError]);
  useEffect(() => () => { loading.current = ''; }, [key]);
  return held.key === key ? held.candles : EMPTY;
}
const EMPTY: Candle[] = [];
const ignore = () => {};
const drawingsKey = (symbol: string) => `bt-dual-drawings:${symbol}`;
function loadDrawings(symbol: string): SerializedDrawing[] {
  try { const raw = localStorage.getItem(drawingsKey(symbol)); return raw ? JSON.parse(raw) : []; } catch { return []; }
}

export default function SecondChart({ symbol: mainSymbol, mainInterval, interval, onInterval, clockMs, mainChart, mainSeries, mainCandles, colors, headers, onClose }: {
  symbol: string; mainInterval: string; interval: string; onInterval: (tf: string) => void; clockMs: number | null;
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
  const [symbolList, setSymbolList] = useState<string[]>([]);
  useEffect(() => {
    let saved = ''; try { saved = localStorage.getItem('bt-dual-symbol') || ''; } catch { /* private mode */ }
    if (saved) queueMicrotask(() => { setOwnSymbol(saved); setSymbolDraft(saved); });
    fetch('/api/pre-trade-analyses/symbols', { headers: headers() }).then(r => (r.ok ? r.json() : { symbols: [] }))
      .then(d => setSymbolList(Array.isArray(d.symbols) ? d.symbols : [])).catch(() => {});
  }, [headers]);
  const applySymbol = (raw: string) => {
    const want = raw.trim().toUpperCase().slice(0, 30);
    const next = want === mainSymbol ? '' : want;
    setOwnSymbol(next); setSymbolDraft(next);
    try { if (next) localStorage.setItem('bt-dual-symbol', next); else localStorage.removeItem('bt-dual-symbol'); } catch { /* private mode */ }
  };
  const symbol = ownSymbol || mainSymbol;
  const sameMarket = !ownSymbol;

  // Drawings (the shared tools), kept per symbol in this browser.
  const symbolRef = useRef(symbol);
  const engine = useChartDrawings({
    onChange: drawings => { try { localStorage.setItem(drawingsKey(symbolRef.current), JSON.stringify(drawings.slice(0, 200))); } catch { /* full or private */ } },
    getCandles: () => dataRef.current,
  });
  const { attach, replaceDrawings } = engine;
  useEffect(() => {
    symbolRef.current = symbol;
    replaceDrawings(loadDrawings(symbol));
  }, [symbol, replaceDrawings]);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);
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

  // The chart itself, with the drawing tools attached.
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
    const detach = attach(chart, series, el, loadDrawings(symbolRef.current));
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => { ro.disconnect(); detach(); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, [colors.bg, colors.text, colors.grid, colors.up, colors.down, attach]);

  // Candles around the replay clock, loaded in blocks that reach ahead of
  // it and revealed locally, so replay never waits on the network each candle.
  const nearClock = useCandleWindow(symbol, interval, clockMs, BARS, headers, setError);
  const firstLoad = useRef(true);
  useEffect(() => { firstLoad.current = true; }, [interval, symbol]);
  const closed = useMemo(() => {
    if (clockMs == null) return [];
    return nearClock.filter(c => candleEndMs(Number(c.time), interval) <= clockMs);
  }, [nearClock, clockMs, interval]);
  // Another symbol on a larger timeframe: its forming candle comes from its
  // own candles on the main chart's timeframe.
  const needFine = !sameMarket && barMs(mainInterval) < barMs(interval);
  const fine = useCandleWindow(needFine ? symbol : '', mainInterval, clockMs, Math.ceil(barMs(interval) / barMs(mainInterval)) + 1, headers, ignore);

  // Closed candles + the forming one (same symbol, main chart on a smaller
  // timeframe: its revealed candles inside the current bar) + empty slots so
  // drawings can reach past the last candle.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || clockMs == null) return;
    const bar = barMs(interval), mainBar = barMs(mainInterval);
    // Where the last closed candle ends (daily/weekly candles don't start on multiples of their length).
    const start = closed.length ? candleEndMs(Number(closed[closed.length - 1].time), interval) : Math.floor(clockMs / bar) * bar;
    const shown: Candle[] = [...closed];
    const source = sameMarket ? mainCandles : needFine ? fine : null;
    if (mainBar < bar && source?.length) {
      const inBar = source.filter(c => Number(c.time) * 1000 >= start && Number(c.time) * 1000 + mainBar <= clockMs);
      if (inBar.length) {
        shown.push({
          time: inBar[0].time as Candle['time'], open: inBar[0].open, close: inBar[inBar.length - 1].close,
          high: Math.max(...inBar.map(c => c.high)), low: Math.min(...inBar.map(c => c.low)),
        } as Candle);
      }
    }
    dataRef.current = shown;
    if (!shown.length) { series.setData([]); return; }
    // Decimals to suit the market: 5 for FX pairs, 2 for gold and indices.
    const last = shown[shown.length - 1].close;
    const precision = last < 10 ? 5 : last < 200 ? 3 : 2;
    series.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
    const slots = futureSlotTimes(Number(shown[shown.length - 1].time), bar / 1000, engine.exportDrawings(), [], 60);
    series.setData([
      ...shown.map(c => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })),
      ...slots.map(t => ({ time: t as UTCTimestamp })),
    ]);
    if (firstLoad.current && closed.length) { // not before the history has loaded
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, shown.length - 120), to: shown.length + 4 });
      firstLoad.current = false;
      replaceDrawings(snapToCandles(loadDrawings(symbolRef.current), shown.map(c => Number(c.time))));
    }
    // engine.exportDrawings is read fresh; the engine object itself changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closed, clockMs, interval, mainInterval, mainCandles, sameMarket, needFine, fine, replaceDrawings]);

  // Crosshair sync, both ways.
  useEffect(() => {
    const chart = chartRef.current, series = seriesRef.current;
    if (!chart || !series || !mainChart || !mainSeries) return;
    // Only the chart under the mouse drives the other one: setting a
    // crosshair fires that chart's own crosshair event, and mirroring those
    // back and forth never stops.
    let hovered: 'main' | 'second' | null = null;
    // Another symbol: sync the time only, and put the crosshair on that candle's close.
    const mirror = (p: MouseEventParams<Time>, fromSeries: ISeriesApi<'Candlestick'>, to: IChartApi, toSeries: ISeriesApi<'Candlestick'>, toData: { time: unknown; close: number }[]) => {
      {
        const i = p.time == null || !p.point ? -1 : candleAt(toData, Number(p.time));
        const price = !p.point ? null : sameMarket ? fromSeries.coordinateToPrice(p.point.y) : i >= 0 ? toData[i].close : null;
        if (i < 0 || price == null) to.clearCrosshairPosition();
        else to.setCrosshairPosition(Number(price), toData[i].time as Time, toSeries);
      }
    };
    const fromMain = (p: MouseEventParams<Time>) => { if (hovered === 'main') mirror(p, mainSeries, chart, series, dataRef.current); };
    const fromSecond = (p: MouseEventParams<Time>) => { if (hovered === 'second') mirror(p, series, mainChart, mainSeries, mainCandles ?? []); };
    const mainEl = mainChart.chartElement(), secondEl = chart.chartElement();
    const enterMain = () => { hovered = 'main'; }, enterSecond = () => { hovered = 'second'; };
    const leaveMain = () => { if (hovered === 'main') { hovered = null; chart.clearCrosshairPosition(); } };
    const leaveSecond = () => { if (hovered === 'second') { hovered = null; mainChart.clearCrosshairPosition(); } };
    mainEl.addEventListener('mouseenter', enterMain); mainEl.addEventListener('mouseleave', leaveMain);
    secondEl.addEventListener('mouseenter', enterSecond); secondEl.addEventListener('mouseleave', leaveSecond);
    mainChart.subscribeCrosshairMove(fromMain);
    chart.subscribeCrosshairMove(fromSecond);
    return () => {
      mainEl.removeEventListener('mouseenter', enterMain); mainEl.removeEventListener('mouseleave', leaveMain);
      secondEl.removeEventListener('mouseenter', enterSecond); secondEl.removeEventListener('mouseleave', leaveSecond);
      mainChart.unsubscribeCrosshairMove(fromMain); chart.unsubscribeCrosshairMove(fromSecond);
    };
  }, [mainChart, mainSeries, mainCandles, colors.bg, sameMarket]);

  return (
    <div className="tw:flex tw:flex-1 tw:min-w-0 tw:border-l tw:border-surface-container-highest">
      <ChartDrawingToolbar engine={engine} />
      <div className="tw:relative tw:flex-1 tw:min-w-0"
        onContextMenu={e => { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: e.clientX - r.left, y: e.clientY - r.top }); }}>
        <div ref={hostRef} className="tw:absolute tw:inset-0" />
        <ChartDrawingLayer engine={engine} />
        <div className="tw:absolute tw:top-1 tw:left-1 tw:z-10 tw:flex tw:items-center tw:gap-1 tw:bg-surface-container-high/90 tw:rounded tw:px-1 tw:py-0.5">
          <input value={symbolDraft} placeholder={mainSymbol} list="bt-second-chart-symbols" aria-label="Second chart symbol"
            title="Search a symbol for this chart (blank = same as the main chart)"
            onChange={e => {
              const v = e.target.value.toUpperCase();
              setSymbolDraft(v);
              if (symbolList.includes(v)) applySymbol(v); // picked from the list
            }}
            onKeyDown={e => { if (e.key === 'Enter') applySymbol(symbolDraft); if (e.key === 'Escape') setSymbolDraft(ownSymbol); e.stopPropagation(); }}
            onBlur={() => applySymbol(symbolDraft)}
            className="tw:w-24 tw:px-1.5 tw:py-0.5 tw:rounded tw:bg-surface-container-lowest tw:border tw:border-outline-variant tw:font-mono-metric-md tw:text-[10px] tw:text-on-surface tw:uppercase" />
          <datalist id="bt-second-chart-symbols">
            {symbolList.map(s => <option key={s} value={s} />)}
          </datalist>
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
    </div>
  );
}
