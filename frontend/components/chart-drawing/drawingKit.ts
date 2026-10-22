// Shared chart drawing kit: the tool set, colours and property helpers used by
// every chart with drawing tools (Backtest workspace, Pre-Trade Analysis,
// Trade Replay), all on lightweight-charts-drawing so a drawing looks and
// behaves the same everywhere. React wiring lives in useChartDrawings.ts.
import { Drawing, FibRetracement, TextAnnotation, drawControlPoints, getToolRegistry } from 'lightweight-charts-drawing';
import type { IDrawing, SerializedDrawing } from 'lightweight-charts-drawing';
import type { DrawingPropertiesCapabilities, DrawingPropertiesValue } from '../backtest-tools/DrawingPropertiesPanel';

// The library feeds every drawing's anchor prices into the price scale's
// auto-fit, so one old line far from price (even hidden or off screen)
// squashes the candles. Like TradingView, fit the price scale to candles only.
(Drawing.prototype as unknown as { autoscaleInfo: () => null }).autoscaleInfo = () => null;

// The library draws a text note on one line (line breaks vanish) and sizes
// its click area for one line. Draw each line of the note and hit-test the
// whole block. The note's anchor is the middle of its first line.
type Point = { x: number; y: number };
type NoteInternals = {
  textOptions: { text?: string; fontSize?: number; fontFamily?: string; fontWeight?: string; backgroundColor?: string; borderColor?: string; padding?: number };
  style: { labelColor?: string; lineColor?: string };
  options: { visible?: boolean };
  state: string;
  anchors: { time: unknown; price: number }[];
  isValid(): boolean;
  getViewport(): unknown;
  anchorToPixel(anchor: unknown, viewport: unknown): Point | null;
};
const noteLines = (note: NoteInternals) => String(note.textOptions.text ?? '').split(/\r?\n/);
/** The note's box in CSS pixels, measured with `ctx` when given (else estimated). */
function noteBox(note: NoteInternals, anchor: Point, ctx?: CanvasRenderingContext2D) {
  const o = note.textOptions, size = o.fontSize ?? 14, pad = o.padding ?? 8, lineH = size * 1.3;
  const lines = noteLines(note);
  const width = Math.max(...lines.map(line => (ctx ? ctx.measureText(line).width : line.length * size * 0.6)), size);
  return { left: anchor.x - pad, top: anchor.y - lineH / 2 - pad, width: width + pad * 2, height: lines.length * lineH + pad * 2, lineH, lines };
}
const noteProto = TextAnnotation.prototype as unknown as {
  paneViews(this: NoteInternals): unknown[];
  testHit(this: NoteInternals, point: Point, viewport: unknown): boolean;
};
type PaneTarget = { useBitmapCoordinateSpace(fn: (scope: { context: CanvasRenderingContext2D; horizontalPixelRatio: number; verticalPixelRatio: number }) => void): void };
function drawNote(note: NoteInternals, target: PaneTarget) {
  target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
    const viewport = note.getViewport();
    if (!viewport || note.options.visible === false || !note.isValid()) return;
    const anchor = note.anchorToPixel(note.anchors[0], viewport);
    if (!anchor) return;
    const o = note.textOptions;
    ctx.save();
    ctx.scale(hr, vr); // draw in CSS pixels
    ctx.font = `${o.fontWeight ?? 'normal'} ${o.fontSize ?? 14}px ${o.fontFamily ?? 'sans-serif'}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const box = noteBox(note, anchor, ctx);
    ctx.beginPath();
    ctx.roundRect(box.left, box.top, box.width, box.height, 4);
    if (o.backgroundColor) { ctx.fillStyle = o.backgroundColor; ctx.fill(); }
    if (o.borderColor) { ctx.strokeStyle = o.borderColor; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.fillStyle = note.style.labelColor ?? '#000000';
    box.lines.forEach((line, i) => ctx.fillText(line, anchor.x, anchor.y + i * box.lineH));
    if (note.state === 'selected' || note.state === 'editing') {
      // The anchor handle (the note moves by dragging it, or its box).
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.strokeStyle = o.borderColor || note.style.lineColor || '#3b82f6'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.restore();
  });
}
noteProto.paneViews = function paneViews(this: NoteInternals) {
  const renderer = { draw: (target: PaneTarget) => drawNote(this, target) };
  return [{ zOrder: () => 'top', renderer: () => renderer }];
};
noteProto.testHit = function testHit(this: NoteInternals, point: Point, viewport: unknown) {
  if (!this.isValid()) return false;
  const anchor = this.anchorToPixel(this.anchors[0], viewport);
  if (!anchor) return false;
  const box = noteBox(this, anchor);
  return point.x >= box.left && point.x <= box.left + box.width && point.y >= box.top && point.y <= box.top + box.height;
};

// Fib retracement, drawn the TradingView way: each level in its own colour
// with a soft band to the next level, and the labels ("0.618 (102.18)") to the
// left of the levels -- the library puts them past the right end, where they
// run under the price scale.
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618];
const FIB_COLORS: Record<number, string> = {
  0: '#787b86', 0.236: '#f23645', 0.382: '#ff9800', 0.5: '#4caf50', 0.618: '#089981',
  0.786: '#00bcd4', 1: '#787b86', 1.618: '#2962ff', 2.618: '#f23645',
};
type FibInternals = NoteInternals & {
  fibOptions: { levels?: number[]; showPrices?: boolean; showPercentages?: boolean; extendLines?: boolean; reverseDirection?: boolean };
  style: { lineColor?: string; lineWidth?: number };
  getControlPoints(viewport: unknown): unknown[];
};
type FibViewport = { width: number; priceScale: { priceToCoordinate(price: number): number | null } };
const fibPrice = (n: number) => n.toFixed(Math.abs(n) >= 10 ? 2 : Math.abs(n) >= 1 ? 4 : 5);
function drawFib(fib: FibInternals, target: PaneTarget) {
  target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
    const viewport = fib.getViewport() as FibViewport | null;
    if (!viewport || fib.options.visible === false || !fib.isValid()) return;
    const a = fib.anchorToPixel(fib.anchors[0], viewport), b = fib.anchorToPixel(fib.anchors[1], viewport);
    if (!a || !b) return;
    const o = fib.fibOptions, start = fib.anchors[0].price, end = fib.anchors[1].price, range = end - start;
    const levels = [...(o.levels ?? FIB_LEVELS)].sort((x, y) => x - y);
    const left = o.extendLines ? 0 : Math.min(a.x, b.x), right = o.extendLines ? viewport.width : Math.max(a.x, b.x);
    const priceAt = (level: number) => (o.reverseDirection ? end - range * level : start + range * level);
    const ys = levels.map(level => viewport.priceScale.priceToCoordinate(priceAt(level)));
    const colorOf = (level: number) => FIB_COLORS[level] ?? fib.style.lineColor ?? '#787b86';
    ctx.save();
    ctx.scale(hr, vr); // draw in CSS pixels
    // Bands between neighbouring levels.
    for (let i = 0; i < levels.length - 1; i++) {
      const y1 = ys[i], y2 = ys[i + 1];
      if (y1 == null || y2 == null) continue;
      ctx.globalAlpha = 0.1; ctx.fillStyle = colorOf(levels[i + 1]);
      ctx.fillRect(left, Math.min(y1, y2), right - left, Math.abs(y2 - y1));
    }
    ctx.globalAlpha = 1;
    // Level lines and their labels.
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, sans-serif';
    ctx.textBaseline = 'middle';
    const labelRight = left - 6, labelsInside = labelRight < 40; // no room on the left: label inside, at the start
    ctx.textAlign = labelsInside ? 'left' : 'right';
    levels.forEach((level, i) => {
      const y = ys[i]; if (y == null) return;
      const color = colorOf(level);
      ctx.strokeStyle = color; ctx.lineWidth = fib.style.lineWidth || 1;
      ctx.beginPath(); ctx.moveTo(left, Math.round(y) + 0.5); ctx.lineTo(right, Math.round(y) + 0.5); ctx.stroke();
      const parts = [o.showPercentages !== false ? String(Number(level.toFixed(3))) : '', o.showPrices !== false ? `(${fibPrice(priceAt(level))})` : ''].filter(Boolean);
      if (parts.length) { ctx.fillStyle = color; ctx.fillText(parts.join(' '), labelsInside ? left + 4 : labelRight, y - (labelsInside ? 7 : 0)); }
    });
    // The trend line the levels were drawn from.
    ctx.strokeStyle = fib.style.lineColor || '#787b86'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
    if (fib.state === 'selected' || fib.state === 'editing') {
      drawControlPoints(ctx, fib.getControlPoints(viewport) as Parameters<typeof drawControlPoints>[1], null, hr);
    }
  });
}
(FibRetracement.prototype as unknown as { paneViews(this: FibInternals): unknown[] }).paneViews = function paneViews(this: FibInternals) {
  const renderer = { draw: (target: PaneTarget) => drawFib(this, target) };
  return [{ zOrder: () => 'normal', renderer: () => renderer }];
};

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
  // Rectangles read `filled` once at creation and keep it out of their saved
  // options; put it back there so it survives the next save.
  const filled = (data.options as { filled?: boolean } | undefined)?.filled;
  if (drawing && type === 'rectangle' && typeof filled === 'boolean') drawing.updateOptions({ filled } as Partial<IDrawing['options']>);
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

/** zonesExtend: the chart grows extending rectangles with the replay (Backtest workspace). */
export function drawingCapabilities(drawing: IDrawing, { zonesExtend = false } = {}): DrawingPropertiesCapabilities {
  const textTypes = new Set(['rectangle', 'trend-line', 'ray', 'horizontal-line', 'parallel-channel', 'fib-retracement', 'fib-extension', 'arrow', 'text-annotation']);
  return {
    style: true,
    fill: drawing.type === 'rectangle',
    text: textTypes.has(drawing.type),
    coordinates: true,
    visibility: true,
    // Trend lines extend both ways; rays always extend; rectangles only where the chart grows them.
    extendRight: drawing.type === 'trend-line' || (zonesExtend && drawing.type === 'rectangle'),
    extendLeft: drawing.type === 'trend-line',
    lineWidth: drawing.type !== 'text-annotation',
    placement: drawing.type !== 'text-annotation',
  };
}

const LINE_DASH: Record<DrawingPropertiesValue['lineStyle'], number[]> = { solid: [], dashed: [6, 4], dotted: [1.5, 3] };
function lineStyleOf(dash: number[] | undefined): DrawingPropertiesValue['lineStyle'] {
  if (!dash || !dash.length) return 'solid';
  return dash[0] <= 2 ? 'dotted' : 'dashed';
}
function rectangleFilled(drawing: IDrawing) {
  const own = (drawing as { rectangleOptions?: { filled?: boolean } }).rectangleOptions?.filled;
  if (typeof own === 'boolean') return own;
  return Boolean((drawing.options as { filled?: boolean }).filled);
}

export function drawingPropertiesValue(drawing: IDrawing): DrawingPropertiesValue {
  const withText = drawing as DrawingWithText;
  return {
    lineColor: drawing.style.lineColor || '#3b82f6',
    lineWidth: drawing.style.lineWidth || 2,
    fillColor: withText.style.fillHex || (drawing.style.fillColor?.startsWith('#') ? drawing.style.fillColor : '') || drawing.style.lineColor || '#3b82f6',
    fillOpacity: typeof drawing.style.fillOpacity === 'number' ? drawing.style.fillOpacity : 0.12,
    filled: rectangleFilled(drawing),
    lineStyle: lineStyleOf(drawing.style.lineDash),
    text: getDrawingText(drawing),
    textFontSize: withText.style.drawingTextFontSize || (drawing.type === 'text-annotation' ? 14 : 12),
    textBold: Boolean(withText.style.drawingTextBold),
    textItalic: Boolean(withText.style.drawingTextItalic),
    textPlacement: withText.style.drawingTextPlacement || 'inside',
    textAlign: withText.style.drawingTextAlign || 'center',
    // hiddenByUser: hidden from this panel (a replay may also hide drawings for a while).
    visible: (drawing.options as { hiddenByUser?: boolean }).hiddenByUser ? false : drawing.options.visible !== false,
    locked: Boolean(drawing.options.locked),
    extendRight: Boolean(drawing.options.extendRight),
    extendLeft: Boolean(drawing.options.extendLeft),
    anchors: drawing.anchors.map(anchor => ({ time: Number(anchor.time), price: anchor.price })),
  };
}

/**
 * Change a drawing's options so they're also saved: trend lines save a copy
 * of their options taken when they were created, so it gets the change too.
 */
export function setDrawingOptions(drawing: IDrawing, options: Record<string, unknown>) {
  drawing.updateOptions(options as Partial<IDrawing['options']>);
  (drawing as { setTrendLineOptions?: (o: Record<string, unknown>) => void }).setTrendLineOptions?.(options);
}

/** Hidden by the trader (not by a replay that hasn't reached it yet). */
export function isUserHidden(drawing: IDrawing) {
  return Boolean((drawing.options as { hiddenByUser?: boolean }).hiddenByUser);
}
/** Show a drawing the trader hid. */
export function unhideDrawing(drawing: IDrawing) {
  setDrawingOptions(drawing, { visible: true, hiddenByUser: false });
  drawing.requestUpdate();
}

export function applyDrawingProperties(drawing: IDrawing, value: DrawingPropertiesValue) {
  setDrawingText(drawing, value.text);
  drawing.updateStyle({
    lineColor: value.lineColor,
    lineWidth: value.lineWidth,
    lineDash: LINE_DASH[value.lineStyle],
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
  setDrawingOptions(drawing, {
    visible: value.visible,
    hiddenByUser: !value.visible,
    locked: value.locked,
    extendRight: value.extendRight,
    extendLeft: value.extendLeft,
    ...(drawing.type === 'rectangle' ? { filled: value.filled } : {}),
  });
  // The rectangle paints from its own copy of `filled`.
  (drawing as { setRectangleOptions?: (o: { filled: boolean }) => void }).setRectangleOptions?.({ filled: value.filled });
  value.anchors.forEach((anchor, i) => {
    const cur = drawing.anchors[i];
    if (cur && Number.isFinite(anchor.time) && Number.isFinite(anchor.price) && (Number(cur.time) !== anchor.time || cur.price !== anchor.price)) {
      drawing.updateAnchor(i, { ...cur, time: anchor.time as typeof cur.time, price: anchor.price });
    }
  });
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

// ── Room to draw past the last candle ────────────────────────────────────────
// The chart only has times where it has data, so drawings stop at the last
// candle. Empty time slots after it (no prices) give the space on the right
// real times, like Backtest does.
export const FUTURE_SLOTS = 500;
const MAX_FUTURE_SLOTS = 20_000;

/** Typical bar length in seconds (smallest gap among the last candles). */
export function barSeconds(times: number[]) {
  let best = Infinity;
  for (let i = Math.max(1, times.length - 20); i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > 0 && gap < best) best = gap;
  }
  return Number.isFinite(best) ? best : 60;
}

/**
 * Times for the empty slots after `lastTime`: the known upcoming times first
 * (Replay's unrevealed candles), then evenly spaced ones, at least `min` in all
 * and enough to reach the furthest drawing.
 */
export function futureSlotTimes(lastTime: number, bar: number, drawings: SerializedDrawing[], upcoming: number[] = [], min = FUTURE_SLOTS) {
  const furthest = Math.max(0, ...drawings.flatMap(d => d.anchors.map(a => Number(a.time))));
  const out = upcoming.slice(0, MAX_FUTURE_SLOTS);
  let t = out.length ? out[out.length - 1] : lastTime;
  while (out.length < MAX_FUTURE_SLOTS && (out.length < min || t < furthest + 50 * bar)) { t += bar; out.push(t); }
  return out;
}
