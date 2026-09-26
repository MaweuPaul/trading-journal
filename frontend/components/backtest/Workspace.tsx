'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  createChart, CandlestickSeries, HistogramSeries, LineSeries, ColorType, CrosshairMode, LineStyle,
} from 'lightweight-charts';
import type { IChartApi, ISeriesApi, MouseEventParams, Time } from 'lightweight-charts';
import { DrawingManager, getToolRegistry } from 'lightweight-charts-drawing';
import type { Anchor, IDrawing, SerializedDrawing } from 'lightweight-charts-drawing';
import { useTheme } from '../ThemeProvider';
import { Icon } from './BacktestShell';
import { BacktestTrade, authHeaders, fmtR, fmtUSD, hashTag, useBacktest } from './data';
import JournalFields, { EMPTY_JOURNAL, JournalValues } from './JournalFields';
import { WorkspaceDraft, readDraft, writeDraft, clearDraft, sessionIdFor } from './session';
import { useIsDesktop } from './layout';
import { EMA_CONFIG, ema, rsi, symbolDescription } from './indicators';
import {
  Candle, MeasureRange, OpenTrade, ClosedTrade, TradeHandle,
  CHART_INTERVALS, INTERVAL_DAYS, SPEEDS, isoDaysAgo, fmtPrice, suggestInterval, lookbackMs, nearestCandleIndex,
} from '../backtest-tools/types';
import {
  placeTradeAt as placeTradeAtPure, updateHandlePrice as updateHandlePricePure,
  findTradeHandleAt as findTradeHandleAtIn, drawTradeOverlay, OverlayPalette,
} from '../backtest-tools/positionTool';
import { drawMeasureOverlay } from '../backtest-tools/measureTool';
import { ChartFetchError, getCandles } from '../backtest-tools/candleCache';

// ── Tool catalogue ───────────────────────────────────────────────────────────
// `type` is the lightweight-charts-drawing registry key.
type ToolId = 'select' | 'measure' | 'position' | string;
const WORKSPACE_TOOLS: { id: ToolId; icon: string; label: string }[] = [
  { id: 'select', icon: 'filter_center_focus', label: 'Crosshair / select' },
  { id: 'trend-line', icon: 'show_chart', label: 'Trend line' },
  { id: 'ray', icon: 'arrow_outward', label: 'Ray' },
  { id: 'horizontal-line', icon: 'horizontal_rule', label: 'Horizontal line' },
  { id: 'rectangle', icon: 'crop_square', label: 'Rectangle / zone' },
  { id: 'parallel-channel', icon: 'view_stream', label: 'Parallel channel' },
  { id: 'fib-retracement', icon: 'stacked_bar_chart', label: 'Fib retracement' },
  { id: 'fib-extension', icon: 'stacked_line_chart', label: 'Fib extension' },
  { id: 'arrow', icon: 'north_east', label: 'Arrow' },
  { id: 'measure', icon: 'straighten', label: 'Measure' },
  { id: 'text-annotation', icon: 'title', label: 'Text note' },
];
const STYLE_SWATCHES = [
  { color: '#3b82f6', cls: 'tw:bg-[#3b82f6]', label: 'Blue' },
  { color: '#16a34a', cls: 'tw:bg-[#16a34a]', label: 'Green' },
  { color: '#dc2626', cls: 'tw:bg-[#dc2626]', label: 'Red' },
  { color: '#f59e0b', cls: 'tw:bg-[#f59e0b]', label: 'Amber' },
];
const VIEW_INTERVALS = CHART_INTERVALS;
const DAY = 86_400_000;
// Candles are streamed a page at a time: the next page is fetched once the
// replay gets within PREFETCH_BARS of the end of what's loaded.
const CHUNK_BARS = 1500;
const PREFETCH_BARS = 300;
const barMsOf = (tf: string) => (INTERVAL_DAYS[tf] ?? INTERVAL_DAYS['15min']) * DAY;

/** Did this candle trade through the trade's stop / target? */
function levelsHit(c: Candle, t: OpenTrade) {
  const long = t.direction === 'long';
  return {
    sl: long ? c.low <= t.stopLoss : c.high >= t.stopLoss,
    tp: t.takeProfit != null && (long ? c.high >= t.takeProfit : c.low <= t.takeProfit),
  };
}
const FINER: Record<string, string> = { '1day': '4h', '4h': '1h', '1h': '15min', '15min': '5min', '5min': '1min' };
/**
 * Which level was reached first inside [startMs, endMs), walking smaller and
 * smaller candles (down to 1m) while a candle still spans both. If even 1m
 * can't separate them, the stop is assumed (the conservative reading).
 */
async function firstLevelHit(symbol: string, tf: string, startMs: number, endMs: number, t: OpenTrade): Promise<'sl' | 'tp'> {
  const finer = FINER[tf];
  if (!finer) return 'sl';
  const parts = await getCandles(symbol, finer, startMs, endMs, authHeaders());
  const step = barMsOf(finer);
  for (const p of parts) {
    const h = levelsHit(p, t);
    if (h.sl && h.tp) {
      const s = Number(p.time) * 1000;
      return firstLevelHit(symbol, finer, s, Math.min(endMs, s + step), t);
    }
    if (h.sl) return 'sl';
    if (h.tp) return 'tp';
  }
  return 'sl';
}

// A drawing being placed: `placed` anchors are fixed, the rest follow the
// cursor until clicked (or, for the 2nd anchor, until a drag is released).
interface PendingDrawing { drawing: IDrawing; required: number; placed: number; startX: number; startY: number; origin: Anchor }
interface Indicators { ema: boolean; rsi: boolean; volume: boolean }

