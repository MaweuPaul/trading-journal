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

// Drawings whose label follows the line: centred on it, turned to its angle.
const LINE_TYPES = new Set(['trend-line', 'ray', 'arrow', 'extended-line', 'info-line', 'horizontal-ray', 'parallel-channel']);

/**
 * Where each drawing's text label sits on the chart (text notes draw their
 * own). Plain text in the drawing's colour: on lines, centred on the line
 * just above it (below with "Below") and turned to its angle; on zones and
 * other shapes, at their centre (or above / below them).
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
      fontSize,
      fontWeight: drawing.style.drawingTextBold ? 700 : 600,
      fontStyle: drawing.style.drawingTextItalic ? 'italic' : 'normal',
      textAlign: align,
      translateX: align === 'left' ? '0' : align === 'right' ? '-100%' : '-50%',
    };
    // Gap between the line and the text's centre.
    const gap = fontSize * 0.7 + 3;
    const side = placement === 'below' ? 1 : -1;

    if (drawing.type === 'horizontal-line') {
      const y = series.priceToCoordinate(drawing.anchors[0].price);
      if (y == null) return [];
      return [{ ...base, x: chart.timeScale().width() / 2, y: Number(y) + side * gap, angle: 0 }];
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
      return [{ ...base, x: (a.x + b.x) / 2 + side * nx * gap, y: (a.y + b.y) / 2 + side * ny * gap, angle: angle * 180 / Math.PI }];
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
  for (const label of drawingLabels(chart, series, drawings)) {
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(label.x, label.y);
    ctx.rotate(label.angle * Math.PI / 180);
    ctx.font = `${label.fontStyle} ${label.fontWeight} ${label.fontSize}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = label.color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = label.translateX === '0' ? 'left' : label.translateX === '-100%' ? 'right' : 'center';
    const lines = label.text.split('\n');
    const lineH = label.fontSize * 1.3;
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

  return (
    <div aria-hidden="true" className="tw:absolute tw:inset-0 tw:z-[4] tw:overflow-hidden tw:pointer-events-none">
      {labels.map(label => (
        <span
          key={label.id}
          className="tw:absolute tw:max-w-72 tw:whitespace-pre-wrap tw:leading-snug"
          style={{
            left: label.x,
            top: label.y,
            transform: `translate(${label.translateX}, -50%) rotate(${label.angle}deg)`,
            transformOrigin: label.translateX === '0' ? 'left center' : label.translateX === '-100%' ? 'right center' : 'center',
            color: label.color,
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
