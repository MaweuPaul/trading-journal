'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TrendingUp, Minus, ArrowUpRight, MoveUpRight, Layers, List, Square, Type as TypeIcon, Loader2, AlertTriangle, ExternalLink,
  Undo2, Trash2, MousePointer2,
  SkipBack, SkipForward, Play, Pause, Crosshair, LogOut as CloseIcon, Ruler,
} from 'lucide-react';
import { createChart, CandlestickSeries, ColorType, CrosshairMode } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { DrawingManager, getToolRegistry } from 'lightweight-charts-drawing';
import type { SerializedDrawing } from 'lightweight-charts-drawing';
import { useTheme } from './ThemeProvider';
import {
  Candle, MeasureRange, OpenTrade, ClosedTrade, TradeHandle,
  DRAWING_COLORS, CHART_INTERVALS, SPEEDS,
  isoDaysAgo, fmtPrice, suggestInterval, lookbackMs,
} from './backtest-tools/types';
import { placeTradeAt as placeTradeAtPure, updateHandlePrice as updateHandlePricePure, findTradeHandleAt as findTradeHandleAtIn, drawTradeOverlay } from './backtest-tools/positionTool';
import { drawMeasureOverlay } from './backtest-tools/measureTool';

const API = '/api';

// Frequently used drawing tools in the workspace's persistent icon rail.
const DRAW_TOOLS: { type: string; label: string; icon: typeof Square }[] = [
  { type: 'TrendLine', label: 'Trend line', icon: TrendingUp },
  { type: 'Ray', label: 'Ray', icon: MoveUpRight },
  { type: 'HorizontalLine', label: 'Horizontal line', icon: Minus },
  { type: 'Rectangle', label: 'Rectangle', icon: Square },
  { type: 'ParallelChannel', label: 'Channel', icon: Layers },
  { type: 'FibRetracement', label: 'Fib retracement', icon: List },
  { type: 'FibExtension', label: 'Fib extension', icon: Layers },
  { type: 'Arrow', label: 'Arrow', icon: ArrowUpRight },
];

function drawingFactory(type: string, data: SerializedDrawing) {
  return getToolRegistry().createDrawing(type, data.id, data.anchors, data.style, data.options);
}

interface Props { onSaved: () => void; }

