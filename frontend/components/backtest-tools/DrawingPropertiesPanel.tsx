'use client';

import { FormEvent, KeyboardEvent, MouseEvent, PointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../backtest/BacktestShell';

export interface DrawingPropertiesCapabilities {
  style?: boolean;
  fill?: boolean;
  text?: boolean;
  coordinates?: boolean;
  visibility?: boolean;
  extendRight?: boolean;
  extendLeft?: boolean;
  /** false hides the line width picker (e.g. text notes). */
  lineWidth?: boolean;
  /** false hides the inside/above/below text placement (e.g. text notes). */
  placement?: boolean;
}

export type LineStyle = 'solid' | 'dashed' | 'dotted';

export interface DrawingPropertiesValue {
  lineColor: string;
  lineWidth: number;
  lineStyle: LineStyle;
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
  extendLeft: boolean;
  /** time: unix seconds (shown, not edited: it has to sit on a candle); price: editable. */
  anchors: { time: number; price: number }[];
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

const LINE_WIDTHS = [1, 2, 3, 4];
const LINE_STYLES: { id: LineStyle; label: string; dash: string }[] = [
  { id: 'solid', label: 'Solid', dash: '' },
  { id: 'dashed', label: 'Dashed', dash: '6 4' },
  { id: 'dotted', label: 'Dotted', dash: '1.5 3' },
];
const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20];
const COLOR_SWATCHES = ['#3b82f6', '#16a34a', '#dc2626', '#f59e0b', '#8b5cf6', '#14b8a6', '#64748b', '#000000'];
const whenUtc = (sec: number) => (Number.isFinite(sec) && sec > 0
  ? new Date(sec * 1000).toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' UTC'
  : '—');

function clampPercent(value: number) {
  return Math.max(0, Math.min(1, value));
}

// Where the panel was last dragged to (offset from its centred spot), so it reopens there.
let lastOffset = { x: 0, y: 0 };

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

  // Drag by the title bar, kept inside the chart so it can't be lost off-screen.
  // The position is written straight onto the form, so moving doesn't re-render the panel.
  const formRef = useRef<HTMLFormElement>(null);
  const offset = useRef(lastOffset);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; from: { x: number; y: number } } | null>(null);
  const moveTo = (next: { x: number; y: number }) => {
    const form = formRef.current, area = form?.parentElement;
    if (!form || !area) return;
    const a = area.getBoundingClientRect(), f = form.getBoundingClientRect();
    // Where the form sits with no offset: its current box minus the current offset.
    const baseLeft = f.left - offset.current.x, baseTop = f.top - offset.current.y;
    offset.current = {
      x: Math.min(Math.max(next.x, a.left - baseLeft), a.right - f.width - baseLeft),
      y: Math.min(Math.max(next.y, a.top - baseTop), Math.max(a.top - baseTop, a.bottom - f.height - baseTop)),
    };
    form.style.transform = `translate(${offset.current.x}px, ${offset.current.y}px)`;
  };
  // A remembered spot may not fit a smaller chart (or the dual-chart pane): pull it back in.
  useLayoutEffect(() => { moveTo(offset.current); }, []);
  const onDragStart = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, from: offset.current };
  };
  const onDragMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    moveTo({ x: d.from.x + event.clientX - d.startX, y: d.from.y + event.clientY - d.startY });
  };
  const onDragEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    lastOffset = offset.current;
  };

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

  const finish = () => onSave({ ...draft, text: draft.text.trim().slice(0, 160), fillOpacity: clampPercent(draft.fillOpacity) });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    finish();
  };
  // Only an empty new text note has nothing to keep.
  const discards = isNew && drawingName === 'Text note' && !draft.text.trim();
  const tabIds = tabs.map(tab => tab.id);
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const i = tabIds.indexOf(activeTab);
    setActiveTab(tabIds[(i + (event.key === 'ArrowRight' ? 1 : tabIds.length - 1)) % tabIds.length]);
  };

  const handleTextKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      finish();
    }
  };

  const stopChartInteraction = (event: MouseEvent) => {
    event.stopPropagation();
  };

  const update = <K extends keyof DrawingPropertiesValue>(key: K, nextValue: DrawingPropertiesValue[K]) => {
    setDraft(current => ({ ...current, [key]: nextValue }));
  };

  const row = 'tw:grid tw:grid-cols-[88px_1fr] tw:items-center tw:gap-3';
  const rowLabel = 'tw:text-sm tw:font-medium tw:text-on-surface-variant';
  const control = 'tw:h-9 tw:rounded-md tw:border tw:border-outline-variant tw:bg-surface-container-lowest tw:px-2.5 tw:text-sm tw:text-on-surface';
  const segment = (on: boolean) => `tw:h-9 tw:min-w-9 tw:px-2 tw:flex tw:items-center tw:justify-center tw:text-sm tw:transition-colors ${on ? 'tw:bg-primary/15 tw:text-primary' : 'tw:text-on-surface-variant tw:hover:bg-surface-container-high tw:hover:text-on-surface'}`;
  const toggle = 'tw:flex tw:items-center tw:justify-between tw:gap-4 tw:py-1 tw:text-sm tw:text-on-surface tw:cursor-pointer';
  const swatches = (current: string, pick: (c: string) => void, label: string) => (
    <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-1.5" role="radiogroup" aria-label={label}>
      {COLOR_SWATCHES.map(color => (
        <button key={color} type="button" role="radio" aria-checked={current.toLowerCase() === color} aria-label={label + ' ' + color} title={color} onClick={() => pick(color)}
          className={`tw:h-6 tw:w-6 tw:rounded-full tw:ring-offset-2 tw:ring-offset-surface-container-lowest ${current.toLowerCase() === color ? 'tw:ring-2 tw:ring-on-surface' : 'tw:ring-1 tw:ring-outline-variant'}`} style={{ background: color }} />
      ))}
      <label className="tw:relative tw:h-6 tw:w-6 tw:rounded-full tw:overflow-hidden tw:ring-1 tw:ring-outline-variant tw:cursor-pointer" title="Custom colour"
        style={{ background: 'conic-gradient(#ef4444, #f59e0b, #22c55e, #3b82f6, #8b5cf6, #ef4444)' }}>
        <span className="tw:sr-only">{label}: custom</span>
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(current) ? current : '#3b82f6'} onChange={event => pick(event.target.value)} className="tw:absolute tw:inset-0 tw:opacity-0 tw:cursor-pointer" />
      </label>
    </div>
  );

  return (
    <div className="tw:absolute tw:inset-0 tw:z-50 tw:flex tw:items-start tw:justify-center tw:px-3 tw:pt-3">
      <button
        type="button"
        aria-label="Close drawing properties"
        tabIndex={-1}
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
        ref={formRef}
        className="tw:relative tw:w-full tw:max-w-[420px] tw:overflow-hidden tw:rounded-xl tw:border tw:border-outline-variant tw:bg-surface-container-lowest tw:shadow-2xl"
      >
        <div
          onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd}
          title="Drag to move"
          className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:px-5 tw:pt-4 tw:pb-1 tw:cursor-move tw:select-none tw:touch-none">
          <h3 id="drawing-properties-title" className="tw:truncate tw:text-base tw:font-semibold tw:text-on-surface">
            {drawingName}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close drawing properties"
            className="tw:flex tw:h-8 tw:w-8 tw:items-center tw:justify-center tw:rounded-md tw:text-on-surface-variant tw:hover:bg-surface-container-high tw:hover:text-on-surface"
          >
            <Icon name="close" className="tw:text-[20px]" />
          </button>
        </div>

        <div className="tw:px-5 tw:pt-2">
          <div role="tablist" aria-label="Drawing settings" className="tw:flex tw:gap-5 tw:border-b tw:border-outline-variant">
            {tabs.map(tab => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={'drawing-tab-' + tab.id}
                aria-selected={activeTab === tab.id}
                aria-controls="drawing-tab-panel"
                tabIndex={activeTab === tab.id ? 0 : -1}
                onKeyDown={onTabKey}
                onClick={() => setActiveTab(tab.id)}
                className={`tw:-mb-px tw:border-b-2 tw:pb-2 tw:pt-1 tw:text-sm tw:font-semibold tw:transition-colors ${activeTab === tab.id ? 'tw:border-primary tw:text-on-surface' : 'tw:border-transparent tw:text-on-surface-variant tw:hover:text-on-surface'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div id="drawing-tab-panel" role="tabpanel" aria-labelledby={'drawing-tab-' + activeTab} className="tw:min-h-[200px] tw:px-5 tw:py-5">
          {activeTab === 'style' && capabilities.style && (
            <div className="tw:flex tw:flex-col tw:gap-4">
              <div className={row}>
                <span className={rowLabel}>{capabilities.lineWidth === false ? 'Colour' : 'Line'}</span>
                {swatches(draft.lineColor, color => update('lineColor', color), 'Line colour')}
              </div>
              {capabilities.lineWidth !== false && (
                <>
                  <div className={row}>
                    <span className={rowLabel}>Thickness</span>
                    <div className="tw:flex tw:w-fit tw:overflow-hidden tw:rounded-md tw:border tw:border-outline-variant" role="radiogroup" aria-label="Line thickness">
                      {LINE_WIDTHS.map(width => (
                        <button key={width} type="button" role="radio" aria-checked={draft.lineWidth === width} aria-label={width + ' px'} title={width + ' px'} onClick={() => update('lineWidth', width)} className={segment(draft.lineWidth === width) + ' tw:w-11'}>
                          <span className="tw:block tw:w-6 tw:rounded-full tw:bg-current" style={{ height: width }} />
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className={row}>
                    <span className={rowLabel}>Style</span>
                    <div className="tw:flex tw:w-fit tw:overflow-hidden tw:rounded-md tw:border tw:border-outline-variant" role="radiogroup" aria-label="Line style">
                      {LINE_STYLES.map(style => (
                        <button key={style.id} type="button" role="radio" aria-checked={draft.lineStyle === style.id} aria-label={style.label} title={style.label} onClick={() => update('lineStyle', style.id)} className={segment(draft.lineStyle === style.id) + ' tw:w-11'}>
                          <svg width="24" height="4" aria-hidden="true"><line x1="1" y1="2" x2="23" y2="2" stroke="currentColor" strokeWidth="2" strokeDasharray={style.dash} strokeLinecap="round" /></svg>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
              {capabilities.fill && (
                <>
                  <div className={row}>
                    <span className={rowLabel}>Fill</span>
                    <label className="tw:flex tw:w-fit tw:items-center tw:gap-2 tw:text-sm tw:text-on-surface tw:cursor-pointer">
                      <input type="checkbox" checked={draft.filled} onChange={event => update('filled', event.target.checked)} className="tw:h-4 tw:w-4 tw:accent-[var(--color-primary,#3b82f6)]" />
                      Fill the zone
                    </label>
                  </div>
                  <div className={`${row} ${draft.filled ? '' : 'tw:opacity-40 tw:pointer-events-none'}`} aria-disabled={!draft.filled}>
                    <span className={rowLabel}>Fill colour</span>
                    {swatches(draft.fillColor, color => update('fillColor', color), 'Fill colour')}
                  </div>
                  <div className={`${row} ${draft.filled ? '' : 'tw:opacity-40 tw:pointer-events-none'}`}>
                    <span className={rowLabel}>Opacity</span>
                    <div className="tw:flex tw:items-center tw:gap-3">
                      <input type="range" min="0" max="100" value={Math.round(draft.fillOpacity * 100)} disabled={!draft.filled} aria-label="Fill opacity"
                        onChange={event => update('fillOpacity', Number(event.target.value) / 100)} className="tw:flex-1" />
                      <span className="tw:w-10 tw:text-right tw:font-mono tw:text-xs tw:text-on-surface-variant">{Math.round(draft.fillOpacity * 100)}%</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'text' && capabilities.text && (
            <div className="tw:flex tw:flex-col tw:gap-4">
              <textarea
                ref={textRef}
                value={draft.text}
                maxLength={160}
                rows={3}
                aria-label={'Text for ' + drawingName}
                placeholder="Add text"
                onChange={event => update('text', event.target.value)}
                onKeyDown={handleTextKeyDown}
                className="tw:w-full tw:resize-none tw:rounded-md tw:border tw:border-outline-variant tw:bg-surface-container-lowest tw:px-3 tw:py-2 tw:text-sm tw:text-on-surface tw:caret-primary tw:outline-none tw:focus:border-primary tw:focus:ring-1 tw:focus:ring-primary tw:placeholder:text-on-surface-variant/70"
              />
              <div className={row}>
                <span className={rowLabel}>Font</span>
                <div className="tw:flex tw:items-center tw:gap-2">
                  <select value={draft.textFontSize} onChange={event => update('textFontSize', Number(event.target.value))} aria-label="Text size" className={control}>
                    {FONT_SIZES.map(size => <option key={size} value={size}>{size}px</option>)}
                  </select>
                  <div className="tw:flex tw:overflow-hidden tw:rounded-md tw:border tw:border-outline-variant">
                    <button type="button" aria-pressed={draft.textBold} aria-label="Bold" title="Bold" onClick={() => update('textBold', !draft.textBold)} className={segment(draft.textBold) + ' tw:font-bold'}>B</button>
                    <button type="button" aria-pressed={draft.textItalic} aria-label="Italic" title="Italic" onClick={() => update('textItalic', !draft.textItalic)} className={segment(draft.textItalic) + ' tw:italic tw:font-serif'}>I</button>
                  </div>
                </div>
              </div>
              {capabilities.placement !== false && (
                <>
                  <div className={row}>
                    <span className={rowLabel}>Position</span>
                    <div className="tw:flex tw:w-fit tw:overflow-hidden tw:rounded-md tw:border tw:border-outline-variant" role="radiogroup" aria-label="Text position">
                      {(['above', 'inside', 'below'] as const).map(place => (
                        <button key={place} type="button" role="radio" aria-checked={draft.textPlacement === place} onClick={() => update('textPlacement', place)} className={segment(draft.textPlacement === place) + ' tw:px-3 tw:capitalize'}>{place === 'inside' ? 'Middle' : place}</button>
                      ))}
                    </div>
                  </div>
                  <div className={row}>
                    <span className={rowLabel}>Align</span>
                    <div className="tw:flex tw:w-fit tw:overflow-hidden tw:rounded-md tw:border tw:border-outline-variant" role="radiogroup" aria-label="Text alignment">
                      {(['left', 'center', 'right'] as const).map(align => (
                        <button key={align} type="button" role="radio" aria-checked={draft.textAlign === align} aria-label={align} title={align} onClick={() => update('textAlign', align)} className={segment(draft.textAlign === align) + ' tw:w-11'}>
                          <Icon name={'format_align_' + align} className="tw:text-[18px]" />
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'coordinates' && capabilities.coordinates && (
            <div className="tw:flex tw:flex-col tw:gap-3">
              {draft.anchors.map((anchor, index) => (
                <div key={index} className={row}>
                  <span className={rowLabel}>Point {index + 1}</span>
                  <div className="tw:flex tw:items-center tw:gap-2">
                    <input type="number" step="any" value={Number.isFinite(anchor.price) ? anchor.price : ''} aria-label={`Point ${index + 1} price`}
                      onChange={event => update('anchors', draft.anchors.map((a, i) => (i === index ? { ...a, price: event.target.value === '' ? NaN : Number(event.target.value) } : a)))}
                      className={control + ' tw:w-28 tw:font-mono'} />
                    <span className="tw:text-xs tw:text-on-surface-variant">{whenUtc(anchor.time)}</span>
                  </div>
                </div>
              ))}
              <p className="tw:text-xs tw:text-on-surface-variant">Type an exact price. To move a point to another candle, drag it on the chart.</p>
            </div>
          )}

          {activeTab === 'visibility' && capabilities.visibility && (
            <div className="tw:flex tw:flex-col tw:divide-y tw:divide-outline-variant">
              <label className={toggle + ' tw:pb-3'}>
                <span>Show on chart<span className="tw:block tw:text-xs tw:text-on-surface-variant">Hidden drawings come back with Show hidden drawings in the toolbar.</span></span>
                <input type="checkbox" checked={draft.visible} onChange={event => update('visible', event.target.checked)} className="tw:h-4 tw:w-4" />
              </label>
              <label className={toggle + ' tw:py-3'}>
                <span>Lock in place<span className="tw:block tw:text-xs tw:text-on-surface-variant">It can still be selected and edited here, but not dragged.</span></span>
                <input type="checkbox" checked={draft.locked} onChange={event => update('locked', event.target.checked)} className="tw:h-4 tw:w-4" />
              </label>
              {capabilities.extendLeft && (
                <label className={toggle + ' tw:py-3'}>
                  Extend left
                  <input type="checkbox" checked={draft.extendLeft} onChange={event => update('extendLeft', event.target.checked)} className="tw:h-4 tw:w-4" />
                </label>
              )}
              {capabilities.extendRight && (
                <label className={toggle + ' tw:pt-3'}>
                  <span>Extend right{drawingName === 'Rectangle / zone' && <span className="tw:block tw:text-xs tw:text-on-surface-variant">The right edge follows the newest candle as the replay moves, until you resize the zone.</span>}</span>
                  <input type="checkbox" checked={draft.extendRight} onChange={event => update('extendRight', event.target.checked)} className="tw:h-4 tw:w-4" />
                </label>
              )}
            </div>
          )}
        </div>

        <div className="tw:flex tw:items-center tw:justify-end tw:gap-2 tw:border-t tw:border-outline-variant tw:bg-surface-container/40 tw:px-5 tw:py-3">
          <button type="button" onClick={onCancel} className="tw:h-9 tw:rounded-md tw:border tw:border-outline-variant tw:px-4 tw:text-sm tw:font-semibold tw:text-on-surface tw:hover:bg-surface-container-high">
            Cancel
          </button>
          <button type="submit" className="tw:h-9 tw:rounded-md tw:bg-primary tw:px-5 tw:text-sm tw:font-semibold tw:text-on-primary tw:shadow-sm tw:hover:brightness-110">
            {discards ? 'Discard' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
