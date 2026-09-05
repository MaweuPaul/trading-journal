'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Square, Type as TypeIcon, Loader2, AlertTriangle, ExternalLink,
  Undo2, Trash2, MousePointer2, ArrowUpRight, ImagePlus, MoveHorizontal, ChevronDown, X,
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
interface DrawnImage { id: string; time: number; price: number; url: string; caption: string; screenshotId: string; color: string; }
export type ChartAnnotation =
  | (DrawnRect & { type: 'rect' }) | (DrawnLine & { type: 'line' })
  | (DrawnHorizontal & { type: 'horizontal' }) | (DrawnArrow & { type: 'arrow' })
  | (DrawnText & { type: 'text' }) | (DrawnImage & { type: 'image' });
type DrawingTool = 'none' | 'select' | 'rect' | 'line' | 'horizontal' | 'arrow' | 'text' | 'image';
type ShapeDrawingTool = Extract<DrawingTool, 'rect' | 'line' | 'horizontal' | 'arrow'>;
interface AnnotationHistory { rects: DrawnRect[]; lines: DrawnLine[]; horizontals: DrawnHorizontal[]; arrows: DrawnArrow[]; texts: DrawnText[]; images: DrawnImage[]; }

const DRAWING_COLORS = [
  { value: '#3b82f6', label: 'Blue' }, { value: '#10b981', label: 'Green' },
  { value: '#f59e0b', label: 'Amber' }, { value: '#ef4444', label: 'Red' },
  { value: '#8b5cf6', label: 'Purple' }, { value: '#ec4899', label: 'Pink' },
] as const;
const SHAPE_DRAWING_TOOLS: ShapeDrawingTool[] = ['rect', 'line', 'horizontal', 'arrow'];
const TOOL_GUIDANCE: Partial<Record<DrawingTool, { label: string; instruction: string }>> = {
  select: { label: 'Select', instruction: 'Drag an annotation to move it. Click it (without dragging) to edit its color, text, or line style.' },
  rect: { label: 'Zone', instruction: 'Drag across the chart to mark an area.' },
  line: { label: 'Trend line', instruction: 'Drag from the start point to the end point.' },
  horizontal: { label: 'Price level', instruction: 'Click once at the price you want to mark (e.g. PDH, PWL, session high).' },
  arrow: { label: 'Arrow', instruction: 'Drag to point from one place to another (e.g. a sweep or continuation).' },
  text: { label: 'Text note', instruction: 'Write the note, then click the candle and price where it belongs.' },
  image: { label: 'Chart image', instruction: 'Add a caption, then click the chart to pin the evidence.' },
};
const CHART_INTERVALS = [
  { value: '1min', label: '1m' }, { value: '5min', label: '5m' }, { value: '15min', label: '15m' },
  { value: '1h', label: '1H' }, { value: '4h', label: '4H' }, { value: '1day', label: '1D' },
] as const;

function toAnnotations(rects: DrawnRect[], lines: DrawnLine[], horizontals: DrawnHorizontal[], arrows: DrawnArrow[], texts: DrawnText[], images: DrawnImage[]): ChartAnnotation[] {
  return [
    ...rects.map(a => ({ ...a, type: 'rect' as const })),
    ...lines.map(a => ({ ...a, type: 'line' as const })),
    ...horizontals.map(a => ({ ...a, type: 'horizontal' as const })),
    ...arrows.map(a => ({ ...a, type: 'arrow' as const })),
    ...texts.map(a => ({ ...a, type: 'text' as const })),
    ...images.map(a => ({ ...a, type: 'image' as const })),
  ];
}

interface Props {
  analysisId: string;
  symbol: string;
  initialInterval?: string;
  initialAnnotations?: ChartAnnotation[];
}

