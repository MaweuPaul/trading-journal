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

/** Where each drawing's text label sits on the chart (text notes draw their own). */
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
    if (!points.length) return [];

    const placement = drawing.style.drawingTextPlacement ?? 'inside';
    const align = drawing.style.drawingTextAlign ?? 'center';
    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const yBase = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const y = placement === 'above'
      ? Math.min(...points.map(point => point.y)) - 18
      : placement === 'below'
        ? Math.max(...points.map(point => point.y)) + 18
        : yBase;
    const translateX = align === 'left' ? '0' : align === 'right' ? '-100%' : '-50%';
    return [{
      id: drawing.id,
      text,
      x,
      y,
      translateX,
      color: drawing.style.lineColor,
      fontSize: drawing.style.drawingTextFontSize ?? 12,
      fontWeight: drawing.style.drawingTextBold ? 700 : 600,
      fontStyle: drawing.style.drawingTextItalic ? 'italic' : 'normal',
      textAlign: align,
    }];
  });
}

/**
 * Paint the labels onto a canvas (chart snapshots: the on-screen labels are
 * page elements, so a chart screenshot doesn't include them). `scale` is the
 * canvas's pixels per chart pixel.
 */
export function paintDrawingLabels(
  ctx: CanvasRenderingContext2D, chart: IChartApi, series: ISeriesApi<'Candlestick'>, drawings: SerializedDrawing[],
  scale: number, colors: { background: string; text: string },
) {
  for (const label of drawingLabels(chart, series, drawings)) {
    ctx.save();
    ctx.scale(scale, scale);
    ctx.font = `${label.fontStyle} ${label.fontWeight} ${label.fontSize}px Inter, system-ui, sans-serif`;
    const lines = label.text.split('\n');
    const lineH = label.fontSize * 1.35;
    const w = Math.min(224, Math.max(...lines.map(l => ctx.measureText(l).width)) + 16);
    const h = lines.length * lineH + 8;
    const left = label.translateX === '0' ? label.x : label.translateX === '-100%' ? label.x - w : label.x - w / 2;
    const top = label.y - h / 2;
    ctx.fillStyle = colors.background;
    ctx.strokeStyle = label.color || '#3b82f6';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(left, top, w, h, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = colors.text; ctx.textBaseline = 'middle';
    ctx.textAlign = label.textAlign;
    const tx = label.textAlign === 'left' ? left + 8 : label.textAlign === 'right' ? left + w - 8 : left + w / 2;
    lines.forEach((l, i) => ctx.fillText(l, tx, top + 4 + lineH * (i + 0.5), w - 16));
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
          className="tw:absolute tw:max-w-56 tw:-translate-y-1/2 tw:whitespace-pre-wrap tw:rounded-md tw:border tw:bg-surface-container-lowest/90 tw:px-2 tw:py-1 tw:leading-snug tw:text-on-surface tw:shadow-md tw:backdrop-blur-sm"
          style={{
            left: label.x,
            top: label.y,
            transform: `translate(${label.translateX}, -50%)`,
            borderColor: label.color,
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
