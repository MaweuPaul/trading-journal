// Rendering + hit-testing for the freehand annotation tools (zone, trend
// line, price level, arrow, text, Fibonacci retracement). Pure functions
// only -- BacktestChart.tsx owns the canvas, the React state, and the mouse
// handlers that call into these.
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import {
  ChartAnnotation, DrawnRect, DrawnLine, DrawnHorizontal, DrawnArrow, DrawnFib, DrawnText,
  FIB_LEVELS, DrawingTool, fmtPrice,
} from './types';

export interface DrawCtx {
  ctx: CanvasRenderingContext2D;
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  canvas: HTMLCanvasElement;
  revealedTime: number;
  selectedId: string;
  resolvedTheme: 'light' | 'dark';
}

export function drawSelectionBox(dc: DrawCtx, x: number, y: number, width: number, height: number) {
  const { ctx, resolvedTheme } = dc;
  ctx.save(); ctx.strokeStyle = resolvedTheme === 'dark' ? '#f8fafc' : '#0f172a'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
  ctx.strokeRect(x - 4, y - 4, width + 8, height + 8); ctx.restore();
}

export function drawArrowHead(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string) {
  const angle = Math.atan2(y2 - y1, x2 - x1); const size = 10;
  ctx.save(); ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6));
  ctx.closePath(); ctx.fill(); ctx.restore();
}

