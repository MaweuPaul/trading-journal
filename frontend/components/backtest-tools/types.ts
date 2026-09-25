// Shared types, constants, and small pure helpers for every Backtest chart
// tool (drawing annotations, the position tool, the measure tool). Each
// tool's rendering/hit-testing logic lives in its own file in this folder;
// BacktestChart.tsx owns the single canvas + interaction state machine that
// all of them share.
import type { UTCTimestamp } from 'lightweight-charts';

export interface Candle { time: UTCTimestamp; open: number; high: number; low: number; close: number; }
export type AnnotationLineStyle = 'solid' | 'dashed';

export interface DrawnRect { id: string; time1: number; time2: number; price1: number; price2: number; color: string; }
export interface DrawnLine { id: string; time1: number; time2: number; price1: number; price2: number; color: string; lineStyle?: AnnotationLineStyle; }
export interface DrawnText { id: string; time: number; price: number; text: string; color: string; }
export interface DrawnHorizontal { id: string; time: number; price: number; color: string; lineStyle?: AnnotationLineStyle; }
export interface DrawnArrow { id: string; time1: number; time2: number; price1: number; price2: number; color: string; lineStyle?: AnnotationLineStyle; }
export interface DrawnFib { id: string; time1: number; time2: number; price1: number; price2: number; color: string; }

export type ChartAnnotation =
  | (DrawnRect & { type: 'rect' }) | (DrawnLine & { type: 'line' })
  | (DrawnHorizontal & { type: 'horizontal' }) | (DrawnArrow & { type: 'arrow' })
  | (DrawnFib & { type: 'fib' })
  | (DrawnText & { type: 'text' });

export type DrawingTool = 'none' | 'select' | 'rect' | 'line' | 'horizontal' | 'arrow' | 'text' | 'fib' | 'measure';
export type ShapeDrawingTool = Extract<DrawingTool, 'rect' | 'line' | 'horizontal' | 'arrow' | 'fib'>;
export interface AnnotationHistory { rects: DrawnRect[]; lines: DrawnLine[]; horizontals: DrawnHorizontal[]; arrows: DrawnArrow[]; texts: DrawnText[]; fibs: DrawnFib[]; }
export interface MeasureRange { time1: number; price1: number; time2: number; price2: number; }

export interface OpenTrade {
  direction: 'long' | 'short';
  entryTime: number; entryPrice: number;
  stopLoss: number; takeProfit: number | null;
  riskAmount: number;
}
export interface ClosedTrade extends OpenTrade {
  exitTime: number; exitPrice: number;
  outcome: 'win' | 'loss' | 'breakeven';
  rMultiple: number; pnlUSD: number;
}
export type TradeHandle = 'sl' | 'tp' | 'entry';

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

export const DRAWING_COLORS = [
  { value: '#3b82f6', label: 'Blue' }, { value: '#10b981', label: 'Green' },
  { value: '#f59e0b', label: 'Amber' }, { value: '#ef4444', label: 'Red' },
  { value: '#8b5cf6', label: 'Purple' }, { value: '#ec4899', label: 'Pink' },
] as const;

export const SHAPE_DRAWING_TOOLS: ShapeDrawingTool[] = ['rect', 'line', 'horizontal', 'arrow', 'fib'];

export const TOOL_GUIDANCE: Partial<Record<DrawingTool, { label: string; instruction: string }>> = {
  select: { label: 'Select', instruction: 'Drag an annotation to move it. Click it (without dragging) to edit its color or line style.' },
  rect: { label: 'Zone', instruction: 'Drag across the chart to mark an area.' },
  line: { label: 'Trend line', instruction: 'Drag from the start point to the end point.' },
  horizontal: { label: 'Price level', instruction: 'Click once at the price you want to mark.' },
  arrow: { label: 'Arrow', instruction: 'Drag to point from one place to another.' },
  text: { label: 'Text note', instruction: 'Write the note, then click the candle and price where it belongs.' },
  fib: { label: 'Fibonacci', instruction: 'Drag from the swing start to the swing end to plot retracement levels.' },
  measure: { label: 'Measure', instruction: 'Drag between two points to measure price, percent move, and bar count.' },
};

export const CHART_INTERVALS = [
  { value: '1min', label: '1m' }, { value: '5min', label: '5m' }, { value: '15min', label: '15m' },
  { value: '1h', label: '1H' }, { value: '4h', label: '4H' }, { value: '1day', label: '1D' },
] as const;
export const SPEEDS = [0.5, 1, 2, 5, 10];

export function toAnnotations(rects: DrawnRect[], lines: DrawnLine[], horizontals: DrawnHorizontal[], arrows: DrawnArrow[], texts: DrawnText[], fibs: DrawnFib[]): ChartAnnotation[] {
  return [
    ...rects.map(a => ({ ...a, type: 'rect' as const })),
    ...lines.map(a => ({ ...a, type: 'line' as const })),
    ...horizontals.map(a => ({ ...a, type: 'horizontal' as const })),
    ...arrows.map(a => ({ ...a, type: 'arrow' as const })),
    ...fibs.map(a => ({ ...a, type: 'fib' as const })),
    ...texts.map(a => ({ ...a, type: 'text' as const })),
  ];
}
export function isoDaysAgo(days: number) {
  const d = new Date(); d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
export function fmtPrice(n: number) { return n.toFixed(n >= 100 ? 2 : 5); }
export function nearestCandleIndex(candles: Candle[], time: number) {
  let lo = 0, hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < time) lo = mid + 1; else hi = mid;
  }
  return lo;
}
