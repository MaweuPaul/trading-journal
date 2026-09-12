'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Square, Type as TypeIcon, Loader2, AlertTriangle, ExternalLink,
  Undo2, Trash2, MousePointer2, ArrowUpRight, MoveHorizontal, ChevronDown, X,
  SkipBack, SkipForward, Play, Pause, Crosshair, LogOut as CloseIcon,
} from 'lucide-react';
import { createChart, CandlestickSeries, ColorType, CrosshairMode } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { useTheme } from './ThemeProvider';

const API = '/api';

interface Candle { time: UTCTimestamp; open: number; high: number; low: number; close: number; }
type AnnotationLineStyle = 'solid' | 'dashed';
interface DrawnRect { id: string; time1: number; time2: number; price1: number; price2: number; color: string; }
interface DrawnLine { id: string; time1: number; time2: number; price1: number; price2: number; color: string; lineStyle?: AnnotationLineStyle; }
interface DrawnText { id: string; time: number; price: number; text: string; color: string; }
interface DrawnHorizontal { id: string; time: number; price: number; color: string; lineStyle?: AnnotationLineStyle; }
interface DrawnArrow { id: string; time1: number; time2: number; price1: number; price2: number; color: string; lineStyle?: AnnotationLineStyle; }
type ChartAnnotation =
  | (DrawnRect & { type: 'rect' }) | (DrawnLine & { type: 'line' })
  | (DrawnHorizontal & { type: 'horizontal' }) | (DrawnArrow & { type: 'arrow' })
  | (DrawnText & { type: 'text' });
type DrawingTool = 'none' | 'select' | 'rect' | 'line' | 'horizontal' | 'arrow' | 'text';
type ShapeDrawingTool = Extract<DrawingTool, 'rect' | 'line' | 'horizontal' | 'arrow'>;
interface AnnotationHistory { rects: DrawnRect[]; lines: DrawnLine[]; horizontals: DrawnHorizontal[]; arrows: DrawnArrow[]; texts: DrawnText[]; }

interface OpenTrade {
  direction: 'long' | 'short';
  entryTime: number; entryPrice: number;
  stopLoss: number; takeProfit: number | null;
  riskAmount: number;
}
interface ClosedTrade extends OpenTrade {
  exitTime: number; exitPrice: number;
  outcome: 'win' | 'loss' | 'breakeven';
  rMultiple: number; pnlUSD: number;
}

const DRAWING_COLORS = [
  { value: '#3b82f6', label: 'Blue' }, { value: '#10b981', label: 'Green' },
  { value: '#f59e0b', label: 'Amber' }, { value: '#ef4444', label: 'Red' },
  { value: '#8b5cf6', label: 'Purple' }, { value: '#ec4899', label: 'Pink' },
] as const;
const SHAPE_DRAWING_TOOLS: ShapeDrawingTool[] = ['rect', 'line', 'horizontal', 'arrow'];
const TOOL_GUIDANCE: Partial<Record<DrawingTool, { label: string; instruction: string }>> = {
  select: { label: 'Select', instruction: 'Drag an annotation to move it. Click it (without dragging) to edit its color or line style.' },
  rect: { label: 'Zone', instruction: 'Drag across the chart to mark an area.' },
  line: { label: 'Trend line', instruction: 'Drag from the start point to the end point.' },
  horizontal: { label: 'Price level', instruction: 'Click once at the price you want to mark.' },
  arrow: { label: 'Arrow', instruction: 'Drag to point from one place to another.' },
  text: { label: 'Text note', instruction: 'Write the note, then click the candle and price where it belongs.' },
};
const CHART_INTERVALS = [
  { value: '1min', label: '1m' }, { value: '5min', label: '5m' }, { value: '15min', label: '15m' },
  { value: '1h', label: '1H' }, { value: '4h', label: '4H' }, { value: '1day', label: '1D' },
] as const;
const SPEEDS = [0.5, 1, 2, 5, 10];

