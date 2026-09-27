'use client';

import { FormEvent, KeyboardEvent, MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../backtest/BacktestShell';

export interface DrawingPropertiesCapabilities {
  style?: boolean;
  fill?: boolean;
  text?: boolean;
  coordinates?: boolean;
  visibility?: boolean;
  extendRight?: boolean;
  /** false hides the line width picker (e.g. text notes). */
  lineWidth?: boolean;
  /** false hides the inside/above/below text placement (e.g. text notes). */
  placement?: boolean;
}

export interface DrawingPropertiesValue {
  lineColor: string;
  lineWidth: number;
  fillColor: string;
  fillOpacity: number;
  filled: boolean;
  text: string;
  textFontSize: number;
  textBold: boolean;
  textItalic: boolean;
  textPlacement: 'inside' | 'above' | 'below';
  textAlign: 'left' | 'center' | 'right';
  visible: boolean;
  locked: boolean;
  extendRight: boolean;
  anchors: { time: string; price: number }[];
}

interface DrawingPropertiesPanelProps {
  drawingName: string;
  isNew?: boolean;
  capabilities: DrawingPropertiesCapabilities;
  value: DrawingPropertiesValue;
  onSave: (value: DrawingPropertiesValue) => void;
  onCancel: () => void;
  initialTab?: TabId;
}

type TabId = 'style' | 'text' | 'coordinates' | 'visibility';

const LINE_WIDTHS = [1, 2, 3, 4, 5];
const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20];
const COLOR_SWATCHES = ['#000000', '#3b82f6', '#16a34a', '#dc2626', '#f59e0b', '#8b5cf6'];

function clampPercent(value: number) {
  return Math.max(0, Math.min(1, value));
}

