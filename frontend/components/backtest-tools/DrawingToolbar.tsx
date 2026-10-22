'use client';
// TradingView-style floating toolbar for the selected drawing: colour, line
// width and style, then settings, clone, lock, hide and delete.
import { useState } from 'react';
import type { DrawingPropertiesValue } from './DrawingPropertiesPanel';

const COLORS = ['#2962ff', '#089981', '#f23645', '#ff9800', '#9c27b0', '#00bcd4', '#e91e63', '#ffeb3b', '#787b86', '#ffffff', '#000000', '#4caf50'];
const WIDTHS = [1, 2, 3, 4];
const STYLES: { id: DrawingPropertiesValue['lineStyle']; dash: string }[] = [
  { id: 'solid', dash: '' }, { id: 'dashed', dash: '6 4' }, { id: 'dotted', dash: '1.5 3' },
];

export interface DrawingToolbarProps {
  name: string;
  value: DrawingPropertiesValue;
  canSetWidth: boolean;
  onChange: (patch: Partial<DrawingPropertiesValue>) => void;
  onSettings: () => void;
  onClone: () => void;
  onDelete: () => void;
}

type Menu = 'color' | 'width' | 'style' | null;

function MaterialIcon({ name }: { name: string }) {
  return <span className="material-symbols-outlined" style={{ fontSize: 18, lineHeight: 1 }} aria-hidden>{name}</span>;
}

export default function DrawingToolbar(p: DrawingToolbarProps) {
  const [menu, setMenu] = useState<Menu>(null);
  const v = p.value;
  const btn = 'tw:h-8 tw:min-w-8 tw:px-1.5 tw:flex tw:items-center tw:justify-center tw:gap-1 tw:rounded tw:text-on-surface tw:hover:bg-surface-container-high';
  const sep = <span className="tw:w-px tw:h-5 tw:bg-outline-variant tw:mx-0.5" aria-hidden />;
  const popover = 'tw:absolute tw:top-full tw:mt-1 tw:z-50 tw:bg-surface-container tw:border tw:border-outline-variant tw:rounded-lg tw:shadow-xl tw:p-1.5';
  const toggle = (m: Menu) => setMenu(cur => (cur === m ? null : m));

  return (
    <div role="toolbar" aria-label={`${p.name} toolbar`}
      className="tw:absolute tw:top-2 tw:left-1/2 tw:-translate-x-1/2 tw:z-30 tw:flex tw:items-center tw:gap-0.5 tw:px-1 tw:py-0.5 tw:bg-surface-container tw:border tw:border-outline-variant tw:rounded-lg tw:shadow-lg tw:select-none"
      onMouseDown={e => e.stopPropagation()}>
      <span className="tw:px-1.5 tw:text-[11px] tw:text-on-surface-variant tw:whitespace-nowrap">{p.name}</span>
      {sep}
      {/* Colour */}
      <div className="tw:relative">
        <button type="button" className={btn} title="Line color" aria-label="Line color" aria-expanded={menu === 'color'} onClick={() => toggle('color')}>
          <span className="tw:flex tw:flex-col tw:items-center">
            <MaterialIcon name="edit" />
            <span className="tw:block tw:w-4 tw:h-[3px] tw:rounded-sm tw:-mt-0.5" style={{ background: v.lineColor }} />
          </span>
        </button>
        {menu === 'color' && (
          <div className={`${popover} tw:left-0 tw:grid tw:grid-cols-6 tw:gap-1 tw:w-[172px]`} role="listbox" aria-label="Colors">
            {COLORS.map(c => (
              <button key={c} type="button" role="option" aria-selected={v.lineColor.toLowerCase() === c} title={c}
                onClick={() => { p.onChange({ lineColor: c, fillColor: c }); setMenu(null); }}
                className={`tw:w-6 tw:h-6 tw:rounded tw:border ${v.lineColor.toLowerCase() === c ? 'tw:ring-2 tw:ring-primary tw:border-transparent' : 'tw:border-outline-variant'}`}
                style={{ background: c }} />
            ))}
          </div>
        )}
      </div>
      {/* Line width */}
      {p.canSetWidth && (
        <div className="tw:relative">
          <button type="button" className={btn} title="Line width" aria-label="Line width" aria-expanded={menu === 'width'} onClick={() => toggle('width')}>
            <span className="tw:block tw:w-4 tw:bg-on-surface tw:rounded-sm" style={{ height: Math.max(1, v.lineWidth) }} />
            <span className="tw:text-[11px] tw:font-mono-metric-md">{v.lineWidth}px</span>
          </button>
          {menu === 'width' && (
            <div className={`${popover} tw:left-0 tw:flex tw:flex-col tw:w-24`}>
              {WIDTHS.map(w => (
                <button key={w} type="button" onClick={() => { p.onChange({ lineWidth: w }); setMenu(null); }}
                  className={`tw:flex tw:items-center tw:gap-2 tw:px-2 tw:py-1.5 tw:rounded tw:hover:bg-surface-container-high ${v.lineWidth === w ? 'tw:bg-surface-container-high' : ''}`}>
                  <span className="tw:block tw:w-8 tw:bg-on-surface tw:rounded-sm" style={{ height: w }} /><span className="tw:text-[11px]">{w}px</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Line style */}
      {p.canSetWidth && (
        <div className="tw:relative">
          <button type="button" className={btn} title="Line style" aria-label="Line style" aria-expanded={menu === 'style'} onClick={() => toggle('style')}>
            <svg width="20" height="8" aria-hidden><line x1="1" y1="4" x2="19" y2="4" stroke="currentColor" strokeWidth="2" strokeDasharray={STYLES.find(s => s.id === v.lineStyle)?.dash} /></svg>
          </button>
          {menu === 'style' && (
            <div className={`${popover} tw:left-0 tw:flex tw:flex-col tw:w-28`}>
              {STYLES.map(s => (
                <button key={s.id} type="button" onClick={() => { p.onChange({ lineStyle: s.id }); setMenu(null); }}
                  className={`tw:flex tw:items-center tw:gap-2 tw:px-2 tw:py-1.5 tw:rounded tw:hover:bg-surface-container-high tw:capitalize ${v.lineStyle === s.id ? 'tw:bg-surface-container-high' : ''}`}>
                  <svg width="32" height="6" aria-hidden><line x1="1" y1="3" x2="31" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray={s.dash} /></svg>
                  <span className="tw:text-[11px]">{s.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {sep}
      <button type="button" className={btn} title="Settings (text, coordinates, visibility)" aria-label="Settings" onClick={p.onSettings}><MaterialIcon name="settings" /></button>
      <button type="button" className={btn} title="Clone (Ctrl+D) · copy Ctrl+C, paste Ctrl+V" aria-label="Clone" onClick={p.onClone}><MaterialIcon name="content_copy" /></button>
      <button type="button" className={btn} title={v.locked ? 'Unlock' : 'Lock (stops it being moved)'} aria-label={v.locked ? 'Unlock' : 'Lock'} aria-pressed={v.locked} onClick={() => p.onChange({ locked: !v.locked })}>
        <MaterialIcon name={v.locked ? 'lock' : 'lock_open'} />
      </button>
      <button type="button" className={btn} title="Hide" aria-label="Hide" onClick={() => p.onChange({ visible: false })}><MaterialIcon name="visibility_off" /></button>
      <button type="button" className={`${btn} tw:hover:text-error`} title="Delete (Del)" aria-label="Delete" onClick={p.onDelete}><MaterialIcon name="delete" /></button>
    </div>
  );
}