function drawingFactory(type: string, data: SerializedDrawing) {
  return getToolRegistry().createDrawing(type, data.id, data.anchors, data.style, data.options);
}
function cssVar(el: Element | null, name: string, fallback: string) {
  const v = el ? getComputedStyle(el).getPropertyValue(name).trim() : '';
  return v || fallback;
}
function hexAlpha(hex: string, alpha: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
function fmtTick(unixSeconds: number) {
  const d = new Date(unixSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export default function Workspace() {
  const isDesktop = useIsDesktop();
  const params = useSearchParams();
  const { resolvedTheme } = useTheme();
  const { activeSymbol, setActiveSymbol, strategies, addTrade, currentStrategy, setCurrentStrategy } = useBacktest();

  const rootRef = useRef<HTMLDivElement>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lineRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const emaRefs = useRef<ISeriesApi<'Line'>[]>([]);
  const rsiRef = useRef<ISeriesApi<'Line'> | null>(null);
  const managerRef = useRef<DrawingManager | null>(null);

  // ── Session autosave ─────────────────────────────────────────────────────
  const [draftAvailable, setDraftAvailable] = useState<WorkspaceDraft | null>(null);
  const pendingRestoreRef = useRef<WorkspaceDraft | null>(null);

  // ── Setup ──────────────────────────────────────────────────────────────────
  const [symbol, setSymbol] = useState(() => params.get('symbol') || activeSymbol || 'XAUUSD');
  const [fromDate, setFromDate] = useState(() => params.get('from') || isoDaysAgo(30));
  const [toDate, setToDate] = useState(() => params.get('to') || isoDaysAgo(0));
  const [interval, setInterval_] = useState(() => params.get('interval') || suggestInterval(isoDaysAgo(30), isoDaysAgo(0)));
  const intervalTouchedRef = useRef(Boolean(params.get('interval')));
  const [candles, setCandles] = useState<Candle[] | null>(null);
  // After switching to a higher timeframe mid-replay, the candle still forming
  // is shown as rebuilt from revealed candles (no peeking at its real close).
  const [partial, setPartial] = useState<{ idx: number; candle: Candle; endMs: number } | null>(null);
  const resolvingRef = useRef<string | null>(null);
  // Bumped on every fresh load / timeframe switch. The chart is rebuilt only
  // then -- appending streamed candles keeps drawings and zoom intact.
  const [chartEpoch, setChartEpoch] = useState(0);
  const chartEpochRef = useRef(0);
  useEffect(() => { chartEpochRef.current = chartEpoch; }, [chartEpoch]);
  const candlesRef = useRef<Candle[] | null>(null);
  useEffect(() => { candlesRef.current = candles; }, [candles]);
  // What the loaded candles belong to, and how far ahead they reach.
  const sessionRef = useRef<{ symbol: string; interval: string; fromMs: number; toMs: number; loadedToMs: number } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [analysisStartIdx, setAnalysisStartIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isSetupError, setIsSetupError] = useState(false);

  // ── Replay ─────────────────────────────────────────────────────────────────
  const [replayIdx, setReplayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  // ── Tools ──────────────────────────────────────────────────────────────────
  const [activeDrawType, setActiveDrawType] = useState<string | null>(null);
  const [drawColor, setDrawColor] = useState<string>(STYLE_SWATCHES[0].color);
  const drawColorRef = useRef(drawColor);
  useEffect(() => { drawColorRef.current = drawColor; }, [drawColor]);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [drawingCount, setDrawingCount] = useState(0);
  const drawingHistoryRef = useRef<SerializedDrawing[][]>([]);
  const [historyDepth, setHistoryDepth] = useState(0);
  const pendingDrawingRef = useRef<PendingDrawing | null>(null);
  const [magnet, setMagnet] = useState(false);
  const [measureActive, setMeasureActive] = useState(false);
  const [measureRange, setMeasureRange] = useState<MeasureRange | null>(null);
  const measureDragRef = useRef<(MeasureRange & { x1: number; y1: number; x2: number; y2: number }) | null>(null);

  // ── Chart view extras ──────────────────────────────────────────────────────
  // EMAs only by default; RSI and volume stay available in the Indicators menu.
  const [indicators, setIndicators] = useState<Indicators>({ ema: true, rsi: false, volume: false });
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);
  const [chartType, setChartType] = useState<'candles' | 'line'>('candles');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // ── Trade ──────────────────────────────────────────────────────────────────
  const [placingDirection, setPlacingDirection] = useState<'long' | 'short' | null>(null);
  const [riskAmountInput, setRiskAmountInput] = useState(() => params.get('risk') || '100');
  const [openTrade, setOpenTrade] = useState<OpenTrade | null>(null);
  const draggingHandleRef = useRef<TradeHandle | null>(null);
  const [hoveredHandle, setHoveredHandle] = useState<TradeHandle | null>(null);
  const [closedTrade, setClosedTrade] = useState<ClosedTrade | null>(null);
  const [showCloseout, setShowCloseout] = useState(false);
  const [notes, setNotes] = useState('');
  const [journal, setJournal] = useState<JournalValues>(EMPTY_JOURNAL);
  const [backtestName, setBacktestName] = useState(() => params.get('name') || '');
  const [tags, setTags] = useState<string[]>(() => { const s = params.get('strategy') || currentStrategy; return s ? [s] : []; });
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [toast, setToast] = useState('');

  const redrawCanvasRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const incomingStrategy = params.get('strategy');
    if (incomingStrategy) setCurrentStrategy(incomingStrategy);
  }, []);

  // The strategy this session tests, and the slot it autosaves into (one
  // saved session per strategy). A resumed session keeps its own slot.
  const sessionStrategyRef = useRef(params.get('strategy') ?? '');
  const sessionSlotRef = useRef(sessionIdFor(params.get('strategy')));

  const resumeDraft = (d?: WorkspaceDraft) => {
    const draft = d ?? draftAvailable; if (!draft) return;
    pendingRestoreRef.current = draft;
    sessionStrategyRef.current = draft.strategy ?? '';
    sessionSlotRef.current = draft.id ?? sessionIdFor(draft.strategy);
    setDraftAvailable(null);
    setSymbol(draft.symbol); setFromDate(draft.fromDate); setToDate(draft.toDate);
    intervalTouchedRef.current = true; setInterval_(draft.interval);
    setDrawColor(draft.drawColor);
    loadChartWithInterval(draft.interval, { symbol: draft.symbol, fromDate: draft.fromDate, toDate: draft.toDate });
  };
  const discardDraft = () => { if (draftAvailable) clearDraft(draftAvailable.id ?? sessionIdFor(draftAvailable.strategy)); setDraftAvailable(null); };
  const endSession = () => {
    if (!window.confirm(`End the ${symbol.trim().toUpperCase()} session? Drawings and any open hypothetical trade are discarded. Saved backtests are not affected.`)) return;
    setPlaying(false); resetTrade(); setCandles(null); setChartEpoch(e => e + 1); sessionRef.current = null;
    clearDraft(sessionSlotRef.current); setDraftAvailable(null);
  };

  // Autosave: whatever's currently on screen, so it survives a refresh or
  // an accidental nav-away. Best-effort and silent -- never blocks the UI.
  useEffect(() => {
    if (!candles) return;
    const t = setTimeout(() => {
      writeDraft({
        symbol: symbol.trim().toUpperCase(), fromDate, toDate, interval,
        replayIdx, analysisStartIdx, totalBars: candles.length, openTrade,
        replayTime: Number(candles[replayIdx]?.time ?? 0) || undefined, strategy: sessionStrategyRef.current, id: sessionSlotRef.current,
        backtestName, notes, tags, drawColor,
        drawings: managerRef.current?.exportDrawings() ?? [],
        savedAt: Date.now(),
      });
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, symbol, fromDate, toDate, interval, replayIdx, analysisStartIdx, openTrade, backtestName, notes, tags, drawColor, drawingCount]);

  // Re-suggest the timeframe when the range changes (cTrader caps a request
  // at 1500 bars) unless the trader picked one explicitly.
  useEffect(() => {
    if (intervalTouchedRef.current || candles) return;
    setInterval_(suggestInterval(fromDate, toDate));
  }, [fromDate, toDate, candles]);

  // ── Drawing history / tools ────────────────────────────────────────────────
  const pushHistorySnapshot = () => {
    const manager = managerRef.current; if (!manager) return;
    drawingHistoryRef.current = [...drawingHistoryRef.current.slice(-19), manager.exportDrawings()];
    setHistoryDepth(drawingHistoryRef.current.length);
  };
  const cancelPendingDrawing = () => {
    const pending = pendingDrawingRef.current;
    if (pending) { pendingDrawingRef.current = null; managerRef.current?.removeDrawing(pending.drawing.id); }
  };
  const activateSelectMode = () => {
    cancelPendingDrawing();
    managerRef.current?.setActiveTool(null);
    setActiveDrawType(null);
    setMeasureActive(false);
    setPlacingDirection(null);
  };
  const activateTool = (id: ToolId) => {
    if (id === 'select') { activateSelectMode(); setMeasureRange(null); return; }
    if (id === 'measure') {
      const next = !measureActive;
      activateSelectMode();
      setMeasureActive(next); setMeasureRange(null); measureDragRef.current = null;
      return;
    }
    if (id === 'position') {
      if (openTrade || closedTrade) return;
      const next = placingDirection ? null : 'long';
      activateSelectMode();
      setPlacingDirection(next);
      return;
    }
    const manager = managerRef.current; if (!manager) return;
    if (activeDrawType === id) { activateSelectMode(); return; }
    cancelPendingDrawing();
    pushHistorySnapshot();
    manager.deselectAll();
    manager.setActiveTool(id);
    setActiveDrawType(id);
    setPlacingDirection(null);
    setMeasureActive(false);
  };
  const isToolActive = (id: ToolId) => {
    if (id === 'select') return !activeDrawType && !measureActive && !placingDirection;
    if (id === 'measure') return measureActive;
    if (id === 'position') return Boolean(placingDirection);
    return activeDrawType === id;
  };
  const undoDrawing = () => {
    const manager = managerRef.current; if (!manager) return;
    const last = drawingHistoryRef.current.pop();
    if (last === undefined) return;
    setHistoryDepth(drawingHistoryRef.current.length);
    manager.clearAll();
    manager.importDrawings(last, drawingFactory);
    setSelectedDrawingId(null);
  };
  const deleteSelectedDrawing = () => {
    const manager = managerRef.current; if (!manager || !selectedDrawingId) return;
    pushHistorySnapshot();
    manager.removeDrawing(selectedDrawingId);
    setSelectedDrawingId(null);
  };
  const clearAllDrawings = () => {
    const manager = managerRef.current; if (!manager || !manager.getAllDrawings().length) return;
    if (!window.confirm('Remove every drawing from this chart?')) return;
    pushHistorySnapshot();
    manager.clearAll();
    setSelectedDrawingId(null);
  };
  const pickColor = (color: string) => {
    setDrawColor(color);
    const manager = managerRef.current;
    if (manager && selectedDrawingId) {
      const d = manager.getDrawing(selectedDrawingId);
      if (d) { pushHistorySnapshot(); d.updateStyle({ lineColor: color }); d.requestUpdate(); }
    }
  };

  // ── Load candles ───────────────────────────────────────────────────────────
  // `overrides` lets a caller (session resume) supply symbol/dates directly
  // instead of reading them off state -- state set just before this is
  // called (setSymbol etc.) hasn't committed yet, so this closure would
  // otherwise still see the *previous* render's values.
  const loadChartWithInterval = useCallback((overrideInterval: string, overrides?: { symbol?: string; fromDate?: string; toDate?: string }) => {
    const trimmed = (overrides?.symbol ?? symbol).trim().toUpperCase();
    if (!trimmed) { setCandles(null); setError(''); return; }
    const fromMs = new Date(overrides?.fromDate ?? fromDate).getTime();
    const toMs = new Date(overrides?.toDate ?? toDate).getTime() + DAY;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) { setError('Pick a valid date range.'); return; }
    setLoading(true); setError(''); setIsSetupError(false); setPlaying(false); setPartial(null);
    setOpenTrade(null); setClosedTrade(null); setShowCloseout(false); setPlacingDirection(null);
    setSelectedDrawingId(null); setActiveDrawType(null); setMeasureActive(false); setMeasureRange(null);
    drawingHistoryRef.current = []; setHistoryDepth(0);
    setActiveSymbol(trimmed);
    // ~100 bars before "From" give the setup visible context; the replay still
    // starts at the chosen date. Only the first page is loaded up front --
    // the rest streams in as the replay approaches it (see auto-load below).
    const restoring = pendingRestoreRef.current?.symbol === trimmed ? pendingRestoreRef.current : null;
    const bar = barMsOf(overrideInterval);
    const fetchFromMs = lookbackMs(fromMs, overrideInterval);
    const resumeAtMs = restoring?.replayTime ? restoring.replayTime * 1000 : null;
    const firstPageToMs = Math.min(toMs, Math.max(fromMs + CHUNK_BARS * bar, (resumeAtMs ?? 0) + PREFETCH_BARS * bar,
      restoring && !resumeAtMs ? fetchFromMs + (restoring.replayIdx + PREFETCH_BARS) * bar * 1.5 : 0));
    const target = { symbol: trimmed, interval: overrideInterval, fromMs, toMs };
    getCandles(trimmed, overrideInterval, fetchFromMs, firstPageToMs, authHeaders())
      .then(loaded => {
        if (!loaded.length) { setError(`cTrader returned no ${trimmed} candles for that range.`); setLoading(false); return; }
        const startIdx = Math.max(0, loaded.findIndex(c => Number(c.time) >= fromMs / 1000));
        sessionRef.current = { ...target, loadedToMs: firstPageToMs };
        setAnalysisStartIdx(startIdx);
        setCandles(loaded);
        setChartEpoch(e => e + 1);
        // pendingRestoreRef is deliberately NOT cleared here -- the chart-creation
        // effect runs after this commits and still needs it to import drawings.
        if (restoring) {
          const idx = resumeAtMs != null ? nearestCandleIndex(loaded, resumeAtMs / 1000) : restoring.replayIdx;
          setReplayIdx(Math.max(0, Math.min(loaded.length - 1, idx)));
          setOpenTrade(restoring.openTrade);
          setBacktestName(restoring.backtestName); setNotes(restoring.notes); setTags(restoring.tags);
        } else {
          setReplayIdx(Math.min(loaded.length - 1, startIdx + 40));
        }
        setLoading(false);
      })
      .catch(e => {
        setError(e instanceof Error ? e.message : 'Network error');
        setIsSetupError(e instanceof ChartFetchError && e.setup);
        setLoading(false);
      });
  }, [symbol, fromDate, toDate, setActiveSymbol]);
  const loadChart = useCallback(() => loadChartWithInterval(interval), [loadChartWithInterval, interval]);
  // Switching timeframe mid-replay keeps the replay clock where it is: the new
  // timeframe shows only candles that had closed by then, and if the new
  // timeframe is higher, the candle still forming is rebuilt from the candles
  // already revealed -- so switching never shows the future. Drawings and an
  // open trade carry over.
  const switchInterval = (tf: string) => {
    if (tf === interval || closedTrade) return;
    intervalTouchedRef.current = true;
    if (!candles || loading) { setInterval_(tf); return; }
    const oldSec = (INTERVAL_DAYS[interval] ?? INTERVAL_DAYS['15min']) * 86400;
    const newSec = (INTERVAL_DAYS[tf] ?? INTERVAL_DAYS['15min']) * 86400;
    const seen = candles.slice(0, replayIdx + 1);
    const clock = Number(seen[seen.length - 1].time) + oldSec; // close time of the current candle
    const sessionFromMs = new Date(fromDate).getTime();
    const sessionToMs = new Date(toDate).getTime() + DAY;
    // Window: 300 candles of context before the clock and a page ahead; more
    // streams in as the replay advances.
    const fetchFromMs = clock * 1000 - 300 * newSec * 1000;
    const fetchToMs = Math.min(sessionToMs, clock * 1000 + CHUNK_BARS * newSec * 1000);
    const drawings = managerRef.current?.exportDrawings() ?? [];
    const sym = symbol.trim().toUpperCase();
    setLoading(true); setPlaying(false); setPlacingDirection(null); setMeasureRange(null);
    getCandles(sym, tf, fetchFromMs, fetchToMs, authHeaders())
      .then(loaded => {
        // Last candle that is fully closed by the clock...
        let idx = -1;
        for (let i = 0; i < loaded.length && Number(loaded[i].time) + newSec <= clock; i++) idx = i;
        // ...plus, when zooming out, the forming candle built from what's already revealed.
        let built: { idx: number; candle: Candle; endMs: number } | null = null;
        const forming = loaded[idx + 1];
        if (forming && Number(forming.time) < clock) {
          const parts = seen.filter(c => Number(c.time) >= Number(forming.time));
          if (parts.length) {
            built = {
              idx: idx + 1, endMs: clock * 1000,
              candle: {
                ...forming, open: parts[0].open, close: parts[parts.length - 1].close,
                high: Math.max(...parts.map(c => c.high)), low: Math.min(...parts.map(c => c.low)),
                volume: parts.reduce((s, c) => s + (c.volume ?? 0), 0),
              },
            };
            idx += 1;
          }
        }
        if (idx < 0) { setToast('No candles for that timeframe at this point in the replay'); setLoading(false); return; }
        pendingRestoreRef.current = { drawings } as unknown as WorkspaceDraft;
        sessionRef.current = { symbol: sym, interval: tf, fromMs: sessionFromMs, toMs: sessionToMs, loadedToMs: fetchToMs };
        setInterval_(tf);
        setAnalysisStartIdx(Math.max(0, loaded.findIndex(c => Number(c.time) * 1000 >= sessionFromMs)));
        setCandles(loaded);
        setChartEpoch(e => e + 1);
        setPartial(built);
        setReplayIdx(idx);
        setLoading(false);
      })
      .catch(e => { setToast(e instanceof Error ? e.message : 'Network error'); setLoading(false); });
  };

  // ?session=<id> (from a strategy's "Continue") resumes that session straight
  // away. A deep link with ?symbol starts fresh. Otherwise offer to resume
  // the most recent session.
  const resumedFromLinkRef = useRef(false);
  useEffect(() => {
    if (params.get('symbol')) return;
    const sid = params.get('session');
    const draft = readDraft(sid);
    if (sid && draft && !resumedFromLinkRef.current) { resumedFromLinkRef.current = true; resumeDraft(draft); return; }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- offer the saved session once on arrival
    if (draft) setDraftAvailable(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Deep link from the Log's "Load in Workspace".
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (autoLoadedRef.current || !params.get('symbol')) return;
    autoLoadedRef.current = true;
    loadChart();
  }, [params, loadChart]);

  // ── Chart + drawing manager creation ───────────────────────────────────────
  useEffect(() => {
    if (!candlesRef.current || !chartContainerRef.current) return;
    const el = chartContainerRef.current;
    const root = rootRef.current;
    const text = cssVar(root, '--bt-on-surface-variant', '#d8c3ad');
    const grid = cssVar(root, '--bt-surface-container', '#1b2027');
    const bg = cssVar(root, '--bt-surface-container-lowest', '#090f15');
    const up = cssVar(root, '--bt-secondary', '#4edea3');
    const down = cssVar(root, '--bt-error', '#ffb4ab');
    const chart = createChart(el, {
      width: el.clientWidth, height: el.clientHeight,
      layout: { background: { type: ColorType.Solid, color: bg }, textColor: text, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, panes: { separatorColor: grid } },
      grid: { vertLines: { color: hexAlpha(grid, 0.6) }, horzLines: { color: hexAlpha(grid, 0.9) } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false, rightOffset: 2 },
      rightPriceScale: { borderColor: grid },
    });
    chartRef.current = chart;
    const series = chart.addSeries(CandlestickSeries, {
      upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down,
      priceLineColor: down, priceLineStyle: LineStyle.Dotted,
    });
    seriesRef.current = series;
    lineRef.current = chart.addSeries(LineSeries, { color: up, lineWidth: 2, visible: false, priceLineVisible: false, lastValueVisible: false });
    volumeRef.current = chart.addSeries(HistogramSeries, { priceScaleId: 'bt-volume', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
    chart.priceScale('bt-volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    emaRefs.current = EMA_CONFIG.map(cfg => chart.addSeries(LineSeries, {
      color: cfg.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    }));

    const manager = new DrawingManager();
    manager.attach(chart, series, el);
    managerRef.current = manager;
    const restoring = pendingRestoreRef.current;
    if (restoring) {
      if (restoring.drawings.length) manager.importDrawings(restoring.drawings, drawingFactory);
      pendingRestoreRef.current = null;
    }
    const recount = () => setDrawingCount(manager.getAllDrawings().length);
    const unsubscribers = [
      manager.on('drawing:added', event => {
        if (event.drawing) {
          if (drawColorRef.current) event.drawing.updateStyle({ lineColor: drawColorRef.current });
          if (event.drawing.type === 'text-annotation') {
            const note = (window.prompt('Text for this note:', '') || '').trim().slice(0, 80);
            if (note) { (event.drawing as unknown as { setText: (t: string) => void }).setText(note); event.drawing.requestUpdate(); }
            else manager.removeDrawing(event.drawing.id);
          }
        }
        recount();
      }),
      manager.on('drawing:removed', recount),
      manager.on('drawing:cleared', recount),
      manager.on('drawing:selected', event => setSelectedDrawingId(event.drawingId ?? null)),
      manager.on('drawing:deselected', () => setSelectedDrawingId(null)),
    ];

    const onCrosshair = (p: MouseEventParams<Time>) => {
      if (p.time == null) { setHoverIdx(null); return; }
      const all = candlesRef.current;
      setHoverIdx(all ? nearestCandleIndex(all, Number(p.time)) : null);
    };
    chart.subscribeCrosshairMove(onCrosshair);

    const syncCanvas = () => { if (canvasRef.current) { canvasRef.current.width = el.clientWidth; canvasRef.current.height = el.clientHeight; } };
    syncCanvas();
    const redraw = () => requestAnimationFrame(() => redrawCanvasRef.current());
    const ro = new ResizeObserver(() => { chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }); syncCanvas(); redraw(); });
    ro.observe(el);
    chart.timeScale().subscribeVisibleLogicalRangeChange(redraw);
    return () => {
      unsubscribers.forEach(unsub => unsub());
      chart.unsubscribeCrosshairMove(onCrosshair);
      manager.detach();
      managerRef.current = null;
      ro.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(redraw);
      chart.remove();
      chartRef.current = null; seriesRef.current = null; lineRef.current = null; volumeRef.current = null; rsiRef.current = null; emaRefs.current = [];
    };
  }, [chartEpoch, resolvedTheme]);

  // ── Indicator values (computed once per load, sliced per replay step) ──────
  const indicatorData = useMemo(() => {
    if (!candles) return null;
    const closes = candles.map((c, i) => (partial && i === partial.idx ? partial.candle.close : c.close));
    return { emas: EMA_CONFIG.map(cfg => ema(closes, cfg.period)), rsi: rsi(closes, 14) };
  }, [candles, partial]);

  // ── Indicator / chart-type visibility ──────────────────────────────────────
  const showIndicators = true;
  useEffect(() => {
    const chart = chartRef.current; if (!chart || !candles) return;
    const candlesVisible = chartType === 'candles';
    seriesRef.current?.applyOptions({ visible: candlesVisible });
    lineRef.current?.applyOptions({ visible: !candlesVisible });
    volumeRef.current?.applyOptions({ visible: showIndicators && indicators.volume });
    emaRefs.current.forEach(s => s.applyOptions({ visible: showIndicators && indicators.ema }));
    const wantRsi = showIndicators && indicators.rsi;
    if (wantRsi && !rsiRef.current) {
      const rsiSeries = chart.addSeries(LineSeries, { color: '#ffc174', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false }, 1);
      rsiSeries.createPriceLine({ price: 70, color: hexAlpha('#ffb4ab', 0.6), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
      rsiSeries.createPriceLine({ price: 30, color: hexAlpha('#4edea3', 0.6), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
      rsiSeries.priceScale().applyOptions({ autoScale: false, scaleMargins: { top: 0.1, bottom: 0.1 } });
      rsiSeries.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
      chart.panes()[1]?.setHeight(90);
      rsiRef.current = rsiSeries;
    } else if (!wantRsi && rsiRef.current) {
      chart.removeSeries(rsiRef.current);
      rsiRef.current = null;
      if (chart.panes().length > 1) chart.removePane(1);
    }
  }, [candles, resolvedTheme, showIndicators, indicators, chartType]);

  // ── Progressive reveal ─────────────────────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!candles || !series || !indicatorData) return;
    const root = rootRef.current;
    const up = cssVar(root, '--bt-secondary', '#4edea3');
    const down = cssVar(root, '--bt-error', '#ffb4ab');
    const shown = candles.slice(0, replayIdx + 1);
    if (partial && partial.idx < shown.length) shown[partial.idx] = partial.candle;
    // Context candles before "From" look like any other candle -- they're real history.
    series.setData(shown);
    lineRef.current?.setData(shown.map(c => ({ time: c.time, value: c.close })));
    volumeRef.current?.setData(shown.map(c => ({ time: c.time, value: c.volume ?? 0, color: hexAlpha(c.close >= c.open ? up : down, 0.35) })));
    emaRefs.current.forEach((s, k) => s.setData(shown.flatMap((c, i) => {
      const v = indicatorData.emas[k][i];
      return v == null ? [] : [{ time: c.time, value: v }];
    })));
    rsiRef.current?.setData(shown.flatMap((c, i) => {
      const v = indicatorData.rsi[i];
      return v == null ? [] : [{ time: c.time, value: v }];
    }));
  }, [candles, replayIdx, partial, indicatorData, resolvedTheme, indicators.rsi]);

  // Fit to the revealed data on a fresh load only (not on every replay step),
  // so the chart ends on the current candle with nothing hanging off the right.
  useEffect(() => {
    if (!candlesRef.current || !chartRef.current) return;
    chartRef.current.timeScale().fitContent();
  }, [chartEpoch]);

  // Hide drawings anchored past the revealed candle -- no peeking at your own future analysis.
  useEffect(() => {
    const manager = managerRef.current; if (!manager || !candles) return;
    const revealedTime = Number(candles[replayIdx]?.time ?? Number.POSITIVE_INFINITY);
    for (const d of manager.getAllDrawings()) {
      const maxAnchorTime = d.anchors.length ? Math.max(...d.anchors.map(a => Number(a.time))) : 0;
      const shouldShow = maxAnchorTime <= revealedTime;
      if ((d.options.visible !== false) !== shouldShow) { d.updateOptions({ visible: shouldShow }); d.requestUpdate(); }
    }
  }, [candles, replayIdx, drawingCount]);

  // ── Playback ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!candles || !playing) return;
    const timer = setInterval(() => {
      setReplayIdx(prev => {
        if (prev < candles.length - 1) return prev + 1;
        // At the edge of what's loaded: wait for the next page if there is one.
        const s = sessionRef.current;
        if (!s || s.loadedToMs >= s.toMs) setPlaying(false);
        return prev;
      });
    }, Math.max(40, 300 / speed));
    return () => clearInterval(timer);
  }, [playing, speed, candles]);

  // ── Auto-load: stream the next page before the replay reaches the edge ────
  useEffect(() => {
    const s = sessionRef.current;
    if (!candles || !s || loadingMore || loading || s.loadedToMs >= s.toMs) return;
    if (replayIdx < candles.length - 1 - PREFETCH_BARS) return;
    const from = s.loadedToMs, to = Math.min(s.toMs, from + CHUNK_BARS * barMsOf(s.interval));
    const epoch = chartEpoch;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kick off a background fetch
    setLoadingMore(true);
    getCandles(s.symbol, s.interval, from, to, authHeaders())
      .then(more => {
        const cur = sessionRef.current;
        if (!cur || cur !== s) return; // session changed while loading
        cur.loadedToMs = to;
        if (more.length) {
          setCandles(prev => {
            if (!prev || epoch !== chartEpochRef.current) return prev;
            const last = Number(prev[prev.length - 1].time);
            const fresh = more.filter(c => Number(c.time) > last);
            return fresh.length ? [...prev, ...fresh] : prev;
          });
        }
      })
      .catch(e => setToast(e instanceof Error ? `Couldn't load more candles: ${e.message}` : "Couldn't load more candles"))
      .finally(() => setLoadingMore(false));
  }, [candles, replayIdx, loadingMore, loading, chartEpoch]);
  const jumpToReplayIndex = useCallback((index: number) => {
    if (!candles) return;
    setPlaying(false);
    setReplayIdx(Math.max(0, Math.min(candles.length - 1, index)));
  }, [candles]);

  // Once the replay steps past the rebuilt forming candle, the real one is history.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- replay moved past the rebuilt candle
    if (partial && replayIdx > partial.idx) setPartial(null);
  }, [partial, replayIdx]);
  /** The candle as the trader may see it at index i (the rebuilt one while it's still forming). */
  const barAt = (i: number) => (partial && i === partial.idx ? partial.candle : candles?.[i]);

  // ── Resolve the open trade against each newly revealed candle ──────────────
  useEffect(() => {
    if (!candles || !openTrade || closedTrade) return;
    const isPartial = Boolean(partial && replayIdx === partial.idx);
    const candle = isPartial ? partial!.candle : candles[replayIdx];
    if (!candle || candle.time <= openTrade.entryTime) return;
    const trade = openTrade;
    const close = (which: 'sl' | 'tp') => {
      const exitPrice = which === 'sl' ? trade.stopLoss : trade.takeProfit!;
      const outcome: ClosedTrade['outcome'] = which === 'tp' ? 'win'
        : (trade.direction === 'long' ? trade.stopLoss >= trade.entryPrice : trade.stopLoss <= trade.entryPrice) ? 'breakeven' : 'loss';
      const riskPerUnit = trade.direction === 'long' ? trade.entryPrice - trade.stopLoss : trade.stopLoss - trade.entryPrice;
      const gainPerUnit = trade.direction === 'long' ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
      const rMultiple = riskPerUnit !== 0 ? gainPerUnit / riskPerUnit : 0;
      setPlaying(false);
      setClosedTrade(prev => prev ?? { ...trade, exitTime: candle.time, exitPrice, outcome, rMultiple, pnlUSD: rMultiple * trade.riskAmount });
      setShowCloseout(true);
    };
    const hit = levelsHit(candle, trade);
    if (hit.sl && hit.tp) {
      // One candle spans both levels: which came first is decided on smaller
      // candles for that period (never past what's been revealed).
      const key = `${trade.entryTime}:${candle.time}`;
      if (resolvingRef.current === key) return;
      resolvingRef.current = key;
      setPlaying(false);
      const startMs = Number(candle.time) * 1000;
      const endMs = isPartial ? partial!.endMs : startMs + barMsOf(interval);
      setToast('Stop and target inside one candle — checking smaller candles…');
      firstLevelHit(symbol.trim().toUpperCase(), interval, startMs, endMs, trade)
        .catch(() => 'sl' as const)
        .then(which => { if (resolvingRef.current === key) close(which); });
      return;
    }
    if (hit.sl) close('sl');
    else if (hit.tp) close('tp');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, replayIdx, partial, openTrade, closedTrade]);

  const unrealizedR = useMemo(() => {
    if (!openTrade || !candles) return 0;
    const px = (partial && replayIdx === partial.idx ? partial.candle : candles[replayIdx])?.close ?? openTrade.entryPrice;
    const risk = Math.abs(openTrade.entryPrice - openTrade.stopLoss);
    const gain = openTrade.direction === 'long' ? px - openTrade.entryPrice : openTrade.entryPrice - px;
    return risk ? gain / risk : 0;
  }, [openTrade, candles, replayIdx, partial]);

  const closeTradeNow = () => {
    if (!candles || !openTrade) return;
    const candle = barAt(replayIdx); if (!candle) return;
    const exitPrice = candle.close;
    const outcome: ClosedTrade['outcome'] = Math.abs(exitPrice - openTrade.entryPrice) < 1e-9 ? 'breakeven' : unrealizedR > 0 ? 'win' : 'loss';
    setPlaying(false);
    setClosedTrade({ ...openTrade, exitTime: candle.time, exitPrice, outcome, rMultiple: unrealizedR, pnlUSD: unrealizedR * openTrade.riskAmount });
    setShowCloseout(true);
  };
  const resetTrade = () => {
    setOpenTrade(null); setClosedTrade(null); setShowCloseout(false);
    setNotes(''); setJournal(EMPTY_JOURNAL); setBacktestName(''); setTags(currentStrategy ? [currentStrategy] : []); setTagDraft(null); setSaveError('');
  };
  useEffect(() => {
    if (!closedTrade || backtestName) return;
    const d = new Date(closedTrade.entryTime * 1000);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- default name, editable
    setBacktestName(`${d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })} ${symbol.trim().toUpperCase()} ${closedTrade.direction === 'long' ? 'Long' : 'Short'}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedTrade]);
  useEffect(() => {
    if (!openTrade || closedTrade) return;
    const amount = Number(riskAmountInput) || 0;
    if (amount === openTrade.riskAmount) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- keep the open trade's risk in sync with the input
    setOpenTrade(cur => (cur ? { ...cur, riskAmount: amount } : cur));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riskAmountInput]);

  const placeTradeAt = (direction: 'long' | 'short', time: number, price: number) => {
    setOpenTrade(placeTradeAtPure(direction, time, price, Number(riskAmountInput) || 0));
    setPlacingDirection(null);
  };
  const updateHandlePrice = (handle: TradeHandle, price: number) => setOpenTrade(cur => (cur ? updateHandlePricePure(cur, handle, price) : cur));
  const startPlacing = (direction: 'long' | 'short') => {
    if (!candles || openTrade || closedTrade) return;
    const next = placingDirection === direction ? null : direction;
    activateSelectMode();
    setPlacingDirection(next);
  };

  // ── Snapshots ──────────────────────────────────────────────────────────────
  const composeSnapshot = useCallback((maxWidth: number) => {
    const chart = chartRef.current, overlay = canvasRef.current;
    if (!chart) return null;
    const shot = chart.takeScreenshot(true);
    if (overlay) shot.getContext('2d')?.drawImage(overlay, 0, 0, shot.width, shot.height);
    const scale = Math.min(1, maxWidth / shot.width);
    const out = document.createElement('canvas');
    out.width = Math.round(shot.width * scale); out.height = Math.round(shot.height * scale);
    out.getContext('2d')?.drawImage(shot, 0, 0, out.width, out.height);
    return out;
  }, []);
  const downloadSnapshot = () => {
    const canvas = composeSnapshot(2400); if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `${symbol.trim().toUpperCase() || 'chart'}-${interval}-${candles ? fmtTick(Number(candles[replayIdx].time)).replace(/[: ]/g, '-') : 'snapshot'}.png`;
    a.click();
    setToast('Chart snapshot downloaded');
  };

  // ── Save to log ────────────────────────────────────────────────────────────
  const saveBacktestTrade = async () => {
    if (!closedTrade) return;
    setSaving(true); setSaveError('');
    try {
      const pendingTag = tagDraft?.trim();
      const allTags = pendingTag && !tags.includes(pendingTag) ? [...tags, pendingTag] : tags;
      const snapshot = composeSnapshot(640)?.toDataURL('image/jpeg', 0.72);
      const res = await fetch('/api/backtest-trades', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          name: backtestName.trim(), tags: allTags,
          symbol: symbol.trim().toUpperCase(), interval,
          direction: closedTrade.direction,
          entryTime: closedTrade.entryTime, entryPrice: closedTrade.entryPrice,
          exitTime: closedTrade.exitTime, exitPrice: closedTrade.exitPrice,
          stopLoss: closedTrade.stopLoss, takeProfit: closedTrade.takeProfit,
          outcome: closedTrade.outcome, riskAmount: closedTrade.riskAmount,
          pnlUSD: closedTrade.pnlUSD, rMultiple: closedTrade.rMultiple,
          notes, chartAnnotations: managerRef.current?.exportDrawings() ?? [], snapshot,
          ...journal,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not save backtest trade');
      addTrade(body as BacktestTrade);
      resetTrade();
      setToast('Saved to Backtest Log — keep replaying for the next setup');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save backtest trade');
    } finally {
      setSaving(false);
    }
  };

  // ── Overlay canvas (position box, replay-from marker, measure) ────────────
  const palette = useCallback((): OverlayPalette => {
    const root = rootRef.current;
    return {
      win: cssVar(root, '--bt-secondary', '#4edea3'), loss: cssVar(root, '--bt-error', '#ffb4ab'),
      accent: cssVar(root, '--bt-primary-container', '#f59e0b'), label: cssVar(root, '--bt-on-surface-variant', '#d8c3ad'),
      labelBg: hexAlpha(cssVar(root, '--bt-surface-container-lowest', '#090f15'), 0.88),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTheme]);
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current, chart = chartRef.current, series = seriesRef.current;
    if (!canvas || !chart || !series || !candles) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const colors = palette();
    const trade = closedTrade || openTrade;
    if (trade) drawTradeOverlay({ ctx, chart, series, canvas, trade, closedTrade, hoveredHandle, draggingHandle: draggingHandleRef.current, palette: colors });
    const activeMeasure = measureDragRef.current || measureRange;
    if (activeMeasure) drawMeasureOverlay({ ctx, chart, series, range: activeMeasure, candles, resolvedTheme: resolvedTheme === 'dark' ? 'dark' : 'light' });
  }, [candles, resolvedTheme, openTrade, closedTrade, hoveredHandle, measureRange, palette]);
  useEffect(() => { redrawCanvasRef.current = redrawCanvas; redrawCanvas(); }, [redrawCanvas, replayIdx]);

  // ── Pointer handling on the overlay canvas ─────────────────────────────────
  // lightweight-charts-drawing renders/selects/edits drawings but never creates
  // one from clicks, so placement for the active tool happens here.
  const anchorAt = (x: number, y: number): Anchor | null => {
    const chart = chartRef.current, series = seriesRef.current; if (!chart || !series || !candles) return null;
    const time = chart.timeScale().coordinateToTime(x);
    const raw = series.coordinateToPrice(y);
    if (time == null || raw == null) return null;
    let price: number = raw;
    if (magnet) {
      // Snap to the nearest open/high/low/close of the candle under the cursor.
      const c = candles[nearestCandleIndex(candles, Number(time))];
      if (c) price = [c.open, c.high, c.low, c.close].reduce((best, v) => (Math.abs(v - raw) < Math.abs(best - raw) ? v : best), c.close);
    }
    return { time, price };
  };
  const finishPendingDrawing = () => {
    const pending = pendingDrawingRef.current; if (!pending) return;
    pendingDrawingRef.current = null;
    managerRef.current?.selectDrawing(pending.drawing.id);
    managerRef.current?.setActiveTool(null);
    setActiveDrawType(null);
    setDrawingCount(managerRef.current?.getAllDrawings().length ?? 0);
  };
  // Shift held: lock the line horizontal (same price) or vertical (same time),
  // whichever the mouse has moved further along.
  const constrain = (pending: PendingDrawing, anchor: Anchor, x: number, y: number, shift: boolean): Anchor => {
    if (!shift) return anchor;
    return Math.abs(x - pending.startX) >= Math.abs(y - pending.startY)
      ? { time: anchor.time, price: pending.origin.price }
      : { time: pending.origin.time, price: anchor.price };
  };
  const moveFreeAnchors = (pending: PendingDrawing, anchor: Anchor) => {
    for (let i = pending.placed; i < pending.required; i++) pending.drawing.updateAnchor(i, anchor);
    pending.drawing.requestUpdate();
  };
  const handleDrawMouseDown = (x: number, y: number, shift = false) => {
    const manager = managerRef.current; if (!manager || !activeDrawType) return;
    const anchor = anchorAt(x, y); if (!anchor) return;
    const pending = pendingDrawingRef.current;
    if (pending) {
      moveFreeAnchors(pending, constrain(pending, anchor, x, y, shift));
      pending.placed += 1;
      if (pending.placed >= pending.required) finishPendingDrawing();
      return;
    }
    const registry = getToolRegistry();
    const required = Math.max(1, registry.get(activeDrawType)?.requiredAnchors ?? 2);
    const id = `${activeDrawType}-${crypto.randomUUID().slice(0, 8)}`;
    const drawing = registry.createDrawing(activeDrawType, id, Array.from({ length: required }, () => ({ ...anchor })), { lineColor: drawColor });
    if (!drawing) return;
    pendingDrawingRef.current = { drawing, required, placed: 1, startX: x, startY: y, origin: anchor };
    manager.addDrawing(drawing);
    // The text tool's `drawing:added` handler may have removed it (prompt cancelled).
    if (!manager.getDrawing(id)) { pendingDrawingRef.current = null; activateSelectMode(); return; }
    if (required === 1) finishPendingDrawing();
  };
  const handleDrawMouseUp = (x: number, y: number, shift = false) => {
    const pending = pendingDrawingRef.current;
    // A press-drag-release fixes the second anchor; a plain click waits for the next click.
    if (!pending || pending.placed !== 1 || Math.hypot(x - pending.startX, y - pending.startY) < 5) return;
    const anchor = anchorAt(x, y); if (anchor) moveFreeAnchors(pending, constrain(pending, anchor, x, y, shift));
    pending.placed = 2;
    if (pending.placed >= pending.required) finishPendingDrawing();
  };
  const localPoint = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(e);
    if (activeDrawType) { handleDrawMouseDown(x, y, e.shiftKey); return; }
    if (placingDirection) {
      const anchor = anchorAt(x, y); if (!anchor || !candles) return;
      // Entries happen on the current replay candle (like TradingView's replay
      // mode) -- only the clicked price is used, so a click further left can't
      // backdate the entry into candles whose outcome is already visible.
      placeTradeAt(placingDirection, Number(candles[replayIdx].time), anchor.price);
      return;
    }
    if (measureActive) {
      const anchor = anchorAt(x, y); if (!anchor) return;
      setMeasureRange(null);
      measureDragRef.current = { x1: x, y1: y, x2: x, y2: y, time1: Number(anchor.time), price1: anchor.price, time2: Number(anchor.time), price2: anchor.price };
      return;
    }
    const handle = findTradeHandleAtIn(y, openTrade, closedTrade, seriesRef.current);
    if (handle) draggingHandleRef.current = handle;
  };
  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(e);
    if (activeDrawType) {
      const pending = pendingDrawingRef.current;
      const anchor = pending ? anchorAt(x, y) : null;
      if (pending && anchor) moveFreeAnchors(pending, constrain(pending, anchor, x, y, e.shiftKey));
      return;
    }
    if (draggingHandleRef.current) {
      const price = seriesRef.current?.coordinateToPrice(y);
      if (price != null) updateHandlePrice(draggingHandleRef.current, price);
      return;
    }
    if (measureActive && measureDragRef.current) {
      const anchor = anchorAt(x, y); if (!anchor) return;
      measureDragRef.current = { ...measureDragRef.current, x2: x, y2: y, time2: Number(anchor.time), price2: anchor.price };
      redrawCanvas();
    }
  };
  const handleCanvasMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(e);
    if (activeDrawType) { handleDrawMouseUp(x, y, e.shiftKey); return; }
    if (draggingHandleRef.current) { draggingHandleRef.current = null; return; }
    if (measureActive && measureDragRef.current) {
      const { time1, price1, time2, price2 } = measureDragRef.current;
      setMeasureRange({ time1, price1, time2, price2 });
      measureDragRef.current = null;
    }
  };
  const handleChartHover = (e: React.MouseEvent<HTMLDivElement>) => {
    if (draggingHandleRef.current) return;
    const canvas = canvasRef.current; if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    if (!placingDirection && !measureActive && !activeDrawType && openTrade && !closedTrade) {
      setHoveredHandle(findTradeHandleAtIn(e.clientY - r.top, openTrade, closedTrade, seriesRef.current));
    } else if (hoveredHandle) setHoveredHandle(null);
  };

  // ── Keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable));
      if (e.key === 'Escape') {
        if (showCloseout) { setShowCloseout(false); return; }
        if (placingDirection || activeDrawType || measureActive) { activateSelectMode(); setMeasureRange(null); return; }
        managerRef.current?.deselectAll();
        return;
      }
      if (typing || !candles) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDrawingId) { e.preventDefault(); deleteSelectedDrawing(); }
      else if (e.key === ' ') { e.preventDefault(); setPlaying(p => !p); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); jumpToReplayIndex(replayIdx + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); jumpToReplayIndex(replayIdx - 1); }
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'l' || e.key === 'L')) startPlacing('long');
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 's' || e.key === 'S')) startPlacing('short');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placingDirection, activeDrawType, measureActive, selectedDrawingId, showCloseout, candles, replayIdx, openTrade, closedTrade]);

  // ── Derived display values ─────────────────────────────────────────────────
  const total = candles?.length ?? 0;
  const current = barAt(replayIdx) ?? null;
  const legendCandle = candles && hoverIdx != null && hoverIdx <= replayIdx ? barAt(hoverIdx) ?? null : current;
  const legendPrev = candles && legendCandle ? candles[Math.max(0, candles.indexOf(legendCandle) - 1)] : null;
  const progressPct = total ? ((replayIdx + 1) / total) * 100 : 0;
  const analysisBars = total ? replayIdx - analysisStartIdx + 1 : 0;
  const analysisTotal = total ? total - analysisStartIdx : 0;
  const desc = symbolDescription(symbol);
  const sessionChangePct = candles && current && candles[analysisStartIdx] ? ((current.close - candles[analysisStartIdx].open) / candles[analysisStartIdx].open) * 100 : 0;
  const legendIdx = legendCandle && candles ? candles.indexOf(legendCandle) : -1;
  const emaValues = indicatorData && legendIdx >= 0 ? indicatorData.emas.map(v => v[legendIdx]) : [];
  const rsiValue = indicatorData && legendIdx >= 0 ? indicatorData.rsi[legendIdx] : null;
  const rr = openTrade?.takeProfit != null ? Math.abs(openTrade.takeProfit - openTrade.entryPrice) / Math.abs(openTrade.entryPrice - openTrade.stopLoss) : 0;
  const up = (n: number) => (n >= 0 ? 'tw:text-secondary' : 'tw:text-error');
  const tradeLocked = Boolean(openTrade || closedTrade);

  // ── Shared pieces ──────────────────────────────────────────────────────────
  const timeframeChips = (activeCls: string) => (
    <div className="tw:flex tw:items-center tw:bg-surface-container-lowest tw:p-0.5 tw:rounded tw:gap-0.5 tw:shrink-0" role="group" aria-label="Timeframe"
      title={closedTrade ? 'Log or discard the closed trade before changing timeframe' : undefined}>
      {VIEW_INTERVALS.map(tf => (
        <button key={tf.value} type="button" aria-pressed={interval === tf.value} disabled={(Boolean(closedTrade) || loading) && interval !== tf.value} onClick={() => switchInterval(tf.value)}
          className={`tw:px-space-sm tw:py-0.5 tw:rounded tw:font-label-caps tw:text-label-caps tw:disabled:opacity-40 ${interval === tf.value ? activeCls : 'tw:text-on-surface-variant tw:hover:text-on-surface'}`}>
          {tf.label}
        </button>
      ))}
    </div>
  );
  const transport = (compact: boolean) => {
    const btn = compact ? 'tw:w-7 tw:h-7' : 'tw:w-8 tw:h-8';
    const base = `${btn} tw:rounded tw:bg-surface-container tw:flex tw:items-center tw:justify-center tw:transition-colors tw:disabled:opacity-40 ${compact ? 'tw:text-on-surface-variant tw:hover:text-on-surface' : 'tw:text-on-surface tw:hover:bg-surface-variant'}`;
    const icon = compact ? 'tw:text-[16px]' : 'tw:text-[18px]';
    return (
      <div className="tw:flex tw:items-center tw:gap-space-xs">
        <button type="button" className={base} title="Reset to start" aria-label="Reset to start" disabled={!total || replayIdx === 0} onClick={() => jumpToReplayIndex(analysisStartIdx)}><Icon name="first_page" className={icon} /></button>
        <button type="button" className={base} title="Step back 1 candle" aria-label="Step back" disabled={!total || replayIdx === 0} onClick={() => jumpToReplayIndex(replayIdx - 1)}><Icon name={compact ? 'navigate_before' : 'chevron_left'} className={icon} /></button>
        <button type="button" disabled={!total} onClick={() => setPlaying(p => !p)} title={playing ? 'Pause' : 'Play replay'} aria-label={playing ? 'Pause' : 'Play'}
          className={compact ? 'tw:w-8 tw:h-8 tw:bg-primary tw:text-on-primary tw:rounded tw:flex tw:items-center tw:justify-center tw:shadow tw:disabled:opacity-40' : 'tw:w-9 tw:h-8 tw:rounded tw:bg-primary-container tw:text-on-primary-container tw:flex tw:items-center tw:justify-center tw:shadow-sm tw:hover:brightness-110 tw:transition-all tw:disabled:opacity-40'}>
          <Icon name={playing ? 'pause' : 'play_arrow'} className={compact ? 'tw:text-[18px]' : 'tw:text-[20px]'} />
        </button>
        <button type="button" className={base} title="Step forward 1 candle" aria-label="Step forward" disabled={!total || replayIdx >= total - 1} onClick={() => jumpToReplayIndex(replayIdx + 1)}><Icon name={compact ? 'navigate_next' : 'chevron_right'} className={icon} /></button>
        <button type="button" className={base} title="Jump to end" aria-label="Jump to end" disabled={!total || replayIdx >= total - 1} onClick={() => jumpToReplayIndex(total - 1)}><Icon name="last_page" className={icon} /></button>
      </div>
    );
  };
  const scrubber = (thumbInner: string, trackH: string) => (
    <div className="tw:relative tw:w-full tw:h-6 tw:flex tw:items-center">
      <div className={`tw:w-full ${trackH} tw:bg-surface-container-lowest tw:rounded-full tw:overflow-hidden`}>
        <div className="tw:h-full tw:bg-primary tw:rounded-full" style={{ width: `${progressPct}%` }} />
      </div>
      <div className="tw:absolute tw:w-4 tw:h-4 tw:-ml-2 tw:bg-primary tw:rounded-full tw:shadow-[0_0_8px_rgba(245,158,11,0.6)] tw:flex tw:items-center tw:justify-center tw:pointer-events-none" style={{ left: `${progressPct}%` }}>
        <div className={`tw:w-1.5 tw:h-1.5 tw:rounded-full ${thumbInner}`} />
      </div>
      <input type="range" aria-label="Replay progress" min={0} max={Math.max(0, total - 1)} value={replayIdx} disabled={!total}
        onChange={e => jumpToReplayIndex(Number(e.target.value))} className="tw:absolute tw:inset-0 tw:w-full tw:opacity-0 tw:cursor-pointer" />
    </div>
  );
  const speedPills = (list: number[], compact: boolean) => (
    <div className={compact ? 'tw:flex tw:items-center tw:gap-1' : 'tw:flex tw:items-center tw:bg-surface-container-lowest tw:p-0.5 tw:rounded tw:gap-0.5'} role="group" aria-label="Replay speed">
      {list.map(s => (
        <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}
          className={compact
            ? `tw:px-space-sm tw:py-1 tw:bg-surface-container tw:font-mono-metric-md tw:text-mono-metric-md tw:rounded ${speed === s ? 'tw:text-on-surface' : 'tw:text-on-surface-variant tw:hover:text-on-surface'}`
            : `tw:px-space-xs tw:py-0.5 tw:rounded tw:font-mono-metric-md tw:text-mono-metric-md ${speed === s ? 'tw:bg-surface-container-high tw:text-primary tw:font-bold' : 'tw:text-on-surface-variant tw:hover:text-on-surface'}`}>
          {s}x
        </button>
      ))}
    </div>
  );
  const railTool = (t: { id: ToolId; icon: string; label: string }, cls: string, activeCls: string, idleCls: string) => (
    <button key={t.id} type="button" title={t.label} aria-label={t.label} aria-pressed={isToolActive(t.id)} disabled={!candles || (t.id === 'position' && tradeLocked)}
      onClick={() => activateTool(t.id)} className={`${cls} tw:disabled:opacity-40 ${isToolActive(t.id) ? activeCls : idleCls}`}>
      <Icon name={t.icon} className="tw:text-[20px]" />
    </button>
  );
  const hint = activeDrawType
    ? `${WORKSPACE_TOOLS.find(t => t.id === activeDrawType)?.label ?? 'Draw'}: ${activeDrawType === 'text-annotation' ? 'click to place a note' : 'click or drag on the chart · Esc to cancel'}`
    : placingDirection ? `${placingDirection === 'long' ? 'Long' : 'Short'}: click the entry price on the chart · Esc to cancel`
      : measureActive ? 'Measure: drag between two points' : null;

  // ── Desktop terminal layout (Stitch "Backtest Workspace", >= 900px) ─────────
  const nextCandle = candles?.[replayIdx + 1] ?? null;
  const analysisPct = analysisTotal ? (Math.max(0, analysisBars) / analysisTotal) * 100 : 0;
  const rrFor = (price: number) => openTrade ? Math.abs(price - openTrade.entryPrice) / Math.abs(openTrade.entryPrice - openTrade.stopLoss || 1) : 0;
  const exitKind = closedTrade
    ? Math.abs(closedTrade.exitPrice - closedTrade.stopLoss) < 1e-9 ? 'SL HIT'
      : closedTrade.takeProfit != null && Math.abs(closedTrade.exitPrice - closedTrade.takeProfit) < 1e-9 ? 'TP HIT' : 'MANUAL CLOSE'
    : '';
  const tradeBars = closedTrade && candles
    ? Math.max(1, nearestCandleIndex(candles, closedTrade.exitTime) - nearestCandleIndex(candles, closedTrade.entryTime))
    : 0;
  const tfLabel = CHART_INTERVALS.find(t => t.value === interval)?.label ?? interval;
  const dockBtn = 'tw:w-7 tw:h-7 tw:rounded tw:bg-surface-container-high tw:hover:bg-outline-variant tw:border tw:border-outline-variant tw:text-on-surface-variant tw:hover:text-on-surface tw:flex tw:items-center tw:justify-center tw:transition tw:disabled:opacity-40';

  const desktopTop = (
    <>
      {/* 1. Top setup bar */}
      <header className="tw:h-12 tw:bg-surface-container-low tw:border-b tw:border-outline-variant tw:flex tw:items-center tw:justify-between tw:px-3 tw:shrink-0 tw:gap-3 tw:text-xs">
        {/* Read-only session summary: symbol and range are chosen on New Backtest. */}
        <div className="tw:flex tw:items-center tw:gap-3 tw:min-w-0 tw:whitespace-nowrap">
          <span className="tw:font-mono-metric-md tw:font-bold tw:text-on-surface">{symbol.trim().toUpperCase() || '—'}</span>
          {desc && <span className="tw:text-on-surface-variant tw:truncate">{desc[0]}</span>}
          <span className="tw:font-mono-metric-md tw:text-on-surface-variant">{fromDate} → {toDate}</span>
          {loading && <span className="tw:flex tw:items-center tw:gap-1 tw:text-on-surface-variant"><Icon name="progress_activity" className="tw:text-[14px] tw:animate-spin" />Loading…</span>}
          <Link href="/backtest/new" className="tw:flex tw:items-center tw:gap-1 tw:text-primary tw:hover:underline"><Icon name="add" className="tw:text-[14px]" />New backtest</Link>
          {candles && <button type="button" onClick={endSession} className="tw:flex tw:items-center tw:gap-1 tw:text-on-surface-variant tw:hover:text-error"><Icon name="stop_circle" className="tw:text-[14px]" />End session</button>}
        </div>
        <div className="tw:flex tw:items-center tw:gap-1 tw:shrink-0">
          <div className="tw:relative">
            <button type="button" onClick={() => setShowIndicatorMenu(v => !v)} aria-expanded={showIndicatorMenu}
              className="tw:flex tw:items-center tw:gap-1 tw:px-2 tw:h-7 tw:rounded tw:hover:bg-surface-container-high tw:text-on-surface-variant tw:hover:text-on-surface tw:transition">
              <Icon name="tune" className="tw:text-[15px] tw:text-primary" />
              <span>Indicators ({(indicators.ema ? 3 : 0) + (indicators.rsi ? 1 : 0) + (indicators.volume ? 1 : 0)})</span>
            </button>
            {showIndicatorMenu && (
              <div className="tw:absolute tw:right-0 tw:top-full tw:mt-1 tw:z-40 tw:w-52 tw:bg-surface-container-high tw:border tw:border-outline-variant tw:rounded tw:shadow-xl tw:p-space-sm tw:flex tw:flex-col tw:gap-1">
                {([['ema', 'EMA 20 / 50 / 200'], ['rsi', 'RSI (14)'], ['volume', 'Volume']] as const).map(([k, label]) => (
                  <label key={k} className="tw:flex tw:items-center tw:justify-between tw:gap-space-sm tw:px-space-xs tw:py-1 tw:rounded tw:hover:bg-surface-bright tw:cursor-pointer tw:font-label-action tw:text-label-action">
                    <span>{label}</span>
                    <input type="checkbox" checked={indicators[k]} onChange={e => setIndicators(v => ({ ...v, [k]: e.target.checked }))} className="tw:accent-primary" />
                  </label>
                ))}
              </div>
            )}
          </div>
          <button type="button" onClick={() => setChartType(t => (t === 'candles' ? 'line' : 'candles'))} title={chartType === 'candles' ? 'Switch to line chart' : 'Switch to candlesticks'}
            className="tw:w-7 tw:h-7 tw:rounded tw:hover:bg-surface-container-high tw:flex tw:items-center tw:justify-center tw:text-primary tw:transition">
            <Icon name={chartType === 'candles' ? 'candlestick_chart' : 'show_chart'} className="tw:text-[16px]" />
          </button>
          <button type="button" onClick={downloadSnapshot} disabled={!candles} title="Take chart snapshot" aria-label="Take chart snapshot"
            className="tw:w-7 tw:h-7 tw:rounded tw:hover:bg-surface-container-high tw:flex tw:items-center tw:justify-center tw:text-on-surface-variant tw:hover:text-on-surface tw:transition tw:disabled:opacity-40">
            <Icon name="photo_camera" className="tw:text-[16px]" />
          </button>
        </div>
      </header>

      {/* 2. Simulation context & action toolbar */}
      <section className="tw:h-10 tw:bg-surface-container-low/90 tw:border-b tw:border-outline-variant tw:px-3 tw:flex tw:items-center tw:justify-between tw:gap-3 tw:shrink-0 tw:text-[11px]">
        <div className="tw:flex tw:items-center tw:gap-2 tw:min-w-0">
          <div className="tw:flex tw:items-center tw:bg-surface-container-lowest tw:rounded tw:p-0.5 tw:border tw:border-outline-variant tw:font-mono-metric-md" role="group" aria-label="Timeframe"
            title={closedTrade ? 'Log or discard the closed trade before changing timeframe' : undefined}>
            {VIEW_INTERVALS.map(tf => (
              <button key={tf.value} type="button" aria-pressed={interval === tf.value} disabled={(Boolean(closedTrade) || loading) && interval !== tf.value} onClick={() => switchInterval(tf.value)}
                className={`tw:px-2 tw:py-0.5 tw:rounded tw:transition tw:disabled:opacity-40 ${interval === tf.value ? 'tw:bg-primary-container tw:text-on-primary tw:font-bold' : 'tw:text-on-surface-variant tw:hover:text-on-surface'}`}>{tf.label}</button>
            ))}
          </div>
          <div className="tw:h-4 tw:w-px tw:bg-outline-variant tw:mx-1" />
          <div className="tw:flex tw:items-center tw:gap-2 tw:font-mono-metric-md tw:bg-surface-container-high/60 tw:border tw:border-outline-variant tw:px-2.5 tw:py-0.5 tw:rounded tw:whitespace-nowrap">
            <span className="tw:text-primary-container tw:font-semibold tw:uppercase tw:tracking-wider tw:text-[10px]">{playing ? 'REPLAYING:' : 'REPLAY MODE:'}</span>
            <span className="tw:text-on-surface tw:font-bold">Bar {Math.max(0, analysisBars)} / {analysisTotal}</span>
            <span className="tw:text-on-surface-variant">({analysisPct.toFixed(1)}%)</span>
            {current && <><span className="tw:text-outline-variant">|</span><span className="tw:text-cyan-500">{fmtTick(Number(current.time))} UTC</span></>}
          </div>
        </div>
        <div className="tw:flex tw:items-center tw:gap-2 tw:shrink-0">
          {openTrade && (
            <>
              <div className="tw:flex tw:items-center tw:gap-2 tw:bg-surface-container-high tw:border tw:border-primary-container/40 tw:px-2.5 tw:py-1 tw:rounded tw:font-mono-metric-md tw:whitespace-nowrap">
                <span className={`tw:border tw:px-1.5 tw:rounded tw:font-bold tw:text-[10px] tw:tracking-wide ${openTrade.direction === 'long' ? 'tw:bg-secondary/20 tw:text-secondary tw:border-secondary/40' : 'tw:bg-tertiary/20 tw:text-tertiary tw:border-tertiary/40'}`}>
                  {closedTrade ? 'CLOSED' : 'SIMULATED'} {openTrade.direction === 'long' ? 'LONG' : 'SHORT'}
                </span>
                <span className="tw:text-on-surface-variant">Entry:</span><span className="tw:text-on-surface tw:font-semibold">{fmtPrice(openTrade.entryPrice)}</span>
                <span className="tw:text-outline-variant">•</span>
                <span className="tw:text-tertiary">SL: {fmtPrice(openTrade.stopLoss)} (-1.0R / -${openTrade.riskAmount.toFixed(0)})</span>
                {openTrade.takeProfit != null && <>
                  <span className="tw:text-outline-variant">•</span>
                  <span className="tw:text-secondary">TP: {fmtPrice(openTrade.takeProfit)} (+{rrFor(openTrade.takeProfit).toFixed(1)}R / +${(rrFor(openTrade.takeProfit) * openTrade.riskAmount).toFixed(0)})</span>
                </>}
                <span className="tw:text-outline-variant">•</span>
                <span className="tw:text-on-surface-variant tw:text-[10px]">{closedTrade ? 'Result:' : 'Unrealized:'}</span>
                <span className={`tw:font-bold ${(closedTrade?.rMultiple ?? unrealizedR) >= 0 ? 'tw:text-secondary' : 'tw:text-tertiary'}`}>
                  {fmtR(closedTrade?.rMultiple ?? unrealizedR)} ({fmtUSD((closedTrade?.rMultiple ?? unrealizedR) * openTrade.riskAmount)})
                </span>
              </div>
              {closedTrade ? (
                <button type="button" onClick={() => setShowCloseout(true)}
                  className="tw:flex tw:items-center tw:gap-1.5 tw:bg-primary-container/20 tw:hover:bg-primary-container/30 tw:text-primary-container tw:border tw:border-primary-container/50 tw:font-semibold tw:px-2.5 tw:py-1 tw:rounded tw:transition tw:active:scale-95 tw:whitespace-nowrap">
                  <Icon name="bookmark_added" className="tw:text-[14px]" /><span>Log Outcome</span>
                </button>
              ) : (
                <button type="button" onClick={closeTradeNow} title="Close at the current candle's close"
                  className="tw:flex tw:items-center tw:gap-1.5 tw:bg-primary-container/20 tw:hover:bg-primary-container/30 tw:text-primary-container tw:border tw:border-primary-container/50 tw:font-semibold tw:px-2.5 tw:py-1 tw:rounded tw:transition tw:active:scale-95 tw:whitespace-nowrap">
                  <Icon name="flag" className="tw:text-[14px]" /><span>Close at Current Candle</span>
                </button>
              )}
              <button type="button" onClick={resetTrade}
                className="tw:flex tw:items-center tw:gap-1 tw:bg-tertiary/10 tw:hover:bg-tertiary/20 tw:text-tertiary tw:border tw:border-tertiary/30 tw:px-2 tw:py-1 tw:rounded tw:transition tw:active:scale-95">
                <Icon name="close" className="tw:text-[14px]" /><span>Cancel</span>
              </button>
              <div className="tw:h-4 tw:w-px tw:bg-outline-variant tw:mx-1" />
            </>
          )}
          <button type="button" onClick={() => startPlacing('long')} disabled={!candles || tradeLocked} aria-pressed={placingDirection === 'long'} title="Simulate Long Position [L]"
            className={`tw:flex tw:items-center tw:gap-1 tw:font-semibold tw:px-2.5 tw:py-1 tw:rounded tw:transition tw:active:scale-95 tw:whitespace-nowrap tw:disabled:opacity-40 ${placingDirection === 'long' ? 'tw:bg-secondary tw:text-on-secondary tw:ring-2 tw:ring-secondary/40' : 'tw:bg-secondary tw:hover:opacity-90 tw:text-on-secondary'}`}>
            <Icon name="north_east" className="tw:text-[15px]" /><span>+ Simulate Long</span>
          </button>
          <button type="button" onClick={() => startPlacing('short')} disabled={!candles || tradeLocked} aria-pressed={placingDirection === 'short'} title="Simulate Short Position [S]"
            className={`tw:flex tw:items-center tw:gap-1 tw:font-semibold tw:px-2.5 tw:py-1 tw:rounded tw:transition tw:active:scale-95 tw:whitespace-nowrap tw:disabled:opacity-40 ${placingDirection === 'short' ? 'tw:bg-tertiary tw:text-on-tertiary tw:ring-2 tw:ring-tertiary/40' : 'tw:bg-tertiary tw:hover:opacity-90 tw:text-on-tertiary'}`}>
            <Icon name="south_east" className="tw:text-[15px]" /><span>- Simulate Short</span>
          </button>
          <label className="tw:flex tw:items-center tw:bg-surface-container-high tw:border tw:border-outline-variant tw:rounded tw:px-1.5 tw:py-0.5 tw:gap-1 tw:font-mono-metric-md">
            <span className="tw:text-on-surface-variant tw:text-[10px]">Risk $:</span>
            <input aria-label="Risk amount in dollars" type="number" min="0" step="any" value={riskAmountInput} onChange={e => setRiskAmountInput(e.target.value)} disabled={Boolean(closedTrade)}
              className="tw:w-14 tw:bg-transparent tw:text-on-surface tw:font-bold tw:focus:outline-none" />
          </label>
        </div>
      </section>
    </>
  );

  const desktopLegend = (
    <div className="tw:h-8 tw:border-b tw:border-outline-variant/60 tw:bg-surface-container-lowest/85 tw:backdrop-blur-xs tw:flex tw:items-center tw:justify-between tw:px-4 tw:shrink-0 tw:font-mono-metric-md tw:text-[11px] tw:gap-3">
      <div className="tw:flex tw:items-center tw:gap-4 tw:min-w-0 tw:overflow-hidden tw:whitespace-nowrap">
        <div className="tw:flex tw:items-center tw:gap-1.5">
          <span className="tw:font-bold tw:text-on-surface">{symbol.trim().toUpperCase() || '—'}</span>
          <span className="tw:text-on-surface-variant">{tfLabel}</span>
          {legendCandle ? <>
            <span className="tw:text-primary-container tw:font-semibold">O: {fmtPrice(legendCandle.open)}</span>
            <span className="tw:text-on-surface">H: {fmtPrice(legendCandle.high)}</span>
            <span className="tw:text-on-surface">L: {fmtPrice(legendCandle.low)}</span>
            <span className={`tw:font-bold ${legendCandle.close >= legendCandle.open ? 'tw:text-secondary' : 'tw:text-tertiary'}`}>
              C: {fmtPrice(legendCandle.close)}{legendPrev ? ` (${legendCandle.close >= legendPrev.close ? '+' : ''}${(((legendCandle.close - legendPrev.close) / legendPrev.close) * 100).toFixed(2)}%)` : ''}
            </span>
          </> : <span className="tw:text-on-surface-variant">No chart loaded</span>}
        </div>
        {candles && indicators.ema && (
          <div className="tw:flex tw:items-center tw:gap-3 tw:text-[10px] tw:pl-2 tw:border-l tw:border-outline-variant">
            {EMA_CONFIG.map((cfg, k) => (
              <div key={cfg.period} className="tw:flex tw:items-center tw:gap-1">
                <span className="tw:w-2 tw:h-0.5" style={{ background: cfg.color }} />
                <span className="tw:text-on-surface-variant">{cfg.label}:</span>
                <span style={{ color: cfg.color }}>{emaValues[k] != null ? fmtPrice(emaValues[k]!) : '—'}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const addTagFromDraft = () => {
    const v = (tagDraft ?? '').trim().replace(/^#/, '');
    if (v && !tags.some(t => t.toLowerCase() === v.toLowerCase())) setTags(t => [...t, v]);
  };
  const resultDrawer = closedTrade && showCloseout && (
    <aside className="tw:absolute tw:top-0 tw:right-0 tw:bottom-0 tw:w-[380px] tw:max-w-full tw:bg-surface-container-low/98 tw:border-l tw:border-outline-variant tw:shadow-2xl tw:backdrop-blur-md tw:flex tw:flex-col tw:z-30 tw:select-text" role="dialog" aria-label="Simulation complete">
      <div className="tw:h-10 tw:px-4 tw:border-b tw:border-outline-variant tw:flex tw:items-center tw:justify-between tw:bg-surface-container-high/60 tw:shrink-0">
        <div className="tw:flex tw:items-center tw:gap-2">
          <Icon name="verified" className={`tw:text-[18px] ${closedTrade.outcome === 'loss' ? 'tw:text-tertiary' : 'tw:text-secondary'}`} />
          <span className="tw:font-bold tw:text-on-surface tw:text-xs tw:tracking-wide">Simulation Complete</span>
        </div>
        <button type="button" onClick={() => setShowCloseout(false)} aria-label="Close" title="Close (the trade stays on the chart)"
          className="tw:w-6 tw:h-6 tw:rounded tw:hover:bg-surface-container-high tw:flex tw:items-center tw:justify-center tw:text-on-surface-variant tw:hover:text-on-surface">
          <Icon name="close" className="tw:text-[16px]" />
        </button>
      </div>
      <div className="tw:flex-1 tw:overflow-y-auto tw:p-4 tw:flex tw:flex-col tw:gap-3.5">
        <div className="tw:bg-surface-container-high tw:border tw:border-outline-variant tw:rounded tw:p-3 tw:flex tw:items-center tw:justify-between">
          <div className="tw:flex tw:items-center tw:gap-2.5">
            <span className={`tw:px-2 tw:py-0.5 tw:rounded tw:font-bold tw:font-mono-metric-md tw:text-xs tw:tracking-wider ${closedTrade.outcome === 'win' ? 'tw:bg-secondary tw:text-on-secondary' : closedTrade.outcome === 'loss' ? 'tw:bg-tertiary tw:text-on-tertiary' : 'tw:bg-surface-variant tw:text-on-surface'}`}>
              {closedTrade.outcome === 'breakeven' ? 'BE' : closedTrade.outcome.toUpperCase()}
            </span>
            <div className="tw:flex tw:flex-col">
              <span className={`tw:font-mono-metric-md tw:text-sm tw:font-bold ${closedTrade.rMultiple >= 0 ? 'tw:text-secondary' : 'tw:text-tertiary'}`}>{fmtR(closedTrade.rMultiple).replace('R', ' R')}</span>
              <span className="tw:text-[9px] tw:text-on-surface-variant tw:uppercase">Return on Risk</span>
            </div>
          </div>
          <div className="tw:flex tw:flex-col tw:items-end">
            <span className={`tw:font-mono-metric-md tw:text-sm tw:font-bold ${closedTrade.pnlUSD >= 0 ? 'tw:text-secondary' : 'tw:text-tertiary'}`}>{closedTrade.riskAmount > 0 ? fmtUSD(closedTrade.pnlUSD) : '—'}</span>
            <span className="tw:text-[9px] tw:text-on-surface-variant tw:uppercase">Risked: {fmtUSD(closedTrade.riskAmount, false)}</span>
          </div>
        </div>
        <div className="tw:grid tw:grid-cols-2 tw:gap-2 tw:p-2.5 tw:bg-surface-container-lowest/70 tw:border tw:border-outline-variant tw:rounded tw:font-mono-metric-md tw:text-[10px]">
          <div><span className="tw:text-on-surface-variant tw:block tw:text-[9px]">SYMBOL &amp; TF:</span><span className="tw:text-on-surface tw:font-semibold">{symbol.trim().toUpperCase()} {tfLabel}</span></div>
          <div><span className="tw:text-on-surface-variant tw:block tw:text-[9px]">DURATION:</span><span className="tw:text-on-surface tw:font-semibold">{tradeBars} Bar{tradeBars === 1 ? '' : 's'}</span></div>
          <div><span className="tw:text-on-surface-variant tw:block tw:text-[9px]">SIM ENTRY:</span><span className="tw:text-primary-container tw:font-semibold">{fmtPrice(closedTrade.entryPrice)}</span></div>
          <div><span className="tw:text-on-surface-variant tw:block tw:text-[9px]">SIM EXIT ({exitKind}):</span><span className={`tw:font-semibold ${closedTrade.rMultiple >= 0 ? 'tw:text-secondary' : 'tw:text-tertiary'}`}>{fmtPrice(closedTrade.exitPrice)}</span></div>
        </div>
        <label className="tw:flex tw:flex-col tw:gap-1">
          <span className="tw:text-[10px] tw:uppercase tw:font-mono-metric-md tw:tracking-wider tw:text-on-surface-variant">Backtest Name / Setup Identifier</span>
          <input type="text" maxLength={100} value={backtestName} onChange={e => setBacktestName(e.target.value)}
            className="tw:w-full tw:bg-surface-container-high tw:border tw:border-outline-variant tw:rounded tw:px-2.5 tw:py-1.5 tw:font-mono-metric-md tw:text-xs tw:text-on-surface tw:focus:outline-none tw:focus:border-primary-container" />
        </label>
        <div className="tw:flex tw:flex-col tw:gap-1.5">
          <span className="tw:text-[10px] tw:uppercase tw:font-mono-metric-md tw:tracking-wider tw:text-on-surface-variant">Applied Strategy Tags</span>
          <div className="tw:flex tw:flex-wrap tw:gap-1">
            {tags.map(tag => (
              <span key={tag} className="tw:inline-flex tw:items-center tw:gap-1 tw:bg-primary-container/15 tw:border tw:border-primary-container/40 tw:text-primary-container tw:px-2 tw:py-0.5 tw:rounded tw:font-mono-metric-md tw:text-[10px]">
                {hashTag(tag)}
                <button type="button" onClick={() => setTags(t => t.filter(x => x !== tag))} aria-label={`Remove ${tag}`} className="tw:hover:text-on-surface"><Icon name="close" className="tw:text-[12px]" /></button>
              </span>
            ))}
            {tagDraft != null ? (
              <input autoFocus list="bt-tag-options-desktop" value={tagDraft} maxLength={40} placeholder="Strategy name…" aria-label="New strategy tag"
                onChange={e => setTagDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTagFromDraft(); setTagDraft(''); }
                  else if (e.key === 'Escape') { e.stopPropagation(); setTagDraft(null); }
                }}
                onBlur={() => { addTagFromDraft(); setTagDraft(null); }}
                className="tw:bg-surface-container-high tw:border tw:border-outline-variant tw:px-2 tw:py-0.5 tw:rounded tw:font-mono-metric-md tw:text-[10px] tw:text-on-surface tw:w-36 tw:focus:outline-none tw:focus:border-primary-container" />
            ) : (
              <button type="button" onClick={() => setTagDraft('')} className="tw:inline-flex tw:items-center tw:gap-0.5 tw:px-2 tw:py-0.5 tw:rounded tw:bg-surface-container-high tw:border tw:border-outline-variant tw:text-on-surface-variant tw:hover:text-on-surface tw:text-[10px]">
                <Icon name="add" className="tw:text-[12px]" />Tag
              </button>
            )}
            <datalist id="bt-tag-options-desktop">{strategies.filter(s => !tags.includes(s)).map(s => <option key={s} value={s} />)}</datalist>
          </div>
        </div>
        <label className="tw:flex tw:flex-col tw:gap-1">
          <span className="tw:text-[10px] tw:uppercase tw:font-mono-metric-md tw:tracking-wider tw:text-on-surface-variant">What did you see, and what did you learn?</span>
          <textarea rows={4} value={notes} onChange={e => setNotes(e.target.value)} placeholder="What was the setup? What would you do differently?"
            className="tw:w-full tw:bg-surface-container-high tw:border tw:border-outline-variant tw:rounded tw:p-2 tw:text-[11px] tw:text-on-surface tw:leading-relaxed tw:focus:outline-none tw:focus:border-primary-container tw:resize-none" />
        </label>
        <JournalFields value={journal} onChange={setJournal} />
        {saveError && <p className="tw:text-error tw:text-[11px]">{saveError}</p>}
      </div>
      <div className="tw:h-12 tw:px-4 tw:border-t tw:border-outline-variant tw:bg-surface-container-high/60 tw:flex tw:items-center tw:justify-between tw:shrink-0">
        <button type="button" onClick={() => { if (window.confirm('Discard this backtest trade?')) resetTrade(); }}
          className="tw:px-2.5 tw:py-1 tw:text-tertiary tw:hover:bg-tertiary/10 tw:rounded tw:transition tw:text-[11px]">Discard Backtest</button>
        <button type="button" onClick={() => void saveBacktestTrade()} disabled={saving}
          className="tw:flex tw:items-center tw:gap-1.5 tw:bg-primary-container tw:hover:bg-surface-tint tw:active:scale-95 tw:text-on-primary tw:font-semibold tw:px-3 tw:py-1.5 tw:rounded tw:transition tw:shadow tw:text-[11px] tw:disabled:opacity-60">
          <Icon name={saving ? 'progress_activity' : 'bookmark_added'} className={`tw:text-[15px] ${saving ? 'tw:animate-spin' : ''}`} /><span>{saving ? 'Saving…' : 'Save to Log'}</span>
        </button>
      </div>
    </aside>
  );

  const desktopDock = (
    <footer className="tw:h-11 tw:bg-surface-container-low tw:border-t tw:border-outline-variant tw:px-3 tw:flex tw:items-center tw:justify-between tw:gap-3 tw:shrink-0 tw:text-[11px]">
      <div className="tw:flex tw:items-center tw:gap-2 tw:shrink-0">
        <div className="tw:flex tw:items-center tw:gap-1">
          <button type="button" className={dockBtn} title="Reset to start" aria-label="Reset to start" disabled={!total || replayIdx <= analysisStartIdx} onClick={() => jumpToReplayIndex(analysisStartIdx)}><Icon name="first_page" className="tw:text-[16px]" /></button>
          <button type="button" className={dockBtn} title="Step -1 bar (←)" aria-label="Step back" disabled={!total || replayIdx === 0} onClick={() => jumpToReplayIndex(replayIdx - 1)}><Icon name="chevron_left" className="tw:text-[16px]" /></button>
          <button type="button" disabled={!total} onClick={() => setPlaying(p => !p)} title={playing ? 'Pause (Space)' : 'Play (Space)'} aria-label={playing ? 'Pause' : 'Play'}
            className="tw:w-8 tw:h-7 tw:rounded tw:bg-primary-container tw:hover:bg-surface-tint tw:text-on-primary tw:font-bold tw:flex tw:items-center tw:justify-center tw:transition tw:disabled:opacity-40">
            <Icon name={playing ? 'pause' : 'play_arrow'} className="tw:text-[18px]" />
          </button>
          <button type="button" className={dockBtn} title="Step +1 bar (→)" aria-label="Step forward" disabled={!total || replayIdx >= total - 1} onClick={() => jumpToReplayIndex(replayIdx + 1)}><Icon name="chevron_right" className="tw:text-[16px]" /></button>
          <button type="button" className={dockBtn} title="Jump to end" aria-label="Jump to end" disabled={!total || replayIdx >= total - 1} onClick={() => jumpToReplayIndex(total - 1)}><Icon name="last_page" className="tw:text-[16px]" /></button>
        </div>
        <div className="tw:flex tw:items-center tw:bg-surface-container-lowest tw:p-0.5 tw:rounded tw:border tw:border-outline-variant tw:font-mono-metric-md tw:text-[10px]" role="group" aria-label="Replay speed">
          {SPEEDS.map(s => (
            <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}
              className={`tw:px-1.5 tw:py-0.5 tw:rounded ${speed === s ? 'tw:bg-surface-container-high tw:text-primary-container tw:font-bold' : 'tw:text-on-surface-variant tw:hover:text-on-surface'}`}>{s}x</button>
          ))}
        </div>
      </div>
      <div className="tw:flex-1 tw:max-w-2xl tw:flex tw:flex-col tw:justify-center tw:px-3 tw:gap-1 tw:min-w-0">
        <div className="tw:relative tw:w-full tw:h-3.5 tw:flex tw:items-center tw:group">
          <div className="tw:w-full tw:h-1.5 tw:bg-surface-container-lowest tw:rounded-full tw:overflow-hidden tw:border tw:border-outline-variant/60">
            <div className="tw:h-full tw:bg-primary-container tw:rounded-full" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="tw:absolute tw:-translate-x-1/2 tw:w-3.5 tw:h-3.5 tw:rounded-full tw:bg-primary-container tw:border-2 tw:border-surface-container-lowest tw:shadow-[0_0_8px_rgba(245,158,11,0.7)] tw:group-hover:scale-125 tw:transition-transform tw:flex tw:items-center tw:justify-center tw:pointer-events-none" style={{ left: `${progressPct}%` }}>
            <div className="tw:w-1 tw:h-1 tw:rounded-full tw:bg-surface-container-lowest" />
          </div>
          <input type="range" aria-label="Replay progress" min={0} max={Math.max(0, total - 1)} value={replayIdx} disabled={!total}
            onChange={e => jumpToReplayIndex(Number(e.target.value))} className="tw:absolute tw:inset-0 tw:w-full tw:opacity-0 tw:cursor-pointer" />
        </div>
        <div className="tw:flex tw:items-center tw:justify-between tw:font-mono-metric-md tw:text-[10px] tw:text-on-surface-variant tw:whitespace-nowrap tw:gap-2">
          <span>Bar {Math.max(0, analysisBars)} of {analysisTotal} • {analysisPct.toFixed(1)}% elapsed</span>
          <span className="tw:text-primary-container tw:truncate">{nextCandle ? `Next candle: ${fmtTick(Number(nextCandle.time))} UTC` : candles ? 'End of window' : ''}</span>
        </div>
      </div>
      <div className="tw:hidden tw:min-[1400px]:flex tw:items-center tw:gap-1.5 tw:font-mono-metric-md tw:text-[10px] tw:text-on-surface-variant tw:shrink-0 tw:bg-surface-container-high/60 tw:border tw:border-outline-variant/80 tw:px-2 tw:py-1 tw:rounded">
        <span className="tw:text-on-surface tw:font-semibold">[Space]</span><span>Play</span><span className="tw:text-outline-variant">•</span>
        <span className="tw:text-on-surface tw:font-semibold">[← / →]</span><span>Step</span><span className="tw:text-outline-variant">•</span>
        <span className="tw:text-on-surface tw:font-semibold">[L]</span><span>Long</span><span className="tw:text-outline-variant">•</span>
        <span className="tw:text-on-surface tw:font-semibold">[S]</span><span>Short</span><span className="tw:text-outline-variant">•</span>
        <span className="tw:text-on-surface tw:font-semibold">[Esc]</span><span>Cancel</span>
      </div>
    </footer>
  );

  return (
    <div ref={rootRef} className="tw:flex tw:flex-col tw:w-full tw:text-on-surface tw:select-none">
      {toast && (
        <div role="status" className="tw:fixed tw:top-16 tw:left-1/2 tw:-translate-x-1/2 tw:z-50 tw:flex tw:items-center tw:gap-space-sm tw:bg-surface-bright tw:text-on-surface tw:px-space-md tw:py-space-sm tw:rounded tw:shadow-xl">
          <Icon name="check_circle" className="tw:text-[16px] tw:text-secondary" />
          <span className="tw:font-body-sm tw:text-body-sm tw:font-medium">{toast}</span>
        </div>
      )}
      {isDesktop ? desktopTop : (
      <>
          {/* 1. Setup ribbon */}
          <section className="tw:flex tw:flex-col tw:gap-space-sm tw:px-gutter tw:py-space-sm tw:bg-surface-container-low tw:shadow-sm">
            {/* Read-only session summary: symbol and range are chosen on New Backtest. */}
            <div className="tw:flex tw:items-center tw:justify-between tw:gap-space-sm">
              <div className="tw:flex tw:items-baseline tw:gap-space-xs tw:min-w-0">
                <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:font-bold tw:text-on-surface">{symbol.trim().toUpperCase() || '—'}</span>
                {desc && <span className="tw:text-body-sm tw:text-on-surface-variant tw:truncate">{desc[0]}</span>}
              </div>
              {current ? (
                <div className="tw:flex tw:items-baseline tw:gap-space-xs tw:shrink-0">
                  <span className={`tw:font-mono-metric-md tw:text-mono-metric-md tw:font-bold ${up(sessionChangePct)}`}>{fmtPrice(current.close)}</span>
                  <span className={`tw:font-label-caps tw:text-label-caps ${up(sessionChangePct)}`}>{sessionChangePct >= 0 ? '+' : ''}{sessionChangePct.toFixed(2)}%</span>
                </div>
              ) : loading && <span className="tw:text-body-sm tw:text-on-surface-variant">Loading…</span>}
            </div>
            <div className="tw:flex tw:items-center tw:justify-between tw:gap-space-sm tw:text-body-sm tw:text-on-surface-variant">
              <span className="tw:font-mono-metric-md">{fromDate} → {toDate}</span>
              <div className="tw:flex tw:items-center tw:gap-space-md">
                {candles && <button type="button" onClick={endSession} className="tw:text-on-surface-variant">End session</button>}
                <Link href="/backtest/new" className="tw:flex tw:items-center tw:gap-1 tw:text-primary"><Icon name="add" className="tw:text-[14px]" />New backtest</Link>
              </div>
            </div>
          </section>

          {/* 2. Execution ribbon */}
          <section className="tw:flex tw:flex-col tw:bg-surface-container tw:px-gutter tw:py-space-xs tw:gap-space-xs tw:shadow-sm">
            <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-space-xs">
              {timeframeChips('tw:bg-surface-container-high tw:text-primary tw:font-bold tw:shadow-sm')}
              <div className="tw:flex tw:items-center tw:gap-space-xs">
                <label className="tw:flex tw:items-center tw:bg-surface-container-lowest tw:px-space-sm tw:py-1 tw:rounded tw:gap-space-xs">
                  <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant">RISK</span>
                  <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface tw:font-semibold">$</span>
                  <input aria-label="Risk amount in dollars" type="number" min="0" step="any" value={riskAmountInput} onChange={e => setRiskAmountInput(e.target.value)} disabled={Boolean(closedTrade)}
                    className="tw:w-14 tw:bg-transparent tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface tw:font-semibold tw:focus:outline-none" />
                </label>
              </div>
            </div>
            {openTrade && (
              <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:bg-surface-container-high tw:px-space-md tw:py-1 tw:rounded tw:gap-space-xs">
                <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-space-md">
                  <span className={`tw:inline-flex tw:items-center tw:px-space-xs tw:py-0.5 tw:rounded tw:font-label-caps tw:text-label-caps tw:uppercase tw:font-bold ${openTrade.direction === 'long' ? 'tw:bg-secondary tw:text-on-secondary-container' : 'tw:bg-error tw:text-error-container'}`}>
                    {openTrade.direction === 'long' ? 'LONG' : 'SHORT'} · ${openTrade.riskAmount.toFixed(0)} Risk
                  </span>
                  <div className="tw:flex tw:items-baseline tw:gap-space-xs tw:font-mono-metric-md tw:text-mono-metric-md">
                    <span className="tw:text-on-surface-variant">Entry:</span><span className="tw:text-on-surface tw:font-semibold">{fmtPrice(openTrade.entryPrice)}</span>
                  </div>
                  <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-tertiary">SL: {fmtPrice(openTrade.stopLoss)} (-1.0R)</span>
                  {openTrade.takeProfit != null && <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-secondary tw:font-semibold">TP: {fmtPrice(openTrade.takeProfit)} (+{rr.toFixed(1)}R)</span>}
                  <span className="tw:font-label-caps tw:text-label-caps tw:text-primary">R:R 1:{rr.toFixed(1)}</span>
                </div>
                <div className="tw:flex tw:items-center tw:gap-space-xs">
                  {closedTrade ? (
                    <button type="button" onClick={() => setShowCloseout(true)} className="tw:bg-primary tw:px-space-md tw:py-0.5 tw:rounded tw:text-on-primary tw:font-label-action tw:text-label-action tw:font-semibold tw:shadow-sm tw:hover:brightness-110">
                      Log Outcome ({fmtR(closedTrade.rMultiple, 1)})
                    </button>
                  ) : (
                    <button type="button" onClick={closeTradeNow} title="Close at the current candle's close" className="tw:bg-primary tw:px-space-md tw:py-0.5 tw:rounded tw:text-on-primary tw:font-label-action tw:text-label-action tw:font-semibold tw:shadow-sm tw:hover:brightness-110 tw:active:scale-95">
                      Close Now ({fmtR(unrealizedR, 1)})
                    </button>
                  )}
                  <button type="button" onClick={resetTrade} className="tw:bg-surface-variant tw:px-space-sm tw:py-0.5 tw:rounded tw:text-on-surface-variant tw:font-label-action tw:text-label-action tw:hover:text-on-surface">Cancel</button>
                </div>
              </div>
            )}
          </section>

          {/* 3. Control strip */}
          <section className="tw:bg-surface-container tw:px-gutter tw:py-space-xs tw:flex tw:items-center tw:justify-end tw:gap-space-xs tw:shadow-inner tw:relative">
            <div className="tw:flex tw:items-center tw:gap-space-xs tw:shrink-0">
              <div className="tw:relative">
                <button type="button" onClick={() => setShowIndicatorMenu(v => !v)} aria-expanded={showIndicatorMenu}
                  className="tw:flex tw:items-center tw:gap-1 tw:bg-surface-container-high tw:hover:bg-surface-bright tw:px-space-sm tw:py-1 tw:rounded tw:text-on-surface tw:font-label-action tw:text-label-action">
                  <Icon name="tune" className="tw:text-[15px] tw:text-primary" />
                  <span>Indicators ({(indicators.ema ? 3 : 0) + (indicators.rsi ? 1 : 0) + (indicators.volume ? 1 : 0)})</span>
                </button>
                {showIndicatorMenu && (
                  <div className="tw:absolute tw:right-0 tw:top-full tw:mt-1 tw:z-30 tw:w-52 tw:bg-surface-container-high tw:rounded tw:shadow-xl tw:p-space-sm tw:flex tw:flex-col tw:gap-1">
                    {([['ema', 'EMA 20 / 50 / 200'], ['rsi', 'RSI (14)'], ['volume', 'Volume']] as const).map(([k, label]) => (
                      <label key={k} className="tw:flex tw:items-center tw:justify-between tw:gap-space-sm tw:px-space-xs tw:py-1 tw:rounded tw:hover:bg-surface-bright tw:cursor-pointer tw:font-label-action tw:text-label-action">
                        <span>{label}</span>
                        <input type="checkbox" checked={indicators[k]} onChange={e => setIndicators(v => ({ ...v, [k]: e.target.checked }))} className="tw:accent-primary" />
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <button type="button" onClick={() => setChartType(t => (t === 'candles' ? 'line' : 'candles'))} title={chartType === 'candles' ? 'Switch to line chart' : 'Switch to candlesticks'}
                className="tw:flex tw:items-center tw:justify-center tw:bg-surface-container-high tw:w-7 tw:h-7 tw:rounded tw:text-primary">
                <Icon name={chartType === 'candles' ? 'candlestick_chart' : 'show_chart'} className="tw:text-[16px]" />
              </button>
            </div>
          </section>
          {/* 5. OHLC legend */}
          <section className="tw:bg-surface-container-lowest tw:px-gutter tw:py-1 tw:flex tw:items-center tw:justify-between tw:text-on-surface-variant tw:font-mono-metric-md tw:text-mono-metric-md">
            <div className="tw:flex tw:items-center tw:gap-space-sm tw:overflow-x-auto tw:no-scrollbar tw:whitespace-nowrap">
              {legendCandle ? (
                <>
                  <span>O: <span className="tw:text-on-surface tw:font-semibold">{fmtPrice(legendCandle.open)}</span></span>
                  <span>H: <span className="tw:text-on-surface tw:font-semibold">{fmtPrice(legendCandle.high)}</span></span>
                  <span>L: <span className="tw:text-on-surface tw:font-semibold">{fmtPrice(legendCandle.low)}</span></span>
                  <span>C: <span className={`tw:font-semibold ${up(legendCandle.close - legendCandle.open)}`}>{fmtPrice(legendCandle.close)}</span></span>
                  {legendPrev && <span className={up(legendCandle.close - legendPrev.close)}>({legendCandle.close >= legendPrev.close ? '+' : ''}{(((legendCandle.close - legendPrev.close) / legendPrev.close) * 100).toFixed(2)}%)</span>}
                </>
              ) : <span>{loading ? 'Loading chart…' : 'No chart loaded yet.'}</span>}
            </div>
            <div className="tw:flex tw:items-center tw:gap-1 tw:shrink-0 tw:font-label-caps tw:text-label-caps tw:text-primary tw:uppercase">
              <span className={`tw:w-1.5 tw:h-1.5 tw:rounded-full ${playing ? 'tw:bg-secondary tw:animate-pulse' : 'tw:bg-on-surface-variant'}`} />
              <span>{playing ? 'Replaying' : candles ? 'Paused' : 'No chart'}</span>
            </div>
          </section>
        </>
      )}

      {/* Chart canvas dock -- one element for both layouts so the chart survives resizes. */}
      <div className="tw:relative tw:w-full tw:flex tw:bg-surface-container-lowest">
        <aside className="tw:w-12 tw:bg-surface-container-low tw:border-r tw:border-surface-container-highest tw:flex tw:flex-col tw:items-center tw:py-space-sm tw:gap-1 tw:shrink-0 tw:z-20 tw:shadow-md tw:overflow-y-auto tw:no-scrollbar" aria-label="Drawing tools">
          {WORKSPACE_TOOLS.map(t => railTool(t, 'tw:w-9 tw:h-9 tw:rounded-lg tw:flex tw:items-center tw:justify-center tw:shrink-0 tw:transition-colors', 'tw:bg-primary/15 tw:text-primary tw:ring-1 tw:ring-primary/40', 'tw:text-on-surface tw:hover:bg-surface-container-high'))}
          <div className="tw:w-6 tw:h-px tw:bg-surface-container-highest tw:my-1 tw:shrink-0" />
          <button type="button" onClick={() => setMagnet(m => !m)} aria-pressed={magnet} title="Magnet mode (snap to OHLC)" aria-label="Magnet mode"
            className={`tw:w-9 tw:h-9 tw:rounded-lg tw:flex tw:items-center tw:justify-center tw:shrink-0 tw:transition-colors ${magnet ? 'tw:bg-primary/15 tw:text-primary tw:ring-1 tw:ring-primary/40' : 'tw:text-on-surface tw:hover:bg-surface-container-high'}`}>
            <Icon name="all_inclusive" className="tw:text-[20px]" />
          </button>
          {selectedDrawingId && (
            <button type="button" onClick={deleteSelectedDrawing} title="Delete selected drawing" aria-label="Delete selected drawing"
              className="tw:w-9 tw:h-9 tw:rounded-lg tw:flex tw:items-center tw:justify-center tw:shrink-0 tw:transition-colors tw:text-on-surface-variant tw:hover:bg-error/20 tw:hover:text-error">
              <Icon name="delete" className="tw:text-[20px]" />
            </button>
          )}
          <button type="button" onClick={undoDrawing} disabled={!historyDepth} title="Undo" aria-label="Undo drawing"
            className="tw:w-9 tw:h-9 tw:rounded-lg tw:flex tw:items-center tw:justify-center tw:shrink-0 tw:transition-colors tw:text-on-surface-variant tw:hover:bg-surface-container-high tw:hover:text-on-surface tw:disabled:opacity-40">
            <Icon name="undo" className="tw:text-[20px]" />
          </button>
          <button type="button" onClick={clearAllDrawings} disabled={!drawingCount} title="Clear canvas markups" aria-label="Clear all drawings"
            className="tw:w-9 tw:h-9 tw:rounded-lg tw:flex tw:items-center tw:justify-center tw:shrink-0 tw:transition-colors tw:text-on-surface-variant tw:hover:bg-error/20 tw:hover:text-error tw:disabled:opacity-40">
            <Icon name="delete_sweep" className="tw:text-[20px]" />
          </button>
          <div className="tw:w-6 tw:h-px tw:bg-surface-container-highest tw:my-1 tw:shrink-0" />
          <div className="tw:flex tw:flex-col tw:items-center tw:gap-1 tw:p-1 tw:bg-surface-container-lowest tw:rounded" role="radiogroup" aria-label="Drawing color">
            {STYLE_SWATCHES.map(s => (
              <button key={s.color} type="button" role="radio" aria-checked={drawColor === s.color} aria-label={s.label} title={s.label} onClick={() => pickColor(s.color)}
                className={`tw:w-5 tw:h-5 tw:rounded-full tw:shrink-0 tw:border-2 ${s.cls} ${drawColor === s.color ? 'tw:border-on-surface' : 'tw:border-transparent'}`} />
            ))}
          </div>
        </aside>
        <div className="tw:relative tw:flex-1 tw:min-w-0 tw:flex tw:flex-col">
          {isDesktop && desktopLegend}
          <div className={`tw:relative tw:w-full ${isDesktop ? 'tw:h-[calc(100dvh-208px)] tw:min-h-[360px]' : 'tw:h-[clamp(360px,calc(100dvh-330px),900px)]'}`}
            onMouseMove={handleChartHover} onMouseLeave={() => setHoveredHandle(null)}>
          <div ref={chartContainerRef} className="tw:absolute tw:inset-0" />
          {candles && indicators.ema && !isDesktop && (
            <div className="tw:absolute tw:top-2 tw:right-2 tw:z-10 tw:flex tw:flex-wrap tw:items-center tw:gap-space-sm tw:bg-surface-container-lowest/80 tw:backdrop-blur-md tw:px-space-sm tw:py-1 tw:rounded tw:pointer-events-none">
              {EMA_CONFIG.map((cfg, k) => (
                <div key={cfg.period} className="tw:flex tw:items-center tw:gap-1">
                  <span className="tw:w-2 tw:h-0.5 tw:rounded-full" style={{ background: cfg.color }} />
                  <span className="tw:font-label-caps tw:text-label-caps" style={{ color: cfg.color }}>{cfg.label} <span className="tw:text-on-surface">{emaValues[k] != null ? fmtPrice(emaValues[k]!) : '—'}</span></span>
                </div>
              ))}
            </div>
          )}
          {candles && indicators.rsi && (
            <div className="tw:absolute tw:bottom-[84px] tw:left-2 tw:z-10 tw:flex tw:items-center tw:gap-space-sm tw:font-label-caps tw:text-label-caps tw:pointer-events-none">
              <span className="tw:text-primary tw:font-bold">RSI (14)</span>
              <span className={`tw:font-mono-metric-md tw:text-mono-metric-md tw:font-bold ${rsiValue == null ? 'tw:text-on-surface-variant' : rsiValue >= 70 ? 'tw:text-error' : rsiValue <= 30 ? 'tw:text-secondary' : 'tw:text-secondary'}`}>{rsiValue != null ? rsiValue.toFixed(2) : '—'}</span>
              <span className="tw:text-on-surface-variant">OB: 70 • OS: 30</span>
            </div>
          )}
          {hint && (
            <div className="tw:absolute tw:bottom-10 tw:left-1/2 tw:-translate-x-1/2 tw:z-10 tw:bg-surface-container-high/95 tw:px-space-md tw:py-1 tw:rounded tw:shadow-lg tw:font-label-action tw:text-label-action tw:text-on-surface tw:pointer-events-none tw:whitespace-nowrap">{hint}</div>
          )}
          <canvas ref={canvasRef} aria-label="Backtest overlay: position tool, replay marker and measure"
            className="tw:absolute tw:inset-0 tw:z-[5]"
            style={{
              // hoveredHandle stays set for the whole drag (hover tracking pauses while dragging).
              pointerEvents: activeDrawType || placingDirection || measureActive || hoveredHandle ? 'auto' : 'none',
              cursor: activeDrawType || placingDirection || measureActive ? 'crosshair' : hoveredHandle ? 'ns-resize' : undefined,
            }}
            onMouseDown={handleCanvasMouseDown} onMouseMove={handleCanvasMouseMove} onMouseUp={handleCanvasMouseUp}
            onMouseLeave={() => { if (measureDragRef.current) { measureDragRef.current = null; redrawCanvas(); } }} />
          {!candles && (
            <div className="tw:absolute tw:inset-0 tw:flex tw:flex-col tw:items-center tw:justify-center tw:gap-space-sm tw:text-center tw:p-space-xl">
              {loading ? (
                <><Icon name="progress_activity" className="tw:text-[28px] tw:text-primary tw:animate-spin" /><p className="tw:font-body-md tw:text-body-md tw:text-on-surface-variant">Requesting {symbol} candles from cTrader…</p></>
              ) : error ? (
                <>
                  <Icon name="warning" className="tw:text-[28px] tw:text-primary" />
                  <h3 className="tw:font-headline-md tw:text-headline-md tw:text-on-surface">{isSetupError ? 'Chart not configured' : 'Chart data unavailable'}</h3>
                  <p className="tw:font-body-sm tw:text-body-sm tw:text-on-surface-variant tw:max-w-md">{error}</p>
                  {isSetupError
                    ? <a href="/accounts" className="tw:text-primary tw:font-label-action tw:text-label-action tw:underline">Connect cTrader on the Accounts page</a>
                    : <div className="tw:flex tw:gap-space-sm"><button type="button" onClick={loadChart} className="tw:text-primary tw:font-label-action tw:text-label-action tw:underline">Try again</button><Link href="/backtest/new" className="tw:text-primary tw:font-label-action tw:text-label-action tw:underline">Change market or dates</Link></div>}
                </>
              ) : draftAvailable ? (
                <>
                  <Icon name="history" className="tw:text-[32px] tw:text-primary" />
                  <h3 className="tw:font-headline-md tw:text-headline-md tw:text-on-surface">Resume your last session?</h3>
                  <p className="tw:font-body-sm tw:text-body-sm tw:text-on-surface-variant tw:max-w-sm">
                    {draftAvailable.symbol} · {draftAvailable.interval} · {draftAvailable.drawings.length} drawing{draftAvailable.drawings.length === 1 ? '' : 's'}{draftAvailable.openTrade ? ' · an open trade' : ''}, saved {new Date(draftAvailable.savedAt).toLocaleString()}.
                  </p>
                  <div className="tw:flex tw:gap-space-sm tw:mt-space-xs">
                    <button type="button" onClick={() => resumeDraft()}className="tw:px-space-md tw:py-space-xs tw:rounded-full tw:bg-primary tw:text-on-primary tw:font-label-action tw:text-label-action">Resume session</button>
                    <button type="button" onClick={discardDraft} className="tw:px-space-md tw:py-space-xs tw:rounded-full tw:border tw:border-outline tw:text-on-surface-variant tw:font-label-action tw:text-label-action">Start fresh</button>
                  </div>
                </>
              ) : (
                <>
                  <Icon name="query_stats" className="tw:text-[32px] tw:text-primary" />
                  <h3 className="tw:font-headline-md tw:text-headline-md tw:text-on-surface">No session running</h3>
                  <p className="tw:font-body-sm tw:text-body-sm tw:text-on-surface-variant tw:max-w-sm">
                    Pick a market and date range to start replaying.
                  </p>
                  <Link href="/backtest/new" className="tw:mt-space-xs tw:px-space-md tw:py-space-xs tw:rounded-full tw:bg-primary tw:text-on-primary tw:font-label-action tw:text-label-action">New backtest</Link>
                </>
              )}
            </div>
          )}
          </div>
          {isDesktop && resultDrawer}
        </div>
      </div>

      {isDesktop ? desktopDock : (
        <>
      {/* 6. Replay controller */}
      <section className="tw:bg-surface-container-high tw:px-gutter tw:py-space-sm tw:flex tw:flex-col tw:gap-space-xs tw:shadow-md">
        <div className="tw:flex tw:items-center tw:justify-between tw:text-on-surface-variant tw:font-label-caps tw:text-label-caps">
          <div className="tw:flex tw:items-center tw:gap-space-xs"><Icon name="history" className="tw:text-[14px] tw:text-primary" /><span>HISTORICAL BAR REPLAY</span></div>
          <div className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface">Bar <span className="tw:text-primary tw:font-bold">{Math.max(0, analysisBars)}</span> / {analysisTotal}</div>
        </div>
        {scrubber('tw:bg-on-primary', 'tw:h-1.5')}
        <div className="tw:flex tw:items-center tw:justify-between">
          {transport(true)}
          {speedPills(SPEEDS, true)}
        </div>
      </section>
      <section className="tw:p-gutter tw:bg-surface-container-lowest tw:flex tw:items-center tw:gap-space-sm tw:shadow-xl">
        <div className="tw:grid tw:grid-cols-2 tw:gap-space-sm tw:flex-1 tw:min-w-0">
          <button type="button" onClick={() => startPlacing('long')} disabled={!candles || tradeLocked} aria-pressed={placingDirection === 'long'}
            className={`tw:min-h-[44px] tw:bg-secondary-container tw:text-on-secondary-container tw:hover:opacity-95 tw:font-label-action tw:text-label-action tw:font-semibold tw:rounded tw:flex tw:items-center tw:justify-center tw:gap-1 tw:shadow-sm tw:disabled:opacity-40 ${placingDirection === 'long' ? 'tw:ring-2 tw:ring-secondary' : ''}`}>
            <Icon name="arrow_upward" className="tw:text-[18px]" /><span>+ Long</span>
          </button>
          <button type="button" onClick={() => startPlacing('short')} disabled={!candles || tradeLocked} aria-pressed={placingDirection === 'short'}
            className={`tw:min-h-[44px] tw:bg-error-container tw:text-[#ffdad6] tw:hover:opacity-95 tw:font-label-action tw:text-label-action tw:font-semibold tw:rounded tw:flex tw:items-center tw:justify-center tw:gap-1 tw:shadow-sm tw:disabled:opacity-40 ${placingDirection === 'short' ? 'tw:ring-2 tw:ring-error' : ''}`}>
            <Icon name="arrow_downward" className="tw:text-[18px]" /><span>+ Short</span>
          </button>
        </div>
        <button type="button" onClick={downloadSnapshot} disabled={!candles} title="Take chart snapshot" aria-label="Take chart snapshot"
          className="tw:min-h-[44px] tw:min-w-[44px] tw:bg-surface-container-high tw:hover:bg-surface-bright tw:rounded tw:text-on-surface-variant tw:hover:text-on-surface tw:flex tw:items-center tw:justify-center tw:shrink-0 tw:disabled:opacity-40">
          <Icon name="photo_camera" className="tw:text-[20px]" />
        </button>
      </section>
        </>
      )}

      {/* 6. Log Trade Outcome modal */}
      {!isDesktop && closedTrade && showCloseout && (
        <div className="tw:fixed tw:inset-0 tw:z-50 tw:bg-surface-container-lowest/80 tw:backdrop-blur-sm tw:flex tw:items-end tw:sm:items-center tw:justify-center tw:p-gutter" role="dialog" aria-modal="true" aria-label="Log trade outcome">
          <div className="tw:w-full tw:max-w-lg tw:max-h-[90dvh] tw:overflow-y-auto tw:bg-surface-container tw:rounded-xl tw:shadow-[0_10px_30px_rgba(0,0,0,0.8)] tw:flex tw:flex-col">
            <div className="tw:flex tw:items-center tw:justify-between tw:px-space-xl tw:py-space-md tw:bg-surface-container-high">
              <div className="tw:flex tw:items-center tw:gap-space-sm">
                <Icon name="verified" className={`tw:text-[24px] ${closedTrade.outcome === 'loss' ? 'tw:text-error' : 'tw:text-secondary'}`} />
                <div>
                  <h2 className="tw:font-headline-md tw:text-headline-md tw:font-bold tw:text-on-surface">Log Trade Outcome</h2>
                  <p className="tw:font-body-sm tw:text-body-sm tw:text-on-surface-variant">Hypothetical Backtest Ledger Entry</p>
                </div>
              </div>
              <button type="button" onClick={() => setShowCloseout(false)} aria-label="Close" title="Close (the trade stays on the chart)"
                className="tw:w-8 tw:h-8 tw:rounded-full tw:bg-surface-container tw:flex tw:items-center tw:justify-center tw:text-on-surface-variant tw:hover:text-on-surface">
                <Icon name="close" className="tw:text-[18px]" />
              </button>
            </div>
            <div className="tw:p-space-xl tw:flex tw:flex-col tw:gap-space-lg tw:select-text">
              <div className="tw:flex tw:items-center tw:justify-between tw:p-space-md tw:bg-surface-container-lowest tw:rounded-lg">
                <div className="tw:flex tw:items-center tw:gap-space-md">
                  <span className={`tw:px-space-md tw:py-1 tw:rounded tw:font-headline-md tw:text-headline-md tw:font-bold tw:uppercase tw:tracking-wider ${closedTrade.outcome === 'win' ? 'tw:bg-secondary tw:text-on-secondary-container' : closedTrade.outcome === 'loss' ? 'tw:bg-error tw:text-error-container' : 'tw:bg-surface-variant tw:text-on-surface'}`}>
                    {closedTrade.outcome === 'breakeven' ? 'BE' : closedTrade.outcome}
                  </span>
                  <div className="tw:flex tw:flex-col">
                    <span className={`tw:font-mono-metric-lg tw:text-mono-metric-lg tw:font-bold ${up(closedTrade.rMultiple)}`}>{closedTrade.rMultiple >= 0 ? '+' : '-'}{Math.abs(closedTrade.rMultiple).toFixed(2)} R</span>
                    <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant">RETURN ON RISK</span>
                  </div>
                </div>
                <div className="tw:flex tw:flex-col tw:items-end">
                  <span className={`tw:font-mono-metric-lg tw:text-mono-metric-lg tw:font-bold ${up(closedTrade.pnlUSD)}`}>{closedTrade.riskAmount > 0 ? fmtUSD(closedTrade.pnlUSD) : '—'}</span>
                  <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant">{closedTrade.pnlUSD >= 0 ? 'NET PROFIT' : 'NET LOSS'}</span>
                </div>
              </div>
              <label className="tw:flex tw:flex-col tw:gap-space-xs">
                <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Backtest Name / Setup Identifier</span>
                <input type="text" maxLength={100} value={backtestName} onChange={e => setBacktestName(e.target.value)}
                  className="tw:w-full tw:bg-surface-container-lowest tw:px-space-md tw:py-space-sm tw:rounded tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface tw:focus:outline-none tw:focus:bg-surface-variant tw:transition-colors" />
              </label>
              <div className="tw:flex tw:flex-col tw:gap-space-xs">
                <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Applied Strategy Tags</span>
                <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-space-xs">
                  {tags.map(tag => (
                    <span key={tag} className="tw:inline-flex tw:items-center tw:gap-1 tw:bg-surface-container-high tw:px-space-sm tw:py-1 tw:rounded tw:font-mono-metric-md tw:text-mono-metric-md tw:text-primary">
                      {hashTag(tag)}
                      <button type="button" onClick={() => setTags(t => t.filter(x => x !== tag))} aria-label={`Remove ${tag}`}><Icon name="close" className="tw:text-[14px]" /></button>
                    </span>
                  ))}
                  {tagDraft != null ? (
                    <input autoFocus list="bt-tag-options" value={tagDraft} maxLength={40} placeholder="Strategy name…" aria-label="New strategy tag"
                      onChange={e => setTagDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          const v = tagDraft.trim().replace(/^#/, '');
                          if (v && !tags.some(t => t.toLowerCase() === v.toLowerCase())) setTags(t => [...t, v]);
                          setTagDraft('');
                        } else if (e.key === 'Escape') { e.stopPropagation(); setTagDraft(null); }
                      }}
                      onBlur={() => { const v = tagDraft.trim().replace(/^#/, ''); if (v && !tags.includes(v)) setTags(t => [...t, v]); setTagDraft(null); }}
                      className="tw:bg-surface-container-lowest tw:px-space-sm tw:py-1 tw:rounded tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface tw:w-40 tw:focus:outline-none" />
                  ) : (
                    <button type="button" onClick={() => setTagDraft('')} className="tw:inline-flex tw:items-center tw:gap-0.5 tw:bg-surface-variant tw:px-space-sm tw:py-1 tw:rounded tw:font-label-action tw:text-label-action tw:text-on-surface-variant tw:hover:text-on-surface">
                      <Icon name="add" className="tw:text-[14px]" /> Tag
                    </button>
                  )}
                  <datalist id="bt-tag-options">{strategies.filter(s => !tags.includes(s)).map(s => <option key={s} value={s} />)}</datalist>
                </div>
              </div>
              <label className="tw:flex tw:flex-col tw:gap-space-xs">
                <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Execution Notes &amp; Post-Mortem</span>
                <textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="What was the setup? What would you do differently?"
                  className="tw:w-full tw:bg-surface-container-lowest tw:p-space-md tw:rounded tw:font-body-md tw:text-body-md tw:text-on-surface tw:focus:outline-none tw:focus:bg-surface-variant tw:transition-colors tw:resize-none" />
              </label>
              <JournalFields value={journal} onChange={setJournal} />
              {saveError && <p className="tw:text-error tw:font-body-sm tw:text-body-sm">{saveError}</p>}
              <div className="tw:flex tw:items-center tw:justify-end tw:gap-space-sm tw:pt-space-xs">
                <button type="button" onClick={() => { if (window.confirm('Discard this backtest trade?')) resetTrade(); }}
                  className="tw:px-space-lg tw:py-space-sm tw:rounded tw:font-label-action tw:text-label-action tw:text-on-surface-variant tw:hover:text-on-surface tw:hover:bg-surface-variant tw:transition-colors tw:min-h-[40px]">Discard</button>
                <button type="button" onClick={() => void saveBacktestTrade()} disabled={saving}
                  className="tw:flex tw:items-center tw:gap-space-xs tw:bg-primary-container tw:text-on-primary-container tw:px-space-xl tw:py-space-sm tw:rounded tw:font-label-action tw:text-label-action tw:font-semibold tw:shadow-md tw:hover:brightness-110 tw:active:scale-95 tw:transition-all tw:min-h-[40px] tw:disabled:opacity-60">
                  <Icon name={saving ? 'progress_activity' : 'bookmark_added'} className={`tw:text-[18px] ${saving ? 'tw:animate-spin' : ''}`} />
                  <span>{saving ? 'Saving…' : 'Save to log'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
