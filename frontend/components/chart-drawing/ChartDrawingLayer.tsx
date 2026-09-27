'use client';
// Goes inside the chart's positioned wrapper, over the chart: catches clicks
// while a drawing tool is active, shows drawings' text labels and opens the
// properties panel. Pair with <ChartDrawingToolbar> and useChartDrawings.
import '@/app/backtest/backtest.css';
import type { ISeriesApi } from 'lightweight-charts';
import DrawingPropertiesPanel from '../backtest-tools/DrawingPropertiesPanel';
import DrawingTextOverlay from '../backtest-tools/DrawingTextOverlay';
import { drawingCapabilities, drawingPropertiesValue } from './drawingKit';
import type { ChartDrawings } from './useChartDrawings';

export default function ChartDrawingLayer({ engine }: { engine: ChartDrawings }) {
  const editingDrawing = engine.editing ? engine.getDrawing(engine.editing.drawingId) : null;
  return (
    <>
      <DrawingTextOverlay
        chart={engine.chart}
        series={engine.series as ISeriesApi<'Candlestick'> | null}
        drawings={engine.shownDrawings().filter(d => d.options?.visible !== false)}
        revision={engine.revision}
      />
      <div
        aria-hidden={!engine.capture.active}
        onMouseDown={engine.capture.onMouseDown}
        onMouseMove={engine.capture.onMouseMove}
        onMouseUp={engine.capture.onMouseUp}
        style={{ position: 'absolute', inset: 0, zIndex: 5, pointerEvents: engine.capture.active ? 'auto' : 'none', cursor: engine.capture.active ? 'crosshair' : undefined }}
      />
      {engine.editing && editingDrawing && (
        <div className="bt-scope" style={{ position: 'absolute', inset: 0, zIndex: 30, pointerEvents: 'none' }}>
          <div style={{ pointerEvents: 'auto' }}>
            <DrawingPropertiesPanel
              key={engine.editing.drawingId}
              drawingName={engine.editing.drawingName}
              isNew={engine.editing.isNew}
              capabilities={drawingCapabilities(editingDrawing)}
              value={drawingPropertiesValue(editingDrawing)}
              onSave={engine.saveProperties}
              onCancel={engine.cancelProperties}
            />
          </div>
        </div>
      )}
    </>
  );
}
