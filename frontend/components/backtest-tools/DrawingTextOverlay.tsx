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

export default function DrawingTextOverlay({
  chart,
  series,
  drawings,
  revision,
}: DrawingTextOverlayProps) {
  void revision;
  if (!chart || !series) return null;

  const labels = (drawings as DrawingWithText[]).flatMap(drawing => {
    if (drawing.type === 'text-annotation') return [];
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
