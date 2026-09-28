'use client';

import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { SerializedDrawing } from 'lightweight-charts-drawing';

interface DrawingTextOverlayProps {
  chart: IChartApi | null;
  series: ISeriesApi<'Candlestick'> | null;
  drawings: SerializedDrawing[];
  revision: number;
}

type DrawingWithText = SerializedDrawing & {
  style: SerializedDrawing['style'] & {
    drawingText?: string;
    drawingTextFontSize?: number;
    drawingTextBold?: boolean;
    drawingTextItalic?: boolean;
    drawingTextPlacement?: 'inside' | 'above' | 'below';
    drawingTextAlign?: 'left' | 'center' | 'right';
  };
};

/**
 * The chart's background colour (the label's gap in the line uses it) and a
 * text colour that reads on it. A transparent chart uses the first coloured
 * background behind it.
 */
export function labelColors(chart: IChartApi) {
  const opts = chart.options().layout.background as { color?: string };
  let bg = opts?.color && opts.color !== 'transparent' ? opts.color : '';
  for (let el: HTMLElement | null = chart.chartElement(); !bg && el; el = el.parentElement) {
    const c = getComputedStyle(el).backgroundColor;
    if (c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c)) bg = c;
  }
  bg = bg || '#ffffff';
  const probe = document.createElement('canvas').getContext('2d');
  let dark = false;
  if (probe) {
    probe.fillStyle = bg; probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }
  return { background: bg, text: dark ? '#e5e7eb' : '#111827' };
}

// Drawings whose label follows the line: centred on it, turned to its angle.
const LINE_TYPES = new Set(['trend-line', 'ray', 'arrow', 'extended-line', 'info-line', 'horizontal-ray', 'parallel-channel']);

/**
 * Where each drawing's text label sits on the chart (text notes draw their
 * own), TradingView style: on lines, centred on the line itself, turned to
 * its angle, with the line broken behind it (`onLine`); "Above" / "Below"
 * put it just off the line instead. On zones and other shapes, at their
 * centre (or above / below them).
 */
export function drawingLabels(chart: IChartApi, series: ISeriesApi<'Candlestick'>, drawings: SerializedDrawing[]) {
  return (drawings as DrawingWithText[]).flatMap(drawing => {
    if (drawing.type === 'text-annotation' || drawing.options?.visible === false) return [];
    const text = drawing.style.drawingText?.trim();
    if (!text || !drawing.anchors.length) return [];

    const points = drawing.anchors.flatMap(anchor => {
      const x = chart.timeScale().timeToCoordinate(anchor.time);
      const y = series.priceToCoordinate(anchor.price);
      return x == null || y == null ? [] : [{ x: Number(x), y: Number(y) }];
    });
    const fontSize = drawing.style.drawingTextFontSize ?? 12;
    const placement = drawing.style.drawingTextPlacement ?? 'inside';
    const align = drawing.style.drawingTextAlign ?? 'center';
    const base = {
      id: drawing.id, text,
      color: drawing.style.lineColor || '#3b82f6',
      onLine: false,
      fontSize,
      fontWeight: drawing.style.drawingTextBold ? 700 : 600,
      fontStyle: drawing.style.drawingTextItalic ? 'italic' : 'normal',
      textAlign: align,
      translateX: align === 'left' ? '0' : align === 'right' ? '-100%' : '-50%',
    };
    // Gap between the line and the text's centre.
    const gap = fontSize * 0.7 + 3;
    const side = placement === 'below' ? 1 : placement === 'above' ? -1 : 0;

    if (drawing.type === 'horizontal-line') {
      const y = series.priceToCoordinate(drawing.anchors[0].price);
      if (y == null) return [];
      return [{ ...base, onLine: side === 0, x: chart.timeScale().width() / 2, y: Number(y) + side * gap, angle: 0 }];
    }
    if (!points.length) return [];
    if (LINE_TYPES.has(drawing.type) && points.length >= 2) {
      const [a, b] = points;
      let angle = Math.atan2(b.y - a.y, b.x - a.x);
      // Keep the text upright.
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      // Step off the line along its normal: (nx, ny) points below the line on screen.
      const nx = -Math.sin(angle), ny = Math.cos(angle);
      return [{ ...base, onLine: side === 0, x: (a.x + b.x) / 2 + side * nx * gap, y: (a.y + b.y) / 2 + side * ny * gap, angle: angle * 180 / Math.PI }];
    }
    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const yBase = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const y = placement === 'above'
      ? Math.min(...points.map(point => point.y)) - gap
      : placement === 'below'
        ? Math.max(...points.map(point => point.y)) + gap
        : yBase;
    return [{ ...base, x, y, angle: 0 }];
  });
}

/**
 * Paint the labels onto a canvas (chart snapshots: the on-screen labels are
 * page elements, so a chart screenshot doesn't include them). `scale` is the
 * canvas's pixels per chart pixel.
 */
export function paintDrawingLabels(
  ctx: CanvasRenderingContext2D, chart: IChartApi, series: ISeriesApi<'Candlestick'>, drawings: SerializedDrawing[], scale: number,
) {
  const colors = labelColors(chart);
  for (const label of drawingLabels(chart, series, drawings)) {
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(label.x, label.y);
    ctx.rotate(label.angle * Math.PI / 180);
    ctx.font = `${label.fontStyle} ${label.fontWeight} ${label.fontSize}px Inter, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = label.translateX === '0' ? 'left' : label.translateX === '-100%' ? 'right' : 'center';
    const lines = label.text.split('\n');
    const lineH = label.fontSize * 1.3;
    if (label.onLine) {
      // Break the line behind the text.
      const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 12, h = lines.length * lineH + 2;
      const left = ctx.textAlign === 'left' ? -6 : ctx.textAlign === 'right' ? -w + 6 : -w / 2;
      ctx.fillStyle = colors.background;
      ctx.fillRect(left, -h / 2, w, h);
    }
    ctx.fillStyle = label.onLine ? colors.text : label.color;
    lines.forEach((line, i) => ctx.fillText(line, 0, (i - (lines.length - 1) / 2) * lineH));
    ctx.restore();
  }
}

export default function DrawingTextOverlay({
  chart,
  series,
  drawings,
  revision,
}: DrawingTextOverlayProps) {
  void revision;
  if (!chart || !series) return null;
  const labels = drawingLabels(chart, series, drawings);
  const colors = labels.some(label => label.onLine) ? labelColors(chart) : null;

  return (
    <div aria-hidden="true" className="tw:absolute tw:inset-0 tw:z-[4] tw:overflow-hidden tw:pointer-events-none">
      {labels.map(label => (
        <span
          key={label.id}
          className="tw:absolute tw:max-w-72 tw:whitespace-pre-wrap tw:leading-snug tw:px-1.5"
          style={{
            left: label.x,
            top: label.y,
            transform: `translate(${label.translateX}, -50%) rotate(${label.angle}deg)`,
            transformOrigin: label.translateX === '0' ? 'left center' : label.translateX === '-100%' ? 'right center' : 'center',
            color: label.onLine ? colors?.text : label.color,
            background: label.onLine ? colors?.background : undefined,
            fontSize: label.fontSize,
            fontWeight: label.fontWeight,
            fontStyle: label.fontStyle,
            textAlign: label.textAlign,
          }}
        >
          {label.text}
        </span>
      ))}
    </div>
  );
}