export default function BacktestChart({ onSaved }: Props) {
  const { resolvedTheme } = useTheme();
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const managerRef = useRef<DrawingManager | null>(null);

  const [symbol, setSymbol] = useState('');
  const [availableSymbols, setAvailableSymbols] = useState<string[]>([]);
  const [interval, setInterval_] = useState(() => suggestInterval(isoDaysAgo(30), isoDaysAgo(0)));
  const [fromDate, setFromDate] = useState(isoDaysAgo(30));
  const [toDate, setToDate] = useState(isoDaysAgo(0));
  const intervalTouchedRef = useRef(false);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isSetupError, setIsSetupError] = useState(false);

  const [replayIdx, setReplayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Drawing tools (lightweight-charts-drawing) ───────────────────────────
  const [activeDrawType, setActiveDrawType] = useState<string | null>(null);
  const [showDrawingList, setShowDrawingList] = useState(false);
  const [drawColor, setDrawColor] = useState<string>(DRAWING_COLORS[0].value);
  const drawColorRef = useRef(drawColor);
  drawColorRef.current = drawColor;
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [drawingsVersion, setDrawingsVersion] = useState(0);
  const drawingHistoryRef = useRef<SerializedDrawing[][]>([]);
  const [historyDepth, setHistoryDepth] = useState(0);

  const [placingDirection, setPlacingDirection] = useState<'long' | 'short' | null>(null);
  const [riskAmountInput, setRiskAmountInput] = useState('100');
  const [openTrade, setOpenTrade] = useState<OpenTrade | null>(null);
  const draggingHandleRef = useRef<TradeHandle | null>(null);
  const [hoveredHandle, setHoveredHandle] = useState<TradeHandle | null>(null);
  const [closedTrade, setClosedTrade] = useState<ClosedTrade | null>(null);
  const [notes, setNotes] = useState('');
  const [backtestName, setBacktestName] = useState('');
  const [strategy, setStrategy] = useState('');
  const [availableStrategies, setAvailableStrategies] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [measureActive, setMeasureActive] = useState(false);
  const [measureRange, setMeasureRange] = useState<MeasureRange | null>(null);
  const measureDragRef = useRef<MeasureRange & { x1: number; y1: number; x2: number; y2: number } | null>(null);

  const redrawCanvasRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch(`${API}/pre-trade-analyses/symbols`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.ok ? res.json() : { symbols: [] })
      .then(data => setAvailableSymbols(Array.isArray(data.symbols) ? data.symbols : []))
      .catch(() => {});
    fetch(`${API}/backtest-trades/strategies`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.ok ? res.json() : { strategies: [] })
      .then(data => setAvailableStrategies(Array.isArray(data.strategies) ? data.strategies : []))
      .catch(() => {});
  }, []);

  // Re-suggest the timeframe whenever the date range changes, so the trader
  // never has to work out by hand which timeframe fits cTrader's 1500-bar
  // cap for a given range -- unless they've explicitly picked one themselves,
  // in which case their choice is left alone (they'll see the "too wide"
  // error and can widen the timeframe or narrow the range from there).
  useEffect(() => {
    if (intervalTouchedRef.current || candles) return;
    setInterval_(suggestInterval(fromDate, toDate));
  }, [fromDate, toDate, candles]);

  const pushHistorySnapshot = () => {
    const manager = managerRef.current; if (!manager) return;
    drawingHistoryRef.current = [...drawingHistoryRef.current.slice(-19), manager.exportDrawings()];
    setHistoryDepth(drawingHistoryRef.current.length);
  };
  const activateSelectMode = () => {
    managerRef.current?.setActiveTool(null);
    setActiveDrawType(null);
  };
  const activateDrawType = (type: string) => {
    const manager = managerRef.current; if (!manager) return;
    if (activeDrawType === type) { activateSelectMode(); return; }
    pushHistorySnapshot();
    manager.deselectAll();
    manager.setActiveTool(type);
    setActiveDrawType(type);
    setPlacingDirection(null);
    setMeasureActive(false);
  };
  const toggleMeasure = () => {
    const next = !measureActive;
    activateSelectMode();
    setMeasureActive(next);
    setMeasureRange(null);
    measureDragRef.current = null;
    setPlacingDirection(null);
  };
  const undoDrawing = () => {
    const manager = managerRef.current; if (!manager) return;
    const last = drawingHistoryRef.current.pop();
    if (last === undefined) return;
    setHistoryDepth(drawingHistoryRef.current.length);
    manager.clearAll();
    manager.importDrawings(last, drawingFactory);
    setSelectedDrawingId(null);
    setDrawingsVersion(v => v + 1);
  };
  const deleteSelectedDrawing = () => {
    const manager = managerRef.current; if (!manager || !selectedDrawingId) return;
    pushHistorySnapshot();
    manager.removeDrawing(selectedDrawingId);
    setSelectedDrawingId(null);
    setDrawingsVersion(v => v + 1);
  };
  const clearAllDrawings = () => {
    const manager = managerRef.current; if (!manager) return;
    if (!window.confirm('Remove every drawing from this chart?')) return;
    pushHistorySnapshot();
    manager.clearAll();
    setSelectedDrawingId(null);
    setShowDrawingList(false);
    setDrawingsVersion(v => v + 1);
  };
  const drawings = useMemo(() => managerRef.current?.getAllDrawings() ?? [], [drawingsVersion]);

  // ── Load candles for the chosen symbol/interval/date range ──────────────
  const loadChartWithInterval = useCallback((overrideInterval: string) => {
    const trimmed = symbol.trim();
    if (!trimmed) { setCandles(null); setError(''); return; }
    const token = localStorage.getItem('token');
    if (!token) return;
    const fromMs = new Date(fromDate).getTime();
    const toMs = new Date(toDate).getTime() + 24 * 60 * 60 * 1000;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) { setError('Pick a valid date range.'); return; }
    setLoading(true); setError(''); setIsSetupError(false);
    setOpenTrade(null); setClosedTrade(null); setPlacingDirection(null);
    setSelectedDrawingId(null); setActiveDrawType(null); setMeasureActive(false); setMeasureRange(null);
    drawingHistoryRef.current = []; setHistoryDepth(0); setDrawingsVersion(0);
    // Fetch starting a bit before the chosen date, so the chart opens
    // already showing the lead-up to the setup instead of cutting off right
    // at "From" -- the replay reveal still starts at the chosen date, this
    // lookback is only ever-visible context, not part of the analysis window.
    const fetchFromMs = lookbackMs(fromMs, overrideInterval);
    fetch(`${API}/backtest-trades/chart?symbol=${encodeURIComponent(trimmed)}&interval=${overrideInterval}&fromMs=${fetchFromMs}&toMs=${toMs}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) { setError(data.error || 'Failed to load chart data'); setIsSetupError(Boolean(data.setup)); setLoading(false); return; }
        const loaded = (data.candles || []).map((c: Candle) => ({ ...c, time: Number(c.time) as UTCTimestamp }));
        setCandles(loaded);
        const chosenStartIdx = loaded.findIndex((c: Candle) => Number(c.time) >= fromMs / 1000);
        const revealFrom = chosenStartIdx >= 0 ? chosenStartIdx : 0;
        setReplayIdx(Math.min(loaded.length - 1, revealFrom + 40));
        setLoading(false);
      })
      .catch(e => { setError(e.message || 'Network error'); setLoading(false); });
  }, [symbol, fromDate, toDate]);
  const loadChart = useCallback(() => loadChartWithInterval(interval), [loadChartWithInterval, interval]);
  const switchInterval = (tf: string) => {
    if (tf === interval || openTrade || closedTrade) return;
    setInterval_(tf);
    loadChartWithInterval(tf);
  };

  // ── Chart + drawing manager creation ─────────────────────────────────────
  useEffect(() => {
    if (!candles || !chartContainerRef.current) return;
    const chartTheme = resolvedTheme === 'dark'
      ? { background: '#0d1117', text: '#8e9bb0', grid: '#1f2a3c' }
      : { background: '#f8fafc', text: '#5b6780', grid: '#dfe5ee' };
    const el = chartContainerRef.current;
    const chart = createChart(el, {
      width: el.clientWidth, height: el.clientHeight,
      layout: { background: { type: ColorType.Solid, color: chartTheme.background }, textColor: chartTheme.text },
      grid: { vertLines: { color: chartTheme.grid }, horzLines: { color: chartTheme.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { borderColor: chartTheme.grid, timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: chartTheme.grid },
    });
    chartRef.current = chart;
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981', downColor: '#ef4444', borderVisible: false,
      wickUpColor: '#10b981', wickDownColor: '#ef4444',
    });
    seriesRef.current = series;

    const manager = new DrawingManager();
    manager.attach(chart, series, el);
    managerRef.current = manager;
    const unsubscribers = [
      manager.on('drawing:added', event => {
        if (event.drawing) {
          if (drawColorRef.current) event.drawing.updateStyle({ lineColor: drawColorRef.current });
          if (event.drawing.type === 'text-annotation') {
            const text = (window.prompt('Text for this note:', '') || '').trim().slice(0, 80);
            if (text) {
              (event.drawing as unknown as { setText: (t: string) => void }).setText(text);
              event.drawing.requestUpdate();
            } else {
              manager.removeDrawing(event.drawing.id);
            }
          }
        }
        setDrawingsVersion(v => v + 1);
      }),
      manager.on('drawing:removed', () => setDrawingsVersion(v => v + 1)),
      manager.on('drawing:updated', () => setDrawingsVersion(v => v + 1)),
      manager.on('drawing:cleared', () => setDrawingsVersion(v => v + 1)),
      manager.on('drawing:selected', event => setSelectedDrawingId(event.drawingId ?? null)),
      manager.on('drawing:deselected', () => setSelectedDrawingId(null)),
      manager.on('tool:changed', event => setActiveDrawType(event.toolType ?? null)),
    ];

    const syncCanvas = () => { if (canvasRef.current) { canvasRef.current.width = el.clientWidth; canvasRef.current.height = el.clientHeight; } };
    syncCanvas();
    const redraw = () => requestAnimationFrame(() => redrawCanvasRef.current());
    const ro = new ResizeObserver(() => { chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }); syncCanvas(); redraw(); });
    ro.observe(el);
    chart.timeScale().subscribeVisibleTimeRangeChange(redraw);
    return () => {
      unsubscribers.forEach(unsub => unsub());
      manager.detach();
      managerRef.current = null;
      ro.disconnect();
      chart.timeScale().unsubscribeVisibleTimeRangeChange(redraw);
      chart.remove();
      chartRef.current = null; seriesRef.current = null;
    };
  }, [candles, resolvedTheme]);

  // ── Progressive reveal: only candles up to replayIdx are ever shown ─────
  useEffect(() => {
    if (!candles || !seriesRef.current) return;
    seriesRef.current.setData(candles.slice(0, replayIdx + 1));
  }, [candles, replayIdx]);

  // Fit the view to whatever's revealed right after a fresh load, so the
  // chart doesn't sit at a leftover zoom level (tiny candle cluster lost in
  // a mostly-empty pane) -- but only on a fresh load, not on every replay
  // step, or playback would re-center itself on every single candle.
  useEffect(() => {
    if (!candles || !chartRef.current) return;
    chartRef.current.timeScale().fitContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles]);

  // Hide any drawing whose anchors reach past the currently revealed candle,
  // so you can't see your own future analysis while stepping through replay.
  const applyRevealGating = useCallback(() => {
    const manager = managerRef.current; if (!manager || !candles) return;
    const revealedTime = Number(candles[replayIdx]?.time ?? Number.POSITIVE_INFINITY);
    for (const d of manager.getAllDrawings()) {
      const maxAnchorTime = d.anchors.length ? Math.max(...d.anchors.map(a => Number(a.time))) : 0;
      const shouldShow = maxAnchorTime <= revealedTime;
      const currentlyVisible = d.options.visible !== false;
      if (currentlyVisible !== shouldShow) { d.updateOptions({ visible: shouldShow }); d.requestUpdate(); }
    }
  }, [candles, replayIdx]);
  useEffect(() => { applyRevealGating(); }, [applyRevealGating, drawingsVersion]);

  // ── Playback ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!candles) return;
    if (playing) {
      const ms = Math.max(50, 300 / speed);
      intervalRef.current = setInterval(() => {
        setReplayIdx(prev => {
          if (prev >= candles.length - 1) { setPlaying(false); return prev; }
          return prev + 1;
        });
      }, ms);
    } else if (intervalRef.current) clearInterval(intervalRef.current);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [playing, speed, candles]);

  const jumpToReplayIndex = useCallback((index: number) => {
    if (!candles) return;
    setPlaying(false);
    setReplayIdx(Math.max(0, Math.min(candles.length - 1, index)));
  }, [candles]);

  // ── Check the newly-revealed candle against an open hypothetical trade ──
  useEffect(() => {
    if (!candles || !openTrade || closedTrade) return;
    const candle = candles[replayIdx];
    if (!candle || candle.time <= openTrade.entryTime) return;
    const { direction, entryPrice, stopLoss, takeProfit } = openTrade;
    let exitPrice: number | null = null;
    let outcome: ClosedTrade['outcome'] | null = null;
    if (direction === 'long') {
      if (candle.low <= stopLoss) { exitPrice = stopLoss; outcome = stopLoss >= entryPrice ? 'breakeven' : 'loss'; }
      else if (takeProfit != null && candle.high >= takeProfit) { exitPrice = takeProfit; outcome = 'win'; }
    } else {
      if (candle.high >= stopLoss) { exitPrice = stopLoss; outcome = stopLoss <= entryPrice ? 'breakeven' : 'loss'; }
      else if (takeProfit != null && candle.low <= takeProfit) { exitPrice = takeProfit; outcome = 'win'; }
    }
    if (exitPrice == null || !outcome) return;
    const riskPerUnit = direction === 'long' ? entryPrice - stopLoss : stopLoss - entryPrice;
    const gainPerUnit = direction === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
    const rMultiple = riskPerUnit !== 0 ? gainPerUnit / riskPerUnit : 0;
    setPlaying(false);
    setClosedTrade({ ...openTrade, exitTime: candle.time, exitPrice, outcome, rMultiple, pnlUSD: rMultiple * openTrade.riskAmount });
  }, [candles, replayIdx, openTrade, closedTrade]);

  const closeTradeNow = () => {
    if (!candles || !openTrade) return;
    const candle = candles[replayIdx];
    if (!candle) return;
    const { direction, entryPrice, stopLoss } = openTrade;
    const exitPrice = candle.close;
    const riskPerUnit = direction === 'long' ? entryPrice - stopLoss : stopLoss - entryPrice;
    const gainPerUnit = direction === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
    const rMultiple = riskPerUnit !== 0 ? gainPerUnit / riskPerUnit : 0;
    const outcome: ClosedTrade['outcome'] = Math.abs(exitPrice - entryPrice) < 1e-9 ? 'breakeven' : rMultiple > 0 ? 'win' : 'loss';
    setClosedTrade({ ...openTrade, exitTime: candle.time, exitPrice, outcome, rMultiple, pnlUSD: rMultiple * openTrade.riskAmount });
  };
  const cancelTrade = () => { setOpenTrade(null); setClosedTrade(null); setNotes(''); setBacktestName(''); };
  useEffect(() => {
    if (!closedTrade || backtestName) return;
    const label = closedTrade.direction === 'long' ? 'Long' : 'Short';
    setBacktestName(`${symbol.trim() || 'Backtest'} ${label} — ${new Date().toLocaleDateString()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedTrade]);
  useEffect(() => {
    if (!openTrade || closedTrade) return;
    const amount = Number(riskAmountInput) || 0;
    if (amount === openTrade.riskAmount) return;
    setOpenTrade(cur => cur ? { ...cur, riskAmount: amount } : cur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riskAmountInput]);
  const discardClosedTrade = () => { setOpenTrade(null); setClosedTrade(null); setNotes(''); setBacktestName(''); };

  // TradingView-style placement: one click drops a ready-to-drag position box
  // with sensible default SL/TP (a 1:2 risk:reward box off entry) instead of
  // asking for typed prices first -- drag the SL/TP/Entry lines to adjust.
  const placeTradeAt = (direction: 'long' | 'short', time: number, price: number) => {
    setOpenTrade(placeTradeAtPure(direction, time, price, Number(riskAmountInput) || 0));
    setPlacingDirection(null);
  };
  const updateHandlePrice = (handle: TradeHandle, price: number) => {
    setOpenTrade(cur => cur ? updateHandlePricePure(cur, handle, price) : cur);
  };

  const saveBacktestTrade = async () => {
    if (!closedTrade) return;
    const token = localStorage.getItem('token'); if (!token) return;
    setSaving(true); setSaveError('');
    try {
      const res = await fetch(`${API}/backtest-trades`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: backtestName.trim(), strategy: strategy.trim(),
          symbol: symbol.trim(), interval,
          direction: closedTrade.direction,
          entryTime: closedTrade.entryTime, entryPrice: closedTrade.entryPrice,
          exitTime: closedTrade.exitTime, exitPrice: closedTrade.exitPrice,
          stopLoss: closedTrade.stopLoss, takeProfit: closedTrade.takeProfit,
          outcome: closedTrade.outcome, riskAmount: closedTrade.riskAmount,
          pnlUSD: closedTrade.pnlUSD, rMultiple: closedTrade.rMultiple,
          notes, chartAnnotations: managerRef.current?.exportDrawings() ?? [],
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not save backtest trade');
      setOpenTrade(null); setClosedTrade(null); setNotes(''); setBacktestName('');
      const savedStrategy = strategy.trim();
      if (savedStrategy) setAvailableStrategies(cur => cur.includes(savedStrategy) ? cur : [...cur, savedStrategy].sort((a, b) => a.localeCompare(b)));
      onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save backtest trade');
    } finally {
      setSaving(false);
    }
  };

  // ── Canvas redraw: the trade-simulation overlay + measure tool only ─────
  // (freehand drawings render themselves via lightweight-charts-drawing,
  // directly on the chart's own pane -- this canvas is just for the two
  // backtest-specific tools the library doesn't know about.)
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current, chart = chartRef.current, series = seriesRef.current;
    if (!canvas || !chart || !series) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const trade = closedTrade || openTrade;
    if (trade) drawTradeOverlay({ ctx, chart, series, canvas, trade, closedTrade, hoveredHandle, draggingHandle: draggingHandleRef.current });
    const activeMeasure = measureDragRef.current || measureRange;
    if (activeMeasure) drawMeasureOverlay({ ctx, chart, series, range: activeMeasure, candles, resolvedTheme: resolvedTheme === 'dark' ? 'dark' : 'light' });
  }, [candles, resolvedTheme, openTrade, closedTrade, hoveredHandle, measureRange]);

  useEffect(() => { redrawCanvasRef.current = redrawCanvas; redrawCanvas(); }, [redrawCanvas]);

  const findTradeHandleAt = (y: number): TradeHandle | null => {
    return findTradeHandleAtIn(y, openTrade, closedTrade, seriesRef.current);
  };
  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (placingDirection) {
      const chart = chartRef.current, series = seriesRef.current; if (!chart || !series) return;
      const time = chart.timeScale().coordinateToTime(x); const price = series.coordinateToPrice(y);
      if (time == null || price == null) return;
      placeTradeAt(placingDirection, Number(time), price);
      return;
    }
    if (measureActive) {
      const chart = chartRef.current, series = seriesRef.current; if (!chart || !series) return;
      const time = chart.timeScale().coordinateToTime(x); const price = series.coordinateToPrice(y);
      if (time == null || price == null) return;
      setMeasureRange(null);
      measureDragRef.current = { x1: x, y1: y, x2: x, y2: y, time1: Number(time), price1: price, time2: Number(time), price2: price };
      return;
    }
    const handle = findTradeHandleAt(y);
    if (handle) draggingHandleRef.current = handle;
  };
  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggingHandleRef.current) {
      const series = seriesRef.current; if (!series) return;
      const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
      const price = series.coordinateToPrice(e.clientY - r.top);
      if (price != null) updateHandlePrice(draggingHandleRef.current, price);
      return;
    }
    if (measureActive && measureDragRef.current) {
      const chart = chartRef.current, series = seriesRef.current; if (!chart || !series) return;
      const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
      const x2 = e.clientX - r.left, y2 = e.clientY - r.top;
      const time2 = chart.timeScale().coordinateToTime(x2); const price2 = series.coordinateToPrice(y2);
      if (time2 == null || price2 == null) return;
      measureDragRef.current = { ...measureDragRef.current, x2, y2, time2: Number(time2), price2 };
      redrawCanvas();
    }
  };
  const handleCanvasMouseUp = () => {
    if (draggingHandleRef.current) { draggingHandleRef.current = null; return; }
    if (measureActive && measureDragRef.current) {
      const { time1, price1, time2, price2 } = measureDragRef.current;
      setMeasureRange({ time1, price1, time2, price2 });
      measureDragRef.current = null;
    }
  };
  const handleChartWrapHoverMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (draggingHandleRef.current) return;
    const canvas = canvasRef.current; if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    if (!placingDirection && !measureActive && openTrade && !closedTrade) {
      setHoveredHandle(findTradeHandleAt(e.clientY - r.top));
    } else if (hoveredHandle) {
      setHoveredHandle(null);
    }
  };
  const handleChartWrapMouseLeave = () => setHoveredHandle(null);

  // Esc backs out of whatever's active; Delete/Backspace removes the
  // selected drawing (ignored while typing in a field).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable));
      if (e.key === 'Escape') {
        if (placingDirection) { setPlacingDirection(null); return; }
        if (activeDrawType) { activateSelectMode(); return; }
        if (measureActive) { setMeasureActive(false); setMeasureRange(null); return; }
        managerRef.current?.deselectAll();
        return;
      }
      if (typing) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDrawingId) {
        e.preventDefault();
        deleteSelectedDrawing();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placingDirection, activeDrawType, measureActive, selectedDrawingId]);

  const totalCandles = candles?.length ?? 1;
  const progressPct = ((replayIdx + 1) / totalCandles) * 100;
  const activeDrawLabel = activeDrawType === 'TextAnnotation' ? 'Text' : DRAW_TOOLS.find(t => t.type === activeDrawType)?.label;

  return (
    <div className="card bt-workspace">
      <div className="bt-workspace-heading"><span className="bt-eyebrow">REPLAY WORKSPACE</span><span>Historical market simulation</span></div>
      <div className="bt-setup">
        <label>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Symbol</span>
          <input type="text" list="backtest-symbol-options" value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="e.g. XAUUSD" style={{ width: '100%', minHeight: 36, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }} />
          <datalist id="backtest-symbol-options">
            {availableSymbols.map(s => <option key={s} value={s} />)}
          </datalist>
        </label>
        <label>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>From</span>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} style={{ width: '100%', minHeight: 36, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }} />
        </label>
        <label>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>To</span>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} style={{ width: '100%', minHeight: 36, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }} />
        </label>
        <label>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Timeframe <span style={{ fontWeight: 400, textTransform: 'none', color: 'var(--text-muted)' }}>(auto)</span></span>
          <select value={interval} onChange={e => { intervalTouchedRef.current = true; setInterval_(e.target.value); }} style={{ width: '100%', minHeight: 36, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }}>
            {CHART_INTERVALS.map(tf => <option key={tf.value} value={tf.value}>{tf.label}</option>)}
          </select>
        </label>
        <div style={{ alignSelf: 'end' }}>
          <button type="button" className="btn-primary" style={{ width: '100%' }} onClick={loadChart} disabled={!symbol.trim() || loading}>
            {loading ? 'Loading…' : 'Load chart'}
          </button>
        </div>
      </div>

      {candles && (
        <>
          <div className="replay-workspace-toolbar bt-execution" aria-label="Backtest chart tools">
            <div className="replay-tool-group timeframe-group">
              <span className="replay-tool-group-label">Timeframe</span>
              <div className="replay-timeframes" role="group" aria-label="Chart timeframe" title={openTrade || closedTrade ? 'Close or discard the current trade before changing timeframe' : undefined}>
                {CHART_INTERVALS.map(tf => (
                  <button type="button" key={tf.value} aria-pressed={interval === tf.value} disabled={Boolean(openTrade || closedTrade)} className={interval === tf.value ? 'active' : ''} onClick={() => switchInterval(tf.value)}>{tf.label}</button>
                ))}
              </div>
            </div>
            <div className="replay-toolbar-divider" />
            <div className="replay-tool-group">
              <span className="replay-tool-group-label">Trade</span>
              {!openTrade && !closedTrade && (
                <>
                  <button type="button" aria-pressed={placingDirection === 'long'} className={`replay-tool-btn replay-tool-primary${placingDirection === 'long' ? ' active' : ''}`} onClick={() => { setPlacingDirection(d => d === 'long' ? null : 'long'); activateSelectMode(); setMeasureActive(false); }} title="Click the chart to place a long"><Crosshair size={16} /> Long</button>
                  <button type="button" aria-pressed={placingDirection === 'short'} className={`replay-tool-btn replay-tool-primary${placingDirection === 'short' ? ' active' : ''}`} onClick={() => { setPlacingDirection(d => d === 'short' ? null : 'short'); activateSelectMode(); setMeasureActive(false); }} title="Click the chart to place a short"><Crosshair size={16} /> Short</button>
                  <label className="bt-risk-input"><span>Risk $</span><input aria-label="Risk amount in dollars" type="number" step="any" min="0" value={riskAmountInput} onChange={e => setRiskAmountInput(e.target.value)} placeholder="Risk $" style={{ width: 78, minHeight: 34, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: 11.5, padding: '0 8px' }} /></label>
                </>
              )}
              {openTrade && !closedTrade && (
                <>
                  <span className={`badge ${openTrade.direction === 'long' ? 'buy' : 'sell'}`}>{openTrade.direction === 'long' ? 'LONG' : 'SHORT'} @ {fmtPrice(openTrade.entryPrice)}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    SL {fmtPrice(openTrade.stopLoss)}{openTrade.takeProfit != null && <> · TP {fmtPrice(openTrade.takeProfit)}</>} · R:R 1:{(Math.abs((openTrade.takeProfit ?? openTrade.entryPrice) - openTrade.entryPrice) / Math.abs(openTrade.entryPrice - openTrade.stopLoss)).toFixed(2)}
                  </span>
                  <label className="bt-risk-input"><span>Risk $</span><input aria-label="Risk amount in dollars" type="number" step="any" min="0" value={riskAmountInput} onChange={e => setRiskAmountInput(e.target.value)} placeholder="Risk $" style={{ width: 78, minHeight: 34, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: 11.5, padding: '0 8px' }} /></label>
                  <button type="button" className="replay-tool-btn" onClick={closeTradeNow} title="Close using the current candle's price"><CloseIcon size={16} /> Close Now</button>
                  <button type="button" className="replay-tool-btn replay-delete-tool" onClick={cancelTrade} title="Discard this hypothetical trade">Cancel</button>
                </>
              )}
            </div>
          </div>

          <div className="bt-chart-layout">
          <aside className="bt-drawing-rail" aria-label="Drawing tools">
            <button type="button" title="Select drawings" aria-label="Select drawings" aria-pressed={!activeDrawType && !measureActive} onClick={activateSelectMode}><MousePointer2 size={18} /></button>
            <div className="bt-rail-divider" />
            {DRAW_TOOLS.map(tool => <button type="button" key={tool.type} title={tool.label} aria-label={tool.label} aria-pressed={activeDrawType === tool.type} onClick={() => activateDrawType(tool.type)}><tool.icon size={18} /></button>)}
            <button type="button" title="Text annotation" aria-label="Text annotation" aria-pressed={activeDrawType === 'TextAnnotation'} onClick={() => activateDrawType('TextAnnotation')}><TypeIcon size={18} /></button>
            <button type="button" title="Measure" aria-label="Measure" aria-pressed={measureActive} onClick={toggleMeasure}><Ruler size={18} /></button>
            <label className="bt-color-picker" title="Drawing color"><span className="bt-sr-only">Drawing color</span><input type="color" value={drawColor} onChange={e => setDrawColor(e.target.value)} /></label>
            <div className="bt-rail-divider" />
            <button type="button" title="Undo drawing" aria-label="Undo drawing" disabled={historyDepth === 0} onClick={undoDrawing}><Undo2 size={18} /></button>
            <button type="button" title="Delete selected drawing" aria-label="Delete selected drawing" disabled={!selectedDrawingId} onClick={deleteSelectedDrawing}><Trash2 size={18} /></button>
            <button type="button" title={`Objects (${drawings.length})`} aria-label={`Objects (${drawings.length})`} aria-pressed={showDrawingList} onClick={() => setShowDrawingList(v => !v)}><List size={18} /></button>
          </aside>
          <div className="bt-chart-main">
          <div className="bt-chart-heading"><strong>{symbol} <span>{interval}</span></strong><span>Historical replay · {replayIdx + 1} / {totalCandles} bars</span></div>
          {activeDrawType && (
            <div className="replay-active-tool" role="status">
              <strong>{activeDrawLabel}</strong>
              <span>{activeDrawType === 'TextAnnotation' ? 'Click the chart to place a note, then type it in the prompt.' : 'Click (and drag, if needed) on the chart to draw it.'}</span>
              <button type="button" onClick={activateSelectMode}>Cancel</button>
            </div>
          )}
          {measureActive && (
            <div className="replay-active-tool" role="status">
              <strong>Measure</strong>
              <span>Drag between two points to measure price, percent move, and bar count.</span>
              <button type="button" onClick={() => { setMeasureActive(false); setMeasureRange(null); }}>Cancel</button>
            </div>
          )}
          {placingDirection && (
            <div className="replay-active-tool" role="status">
              <strong>{placingDirection === 'long' ? 'Long' : 'Short'}</strong>
              <span>Click the chart at the price and candle where you would have entered. Drag the SL/TP lines afterward to adjust.</span>
              <button type="button" onClick={() => setPlacingDirection(null)}>Cancel</button>
            </div>
          )}

          <div className="replay-chart-wrap" style={{ height: 560, position: 'relative' }} onMouseMove={handleChartWrapHoverMove} onMouseLeave={handleChartWrapMouseLeave}>
            <div ref={chartContainerRef} className="replay-chart-container" />

            {showDrawingList && drawings.length > 0 && (
              <div className="replay-annotation-manager" aria-label="Chart drawings">
                <div className="replay-annotation-manager-head"><strong>Saved drawings</strong><button type="button" onClick={clearAllDrawings}>Clear all</button></div>
                {drawings.map((d, index) => (
                  <div className={`replay-annotation-row${selectedDrawingId === d.id ? ' selected' : ''}`} key={d.id}>
                    <button type="button" className="replay-annotation-select" aria-pressed={selectedDrawingId === d.id} onClick={() => { managerRef.current?.selectDrawing(d.id); }}>
                      <i style={{ background: d.style.lineColor || '#3b82f6' }} />
                      <span><b>{getToolRegistry().get(d.type)?.name ?? d.type}</b> {index + 1}</span>
                    </button>
                    <button type="button" onClick={click => { click.stopPropagation(); pushHistorySnapshot(); managerRef.current?.removeDrawing(d.id); setDrawingsVersion(v => v + 1); }} aria-label={`Delete ${d.type}`}><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
            )}

            <canvas ref={canvasRef}
              className={`replay-canvas-overlay${placingDirection || measureActive ? ' drawing-active' : ''}`}
              style={(hoveredHandle || draggingHandleRef.current) ? { pointerEvents: 'all', cursor: 'ns-resize' } : placingDirection || measureActive ? { pointerEvents: 'all', cursor: 'crosshair' } : undefined}
              aria-label="Backtest trade and measure overlay"
              onMouseDown={handleCanvasMouseDown} onMouseMove={handleCanvasMouseMove} onMouseUp={handleCanvasMouseUp}
              onMouseLeave={() => { if (measureDragRef.current) { measureDragRef.current = null; redrawCanvas(); } }} />
          </div>

          </div>
          </div>
          <div className="replay-bottombar bt-playback">
            <button className="replay-ctrl-btn" disabled={replayIdx === 0} onClick={() => jumpToReplayIndex(0)} aria-label="Reset to start" title="Reset to start"><SkipBack size={14} /></button>
            <button className="replay-ctrl-btn" disabled={replayIdx === 0} onClick={() => jumpToReplayIndex(replayIdx - 1)} aria-label="Step back" title="Step back">‹</button>
            <button className={`replay-ctrl-btn play${playing ? ' is-playing' : ''}`} onClick={() => setPlaying(p => !p)} aria-label="Play/Pause" title="Play/Pause">
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button className="replay-ctrl-btn" disabled={replayIdx >= totalCandles - 1} onClick={() => jumpToReplayIndex(replayIdx + 1)} aria-label="Step forward" title="Step forward">›</button>
            <button className="replay-ctrl-btn" disabled={replayIdx >= totalCandles - 1} onClick={() => jumpToReplayIndex(totalCandles - 1)} aria-label="Jump to end" title="Jump to end"><SkipForward size={14} /></button>
            <select aria-label="Replay speed" className="replay-speed-select" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
              {SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}
            </select>
            <input className="bt-scrubber" type="range" aria-label="Replay progress" min={0} max={Math.max(0, totalCandles - 1)} value={replayIdx} onChange={e => jumpToReplayIndex(Number(e.target.value))} />
            <span className="bt-playback-count">{Math.round(progressPct)}%</span>
          </div>
        </>
      )}

      {!candles && !loading && (
        <div className="replay-chart-state" style={{ position: 'static', minHeight: 200 }}>
          <h4>Load a symbol and date range</h4>
          <p>Pick a symbol, a past date range, and a timeframe, then click Load chart to start backtesting.</p>
        </div>
      )}
      {loading && (
        <div className="replay-chart-state" style={{ position: 'static', minHeight: 200 }}><Loader2 className="spin" size={22} /><h4>Loading chart…</h4><p>Requesting {symbol} candles from cTrader</p></div>
      )}
      {!loading && error && (
        <div className="replay-chart-state" style={{ position: 'static', minHeight: 200 }}>
          <AlertTriangle size={32} color="#f59e0b" />
          <h4>{isSetupError ? 'Chart Not Configured' : 'Chart Data Unavailable'}</h4>
          <p>{error}</p>
          {isSetupError && <a href="/accounts" className="replay-setup-link">Connect cTrader on the Accounts page <ExternalLink size={12} /></a>}
        </div>
      )}

      {closedTrade && (
        <div className="bt-closeout" style={{ padding: 16, borderTop: '1px solid var(--border)', display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <span className={`badge ${closedTrade.outcome === 'win' ? 'buy' : closedTrade.outcome === 'loss' ? 'sell' : ''}`}>{closedTrade.outcome.toUpperCase()}</span>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{closedTrade.direction === 'long' ? 'Long' : 'Short'} · Entry {fmtPrice(closedTrade.entryPrice)} → Exit {fmtPrice(closedTrade.exitPrice)}</span>
            <strong style={{ fontFamily: 'var(--font-mono)' }}>{closedTrade.rMultiple >= 0 ? '+' : ''}{closedTrade.rMultiple.toFixed(2)}R</strong>
            {closedTrade.riskAmount > 0 && <strong style={{ color: closedTrade.pnlUSD >= 0 ? 'var(--green)' : 'var(--red)' }}>{closedTrade.pnlUSD >= 0 ? '+' : ''}${closedTrade.pnlUSD.toFixed(2)}</strong>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            <label>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Backtest Name</span>
              <input type="text" maxLength={100} value={backtestName} onChange={e => setBacktestName(e.target.value)} placeholder="e.g. Gold breakout retest" style={{ width: '100%', minHeight: 36, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }} />
            </label>
            <label>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Strategy</span>
              <input type="text" list="backtest-strategy-options" maxLength={80} value={strategy} onChange={e => setStrategy(e.target.value)} placeholder="e.g. EMA Pullback" style={{ width: '100%', minHeight: 36, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }} />
              <datalist id="backtest-strategy-options">
                {availableStrategies.map(s => <option key={s} value={s} />)}
              </datalist>
            </label>
          </div>
          <label className="bt-notes-label">Trade notes<textarea className="drawer-textarea" placeholder="What was the setup? What would you do differently?" value={notes} onChange={e => setNotes(e.target.value)} /></label>
          {saveError && <div className="account-alert error">{saveError}</div>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="btn-danger" onClick={discardClosedTrade}>Discard</button>
            <button type="button" className="btn-primary" onClick={saveBacktestTrade} disabled={saving}>{saving ? 'Saving…' : 'Save to Backtest Log'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