export default function PreTradeChart({ analysisId, symbol, initialInterval, initialAnnotations }: Props) {
  const { resolvedTheme } = useTheme();
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const annotationInputRef = useRef<HTMLInputElement>(null);

  const [interval, setInterval_] = useState(initialInterval && CHART_INTERVALS.some(t => t.value === initialInterval) ? initialInterval : '15min');
  const [days, setDays] = useState(5);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isSetupError, setIsSetupError] = useState(false);

  const initial = initialAnnotations || [];
  const [drawingTool, setDrawingTool] = useState<DrawingTool>('none');
  const [showDrawingTools, setShowDrawingTools] = useState(false);
  const [rectColor, setRectColor] = useState<string>(DRAWING_COLORS[0].value);
  const [drawnRects, setDrawnRects] = useState<DrawnRect[]>(initial.filter(a => a.type === 'rect'));
  const [drawnLines, setDrawnLines] = useState<DrawnLine[]>(initial.filter(a => a.type === 'line'));
  const [drawnHorizontals, setDrawnHorizontals] = useState<DrawnHorizontal[]>(initial.filter(a => a.type === 'horizontal'));
  const [drawnArrows, setDrawnArrows] = useState<DrawnArrow[]>(initial.filter(a => a.type === 'arrow'));
  const [drawnTexts, setDrawnTexts] = useState<DrawnText[]>(initial.filter(a => a.type === 'text'));
  const [drawnImages, setDrawnImages] = useState<DrawnImage[]>(initial.filter(a => a.type === 'image'));
  const [selectedAnnotationId, setSelectedAnnotationId] = useState('');
  const [pendingImage, setPendingImage] = useState<Omit<DrawnImage, 'id' | 'time' | 'price' | 'color'> | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [annotationText, setAnnotationText] = useState('');
  const [showAnnotationList, setShowAnnotationList] = useState(false);
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState('');
  const [editingAnnotation, setEditingAnnotation] = useState<{ annotation: ChartAnnotation; anchorX: number; anchorY: number } | null>(null);
  const [annotationEditDraft, setAnnotationEditDraft] = useState<{ text: string; caption: string; color: string; lineStyle: AnnotationLineStyle }>({ text: '', caption: '', color: '', lineStyle: 'solid' });
  const [annotationHistoryDepth, setAnnotationHistoryDepth] = useState(0);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [saveError, setSaveError] = useState('');

  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const movingAnnotationRef = useRef<{ annotation: ChartAnnotation; startX: number; startY: number; originTime: number; originPrice: number; moved: boolean } | null>(null);
  const autoSelectModeRef = useRef(false);
  const currentPreview = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const redrawCanvasRef = useRef<() => void>(() => undefined);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const annotationHistoryRef = useRef<AnnotationHistory[]>([]);
  const baselineRef = useRef('');
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const loadedRef = useRef(false);

  useEffect(() => {
    if (drawingTool === 'text') annotationInputRef.current?.focus();
  }, [drawingTool]);

  const allAnnotations = useMemo<ChartAnnotation[]>(
    () => toAnnotations(drawnRects, drawnLines, drawnHorizontals, drawnArrows, drawnTexts, drawnImages),
    [drawnRects, drawnLines, drawnHorizontals, drawnArrows, drawnTexts, drawnImages],
  );
  const activeToolGuidance = TOOL_GUIDANCE[drawingTool];
  const isShapeToolActive = SHAPE_DRAWING_TOOLS.includes(drawingTool as ShapeDrawingTool);

  const stopDrawing = () => {
    setDrawingTool('none'); setShowDrawingTools(false); setPendingImage(null);
    setAnnotationText(''); drawStart.current = null; currentPreview.current = null;
    redrawCanvasRef.current();
  };
  const activateDrawingTool = (tool: Exclude<DrawingTool, 'image'>) => {
    const turningOff = drawingTool === tool;
    setDrawingTool(turningOff ? 'none' : tool);
    setShowDrawingTools(!turningOff && SHAPE_DRAWING_TOOLS.includes(tool as ShapeDrawingTool));
    setSelectedAnnotationId(''); setPendingImage(null);
  };
  const pushAnnotationHistory = () => {
    annotationHistoryRef.current = [...annotationHistoryRef.current.slice(-19), {
      rects: drawnRects.map(i => ({ ...i })), lines: drawnLines.map(i => ({ ...i })),
      horizontals: drawnHorizontals.map(i => ({ ...i })), arrows: drawnArrows.map(i => ({ ...i })),
      texts: drawnTexts.map(i => ({ ...i })), images: drawnImages.map(i => ({ ...i })),
    }];
    setAnnotationHistoryDepth(annotationHistoryRef.current.length);
  };
  const undoAnnotation = () => {
    const last = annotationHistoryRef.current[annotationHistoryRef.current.length - 1];
    if (!last) return;
    annotationHistoryRef.current = annotationHistoryRef.current.slice(0, -1);
    setAnnotationHistoryDepth(annotationHistoryRef.current.length);
    setDrawnRects(last.rects); setDrawnLines(last.lines); setDrawnHorizontals(last.horizontals);
    setDrawnArrows(last.arrows); setDrawnTexts(last.texts); setDrawnImages(last.images);
    setSelectedAnnotationId('');
  };
  const deleteAnnotation = (annotation: ChartAnnotation) => {
    pushAnnotationHistory();
    if (annotation.type === 'rect') setDrawnRects(cur => cur.filter(i => i.id !== annotation.id));
    else if (annotation.type === 'line') setDrawnLines(cur => cur.filter(i => i.id !== annotation.id));
    else if (annotation.type === 'horizontal') setDrawnHorizontals(cur => cur.filter(i => i.id !== annotation.id));
    else if (annotation.type === 'arrow') setDrawnArrows(cur => cur.filter(i => i.id !== annotation.id));
    else if (annotation.type === 'text') setDrawnTexts(cur => cur.filter(i => i.id !== annotation.id));
    else setDrawnImages(cur => cur.filter(i => i.id !== annotation.id));
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
    else if (annotation.type === 'image') setDrawnImages(cur => cur.map(i => i.id === annotation.id ? { ...i, ...patch, caption: annotationEditDraft.caption.trim().slice(0, 180) } : i));
    else if (annotation.type === 'horizontal') setDrawnHorizontals(cur => cur.map(i => i.id === annotation.id ? { ...i, ...patch, lineStyle: annotationEditDraft.lineStyle } : i));
    else if (annotation.type === 'line') setDrawnLines(cur => cur.map(i => i.id === annotation.id ? { ...i, ...patch, lineStyle: annotationEditDraft.lineStyle } : i));
    else if (annotation.type === 'arrow') setDrawnArrows(cur => cur.map(i => i.id === annotation.id ? { ...i, ...patch, lineStyle: annotationEditDraft.lineStyle } : i));
    else if (annotation.type === 'rect') setDrawnRects(cur => cur.map(i => i.id === annotation.id ? { ...i, ...patch } : i));
    setEditingAnnotation(null);
  };
  const clearAnnotations = () => {
    if (!window.confirm('Remove every annotation from this chart?')) return;
    pushAnnotationHistory();
    setDrawnRects([]); setDrawnLines([]); setDrawnHorizontals([]); setDrawnArrows([]); setDrawnTexts([]); setDrawnImages([]);
    setSelectedAnnotationId(''); setShowAnnotationList(false);
  };

  // ── Load candles for the current symbol/interval/days ──────────────────
  useEffect(() => {
    const trimmed = symbol.trim();
    if (!trimmed) { setCandles(null); setError(''); return; }
    const token = localStorage.getItem('token');
    if (!token) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setIsSetupError(false);
    const timer = setTimeout(() => {
      (async () => {
        try {
          const res = await fetch(`${API}/pre-trade-analyses/chart?symbol=${encodeURIComponent(trimmed)}&interval=${interval}&days=${days}`, {
            headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
          });
          const data = await res.json();
          if (!res.ok) { setError(data.error || 'Failed to load chart data'); setIsSetupError(Boolean(data.setup)); setLoading(false); return; }
          setCandles((data.candles || []).map((c: Candle) => ({ ...c, time: Number(c.time) as UTCTimestamp })));
          setLoading(false);
        } catch (e) {
          if ((e as Error).name !== 'AbortError') { setError((e as Error).message || 'Network error'); setLoading(false); }
        }
      })();
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [symbol, interval, days]);

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
    series.setData(candles);
    chart.timeScale().fitContent();
    const syncCanvas = () => { if (canvasRef.current) { canvasRef.current.width = el.clientWidth; canvasRef.current.height = el.clientHeight; } };
    syncCanvas();
    const redrawAnnotations = () => requestAnimationFrame(() => redrawCanvasRef.current());
    const ro = new ResizeObserver(() => { chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }); syncCanvas(); redrawAnnotations(); });
    ro.observe(el);
    chart.timeScale().subscribeVisibleTimeRangeChange(redrawAnnotations);
    return () => { ro.disconnect(); chart.timeScale().unsubscribeVisibleTimeRangeChange(redrawAnnotations); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, [candles, resolvedTheme]);

  // ── Canvas redraw (no reveal-gate -- everything loaded is always shown) ─
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current, chart = chartRef.current, series = seriesRef.current;
    if (!canvas || !chart || !series) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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
      const x1 = chart.timeScale().timeToCoordinate(line.time1 as UTCTimestamp);
      const x2 = chart.timeScale().timeToCoordinate(line.time2 as UTCTimestamp);
      const y1 = series.priceToCoordinate(line.price1); const y2 = series.priceToCoordinate(line.price2);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      ctx.save(); ctx.strokeStyle = line.color; ctx.lineWidth = 2; ctx.setLineDash(line.lineStyle === 'dashed' ? [7, 4] : []); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
      if (selected(line.id)) drawSelection(Math.min(x1, x2), Math.min(y1, y2), Math.max(2, Math.abs(x2 - x1)), Math.max(2, Math.abs(y2 - y1)));
    }
    for (const level of drawnHorizontals) {
      const x = chart.timeScale().timeToCoordinate(level.time as UTCTimestamp); const y = series.priceToCoordinate(level.price);
      if (x == null || y == null) continue;
      ctx.save(); ctx.strokeStyle = level.color; ctx.lineWidth = 1.5; ctx.setLineDash(level.lineStyle === 'solid' ? [] : [7, 4]);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(canvas.width, y); ctx.stroke();
      ctx.fillStyle = level.color; ctx.font = '700 10px sans-serif'; ctx.fillText(level.price.toFixed(2), x + 6, y - 6); ctx.restore();
      if (selected(level.id)) drawSelection(x, y - 2, Math.max(2, canvas.width - x), 4);
    }
    for (const arrow of drawnArrows) {
      const x1 = chart.timeScale().timeToCoordinate(arrow.time1 as UTCTimestamp);
      const x2 = chart.timeScale().timeToCoordinate(arrow.time2 as UTCTimestamp);
      const y1 = series.priceToCoordinate(arrow.price1); const y2 = series.priceToCoordinate(arrow.price2);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      ctx.save(); ctx.strokeStyle = arrow.color; ctx.lineWidth = 2.5; ctx.setLineDash(arrow.lineStyle === 'dashed' ? [7, 4] : []); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
      drawArrowHead(x1, y1, x2, y2, arrow.color);
      if (selected(arrow.id)) drawSelection(Math.min(x1, x2), Math.min(y1, y2), Math.max(2, Math.abs(x2 - x1)), Math.max(2, Math.abs(y2 - y1)));
    }
    for (const note of drawnTexts) {
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
    for (const pin of drawnImages) {
      const x = chart.timeScale().timeToCoordinate(pin.time as UTCTimestamp); const y = series.priceToCoordinate(pin.price);
      if (x == null || y == null) continue;
      const cardX = Math.min(canvas.width - 110, Math.max(8, x + 10)); const cardY = Math.max(8, y - 78);
      let image = imageCacheRef.current.get(pin.url);
      if (!image) {
        image = new window.Image(); image.crossOrigin = 'anonymous'; image.onload = () => redrawCanvasRef.current(); image.src = pin.url;
        imageCacheRef.current.set(pin.url, image);
      }
      ctx.save(); ctx.fillStyle = resolvedTheme === 'dark' ? '#0a0e14ee' : '#ffffffee'; ctx.strokeStyle = pin.color; ctx.lineWidth = selected(pin.id) ? 2.5 : 1.5;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(cardX, cardY + 58); ctx.stroke();
      ctx.fillRect(cardX, cardY, 100, 66);
      if (image.complete && image.naturalWidth > 0) ctx.drawImage(image, cardX + 3, cardY + 3, 94, 48);
      else { ctx.fillStyle = resolvedTheme === 'dark' ? '#182033' : '#e8edf5'; ctx.fillRect(cardX + 3, cardY + 3, 94, 48); }
      ctx.strokeRect(cardX, cardY, 100, 66); ctx.fillStyle = resolvedTheme === 'dark' ? '#cbd5e1' : '#334155'; ctx.font = '600 9px sans-serif';
      ctx.fillText((pin.caption || 'Chart evidence').slice(0, 18), cardX + 5, cardY + 61); ctx.restore();
      if (selected(pin.id)) drawSelection(cardX, cardY, 100, 66);
    }
    if (currentPreview.current) {
      const { x1, y1, x2, y2 } = currentPreview.current;
      ctx.save(); ctx.strokeStyle = rectColor; ctx.fillStyle = rectColor + '18'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
      ctx.beginPath();
      if (drawingTool === 'line' || drawingTool === 'arrow') { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); if (drawingTool === 'arrow') drawArrowHead(x1, y1, x2, y2, rectColor); }
      else { ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); ctx.fill(); ctx.stroke(); }
      ctx.restore();
    }
  }, [drawingTool, drawnArrows, drawnHorizontals, drawnImages, drawnLines, drawnRects, drawnTexts, rectColor, resolvedTheme, selectedAnnotationId]);

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
      if (annotation.type === 'text' || annotation.type === 'image' || annotation.type === 'horizontal') {
        const ax = chart.timeScale().timeToCoordinate(annotation.time as UTCTimestamp); const ay = series.priceToCoordinate(annotation.price);
        if (ax == null || ay == null) continue;
        if (annotation.type === 'horizontal' && x >= ax - 8 && Math.abs(y - ay) <= 8) return annotation;
        if (annotation.type === 'image') {
          const cardX = Math.min(canvas.width - 110, Math.max(8, ax + 10)); const cardY = Math.max(8, ay - 78);
          if ((x >= cardX - 5 && x <= cardX + 105 && y >= cardY - 5 && y <= cardY + 71) || Math.hypot(x - ax, y - ay) <= 12) return annotation;
        }
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
      caption: annotation.type === 'image' ? annotation.caption : '',
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
    if (drawingTool === 'none') {
      const hit = beginAnnotationInteraction(x, y);
      if (hit) { autoSelectModeRef.current = true; setDrawingTool('select'); }
      return;
    }
    if (drawingTool === 'select') { beginAnnotationInteraction(x, y); return; }
    if (drawingTool === 'horizontal' || drawingTool === 'image') {
      const chart = chartRef.current, series = seriesRef.current; if (!chart || !series) return;
      const time = chart.timeScale().coordinateToTime(x); const price = series.coordinateToPrice(y);
      if (time == null || price == null || (drawingTool === 'image' && !pendingImage)) return;
      pushAnnotationHistory(); setSelectedAnnotationId('');
      if (drawingTool === 'horizontal') {
        setDrawnHorizontals(current => [...current, { id: `horizontal-${Date.now()}`, time: Number(time), price, color: rectColor }]);
        setDrawingTool('none'); setShowDrawingTools(false);
      } else if (pendingImage) {
        setDrawnImages(current => [...current, { id: `image-${Date.now()}`, time: Number(time), price, color: rectColor, ...pendingImage }]);
        setPendingImage(null); setDrawingTool('none');
      }
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
      if (original.type === 'image') setDrawnImages(cur => cur.map(item => item.id === id ? updated as DrawnImage : item));
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
    if (drawingTool !== 'none' || movingAnnotationRef.current) return;
    const canvas = canvasRef.current; if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const hit = findAnnotationAt(e.clientX - r.left, e.clientY - r.top);
    setHoveredAnnotationId(hit?.id || '');
  };
  const handleChartWrapMouseLeave = () => { if (drawingTool === 'none') setHoveredAnnotationId(''); };

  const uploadChartImage = async (file: File) => {
    if (!file.type.startsWith('image/')) { alert('Choose an image file to attach to the chart.'); return; }
    if (file.size > 8 * 1024 * 1024) { alert('Please keep chart images under 8MB.'); return; }
    const token = localStorage.getItem('token'); if (!token) return;
    setUploadingImage(true); setPendingImage(null);
    try {
      const imageData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read the image')); reader.readAsDataURL(file);
      });
      const caption = file.name.replace(/\.[^.]+$/, '').slice(0, 160) || 'Chart evidence';
      const response = await fetch(`${API}/pre-trade-analyses/${analysisId}/screenshots`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ imageData, caption }),
      });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not upload chart image');
      const screenshots = Array.isArray(body.screenshots) ? body.screenshots : [];
      const uploaded = screenshots[screenshots.length - 1];
      if (!uploaded?.url) throw new Error('The image uploaded but no image URL was returned');
      setPendingImage({ url: String(uploaded.url), caption, screenshotId: String(uploaded._id || uploaded.publicId || '') });
      setDrawingTool('image'); setSelectedAnnotationId('');
    } catch (uploadError) {
      alert(uploadError instanceof Error ? uploadError.message : 'Could not upload chart image'); setDrawingTool('none');
    } finally { setUploadingImage(false); }
  };
  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (file) uploadChartImage(file);
  };

  // ── Autosave (debounced) ────────────────────────────────────────────────
  useEffect(() => {
    if (!loadedRef.current) { loadedRef.current = true; baselineRef.current = JSON.stringify(allAnnotations); return; }
    const serialized = JSON.stringify(allAnnotations);
    if (serialized === baselineRef.current) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    setSaveState('saving'); setSaveError('');
    const timer = setTimeout(() => {
      const annotations = JSON.parse(serialized) as ChartAnnotation[];
      saveQueueRef.current = saveQueueRef.current.then(async () => {
        const response = await fetch(`${API}/pre-trade-analyses/${analysisId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ chartSymbol: symbol, chartInterval: interval, chartAnnotations: annotations }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not save chart annotations');
        baselineRef.current = serialized; setSaveState('saved');
      }).catch(error => { setSaveState('error'); setSaveError(error.message || 'Could not save chart annotations'); });
    }, 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allAnnotations]);

  return (
    <div className="card" style={{ padding: 0, marginBottom: 16, overflow: 'hidden' }}>
      <div className="replay-workspace-toolbar" aria-label="Pre-trade chart tools">
        <div className="replay-tool-group timeframe-group">
          <span className="replay-tool-group-label">Timeframe</span>
          <div className="replay-timeframes" role="group" aria-label="Chart timeframe">
            {CHART_INTERVALS.map(tf => <button type="button" key={tf.value} aria-pressed={interval === tf.value} className={interval === tf.value ? 'active' : ''} onClick={() => setInterval_(tf.value)}>{tf.label}</button>)}
          </div>
        </div>
        <div className="replay-toolbar-divider" />
        <div className="replay-tool-group">
          <span className="replay-tool-group-label">Lookback</span>
          <select value={days} onChange={e => setDays(Number(e.target.value))} style={{ minHeight: 30, borderRadius: 6, border: '1px solid #303b55', background: '#151b26', color: '#c9d2e8', fontSize: 11.5, padding: '0 6px' }}>
            {[2, 5, 10, 20, 30].map(d => <option key={d} value={d}>{d}d</option>)}
          </select>
        </div>
        <div className="replay-toolbar-divider" />
        <div className="replay-tool-group">
          <span className="replay-tool-group-label">Document</span>
          <button type="button" aria-pressed={drawingTool === 'text'} className={`replay-tool-btn${drawingTool === 'text' ? ' active' : ''}`} onClick={() => activateDrawingTool('text')} title="Write directly on the chart"><TypeIcon size={16} /> Text</button>
          <input ref={imageInputRef} className="replay-hidden-file" type="file" accept="image/*" onChange={handleImageUpload} />
          <button type="button" disabled={uploadingImage} aria-pressed={drawingTool === 'image'} className={`replay-tool-btn${drawingTool === 'image' ? ' active' : ''}`} onClick={() => imageInputRef.current?.click()} title="Upload and pin visual evidence to the chart"><ImagePlus size={16} /> {uploadingImage ? 'Uploading…' : 'Evidence'}</button>
          <button type="button" aria-expanded={showDrawingTools} aria-controls="pretrade-drawing-tray" aria-pressed={isShapeToolActive} className={`replay-tool-btn${isShapeToolActive || showDrawingTools ? ' active' : ''}`} onClick={() => setShowDrawingTools(current => !current)} title="Open drawing tools"><Square size={16} /> {isShapeToolActive ? TOOL_GUIDANCE[drawingTool]?.label : 'Draw'} <ChevronDown size={14} /></button>
        </div>
        <span className="replay-toolbar-spacer" />
        <span className={`replay-annotation-status ${saveState}`} role="status" title={saveError || 'Chart annotations save automatically'}>{saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : 'Saved'}</span>
        <div className="replay-tool-group replay-tool-actions">
          <button type="button" aria-pressed={drawingTool === 'select'} className={`replay-tool-btn${drawingTool === 'select' ? ' active' : ''}`} onClick={() => activateDrawingTool('select')} title="Drag an annotation to move it, click it to edit"><MousePointer2 size={16} /> Select</button>
          <button type="button" className="replay-tool-btn" disabled={annotationHistoryDepth === 0} onClick={undoAnnotation} title="Undo the last annotation change"><Undo2 size={16} /> Undo</button>
          <button type="button" className="replay-tool-btn replay-delete-tool" disabled={!selectedAnnotationId} onClick={deleteSelectedAnnotation} title="Delete the selected annotation"><Trash2 size={16} /> Delete</button>
          {allAnnotations.length > 0 && <button type="button" aria-pressed={showAnnotationList} className={`replay-tool-btn${showAnnotationList ? ' active' : ''}`} title="Manage saved annotations" onClick={() => setShowAnnotationList(current => !current)}>Objects ({allAnnotations.length})</button>}
        </div>
      </div>

      {showDrawingTools && (
        <div id="pretrade-drawing-tray" className="replay-drawing-tray" aria-label="Drawing tools">
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
          <span className="replay-drawing-tray-help">Mark PDH/PDL, PWH/PWL, and Asian/London session highs &amp; lows, then look for a sweep or continuation.</span>
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

      <div className={`replay-chart-wrap`} style={{ height: 440, position: 'relative' }} onMouseMove={handleChartWrapHoverMove} onMouseLeave={handleChartWrapMouseLeave}>
        <div ref={chartContainerRef} className="replay-chart-container" />
        {drawingTool === 'text' && (
          <div className="replay-chart-text-editor" role="group" aria-label="Write on chart">
            <TypeIcon size={15} />
            <input ref={annotationInputRef} aria-label="Text to place on chart" placeholder="Write a note…" maxLength={80} value={annotationText} onChange={event => setAnnotationText(event.target.value)} />
            <span>{annotationText.trim() ? 'Click the chart to place it' : 'Type your note first'}</span>
          </div>
        )}
        {drawingTool === 'image' && pendingImage && (
          <div className="replay-chart-image-placer" role="status">
            <ImagePlus size={16} /><div><strong>Image ready to place</strong><input aria-label="Image caption" maxLength={180} value={pendingImage.caption} onChange={event => setPendingImage(current => current ? { ...current, caption: event.target.value } : current)} /><span>Describe the evidence, then click the candle and price where it belongs.</span></div>
            <button type="button" onClick={() => { setPendingImage(null); setDrawingTool('none'); }}>Cancel</button>
          </div>
        )}
        {showAnnotationList && allAnnotations.length > 0 && (
          <div className="replay-annotation-manager" aria-label="Chart annotations">
            <div className="replay-annotation-manager-head"><strong>Saved annotations</strong><button type="button" onClick={clearAnnotations}>Clear all</button></div>
            {allAnnotations.map((annotation, index) => (
              <div className={`replay-annotation-row${selectedAnnotationId === annotation.id ? ' selected' : ''}`} key={annotation.id}>
                <button type="button" className="replay-annotation-select" aria-pressed={selectedAnnotationId === annotation.id} onClick={() => { setSelectedAnnotationId(annotation.id); setShowDrawingTools(false); setDrawingTool('select'); }}>
                  <i style={{ background: annotation.color }} />
                  <span><b>{annotation.type === 'rect' ? 'Zone' : annotation.type === 'line' ? 'Trend line' : annotation.type === 'horizontal' ? 'Level' : annotation.type === 'arrow' ? 'Arrow' : annotation.type === 'image' ? 'Image' : 'Text'}</b>{annotation.type === 'text' ? ` — ${annotation.text}` : annotation.type === 'image' ? ` — ${annotation.caption || 'Chart evidence'}` : ` ${index + 1}`}</span>
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
          const typeLabel = a.type === 'text' ? 'Text note' : a.type === 'image' ? 'Chart image' : a.type === 'horizontal' ? 'Price level' : a.type === 'arrow' ? 'Arrow' : a.type === 'line' ? 'Trend line' : 'Zone';
          return (
            <div className="replay-annotation-editor" role="dialog" aria-label={`Edit ${typeLabel}`} style={{ left, top }}>
              <div className="replay-annotation-editor-head"><strong>{typeLabel}</strong><button type="button" onClick={closeAnnotationEditor} aria-label="Close editor">×</button></div>
              {a.type === 'text' && <label>Text<input maxLength={80} value={annotationEditDraft.text} onChange={event => setAnnotationEditDraft(cur => ({ ...cur, text: event.target.value }))} autoFocus /></label>}
              {a.type === 'image' && <label>Caption<input maxLength={180} value={annotationEditDraft.caption} onChange={event => setAnnotationEditDraft(cur => ({ ...cur, caption: event.target.value }))} autoFocus /></label>}
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
          className={`replay-canvas-overlay${drawingTool !== 'none' ? ' drawing-active' : ''}${drawingTool === 'select' ? ' selecting' : ''}${drawingTool === 'none' && hoveredAnnotationId ? ' idle-hover' : ''}`}
          aria-label={drawingTool === 'select' ? 'Select a chart annotation' : 'Place a chart annotation'}
          onMouseDown={handleCanvasMouseDown} onMouseMove={handleCanvasMouseMove} onMouseUp={handleCanvasMouseUp}
          onMouseLeave={() => { movingAnnotationRef.current = null; endAutoSelectMode(); if (drawStart.current) { drawStart.current = null; currentPreview.current = null; redrawCanvas(); } }} />
        {!symbol.trim() && (
          <div className="replay-chart-state"><h4>Enter a symbol</h4><p>Type a symbol above to load its chart.</p></div>
        )}
        {symbol.trim() && loading && (
          <div className="replay-chart-state"><Loader2 className="spin" size={22} /><h4>Loading chart…</h4><p>Requesting {symbol} candles from cTrader</p></div>
        )}
        {symbol.trim() && !loading && error && (
          <div className="replay-chart-state">
            <AlertTriangle size={32} color="#f59e0b" />
            <h4>{isSetupError ? 'Chart Not Configured' : 'Chart Data Unavailable'}</h4>
            <p>{error}</p>
            {isSetupError && <a href="/accounts" className="replay-setup-link">Connect cTrader on the Accounts page <ExternalLink size={12} /></a>}
          </div>
        )}
      </div>
    </div>
  );
}
