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
  style: SerializedDrawing['style'] & { drawingText?: string };
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

    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    return [{ id: drawing.id, text, x, y, color: drawing.style.lineColor }];
  });

  return (
    <div aria-hidden="true" className="tw:absolute tw:inset-0 tw:z-[4] tw:overflow-hidden tw:pointer-events-none">
      {labels.map(label => (
        <span
          key={label.id}
          className="tw:absolute tw:max-w-56 tw:-translate-x-1/2 tw:-translate-y-1/2 tw:whitespace-pre-wrap tw:rounded-md tw:border tw:bg-surface-container-lowest/90 tw:px-2 tw:py-1 tw:text-center tw:text-xs tw:font-semibold tw:leading-snug tw:text-on-surface tw:shadow-md tw:backdrop-blur-sm"
          style={{ left: label.x, top: label.y, borderColor: label.color }}
        >
          {label.text}
        </span>
      ))}
    </div>
  );
}