function toAnnotations(rects: DrawnRect[], lines: DrawnLine[], horizontals: DrawnHorizontal[], arrows: DrawnArrow[], texts: DrawnText[]): ChartAnnotation[] {
  return [
    ...rects.map(a => ({ ...a, type: 'rect' as const })),
    ...lines.map(a => ({ ...a, type: 'line' as const })),
    ...horizontals.map(a => ({ ...a, type: 'horizontal' as const })),
    ...arrows.map(a => ({ ...a, type: 'arrow' as const })),
    ...texts.map(a => ({ ...a, type: 'text' as const })),
  ];
}
function isoDaysAgo(days: number) {
  const d = new Date(); d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function fmtPrice(n: number) { return n.toFixed(n >= 100 ? 2 : 5); }

interface Props { onSaved: () => void; }

export default function BacktestChart({ onSaved }: Props) {
  const { resolvedTheme } = useTheme();
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const annotationInputRef = useRef<HTMLInputElement>(null);

  const [symbol, setSymbol] = useState('');
  const [interval, setInterval_] = useState('15min');
  const [fromDate, setFromDate] = useState(isoDaysAgo(30));
  const [toDate, setToDate] = useState(isoDaysAgo(0));
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isSetupError, setIsSetupError] = useState(false);

  const [replayIdx, setReplayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [drawingTool, setDrawingTool] = useState<DrawingTool>('none');
  const [showDrawingTools, setShowDrawingTools] = useState(false);
  const [rectColor, setRectColor] = useState<string>(DRAWING_COLORS[0].value);
  const [drawnRects, setDrawnRects] = useState<DrawnRect[]>([]);
  const [drawnLines, setDrawnLines] = useState<DrawnLine[]>([]);
  const [drawnHorizontals, setDrawnHorizontals] = useState<DrawnHorizontal[]>([]);
  const [drawnArrows, setDrawnArrows] = useState<DrawnArrow[]>([]);
  const [drawnTexts, setDrawnTexts] = useState<DrawnText[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState('');
  const [annotationText, setAnnotationText] = useState('');
  const [showAnnotationList, setShowAnnotationList] = useState(false);
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState('');
  const [editingAnnotation, setEditingAnnotation] = useState<{ annotation: ChartAnnotation; anchorX: number; anchorY: number } | null>(null);
  const [annotationEditDraft, setAnnotationEditDraft] = useState<{ text: string; color: string; lineStyle: AnnotationLineStyle }>({ text: '', color: '', lineStyle: 'solid' });
  const [annotationHistoryDepth, setAnnotationHistoryDepth] = useState(0);

  const [placingTrade, setPlacingTrade] = useState(false);
  const [entryDraft, setEntryDraft] = useState<{ time: number; price: number } | null>(null);
  const [draftDirection, setDraftDirection] = useState<'long' | 'short'>('long');
  const [draftStopLoss, setDraftStopLoss] = useState('');
  const [draftTakeProfit, setDraftTakeProfit] = useState('');
  const [draftRisk, setDraftRisk] = useState('100');
  const [openTrade, setOpenTrade] = useState<OpenTrade | null>(null);
  const [closedTrade, setClosedTrade] = useState<ClosedTrade | null>(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const movingAnnotationRef = useRef<{ annotation: ChartAnnotation; startX: number; startY: number; originTime: number; originPrice: number; moved: boolean } | null>(null);
  const autoSelectModeRef = useRef(false);
  const currentPreview = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const redrawCanvasRef = useRef<() => void>(() => undefined);
  const annotationHistoryRef = useRef<AnnotationHistory[]>([]);

  useEffect(() => {
    if (drawingTool === 'text') annotationInputRef.current?.focus();
  }, [drawingTool]);

  const allAnnotations = useMemo<ChartAnnotation[]>(
    () => toAnnotations(drawnRects, drawnLines, drawnHorizontals, drawnArrows, drawnTexts),
    [drawnRects, drawnLines, drawnHorizontals, drawnArrows, drawnTexts],
  );
  const activeToolGuidance = TOOL_GUIDANCE[drawingTool];
  const isShapeToolActive = SHAPE_DRAWING_TOOLS.includes(drawingTool as ShapeDrawingTool);

  const stopDrawing = () => {
    setDrawingTool('none'); setShowDrawingTools(false);
    setAnnotationText(''); drawStart.current = null; currentPreview.current = null;
    redrawCanvasRef.current();
  };
  const activateDrawingTool = (tool: DrawingTool) => {
    const turningOff = drawingTool === tool;
    setDrawingTool(turningOff ? 'none' : tool);
    setShowDrawingTools(!turningOff && SHAPE_DRAWING_TOOLS.includes(tool as ShapeDrawingTool));
    setSelectedAnnotationId('');
    setPlacingTrade(false); setEntryDraft(null);
  };
  const pushAnnotationHistory = () => {
    annotationHistoryRef.current = [...annotationHistoryRef.current.slice(-19), {
      rects: drawnRects.map(i => ({ ...i })), lines: drawnLines.map(i => ({ ...i })),
      horizontals: drawnHorizontals.map(i => ({ ...i })), arrows: drawnArrows.map(i => ({ ...i })),
      texts: drawnTexts.map(i => ({ ...i })),
    }];
    setAnnotationHistoryDepth(annotationHistoryRef.current.length);
  };
  const undoAnnotation = () => {
    const last = annotationHistoryRef.current[annotationHistoryRef.current.length - 1];
    if (!last) return;
    annotationHistoryRef.current = annotationHistoryRef.current.slice(0, -1);
    setAnnotationHistoryDepth(annotationHistoryRef.current.length);
    setDrawnRects(last.rects); setDrawnLines(last.lines); setDrawnHorizontals(last.horizontals);
    setDrawnArrows(last.arrows); setDrawnTexts(last.texts);
    setSelectedAnnotationId('');
  };
  const deleteAnnotation = (annotation: ChartAnnotation) => {
    pushAnnotationHistory();
    if (annotation.type === 'rect') setDrawnRects(cur => cur.filter(i => i.id !== annotation.id));
    else if (annotation.type === 'line') setDrawnLines(cur => cur.filter(i => i.id !== annotation.id));
    else if (annotation.type === 'horizontal') setDrawnHorizontals(cur => cur.filter(i => i.id !== annotation.id));
    else if (annotation.type === 'arrow') setDrawnArrows(cur => cur.filter(i => i.id !== annotation.id));
    else setDrawnTexts(cur => cur.filter(i => i.id !== annotation.id));
    if (selectedAnnotationId === annotation.id) setSelectedAnnotationId('');
  };
  const deleteSelectedAnnotation = () => {
    const found = allAnnotations.find(a => a.id === selectedAnnotationId);
    if (found) deleteAnnotation(found);
  };
  const closeAnnotationEditor = () => setEditingAnnotation(null);
  const deleteEditingAnnotation = () => {
    if (!editingAnnotation) return;
    deleteAnnotation(editingAnnotation.annotation);
    setEditingAnnotation(null);
  };
  const applyAnnotationEdit = () => {
    if (!editingAnnotation) return;
    const { annotation } = editingAnnotation;
    pushAnnotationHistory();
    const patch = { color: annotationEditDraft.color };
    if (annotation.type === 'text') setDrawnTexts(cur => cur.map(i => i.id === annotation.id ? { ...i, ...patch, text: annotationEditDraft.text.trim().slice(0, 80) || i.text } : i));
    else if (annotation.type === 'horizontal') setDrawnHorizontals(cur => cur.map(i => i.id === annotation.id ? { ...i, ...patch, lineStyle: annotationEditDraft.lineStyle } : i));
    else if (annotation.type === 'line') setDrawnLines(cur => cur.map(i => i.id === annotation.id ? { ...i, ...patch, lineStyle: annotationEditDraft.lineStyle } : i));
    else if (annotation.type === 'arrow') setDrawnArrows(cur => cur.map(i => i.id === annotation.id ? { ...i, ...patch, lineStyle: annotationEditDraft.lineStyle } : i));
    else if (annotation.type === 'rect') setDrawnRects(cur => cur.map(i => i.id === annotation.id ? { ...i, ...patch } : i));
    setEditingAnnotation(null);
  };
  const clearAnnotations = () => {
    if (!window.confirm('Remove every annotation from this chart?')) return;
    pushAnnotationHistory();
    setDrawnRects([]); setDrawnLines([]); setDrawnHorizontals([]); setDrawnArrows([]); setDrawnTexts([]);
    setSelectedAnnotationId(''); setShowAnnotationList(false);
  };

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
    setOpenTrade(null); setClosedTrade(null); setPlacingTrade(false); setEntryDraft(null);
    fetch(`${API}/backtest-trades/chart?symbol=${encodeURIComponent(trimmed)}&interval=${overrideInterval}&fromMs=${fromMs}&toMs=${toMs}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) { setError(data.error || 'Failed to load chart data'); setIsSetupError(Boolean(data.setup)); setLoading(false); return; }
        const loaded = (data.candles || []).map((c: Candle) => ({ ...c, time: Number(c.time) as UTCTimestamp }));
        setCandles(loaded);
        setReplayIdx(Math.min(loaded.length - 1, 40));
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

  // ── Chart creation ──────────────────────────────────────────────────────
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
    const syncCanvas = () => { if (canvasRef.current) { canvasRef.current.width = el.clientWidth; canvasRef.current.height = el.clientHeight; } };
    syncCanvas();
    const redrawAnnotations = () => requestAnimationFrame(() => redrawCanvasRef.current());
    const ro = new ResizeObserver(() => { chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }); syncCanvas(); redrawAnnotations(); });
    ro.observe(el);
    chart.timeScale().subscribeVisibleTimeRangeChange(redrawAnnotations);
    return () => { ro.disconnect(); chart.timeScale().unsubscribeVisibleTimeRangeChange(redrawAnnotations); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, [candles, resolvedTheme]);

  // ── Progressive reveal: only candles up to replayIdx are ever shown ─────
  useEffect(() => {
    if (!candles || !seriesRef.current) return;
    seriesRef.current.setData(candles.slice(0, replayIdx + 1));
  }, [candles, replayIdx]);

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
  const cancelTrade = () => { setOpenTrade(null); setClosedTrade(null); setNotes(''); };
  const discardClosedTrade = () => { setOpenTrade(null); setClosedTrade(null); setNotes(''); };

  const armTrade = () => {
    if (!entryDraft) return;
    const stopLoss = Number(draftStopLoss);
    const takeProfit = draftTakeProfit.trim() === '' ? null : Number(draftTakeProfit);
    const riskAmount = Number(draftRisk) || 0;
    if (!Number.isFinite(stopLoss)) { alert('Enter a stop loss price.'); return; }
    if (draftDirection === 'long' && stopLoss >= entryDraft.price) { alert('For a long, the stop loss must be below your entry price.'); return; }
    if (draftDirection === 'short' && stopLoss <= entryDraft.price) { alert('For a short, the stop loss must be above your entry price.'); return; }
    if (takeProfit != null) {
      if (draftDirection === 'long' && takeProfit <= entryDraft.price) { alert('For a long, take profit must be above your entry price.'); return; }
      if (draftDirection === 'short' && takeProfit >= entryDraft.price) { alert('For a short, take profit must be below your entry price.'); return; }
    }
    setOpenTrade({ direction: draftDirection, entryTime: entryDraft.time, entryPrice: entryDraft.price, stopLoss, takeProfit, riskAmount });
    setEntryDraft(null); setPlacingTrade(false);
    setDraftStopLoss(''); setDraftTakeProfit('');
  };

  const saveBacktestTrade = async () => {
    if (!closedTrade) return;
    const token = localStorage.getItem('token'); if (!token) return;
    setSaving(true); setSaveError('');
    try {
      const res = await fetch(`${API}/backtest-trades`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          symbol: symbol.trim(), interval,
          direction: closedTrade.direction,
          entryTime: closedTrade.entryTime, entryPrice: closedTrade.entryPrice,
          exitTime: closedTrade.exitTime, exitPrice: closedTrade.exitPrice,
          stopLoss: closedTrade.stopLoss, takeProfit: closedTrade.takeProfit,
          outcome: closedTrade.outcome, riskAmount: closedTrade.riskAmount,
          pnlUSD: closedTrade.pnlUSD, rMultiple: closedTrade.rMultiple,
          notes, chartAnnotations: allAnnotations,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not save backtest trade');
      setOpenTrade(null); setClosedTrade(null); setNotes('');
      onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save backtest trade');
    } finally {
      setSaving(false);
    }
  };

  // ── Canvas redraw: freehand annotations + the trade-simulation lines ────
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current, chart = chartRef.current, series = seriesRef.current;
    if (!canvas || !chart || !series) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const revealedTime = Number(candles?.[replayIdx]?.time ?? Number.POSITIVE_INFINITY);
    const selected = (id: string) => id === selectedAnnotationId;
    const drawSelection = (x: number, y: number, width: number, height: number) => {
      ctx.save(); ctx.strokeStyle = resolvedTheme === 'dark' ? '#f8fafc' : '#0f172a'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.strokeRect(x - 4, y - 4, width + 8, height + 8); ctx.restore();
    };
    const drawArrowHead = (x1: number, y1: number, x2: number, y2: number, color: string) => {
      const angle = Math.atan2(y2 - y1, x2 - x1); const size = 10;
      ctx.save(); ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6));
      ctx.closePath(); ctx.fill(); ctx.restore();
    };
    for (const r of drawnRects) {
      if (Math.max(r.time1, r.time2) > revealedTime) continue;
      const x1 = chart.timeScale().timeToCoordinate(r.time1 as UTCTimestamp);
      const x2 = chart.timeScale().timeToCoordinate(r.time2 as UTCTimestamp);
      const y1 = series.priceToCoordinate(r.price1); const y2 = series.priceToCoordinate(r.price2);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      ctx.save(); ctx.strokeStyle = r.color; ctx.fillStyle = r.color + '22'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.fill(); ctx.stroke(); ctx.restore();
      if (selected(r.id)) drawSelection(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    }
    for (const line of drawnLines) {
      if (Math.max(line.time1, line.time2) > revealedTime) continue;
      const x1 = chart.timeScale().timeToCoordinate(line.time1 as UTCTimestamp);
      const x2 = chart.timeScale().timeToCoordinate(line.time2 as UTCTimestamp);
      const y1 = series.priceToCoordinate(line.price1); const y2 = series.priceToCoordinate(line.price2);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      ctx.save(); ctx.strokeStyle = line.color; ctx.lineWidth = 2; ctx.setLineDash(line.lineStyle === 'dashed' ? [7, 4] : []); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
      if (selected(line.id)) drawSelection(Math.min(x1, x2), Math.min(y1, y2), Math.max(2, Math.abs(x2 - x1)), Math.max(2, Math.abs(y2 - y1)));
    }
    for (const level of drawnHorizontals) {
      if (level.time > revealedTime) continue;
      const x = chart.timeScale().timeToCoordinate(level.time as UTCTimestamp); const y = series.priceToCoordinate(level.price);
      if (x == null || y == null) continue;
      ctx.save(); ctx.strokeStyle = level.color; ctx.lineWidth = 1.5; ctx.setLineDash(level.lineStyle === 'solid' ? [] : [7, 4]);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(canvas.width, y); ctx.stroke();
      ctx.fillStyle = level.color; ctx.font = '700 10px sans-serif'; ctx.fillText(level.price.toFixed(2), x + 6, y - 6); ctx.restore();
      if (selected(level.id)) drawSelection(x, y - 2, Math.max(2, canvas.width - x), 4);
    }
    for (const arrow of drawnArrows) {
      if (Math.max(arrow.time1, arrow.time2) > revealedTime) continue;
      const x1 = chart.timeScale().timeToCoordinate(arrow.time1 as UTCTimestamp);
      const x2 = chart.timeScale().timeToCoordinate(arrow.time2 as UTCTimestamp);
      const y1 = series.priceToCoordinate(arrow.price1); const y2 = series.priceToCoordinate(arrow.price2);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      ctx.save(); ctx.strokeStyle = arrow.color; ctx.lineWidth = 2.5; ctx.setLineDash(arrow.lineStyle === 'dashed' ? [7, 4] : []); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
      drawArrowHead(x1, y1, x2, y2, arrow.color);
      if (selected(arrow.id)) drawSelection(Math.min(x1, x2), Math.min(y1, y2), Math.max(2, Math.abs(x2 - x1)), Math.max(2, Math.abs(y2 - y1)));
    }
    for (const note of drawnTexts) {
      if (note.time > revealedTime) continue;
      const x = chart.timeScale().timeToCoordinate(note.time as UTCTimestamp);
      const y = series.priceToCoordinate(note.price);
      if (x == null || y == null) continue;
      ctx.save(); ctx.font = '600 12px sans-serif';
      const width = ctx.measureText(note.text).width;
      ctx.fillStyle = resolvedTheme === 'dark' ? '#0a0d14dd' : '#ffffffee'; ctx.fillRect(x - 5, y - 17, width + 10, 23);
      ctx.strokeStyle = note.color; ctx.strokeRect(x - 5, y - 17, width + 10, 23);
      ctx.fillStyle = note.color; ctx.fillText(note.text, x, y); ctx.restore();
      if (selected(note.id)) drawSelection(x - 5, y - 17, width + 10, 23);
    }
    if (currentPreview.current) {
      const { x1, y1, x2, y2 } = currentPreview.current;
      ctx.save(); ctx.strokeStyle = rectColor; ctx.fillStyle = rectColor + '18'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
      ctx.beginPath();
      if (drawingTool === 'line' || drawingTool === 'arrow') { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); if (drawingTool === 'arrow') drawArrowHead(x1, y1, x2, y2, rectColor); }
      else { ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); ctx.fill(); ctx.stroke(); }
      ctx.restore();
    }

    // ── Trade simulation overlay: entry / SL / TP / exit ─────────────────
    const trade = closedTrade || openTrade;
    if (trade) {
      const drawLevel = (price: number, color: string, label: string, dashed: boolean) => {
        const y = series.priceToCoordinate(price); if (y == null) return;
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dashed ? [6, 4] : []);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = color; ctx.font = '700 10px sans-serif';
        ctx.fillText(`${label} ${fmtPrice(price)}`, 6, y - 6); ctx.restore();
      };
      drawLevel(trade.entryPrice, '#d4af37', 'Entry', false);
      drawLevel(trade.stopLoss, '#ef4444', 'SL', true);
      if (trade.takeProfit != null) drawLevel(trade.takeProfit, '#10b981', 'TP', true);
      const entryX = chart.timeScale().timeToCoordinate(trade.entryTime as UTCTimestamp);
      if (entryX != null) {
        ctx.save(); ctx.strokeStyle = '#d4af3799'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(entryX, 0); ctx.lineTo(entryX, canvas.height); ctx.stroke(); ctx.restore();
      }
      if (closedTrade) {
        const exitX = chart.timeScale().timeToCoordinate(closedTrade.exitTime as UTCTimestamp);
        const exitY = series.priceToCoordinate(closedTrade.exitPrice);
        if (exitX != null && exitY != null) {
          ctx.save();
          ctx.fillStyle = closedTrade.outcome === 'win' ? '#10b981' : closedTrade.outcome === 'loss' ? '#ef4444' : '#94a3b8';
          ctx.beginPath(); ctx.arc(exitX, exitY, 5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        }
      }
    }
  }, [candles, replayIdx, drawingTool, drawnArrows, drawnHorizontals, drawnLines, drawnRects, drawnTexts, rectColor, resolvedTheme, selectedAnnotationId, openTrade, closedTrade]);

  useEffect(() => { redrawCanvasRef.current = redrawCanvas; redrawCanvas(); }, [redrawCanvas]);

  const findAnnotationAt = (x: number, y: number) => {
    const chart = chartRef.current, series = seriesRef.current, canvas = canvasRef.current;
    if (!chart || !series || !canvas) return null;
    const distanceToSegment = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
      const dx = x2 - x1, dy = y2 - y1; if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    };
    for (const annotation of [...allAnnotations].reverse()) {
      if (annotation.type === 'text' || annotation.type === 'horizontal') {
        const ax = chart.timeScale().timeToCoordinate(annotation.time as UTCTimestamp); const ay = series.priceToCoordinate(annotation.price);
        if (ax == null || ay == null) continue;
        if (annotation.type === 'horizontal' && x >= ax - 8 && Math.abs(y - ay) <= 8) return annotation;
        if (annotation.type === 'text') {
          const ctx = canvas.getContext('2d'); if (!ctx) continue; ctx.font = '600 12px sans-serif'; const width = ctx.measureText(annotation.text).width;
          if (x >= ax - 9 && x <= ax + width + 9 && y >= ay - 21 && y <= ay + 7) return annotation;
        }
        continue;
      }
      const x1 = chart.timeScale().timeToCoordinate(annotation.time1 as UTCTimestamp); const x2 = chart.timeScale().timeToCoordinate(annotation.time2 as UTCTimestamp);
      const y1 = series.priceToCoordinate(annotation.price1); const y2 = series.priceToCoordinate(annotation.price2);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      if (annotation.type === 'rect') {
        const left = Math.min(x1, x2), right = Math.max(x1, x2), top = Math.min(y1, y2), bottom = Math.max(y1, y2);
        if (x >= left - 7 && x <= right + 7 && y >= top - 7 && y <= bottom + 7) return annotation;
      } else if (distanceToSegment(x, y, x1, y1, x2, y2) <= 9) return annotation;
    }
    return null;
  };

  const beginAnnotationInteraction = (x: number, y: number) => {
    const hit = findAnnotationAt(x, y);
    setSelectedAnnotationId(hit?.id || '');
    const chart = chartRef.current, series = seriesRef.current;
    if (hit && chart && series) {
      const originTime = chart.timeScale().coordinateToTime(x);
      const originPrice = series.coordinateToPrice(y);
      if (originTime != null && originPrice != null) {
        movingAnnotationRef.current = { annotation: hit, startX: x, startY: y, originTime: Number(originTime), originPrice, moved: false };
      }
    }
    return hit;
  };
  const openAnnotationEditor = (annotation: ChartAnnotation, anchorX: number, anchorY: number) => {
    setEditingAnnotation({ annotation, anchorX, anchorY });
    setAnnotationEditDraft({
      text: annotation.type === 'text' ? annotation.text : '',
      color: annotation.color,
      lineStyle: (annotation.type === 'line' || annotation.type === 'arrow' || annotation.type === 'horizontal')
        ? (annotation.lineStyle || (annotation.type === 'horizontal' ? 'dashed' : 'solid'))
        : 'solid',
    });
  };
  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (editingAnnotation) setEditingAnnotation(null);
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (placingTrade) {
      const chart = chartRef.current, series = seriesRef.current; if (!chart || !series) return;
      const time = chart.timeScale().coordinateToTime(x); const price = series.coordinateToPrice(y);
      if (time == null || price == null) return;
      setEntryDraft({ time: Number(time), price });
      return;
    }
    if (drawingTool === 'none') {
      const hit = beginAnnotationInteraction(x, y);
      if (hit) { autoSelectModeRef.current = true; setDrawingTool('select'); }
      return;
    }
    if (drawingTool === 'select') { beginAnnotationInteraction(x, y); return; }
    if (drawingTool === 'horizontal') {
      const chart = chartRef.current, series = seriesRef.current; if (!chart || !series) return;
      const time = chart.timeScale().coordinateToTime(x); const price = series.coordinateToPrice(y);
      if (time == null || price == null) return;
      pushAnnotationHistory(); setSelectedAnnotationId('');
      setDrawnHorizontals(current => [...current, { id: `horizontal-${Date.now()}`, time: Number(time), price, color: rectColor }]);
      setDrawingTool('none'); setShowDrawingTools(false);
      return;
    }
    if (drawingTool === 'text') {
      const chart = chartRef.current, series = seriesRef.current;
      const text = annotationText.trim();
      if (!chart || !series || !text) return;
      const time = chart.timeScale().coordinateToTime(x); const price = series.coordinateToPrice(y);
      if (time != null && price != null) {
        pushAnnotationHistory();
        setDrawnTexts(current => [...current, { id: `text-${Date.now()}`, time: time as number, price, text: text.slice(0, 80), color: rectColor }]);
        setAnnotationText(''); setDrawingTool('none');
      }
      return;
    }
    drawStart.current = { x, y };
  };
  const applyAnnotationDelta = (original: ChartAnnotation, deltaTime: number, deltaPrice: number) => {
    const id = original.id;
    if (original.type === 'rect' || original.type === 'line' || original.type === 'arrow') {
      const updated = { ...original, time1: original.time1 + deltaTime, time2: original.time2 + deltaTime, price1: original.price1 + deltaPrice, price2: original.price2 + deltaPrice };
      if (original.type === 'rect') setDrawnRects(cur => cur.map(item => item.id === id ? updated as DrawnRect : item));
      if (original.type === 'line') setDrawnLines(cur => cur.map(item => item.id === id ? updated as DrawnLine : item));
      if (original.type === 'arrow') setDrawnArrows(cur => cur.map(item => item.id === id ? updated as DrawnArrow : item));
    } else {
      const updated = { ...original, time: original.time + deltaTime, price: original.price + deltaPrice };
      if (original.type === 'horizontal') setDrawnHorizontals(cur => cur.map(item => item.id === id ? updated as DrawnHorizontal : item));
      if (original.type === 'text') setDrawnTexts(cur => cur.map(item => item.id === id ? updated as DrawnText : item));
    }
  };
  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (drawingTool === 'select' && movingAnnotationRef.current) {
      const move = movingAnnotationRef.current;
      const chart = chartRef.current, series = seriesRef.current;
      if (!chart || !series) return;
      const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (!move.moved && Math.hypot(x - move.startX, y - move.startY) < 3) return;
      if (!move.moved) { move.moved = true; pushAnnotationHistory(); }
      const time = chart.timeScale().coordinateToTime(x);
      const price = series.coordinateToPrice(y);
      if (time == null || price == null) return;
      applyAnnotationDelta(move.annotation, Number(time) - move.originTime, price - move.originPrice);
      return;
    }
    if (!['rect', 'line', 'arrow'].includes(drawingTool) || !drawStart.current) return;
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    currentPreview.current = { x1: drawStart.current.x, y1: drawStart.current.y, x2: e.clientX - r.left, y2: e.clientY - r.top };
    redrawCanvas();
  };
  const endAutoSelectMode = () => {
    if (!autoSelectModeRef.current) return;
    autoSelectModeRef.current = false; setDrawingTool('none'); setHoveredAnnotationId('');
  };
  const handleCanvasMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (movingAnnotationRef.current) {
      const move = movingAnnotationRef.current;
      movingAnnotationRef.current = null;
      if (!move.moved) openAnnotationEditor(move.annotation, move.startX, move.startY);
      endAutoSelectMode();
      return;
    }
    if (!['rect', 'line', 'arrow'].includes(drawingTool) || !drawStart.current) return;
    const canvas = canvasRef.current, chart = chartRef.current, series = seriesRef.current;
    if (!canvas || !chart || !series) return;
    const r = canvas.getBoundingClientRect(); const x2 = e.clientX - r.left; const y2 = e.clientY - r.top;
    let placed = false;
    if (Math.hypot(x2 - drawStart.current.x, y2 - drawStart.current.y) > 6) {
      const t1 = chart.timeScale().coordinateToTime(drawStart.current.x);
      const t2 = chart.timeScale().coordinateToTime(x2);
      const p1 = series.coordinateToPrice(drawStart.current.y);
      const p2 = series.coordinateToPrice(y2);
      if (t1 != null && t2 != null && p1 != null && p2 != null) {
        pushAnnotationHistory();
        const shape = { id: `${drawingTool}-${Date.now()}`, time1: t1 as number, time2: t2 as number, price1: p1, price2: p2, color: rectColor };
        if (drawingTool === 'line') setDrawnLines(prev => [...prev, shape]);
        else if (drawingTool === 'arrow') setDrawnArrows(prev => [...prev, shape]);
        else setDrawnRects(prev => [...prev, shape]);
        placed = true;
      }
    }
    drawStart.current = null; currentPreview.current = null; redrawCanvas();
    if (placed) { setDrawingTool('none'); setShowDrawingTools(false); }
  };
  const handleChartWrapHoverMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (drawingTool !== 'none' || movingAnnotationRef.current || placingTrade) return;
    const canvas = canvasRef.current; if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const hit = findAnnotationAt(e.clientX - r.left, e.clientY - r.top);
    setHoveredAnnotationId(hit?.id || '');
  };
  const handleChartWrapMouseLeave = () => { if (drawingTool === 'none') setHoveredAnnotationId(''); };

  const totalCandles = candles?.length ?? 1;
  const progressPct = ((replayIdx + 1) / totalCandles) * 100;

  return (
    <div className="card" style={{ padding: 0, marginBottom: 16, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, padding: 14, borderBottom: '1px solid var(--border)' }}>
        <label>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Symbol</span>
          <input type="text" value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="e.g. XAUUSD" style={{ width: '100%', minHeight: 36, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }} />
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
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Timeframe</span>
          <select value={interval} onChange={e => setInterval_(e.target.value)} style={{ width: '100%', minHeight: 36, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }}>
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
          <div className="replay-workspace-toolbar" aria-label="Backtest chart tools">
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
                <button type="button" aria-pressed={placingTrade} className={`replay-tool-btn replay-tool-primary${placingTrade ? ' active' : ''}`} onClick={() => { setPlacingTrade(p => !p); setEntryDraft(null); setDrawingTool('none'); }} title="Click the chart to mark a hypothetical entry">
                  <Crosshair size={16} /> Place Trade
                </button>
              )}
              {openTrade && !closedTrade && (
                <>
                  <span className={`badge ${openTrade.direction === 'long' ? 'buy' : 'sell'}`} style={{ marginRight: 6 }}>{openTrade.direction === 'long' ? 'LONG' : 'SHORT'} @ {fmtPrice(openTrade.entryPrice)}</span>
                  <button type="button" className="replay-tool-btn" onClick={closeTradeNow} title="Close using the current candle's price"><CloseIcon size={16} /> Close Now</button>
                  <button type="button" className="replay-tool-btn replay-delete-tool" onClick={cancelTrade} title="Discard this hypothetical trade">Cancel</button>
                </>
              )}
            </div>
            <div className="replay-toolbar-divider" />
            <div className="replay-tool-group">
              <span className="replay-tool-group-label">Document</span>
              <button type="button" aria-pressed={drawingTool === 'text'} className={`replay-tool-btn${drawingTool === 'text' ? ' active' : ''}`} onClick={() => activateDrawingTool('text')} title="Write directly on the chart"><TypeIcon size={16} /> Text</button>
              <button type="button" aria-expanded={showDrawingTools} aria-controls="backtest-drawing-tray" aria-pressed={isShapeToolActive} className={`replay-tool-btn${isShapeToolActive || showDrawingTools ? ' active' : ''}`} onClick={() => setShowDrawingTools(current => !current)} title="Open drawing tools"><Square size={16} /> {isShapeToolActive ? TOOL_GUIDANCE[drawingTool]?.label : 'Draw'} <ChevronDown size={14} /></button>
            </div>
            <span className="replay-toolbar-spacer" />
            <div className="replay-tool-group replay-tool-actions">
              <button type="button" aria-pressed={drawingTool === 'select'} className={`replay-tool-btn${drawingTool === 'select' ? ' active' : ''}`} onClick={() => activateDrawingTool('select')} title="Drag an annotation to move it, click it to edit"><MousePointer2 size={16} /> Select</button>
              <button type="button" className="replay-tool-btn" disabled={annotationHistoryDepth === 0} onClick={undoAnnotation} title="Undo the last annotation change"><Undo2 size={16} /> Undo</button>
              <button type="button" className="replay-tool-btn replay-delete-tool" disabled={!selectedAnnotationId} onClick={deleteSelectedAnnotation} title="Delete the selected annotation"><Trash2 size={16} /> Delete</button>
              {allAnnotations.length > 0 && <button type="button" aria-pressed={showAnnotationList} className={`replay-tool-btn${showAnnotationList ? ' active' : ''}`} title="Manage saved annotations" onClick={() => setShowAnnotationList(current => !current)}>Objects ({allAnnotations.length})</button>}
            </div>
          </div>

          {showDrawingTools && (
            <div id="backtest-drawing-tray" className="replay-drawing-tray" aria-label="Drawing tools">
              <div className="replay-tool-group">
                <span className="replay-tool-group-label">Drawing</span>
                <button type="button" aria-pressed={drawingTool === 'horizontal'} className={`replay-tool-btn${drawingTool === 'horizontal' ? ' active' : ''}`} onClick={() => activateDrawingTool('horizontal')}><MoveHorizontal size={16} /> Price level</button>
                <button type="button" aria-pressed={drawingTool === 'arrow'} className={`replay-tool-btn${drawingTool === 'arrow' ? ' active' : ''}`} onClick={() => activateDrawingTool('arrow')}><ArrowUpRight size={16} /> Arrow</button>
                <button type="button" aria-pressed={drawingTool === 'line'} className={`replay-tool-btn${drawingTool === 'line' ? ' active' : ''}`} onClick={() => activateDrawingTool('line')}>Trend line</button>
                <button type="button" aria-pressed={drawingTool === 'rect'} className={`replay-tool-btn${drawingTool === 'rect' ? ' active' : ''}`} onClick={() => activateDrawingTool('rect')}>Zone</button>
              </div>
              <div className="replay-toolbar-divider" />
              <div className="replay-tool-group replay-color-group" role="group" aria-label="Drawing color">
                <span className="replay-tool-group-label">Color</span>
                {DRAWING_COLORS.map(color => <button type="button" key={color.value} aria-label={`Use ${color.label.toLowerCase()} drawing color`} title={color.label} aria-pressed={color.value === rectColor} className={color.value === rectColor ? 'active' : ''} onClick={() => setRectColor(color.value)} style={{ '--replay-swatch': color.value } as React.CSSProperties} />)}
              </div>
              <button type="button" className="replay-tool-tray-close" onClick={() => setShowDrawingTools(false)} aria-label="Close drawing tools"><X size={16} /></button>
            </div>
          )}

          {activeToolGuidance && (
            <div className="replay-active-tool" role="status">
              <strong>{activeToolGuidance.label}</strong>
              <span>{activeToolGuidance.instruction}</span>
              <button type="button" onClick={stopDrawing}>Cancel</button>
            </div>
          )}
          {placingTrade && !entryDraft && (
            <div className="replay-active-tool" role="status">
              <strong>Place Trade</strong>
              <span>Click the chart at the price and candle where you would have entered.</span>
              <button type="button" onClick={() => setPlacingTrade(false)}>Cancel</button>
            </div>
          )}

          <div className="replay-chart-wrap" style={{ height: 440, position: 'relative' }} onMouseMove={handleChartWrapHoverMove} onMouseLeave={handleChartWrapMouseLeave}>
            <div ref={chartContainerRef} className="replay-chart-container" />

            {entryDraft && (
              <div className="replay-chart-image-placer" role="dialog" aria-label="Confirm trade entry" style={{ maxWidth: 320 }}>
                <div style={{ display: 'grid', gap: 8, width: '100%' }}>
                  <strong>Entry @ {fmtPrice(entryDraft.price)}</strong>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className={`replay-ctrl-btn${draftDirection === 'long' ? ' active' : ''}`} onClick={() => setDraftDirection('long')}>Long</button>
                    <button type="button" className={`replay-ctrl-btn${draftDirection === 'short' ? ' active' : ''}`} onClick={() => setDraftDirection('short')}>Short</button>
                  </div>
                  <input aria-label="Stop loss price" type="number" step="any" placeholder="Stop loss price" value={draftStopLoss} onChange={e => setDraftStopLoss(e.target.value)} />
                  <input aria-label="Take profit price (optional)" type="number" step="any" placeholder="Take profit price (optional)" value={draftTakeProfit} onChange={e => setDraftTakeProfit(e.target.value)} />
                  <input aria-label="Risk amount in dollars" type="number" step="any" placeholder="Risk amount ($)" value={draftRisk} onChange={e => setDraftRisk(e.target.value)} />
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button type="button" onClick={() => { setEntryDraft(null); setPlacingTrade(false); }}>Cancel</button>
                    <button type="button" className="primary" onClick={armTrade}>Arm Trade</button>
                  </div>
                </div>
              </div>
            )}

            {drawingTool === 'text' && (
              <div className="replay-chart-text-editor" role="group" aria-label="Write on chart">
                <TypeIcon size={15} />
                <input ref={annotationInputRef} aria-label="Text to place on chart" placeholder="Write a note…" maxLength={80} value={annotationText} onChange={event => setAnnotationText(event.target.value)} />
                <span>{annotationText.trim() ? 'Click the chart to place it' : 'Type your note first'}</span>
              </div>
            )}
            {showAnnotationList && allAnnotations.length > 0 && (
              <div className="replay-annotation-manager" aria-label="Chart annotations">
                <div className="replay-annotation-manager-head"><strong>Saved annotations</strong><button type="button" onClick={clearAnnotations}>Clear all</button></div>
                {allAnnotations.map((annotation, index) => (
                  <div className={`replay-annotation-row${selectedAnnotationId === annotation.id ? ' selected' : ''}`} key={annotation.id}>
                    <button type="button" className="replay-annotation-select" aria-pressed={selectedAnnotationId === annotation.id} onClick={() => { setSelectedAnnotationId(annotation.id); setShowDrawingTools(false); setDrawingTool('select'); }}>
                      <i style={{ background: annotation.color }} />
                      <span><b>{annotation.type === 'rect' ? 'Zone' : annotation.type === 'line' ? 'Trend line' : annotation.type === 'horizontal' ? 'Level' : annotation.type === 'arrow' ? 'Arrow' : 'Text'}</b>{annotation.type === 'text' ? ` — ${annotation.text}` : ` ${index + 1}`}</span>
                    </button>
                    <button type="button" onClick={click => { click.stopPropagation(); deleteAnnotation(annotation); }} aria-label={`Delete ${annotation.type} annotation`}><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
            )}
            {editingAnnotation && (() => {
              const canvas = canvasRef.current;
              const maxLeft = (canvas?.clientWidth ?? 900) - 240;
              const maxTop = (canvas?.clientHeight ?? 440) - 260;
              const left = Math.max(8, Math.min(editingAnnotation.anchorX + 10, maxLeft));
              const top = Math.max(8, Math.min(editingAnnotation.anchorY + 10, maxTop));
              const a = editingAnnotation.annotation;
              const typeLabel = a.type === 'text' ? 'Text note' : a.type === 'horizontal' ? 'Price level' : a.type === 'arrow' ? 'Arrow' : a.type === 'line' ? 'Trend line' : 'Zone';
              return (
                <div className="replay-annotation-editor" role="dialog" aria-label={`Edit ${typeLabel}`} style={{ left, top }}>
                  <div className="replay-annotation-editor-head"><strong>{typeLabel}</strong><button type="button" onClick={closeAnnotationEditor} aria-label="Close editor">×</button></div>
                  {a.type === 'text' && <label>Text<input maxLength={80} value={annotationEditDraft.text} onChange={event => setAnnotationEditDraft(cur => ({ ...cur, text: event.target.value }))} autoFocus /></label>}
                  <div className="replay-annotation-editor-colors" role="group" aria-label="Color">
                    {DRAWING_COLORS.map(color => (
                      <button type="button" key={color.value} title={color.label} aria-label={color.label} aria-pressed={annotationEditDraft.color === color.value}
                        className={annotationEditDraft.color === color.value ? 'active' : ''}
                        onClick={() => setAnnotationEditDraft(cur => ({ ...cur, color: color.value }))}
                        style={{ '--replay-swatch': color.value } as React.CSSProperties} />
                    ))}
                  </div>
                  {(a.type === 'line' || a.type === 'arrow' || a.type === 'horizontal') && (
                    <div className="replay-annotation-editor-linestyle" role="group" aria-label="Line style">
                      <button type="button" aria-pressed={annotationEditDraft.lineStyle === 'solid'} className={annotationEditDraft.lineStyle === 'solid' ? 'active' : ''} onClick={() => setAnnotationEditDraft(cur => ({ ...cur, lineStyle: 'solid' }))}>Solid</button>
                      <button type="button" aria-pressed={annotationEditDraft.lineStyle === 'dashed'} className={annotationEditDraft.lineStyle === 'dashed' ? 'active' : ''} onClick={() => setAnnotationEditDraft(cur => ({ ...cur, lineStyle: 'dashed' }))}>Dashed</button>
                    </div>
                  )}
                  <div className="replay-annotation-editor-actions">
                    <button type="button" className="replay-annotation-editor-delete" onClick={deleteEditingAnnotation}><Trash2 size={13} /> Delete</button>
                    <button type="button" className="primary" onClick={applyAnnotationEdit}>Save</button>
                  </div>
                </div>
              );
            })()}
            <canvas ref={canvasRef}
              className={`replay-canvas-overlay${drawingTool !== 'none' || placingTrade ? ' drawing-active' : ''}${drawingTool === 'select' ? ' selecting' : ''}${drawingTool === 'none' && hoveredAnnotationId ? ' idle-hover' : ''}`}
              aria-label={drawingTool === 'select' ? 'Select a chart annotation' : 'Place a chart annotation'}
              onMouseDown={handleCanvasMouseDown} onMouseMove={handleCanvasMouseMove} onMouseUp={handleCanvasMouseUp}
              onMouseLeave={() => { movingAnnotationRef.current = null; endAutoSelectMode(); if (drawStart.current) { drawStart.current = null; currentPreview.current = null; redrawCanvas(); } }} />
          </div>

          <div className="replay-bottombar">
            <button className="replay-ctrl-btn" disabled={replayIdx === 0} onClick={() => jumpToReplayIndex(0)} title="Reset to start"><SkipBack size={14} /></button>
            <button className="replay-ctrl-btn" disabled={replayIdx === 0} onClick={() => jumpToReplayIndex(replayIdx - 1)} title="Step back">‹</button>
            <button className={`replay-ctrl-btn play${playing ? ' is-playing' : ''}`} onClick={() => setPlaying(p => !p)} title="Play/Pause">
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button className="replay-ctrl-btn" disabled={replayIdx >= totalCandles - 1} onClick={() => jumpToReplayIndex(replayIdx + 1)} title="Step forward">›</button>
            <button className="replay-ctrl-btn" disabled={replayIdx >= totalCandles - 1} onClick={() => jumpToReplayIndex(totalCandles - 1)} title="Jump to end"><SkipForward size={14} /></button>
            <select className="replay-speed-select" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
              {SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}
            </select>
            <div className="replay-progress-wrap" style={{ flex: 1 }}>
              <div className="replay-progress-track" onClick={event => {
                const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
                const ratio = (event.clientX - rect.left) / rect.width;
                jumpToReplayIndex(Math.round(ratio * (totalCandles - 1)));
              }}>
                <div className="replay-progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
            </div>
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
        <div style={{ padding: 16, borderTop: '1px solid var(--border)', display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <span className={`badge ${closedTrade.outcome === 'win' ? 'buy' : closedTrade.outcome === 'loss' ? 'sell' : ''}`}>{closedTrade.outcome.toUpperCase()}</span>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{closedTrade.direction === 'long' ? 'Long' : 'Short'} · Entry {fmtPrice(closedTrade.entryPrice)} → Exit {fmtPrice(closedTrade.exitPrice)}</span>
            <strong style={{ fontFamily: 'var(--font-mono)' }}>{closedTrade.rMultiple >= 0 ? '+' : ''}{closedTrade.rMultiple.toFixed(2)}R</strong>
            {closedTrade.riskAmount > 0 && <strong style={{ color: closedTrade.pnlUSD >= 0 ? 'var(--green)' : 'var(--red)' }}>{closedTrade.pnlUSD >= 0 ? '+' : ''}${closedTrade.pnlUSD.toFixed(2)}</strong>}
          </div>
          <textarea className="drawer-textarea" placeholder="What was the setup? What would you do differently?" value={notes} onChange={e => setNotes(e.target.value)} />
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
