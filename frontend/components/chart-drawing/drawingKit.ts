// Shared chart drawing kit: the tool set, colours and property helpers used by
// every chart with drawing tools (Backtest workspace, Pre-Trade Analysis,
// Trade Replay), all on lightweight-charts-drawing so a drawing looks and
// behaves the same everywhere. React wiring lives in useChartDrawings.ts.
import { Drawing, getToolRegistry } from 'lightweight-charts-drawing';
import type { IDrawing, SerializedDrawing } from 'lightweight-charts-drawing';
import type { DrawingPropertiesCapabilities, DrawingPropertiesValue } from '../backtest-tools/DrawingPropertiesPanel';

// The library feeds every drawing's anchor prices into the price scale's
// auto-fit, so one old line far from price (even hidden or off screen)
// squashes the candles. Like TradingView, fit the price scale to candles only.
(Drawing.prototype as unknown as { autoscaleInfo: () => null }).autoscaleInfo = () => null;

/** Drawing tools, in toolbar order. `icon` is a Material Symbols name. */
export const DRAWING_TOOLS: { id: string; icon: string; label: string }[] = [
  { id: 'trend-line', icon: 'show_chart', label: 'Trend line' },
  { id: 'ray', icon: 'arrow_outward', label: 'Ray' },
  { id: 'horizontal-line', icon: 'horizontal_rule', label: 'Horizontal line' },
  { id: 'rectangle', icon: 'crop_square', label: 'Rectangle / zone' },
  { id: 'parallel-channel', icon: 'view_stream', label: 'Parallel channel' },
  { id: 'fib-retracement', icon: 'stacked_bar_chart', label: 'Fib retracement' },
  { id: 'fib-extension', icon: 'stacked_line_chart', label: 'Fib extension' },
  { id: 'arrow', icon: 'north_east', label: 'Arrow' },
  { id: 'text-annotation', icon: 'title', label: 'Text note' },
];

export const DRAWING_SWATCHES = [
  { color: '#3b82f6', cls: 'tw:bg-[#3b82f6]', label: 'Blue' },
  { color: '#16a34a', cls: 'tw:bg-[#16a34a]', label: 'Green' },
  { color: '#dc2626', cls: 'tw:bg-[#dc2626]', label: 'Red' },
  { color: '#f59e0b', cls: 'tw:bg-[#f59e0b]', label: 'Orange' },
];