export function drawRects(dc: DrawCtx, rects: DrawnRect[]) {
  const { ctx, chart, series, revealedTime, selectedId } = dc;
  for (const r of rects) {
    if (Math.max(r.time1, r.time2) > revealedTime) continue;
    const x1 = chart.timeScale().timeToCoordinate(r.time1 as UTCTimestamp);
    const x2 = chart.timeScale().timeToCoordinate(r.time2 as UTCTimestamp);
    const y1 = series.priceToCoordinate(r.price1); const y2 = series.priceToCoordinate(r.price2);
    if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
    ctx.save(); ctx.strokeStyle = r.color; ctx.fillStyle = r.color + '22'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.fill(); ctx.stroke(); ctx.restore();
    if (r.id === selectedId) drawSelectionBox(dc, Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  }
}

export function drawLines(dc: DrawCtx, lines: DrawnLine[]) {
  const { ctx, chart, series, revealedTime, selectedId } = dc;
  for (const line of lines) {
    if (Math.max(line.time1, line.time2) > revealedTime) continue;
    const x1 = chart.timeScale().timeToCoordinate(line.time1 as UTCTimestamp);
    const x2 = chart.timeScale().timeToCoordinate(line.time2 as UTCTimestamp);
    const y1 = series.priceToCoordinate(line.price1); const y2 = series.priceToCoordinate(line.price2);
    if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
    ctx.save(); ctx.strokeStyle = line.color; ctx.lineWidth = 2; ctx.setLineDash(line.lineStyle === 'dashed' ? [7, 4] : []); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
    if (line.id === selectedId) drawSelectionBox(dc, Math.min(x1, x2), Math.min(y1, y2), Math.max(2, Math.abs(x2 - x1)), Math.max(2, Math.abs(y2 - y1)));
  }
}

export function drawHorizontals(dc: DrawCtx, horizontals: DrawnHorizontal[]) {
  const { ctx, chart, series, canvas, revealedTime, selectedId } = dc;
  for (const level of horizontals) {
    if (level.time > revealedTime) continue;
    const x = chart.timeScale().timeToCoordinate(level.time as UTCTimestamp); const y = series.priceToCoordinate(level.price);
    if (x == null || y == null) continue;
    ctx.save(); ctx.strokeStyle = level.color; ctx.lineWidth = 1.5; ctx.setLineDash(level.lineStyle === 'solid' ? [] : [7, 4]);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    ctx.fillStyle = level.color; ctx.font = '700 10px sans-serif'; ctx.fillText(level.price.toFixed(2), x + 6, y - 6); ctx.restore();
    if (level.id === selectedId) drawSelectionBox(dc, x, y - 2, Math.max(2, canvas.width - x), 4);
  }
}

export function drawArrows(dc: DrawCtx, arrows: DrawnArrow[]) {
  const { ctx, chart, series, revealedTime, selectedId } = dc;
  for (const arrow of arrows) {
    if (Math.max(arrow.time1, arrow.time2) > revealedTime) continue;
    const x1 = chart.timeScale().timeToCoordinate(arrow.time1 as UTCTimestamp);
    const x2 = chart.timeScale().timeToCoordinate(arrow.time2 as UTCTimestamp);
    const y1 = series.priceToCoordinate(arrow.price1); const y2 = series.priceToCoordinate(arrow.price2);
    if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
    ctx.save(); ctx.strokeStyle = arrow.color; ctx.lineWidth = 2.5; ctx.setLineDash(arrow.lineStyle === 'dashed' ? [7, 4] : []); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
    drawArrowHead(ctx, x1, y1, x2, y2, arrow.color);
    if (arrow.id === selectedId) drawSelectionBox(dc, Math.min(x1, x2), Math.min(y1, y2), Math.max(2, Math.abs(x2 - x1)), Math.max(2, Math.abs(y2 - y1)));
  }
}

export function drawFibs(dc: DrawCtx, fibs: DrawnFib[]) {
  const { ctx, chart, series, canvas, revealedTime, selectedId } = dc;
  for (const f of fibs) {
    if (Math.max(f.time1, f.time2) > revealedTime) continue;
    const leftX = chart.timeScale().timeToCoordinate(Math.min(f.time1, f.time2) as UTCTimestamp);
    if (leftX == null) continue;
    const yTop = series.priceToCoordinate(Math.max(f.price1, f.price2));
    const yBottom = series.priceToCoordinate(Math.min(f.price1, f.price2));
    ctx.save();
    for (const level of FIB_LEVELS) {
      const price = f.price1 + (f.price2 - f.price1) * level;
      const y = series.priceToCoordinate(price); if (y == null) continue;
      const edge = level === 0 || level === 1;
      ctx.strokeStyle = f.color; ctx.globalAlpha = edge ? 1 : 0.55; ctx.lineWidth = edge ? 1.5 : 1;
      ctx.setLineDash(edge ? [] : [5, 3]);
      ctx.beginPath(); ctx.moveTo(leftX, y); ctx.lineTo(canvas.width, y); ctx.stroke();
      ctx.globalAlpha = 1; ctx.fillStyle = f.color; ctx.font = '600 10px sans-serif';
      ctx.fillText(`${(level * 100).toFixed(1)}%  ${fmtPrice(price)}`, leftX + 6, y - 4);
    }
    ctx.restore();
    if (f.id === selectedId && yTop != null && yBottom != null) drawSelectionBox(dc, leftX, yTop, Math.max(2, canvas.width - leftX), Math.max(2, yBottom - yTop));
  }
}

export function drawTexts(dc: DrawCtx, texts: DrawnText[]) {
  const { ctx, chart, series, revealedTime, selectedId, resolvedTheme } = dc;
  for (const note of texts) {
    if (note.time > revealedTime) continue;
    const x = chart.timeScale().timeToCoordinate(note.time as UTCTimestamp);
    const y = series.priceToCoordinate(note.price);
    if (x == null || y == null) continue;
    ctx.save(); ctx.font = '600 12px sans-serif';
    const width = ctx.measureText(note.text).width;
    ctx.fillStyle = resolvedTheme === 'dark' ? '#0a0d14dd' : '#ffffffee'; ctx.fillRect(x - 5, y - 17, width + 10, 23);
    ctx.strokeStyle = note.color; ctx.strokeRect(x - 5, y - 17, width + 10, 23);
    ctx.fillStyle = note.color; ctx.fillText(note.text, x, y); ctx.restore();
    if (note.id === selectedId) drawSelectionBox(dc, x - 5, y - 17, width + 10, 23);
  }
}

export function drawShapePreview(ctx: CanvasRenderingContext2D, drawingTool: DrawingTool, rectColor: string, preview: { x1: number; y1: number; x2: number; y2: number }) {
  const { x1, y1, x2, y2 } = preview;
  ctx.save(); ctx.strokeStyle = rectColor; ctx.fillStyle = rectColor + '18'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
  ctx.beginPath();
  if (drawingTool === 'line' || drawingTool === 'arrow') {
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    if (drawingTool === 'arrow') drawArrowHead(ctx, x1, y1, x2, y2, rectColor);
  } else {
    ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1; if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function findAnnotationAt(params: {
  x: number; y: number; chart: IChartApi; series: ISeriesApi<'Candlestick'>; canvas: HTMLCanvasElement; annotations: ChartAnnotation[];
}): ChartAnnotation | null {
  const { x, y, chart, series, canvas, annotations } = params;
  for (const annotation of [...annotations].reverse()) {
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
    if (annotation.type === 'rect' || annotation.type === 'fib') {
      const left = Math.min(x1, x2), right = Math.max(x1, x2), top = Math.min(y1, y2), bottom = Math.max(y1, y2);
      if (x >= left - 7 && x <= right + 7 && y >= top - 7 && y <= bottom + 7) return annotation;
    } else if (distanceToSegment(x, y, x1, y1, x2, y2) <= 9) return annotation;
  }
  return null;
}