export default function DrawingPropertiesPanel({
  drawingName,
  isNew = false,
  capabilities,
  value,
  onSave,
  onCancel,
  initialTab,
}: DrawingPropertiesPanelProps) {
  const tabs = useMemo(() => ([
    capabilities.style ? { id: 'style' as const, label: 'Style' } : null,
    capabilities.text ? { id: 'text' as const, label: 'Text' } : null,
    capabilities.coordinates ? { id: 'coordinates' as const, label: 'Coordinates' } : null,
    capabilities.visibility ? { id: 'visibility' as const, label: 'Visibility' } : null,
  ].filter(Boolean) as { id: TabId; label: string }[]), [capabilities]);
  const [activeTab, setActiveTab] = useState<TabId>(tabs.some(tab => tab.id === initialTab) ? initialTab! : tabs[0]?.id ?? 'style');
  const [draft, setDraft] = useState(value);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (activeTab !== 'text') return;
    // After the click that opened the panel has finished (it would take focus back).
    const timer = window.setTimeout(() => textRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [activeTab]);

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onCancel]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ ...draft, text: draft.text.trim().slice(0, 160), fillOpacity: clampPercent(draft.fillOpacity) });
  };

  const handleTextKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSave({ ...draft, text: draft.text.trim().slice(0, 160), fillOpacity: clampPercent(draft.fillOpacity) });
    }
  };

  const stopChartInteraction = (event: MouseEvent) => {
    event.stopPropagation();
  };

  const update = <K extends keyof DrawingPropertiesValue>(key: K, nextValue: DrawingPropertiesValue[K]) => {
    setDraft(current => ({ ...current, [key]: nextValue }));
  };

  return (
    <div className="tw:absolute tw:inset-0 tw:z-50 tw:flex tw:items-start tw:justify-center tw:px-3 tw:pt-3">
      <button
        type="button"
        aria-label="Close drawing properties"
        onMouseDown={event => {
          event.preventDefault();
          onCancel();
        }}
        className="tw:absolute tw:inset-0 tw:cursor-default"
      />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawing-properties-title"
        onSubmit={submit}
        onMouseDown={stopChartInteraction}
        onClick={stopChartInteraction}
        className="tw:relative tw:w-full tw:max-w-[476px] tw:overflow-hidden tw:rounded-lg tw:border tw:border-outline-variant tw:bg-surface-container-lowest tw:shadow-2xl"
      >
        <div className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:px-6 tw:pt-5">
          <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
            <h3 id="drawing-properties-title" className="tw:truncate tw:text-2xl tw:font-bold tw:leading-tight tw:text-on-surface">
              {drawingName}
            </h3>
            <Icon name="edit" className="tw:text-[20px] tw:text-on-surface-variant" />
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close drawing properties"
            className="tw:flex tw:h-10 tw:w-10 tw:items-center tw:justify-center tw:rounded-md tw:text-on-surface-variant tw:hover:bg-surface-container-high tw:hover:text-on-surface"
          >
            <Icon name="close" className="tw:text-[24px]" />
          </button>
        </div>

        <div className="tw:px-6 tw:pt-4">
          <div className="tw:flex tw:gap-6 tw:border-b tw:border-outline-variant">
            {tabs.map(tab => (
              <button
                key={tab.id}
                type="button"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`tw:-mb-px tw:border-b-4 tw:px-0 tw:pb-2 tw:text-lg tw:font-semibold tw:transition-colors ${activeTab === tab.id ? 'tw:border-on-surface tw:text-on-surface' : 'tw:border-transparent tw:text-on-surface-variant tw:hover:text-on-surface'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="tw:min-h-[224px] tw:px-6 tw:py-7">
          {activeTab === 'style' && capabilities.style && (
            <div className="tw:flex tw:flex-col tw:gap-5">
              <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-3">
                <label className="tw:flex tw:h-11 tw:w-11 tw:items-center tw:justify-center tw:rounded-md tw:border tw:border-outline-variant tw:bg-surface-container">
                  <span className="tw:sr-only">Line color</span>
                  <input type="color" value={draft.lineColor} onChange={event => update('lineColor', event.target.value)} className="tw:h-8 tw:w-8 tw:cursor-pointer tw:border-0 tw:bg-transparent tw:p-0" />
                </label>
                {capabilities.lineWidth !== false && (
                  <select value={draft.lineWidth} onChange={event => update('lineWidth', Number(event.target.value))} aria-label="Line width" className="tw:h-11 tw:rounded-lg tw:border tw:border-outline-variant tw:bg-surface-container-lowest tw:px-3 tw:text-base tw:text-on-surface">
                    {LINE_WIDTHS.map(width => <option key={width} value={width}>{width}</option>)}
                  </select>
                )}
                <div className="tw:flex tw:flex-wrap tw:gap-2">
                  {COLOR_SWATCHES.map(color => (
                    <button key={color} type="button" aria-label={'Use ' + color} onClick={() => update('lineColor', color)} className={`tw:h-8 tw:w-8 tw:rounded-full tw:border-2 ${draft.lineColor.toLowerCase() === color ? 'tw:border-on-surface' : 'tw:border-outline-variant'}`} style={{ background: color }} />
                  ))}
                </div>
              </div>
              {capabilities.fill && (
                <div className="tw:grid tw:grid-cols-1 tw:gap-4 tw:sm:grid-cols-2">
                  <label className="tw:flex tw:items-center tw:gap-3 tw:text-base tw:font-semibold tw:text-on-surface">
                    <input type="checkbox" checked={draft.filled} onChange={event => update('filled', event.target.checked)} className="tw:h-5 tw:w-5" />
                    Fill zone
                  </label>
                  <label className="tw:flex tw:flex-col tw:gap-2 tw:text-sm tw:font-semibold tw:text-on-surface-variant">
                    Fill opacity
                    <input type="range" min="0" max="100" value={Math.round(draft.fillOpacity * 100)} onChange={event => update('fillOpacity', Number(event.target.value) / 100)} />
                  </label>
                </div>
              )}
            </div>
          )}

          {activeTab === 'text' && capabilities.text && (
            <div className="tw:flex tw:flex-col tw:gap-5">
              <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                <select value={draft.textFontSize} onChange={event => update('textFontSize', Number(event.target.value))} aria-label="Text size" className="tw:h-11 tw:rounded-lg tw:border tw:border-outline-variant tw:bg-surface-container-lowest tw:px-3 tw:text-base tw:text-on-surface">
                  {FONT_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
                </select>
                <button type="button" aria-pressed={draft.textBold} onClick={() => update('textBold', !draft.textBold)} className={`tw:h-11 tw:w-11 tw:rounded-lg tw:text-lg tw:font-bold ${draft.textBold ? 'tw:bg-on-surface-variant tw:text-surface-container-lowest' : 'tw:border tw:border-outline-variant tw:text-on-surface'}`}>B</button>
                <button type="button" aria-pressed={draft.textItalic} onClick={() => update('textItalic', !draft.textItalic)} className={`tw:h-11 tw:w-11 tw:rounded-lg tw:text-lg tw:italic ${draft.textItalic ? 'tw:bg-on-surface-variant tw:text-surface-container-lowest' : 'tw:border tw:border-outline-variant tw:text-on-surface'}`}>I</button>
              </div>
              <textarea
                ref={textRef}
                value={draft.text}
                maxLength={160}
                rows={4}
                aria-label={'Text for ' + drawingName}
                placeholder="Add text"
                onChange={event => update('text', event.target.value)}
                onKeyDown={handleTextKeyDown}
                className="tw:w-full tw:resize-none tw:rounded-lg tw:border-2 tw:border-primary tw:bg-surface-container-lowest tw:px-3 tw:py-2 tw:text-base tw:text-on-surface tw:caret-primary tw:outline-none tw:placeholder:text-on-surface-variant/70"
              />
              {capabilities.placement !== false && <div className="tw:grid tw:grid-cols-1 tw:gap-3 tw:sm:grid-cols-2">
                <label className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:text-base tw:font-semibold tw:text-on-surface">
                  Text alignment
                  <select value={draft.textPlacement} onChange={event => update('textPlacement', event.target.value as DrawingPropertiesValue['textPlacement'])} className="tw:h-11 tw:min-w-32 tw:rounded-lg tw:border tw:border-outline-variant tw:bg-surface-container-lowest tw:px-3 tw:text-base tw:font-normal">
                    <option value="inside">Inside</option>
                    <option value="above">Above</option>
                    <option value="below">Below</option>
                  </select>
                </label>
                <select value={draft.textAlign} onChange={event => update('textAlign', event.target.value as DrawingPropertiesValue['textAlign'])} aria-label="Horizontal text alignment" className="tw:h-11 tw:rounded-lg tw:border tw:border-outline-variant tw:bg-surface-container-lowest tw:px-3 tw:text-base tw:text-on-surface">
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </div>}
            </div>
          )}

          {activeTab === 'coordinates' && capabilities.coordinates && (
            <div className="tw:grid tw:grid-cols-1 tw:gap-3 tw:sm:grid-cols-2">
              {draft.anchors.map((anchor, index) => (
                <div key={index} className="tw:rounded-lg tw:border tw:border-outline-variant tw:bg-surface-container tw:p-3">
                  <div className="tw:text-xs tw:font-semibold tw:uppercase tw:text-on-surface-variant">Point {index + 1}</div>
                  <div className="tw:mt-2 tw:font-mono tw:text-sm tw:text-on-surface">{anchor.time}</div>
                  <div className="tw:font-mono tw:text-sm tw:text-on-surface">{anchor.price.toFixed(2)}</div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'visibility' && capabilities.visibility && (
            <div className="tw:flex tw:flex-col tw:gap-4">
              <label className="tw:flex tw:items-center tw:justify-between tw:gap-4 tw:text-base tw:font-semibold tw:text-on-surface">
                Visible
                <input type="checkbox" checked={draft.visible} onChange={event => update('visible', event.target.checked)} className="tw:h-5 tw:w-5" />
              </label>
              <label className="tw:flex tw:items-center tw:justify-between tw:gap-4 tw:text-base tw:font-semibold tw:text-on-surface">
                Locked
                <input type="checkbox" checked={draft.locked} onChange={event => update('locked', event.target.checked)} className="tw:h-5 tw:w-5" />
              </label>
              {capabilities.extendRight && (
                <label className="tw:flex tw:items-center tw:justify-between tw:gap-4 tw:text-base tw:font-semibold tw:text-on-surface">
                  Extend right
                  <input type="checkbox" checked={draft.extendRight} onChange={event => update('extendRight', event.target.checked)} className="tw:h-5 tw:w-5" />
                </label>
              )}
            </div>
          )}
        </div>

        <div className="tw:flex tw:items-center tw:justify-between tw:border-t tw:border-outline-variant tw:px-6 tw:py-5">
          <span />
          <div className="tw:flex tw:items-center tw:gap-3">
            <button type="button" onClick={onCancel} className="tw:h-11 tw:rounded-lg tw:border tw:border-on-surface tw:px-4 tw:text-base tw:font-semibold tw:text-on-surface hover:tw:bg-surface-container-high">
              Cancel
            </button>
            <button type="submit" className="tw:h-11 tw:rounded-lg tw:bg-on-surface tw:px-5 tw:text-base tw:font-semibold tw:text-surface-container-lowest tw:shadow-sm hover:tw:brightness-110">
              {isNew && !draft.text.trim() ? 'Discard' : 'Ok'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