// The library paints rectangle fills with fillColor as-is (fillOpacity is
// ignored), so the colour it gets carries the opacity; fillHex keeps the
// plain colour for the properties panel.
export function fillWithOpacity(hex: string, opacity: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, opacity))})`;
}

// Text notes keep their text, size and colour in their own settings, which
// the library neither saves nor reads from the style. We keep them in the
// style (drawingText, drawingTextFontSize…, lineColor) so they're saved, and
// copy them onto the note whenever it's created or edited.
type TextNote = IDrawing & { setTextOptions?: (o: Record<string, unknown>) => void; getText?: () => string };
export function syncTextNote(drawing: IDrawing | null | undefined) {
  if (!drawing || drawing.type !== 'text-annotation') return;
  const note = drawing as TextNote;
  const st = (drawing as DrawingWithText).style;
  const color = st.lineColor || '#3b82f6';
  note.setTextOptions?.({
    text: st.drawingText ?? note.getText?.() ?? '',
    fontSize: st.drawingTextFontSize || 14,
    fontWeight: `${st.drawingTextItalic ? 'italic ' : ''}${st.drawingTextBold ? 'bold' : 'normal'}`,
    borderColor: color,
  });
  if (st.labelColor !== color) drawing.updateStyle({ labelColor: color });
  drawing.requestUpdate();
}

/** Change a drawing's colour (text notes: their text and border too). */
export function setDrawingColor(drawing: IDrawing, color: string) {
  drawing.updateStyle({ lineColor: color });
  syncTextNote(drawing);
  drawing.requestUpdate();
}

export function drawingFactory(type: string, data: SerializedDrawing) {
  const style = data.style as DrawingWithText['style'] | undefined;
  const options = type === 'text-annotation'
    ? { ...data.options, text: style?.drawingText ?? (data.options as { text?: string } | undefined)?.text ?? '' }
    : data.options;
  const drawing = getToolRegistry().createDrawing(type, data.id, data.anchors, data.style, options);
  syncTextNote(drawing);
  return drawing;
}

export type DrawingWithText = IDrawing & {
  style: IDrawing['style'] & {
    drawingText?: string;
    drawingTextFontSize?: number;
    drawingTextBold?: boolean;
    drawingTextItalic?: boolean;
    drawingTextPlacement?: DrawingPropertiesValue['textPlacement'];
    drawingTextAlign?: DrawingPropertiesValue['textAlign'];
    fillHex?: string;
  };
  options: IDrawing['options'] & { filled?: boolean };
  getText?: () => string;
  setText?: (text: string) => void;
};

export function getDrawingText(drawing: IDrawing) {
  const withText = drawing as DrawingWithText;
  return (withText.getText?.() ?? withText.style.drawingText ?? '').trim();
}

export function setDrawingText(drawing: IDrawing, text: string) {
  const withText = drawing as DrawingWithText;
  drawing.updateStyle({ drawingText: text } as DrawingWithText['style']);
  if (drawing.type === 'text-annotation') withText.setText?.(text);
  drawing.requestUpdate();
}

export function drawingDisplayName(type: string) {
  return DRAWING_TOOLS.find(tool => tool.id === type)?.label ?? type.split('-').map(word => word[0]?.toUpperCase() + word.slice(1)).join(' ');
}

export function drawingCapabilities(drawing: IDrawing): DrawingPropertiesCapabilities {
  const textTypes = new Set(['rectangle', 'trend-line', 'ray', 'horizontal-line', 'parallel-channel', 'fib-retracement', 'fib-extension', 'arrow', 'text-annotation']);
  return {
    style: true,
    fill: drawing.type === 'rectangle',
    text: textTypes.has(drawing.type),
    coordinates: true,
    visibility: true,
    extendRight: drawing.type === 'rectangle' || drawing.type === 'trend-line' || drawing.type === 'ray',
    lineWidth: drawing.type !== 'text-annotation',
    placement: drawing.type !== 'text-annotation',
  };
}

export function drawingPropertiesValue(drawing: IDrawing): DrawingPropertiesValue {
  const withText = drawing as DrawingWithText;
  return {
    lineColor: drawing.style.lineColor || '#3b82f6',
    lineWidth: drawing.style.lineWidth || 2,
    fillColor: withText.style.fillHex || (drawing.style.fillColor?.startsWith('#') ? drawing.style.fillColor : '') || drawing.style.lineColor || '#3b82f6',
    fillOpacity: typeof drawing.style.fillOpacity === 'number' ? drawing.style.fillOpacity : 0.12,
    filled: Boolean(withText.options.filled),
    text: getDrawingText(drawing),
    textFontSize: withText.style.drawingTextFontSize || (drawing.type === 'text-annotation' ? 14 : 12),
    textBold: Boolean(withText.style.drawingTextBold),
    textItalic: Boolean(withText.style.drawingTextItalic),
    textPlacement: withText.style.drawingTextPlacement || 'inside',
    textAlign: withText.style.drawingTextAlign || 'center',
    visible: drawing.options.visible !== false,
    locked: Boolean(drawing.options.locked),
    extendRight: Boolean(drawing.options.extendRight),
    anchors: drawing.anchors.map(anchor => ({ time: String(anchor.time), price: anchor.price })),
  };
}

export function applyDrawingProperties(drawing: IDrawing, value: DrawingPropertiesValue) {
  setDrawingText(drawing, value.text);
  drawing.updateStyle({
    lineColor: value.lineColor,
    lineWidth: value.lineWidth,
    fillColor: fillWithOpacity(value.fillColor, value.fillOpacity),
    fillHex: value.fillColor,
    fillOpacity: value.fillOpacity,
    drawingText: value.text,
    drawingTextFontSize: value.textFontSize,
    drawingTextBold: value.textBold,
    drawingTextItalic: value.textItalic,
    drawingTextPlacement: value.textPlacement,
    drawingTextAlign: value.textAlign,
  } as Partial<DrawingWithText['style']>);
  drawing.updateOptions({
    visible: value.visible,
    locked: value.locked,
    extendRight: value.extendRight,
    filled: value.filled,
  } as Partial<DrawingWithText['options']>);
  syncTextNote(drawing);
  drawing.requestUpdate();
}

// ── Older annotations (Pre-Trade / Replay's previous drawing tools) ──────────
export type LegacyAnnotation =
  | { type: 'rect' | 'line' | 'arrow'; id: string; time1: number; time2: number; price1: number; price2: number; color: string; lineStyle?: 'solid' | 'dashed' }
  | { type: 'horizontal'; id: string; time: number; price: number; color: string; lineStyle?: 'solid' | 'dashed' }
  | { type: 'text'; id: string; time: number; price: number; text: string; color: string }
  | { type: 'fib'; id: string; time1: number; time2: number; price1: number; price2: number; color: string };

/** Saved shared-tool drawing inside an annotations array. */
export interface DrawingEntry { type: 'drawing'; id: string; drawing: SerializedDrawing }

const LEGACY_TYPE: Record<string, string> = { rect: 'rectangle', line: 'trend-line', arrow: 'arrow', horizontal: 'horizontal-line', text: 'text-annotation', fib: 'fib-retracement' };
const safeId = (id: string, type: string) => (/^[A-Za-z0-9:_-]{1,100}$/.test(id) ? id : `${type}-${Math.random().toString(36).slice(2, 10)}`);

/** Turn one older annotation into the shared tools' saved form (null for types it doesn't cover, e.g. images). */
export function legacyToDrawing(a: { type: string } & Record<string, unknown>): SerializedDrawing | null {
  const type = LEGACY_TYPE[a.type];
  if (!type) return null;
  const color = typeof a.color === 'string' ? a.color : '#3b82f6';
  const dash = a.lineStyle === 'dashed' || (a.type === 'horizontal' && a.lineStyle !== 'solid') ? [7, 4] : undefined;
  const style = { lineColor: color, lineWidth: a.type === 'rect' ? 1.5 : 2, ...(dash ? { lineDash: dash } : {}), ...(a.type === 'rect' ? { fillColor: fillWithOpacity(color, 0.13), fillHex: color, fillOpacity: 0.13 } : {}) };
  const two = [{ time: Number(a.time1), price: Number(a.price1) }, { time: Number(a.time2), price: Number(a.price2) }];
  const one = [{ time: Number(a.time), price: Number(a.price) }];
  const anchors = a.type === 'horizontal' || a.type === 'text' ? one : two;
  if (anchors.some(p => !Number.isFinite(p.time) || !Number.isFinite(p.price))) return null;
  return {
    id: safeId(String(a.id || ''), type), type,
    anchors: anchors as SerializedDrawing['anchors'],
    style: style as SerializedDrawing['style'],
    options: { visible: true, ...(a.type === 'rect' ? { filled: true } : {}), ...(a.type === 'text' ? { text: String(a.text || '') } : {}) } as SerializedDrawing['options'],
    ...(a.type === 'text' ? { style: { ...style, drawingText: String(a.text || '') } as SerializedDrawing['style'] } : {}),
  };
}

/**
 * Split a saved annotations array into shared-tool drawings (converting older
 * shapes) and whatever else the chart keeps itself (e.g. pinned images).
 */
export function splitAnnotations<T extends { type: string }>(list: T[] | undefined | null): { drawings: SerializedDrawing[]; other: T[] } {
  const drawings: SerializedDrawing[] = [];
  const other: T[] = [];
  for (const a of list || []) {
    if (a.type === 'drawing') { const d = (a as unknown as DrawingEntry).drawing; if (d) drawings.push({ ...d, id: (a as unknown as DrawingEntry).id || d.id }); continue; }
    const converted = legacyToDrawing(a as unknown as { type: string } & Record<string, unknown>);
    if (converted) drawings.push(converted); else other.push(a);
  }
  return { drawings, other };
}

export const toDrawingEntries = (drawings: SerializedDrawing[]): DrawingEntry[] => drawings.map(d => ({ type: 'drawing', id: d.id, drawing: d }));

/**
 * Move anchors onto the chart's candles (the last one opening at or before
 * each anchor), so drawings made on another timeframe still line up. Anchors
 * outside the loaded candles are left as they are.
 */
export function snapToCandles(drawings: SerializedDrawing[], candleTimes: number[]): SerializedDrawing[] {
  if (!candleTimes.length) return drawings;
  const first = candleTimes[0], last = candleTimes[candleTimes.length - 1];
  const snap = (t: number) => {
    if (t < first || t > last) return t;
    let lo = 0, hi = candleTimes.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (candleTimes[mid] <= t) lo = mid; else hi = mid - 1; }
    return candleTimes[lo];
  };
  return drawings.map(d => ({ ...d, anchors: d.anchors.map(a => ({ ...a, time: snap(Number(a.time)) as SerializedDrawing['anchors'][number]['time'] })) }));
}
