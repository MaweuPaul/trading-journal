'use client';
// The vertical drawing toolbar (same look as the Backtest workspace), for any
// chart using useChartDrawings. `extra` adds chart-specific buttons (e.g. pin
// an image) above the undo/clear group.
import '@/app/backtest/backtest.css';
import type { ReactNode } from 'react';
import { Icon } from '../backtest/BacktestShell';
import { DRAWING_SWATCHES, DRAWING_TOOLS } from './drawingKit';
import type { ChartDrawings } from './useChartDrawings';

const btn = 'tw:w-9 tw:h-9 tw:rounded-lg tw:flex tw:items-center tw:justify-center tw:shrink-0 tw:transition-colors';
const idle = 'tw:text-on-surface-variant tw:hover:bg-surface-container-high tw:hover:text-on-surface';

export default function ChartDrawingToolbar({ engine, extra, className = '' }: { engine: ChartDrawings; extra?: ReactNode; className?: string }) {
  const ready = Boolean(engine.chart);
  return (
    <aside className={`bt-scope tw:w-12 tw:bg-surface-container-low tw:border-r tw:border-surface-container-highest tw:flex tw:flex-col tw:items-center tw:py-2 tw:gap-1 tw:shrink-0 tw:overflow-y-auto no-scrollbar ${className}`} aria-label="Drawing tools">
      <button type="button" title="Crosshair / select" aria-label="Crosshair / select" aria-pressed={!engine.activeTool} disabled={!ready}
        onClick={() => engine.activateTool(null)}
        className={`${btn} ${!engine.activeTool ? 'tw:bg-primary/15 tw:text-primary' : idle}`}>
        <Icon name="filter_center_focus" className="tw:text-[20px]" />
      </button>
      {DRAWING_TOOLS.map(t => (
        <button key={t.id} type="button" title={t.label} aria-label={t.label} aria-pressed={engine.activeTool === t.id} disabled={!ready}
          onClick={() => engine.activateTool(t.id)}
          className={`${btn} tw:disabled:opacity-40 ${engine.activeTool === t.id ? 'tw:bg-primary/15 tw:text-primary' : idle}`}>
          <Icon name={t.icon} className="tw:text-[20px]" />
        </button>
      ))}
      <button type="button" title={engine.magnet ? 'Magnet on: snaps to candle open/high/low/close' : 'Magnet off'} aria-label="Magnet" aria-pressed={engine.magnet}
        onClick={() => engine.setMagnet(!engine.magnet)}
        className={`${btn} ${engine.magnet ? 'tw:bg-primary/15 tw:text-primary' : idle}`}>
        <Icon name="all_inclusive" className="tw:text-[20px]" />
      </button>
      <div className="tw:w-6 tw:h-px tw:bg-surface-container-highest tw:my-1 tw:shrink-0" />
      {extra}
      {engine.selectedId && (
        <>
          <button type="button" onClick={engine.editSelected} title="Edit drawing (text, style, coordinates)" aria-label="Edit drawing"
            className={`${btn} tw:text-on-surface-variant tw:hover:bg-primary/15 tw:hover:text-primary`}>
            <Icon name="edit_note" className="tw:text-[20px]" />
          </button>
          <button type="button" onClick={engine.deleteSelected} title="Delete selected drawing (Delete)" aria-label="Delete selected drawing"
            className={`${btn} tw:text-on-surface-variant tw:hover:bg-error/20 tw:hover:text-error`}>
            <Icon name="delete" className="tw:text-[20px]" />
          </button>
        </>
      )}
      <button type="button" onClick={engine.undo} disabled={!engine.canUndo} title="Undo" aria-label="Undo drawing"
        className={`${btn} ${idle} tw:disabled:opacity-40`}>
        <Icon name="undo" className="tw:text-[20px]" />
      </button>
      <button type="button" onClick={engine.clearAll} disabled={!engine.count} title="Clear all drawings" aria-label="Clear all drawings"
        className={`${btn} tw:text-on-surface-variant tw:hover:bg-error/20 tw:hover:text-error tw:disabled:opacity-40`}>
        <Icon name="delete_sweep" className="tw:text-[20px]" />
      </button>
      <div className="tw:w-6 tw:h-px tw:bg-surface-container-highest tw:my-1 tw:shrink-0" />
      <div className="tw:flex tw:flex-col tw:items-center tw:gap-1 tw:p-1 tw:bg-surface-container-lowest tw:rounded" role="radiogroup" aria-label="Drawing color">
        {DRAWING_SWATCHES.map(s => (
          <button key={s.color} type="button" role="radio" aria-checked={engine.color === s.color} aria-label={s.label} title={s.label} onClick={() => engine.pickColor(s.color)}
            className={`tw:w-5 tw:h-5 tw:rounded-full tw:shrink-0 tw:border-2 ${s.cls} ${engine.color === s.color ? 'tw:border-on-surface' : 'tw:border-transparent'}`} />
        ))}
      </div>
    </aside>
  );
}
