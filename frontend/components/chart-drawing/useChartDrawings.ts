'use client';
// The shared chart drawing engine: attach it to any lightweight-charts chart
// and it handles placing drawings (click-click or press-drag, Shift to lock
// horizontal/vertical), moving and resizing them, undo, delete, clear,
// colours, the properties panel and change notifications for saving.
// Rendered by <ChartDrawingToolbar> and <ChartDrawingLayer>.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import { DrawingManager, getToolRegistry } from 'lightweight-charts-drawing';
import type { Anchor, IDrawing, SerializedDrawing } from 'lightweight-charts-drawing';
import type { DrawingPropertiesValue } from '../backtest-tools/DrawingPropertiesPanel';
import { DRAWING_SWATCHES, applyDrawingProperties, drawingDisplayName, drawingFactory, setDrawingColor, isUserHidden, unhideDrawing } from './drawingKit';

interface PendingDrawing { drawing: IDrawing; required: number; placed: number; startX: number; startY: number; origin: Anchor }
export interface DrawingPropertiesEdit { drawingId: string; drawingName: string; isNew: boolean }
interface Ohlc { time: unknown; open: number; high: number; low: number; close: number }

export interface ChartDrawings {
  attach: (chart: IChartApi, series: ISeriesApi<SeriesType>, el: HTMLElement, initial?: SerializedDrawing[]) => () => void;
  activeTool: string | null;
  activateTool: (id: string | null) => void;
  color: string;
  pickColor: (color: string) => void;
  magnet: boolean;
  setMagnet: (on: boolean) => void;
  selectedId: string | null;
  count: number;
  canUndo: boolean;
  undo: () => void;
  deleteSelected: () => void;
  clearAll: () => void;
  /** Drawings the trader hid (Visibility tab), and a way to show them all again. */
  hiddenCount: number;
  showHidden: () => void;
  editSelected: () => void;
  editing: DrawingPropertiesEdit | null;
  saveProperties: (value: DrawingPropertiesValue) => void;
  cancelProperties: () => void;
  getDrawing: (id: string) => IDrawing | null;
  exportDrawings: () => SerializedDrawing[];
  /** Drawings as shown right now (hidden ones marked not visible), for overlays. */
  shownDrawings: () => SerializedDrawing[];
  /** Hide drawings that start after this time (Replay: nothing from candles not yet revealed); null shows all. */
  setRevealLimit: (time: number | null) => void;
  replaceDrawings: (drawings: SerializedDrawing[]) => void;
  revision: number;
  chart: IChartApi | null;
  series: ISeriesApi<SeriesType> | null;
  capture: {
    active: boolean;
    onMouseDown: (e: React.MouseEvent<HTMLElement>) => void;
    onMouseMove: (e: React.MouseEvent<HTMLElement>) => void;
    onMouseUp: (e: React.MouseEvent<HTMLElement>) => void;
  };
}

interface Options {
  /** Called after any change, with every drawing (debounce saving yourself). */
  onChange?: (drawings: SerializedDrawing[]) => void;
  /** Candles on the chart, for the magnet (snap to open/high/low/close). */
  getCandles?: () => Ohlc[] | null | undefined;
}

export function useChartDrawings({ onChange, getCandles }: Options = {}): ChartDrawings {
  const managerRef = useRef<DrawingManager | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const pendingRef = useRef<PendingDrawing | null>(null);
  const historyRef = useRef<SerializedDrawing[][]>([]);
  const importingRef = useRef(false);
  // Drawings hidden by setRevealLimit; saved as visible, since the hiding is only for the replay view.
  const revealHiddenRef = useRef<Set<string>>(new Set());
  const revealLimitRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  const getCandlesRef = useRef(getCandles);
  useEffect(() => { onChangeRef.current = onChange; getCandlesRef.current = getCandles; });

  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [color, setColor] = useState(DRAWING_SWATCHES[0].color);
  const colorRef = useRef(color);
  useEffect(() => { colorRef.current = color; }, [color]);
  const [magnet, setMagnet] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [historyDepth, setHistoryDepth] = useState(0);
  const [editing, setEditing] = useState<DrawingPropertiesEdit | null>(null);
  const [revision, setRevision] = useState(0);
  const [attached, setAttached] = useState<{ chart: IChartApi; series: ISeriesApi<SeriesType> } | null>(null);

  const savedDrawings = useCallback((): SerializedDrawing[] => {
    const m = managerRef.current; if (!m) return [];
    const hidden = revealHiddenRef.current;
    return m.exportDrawings().map(d => (hidden.has(d.id) ? { ...d, options: { ...d.options, visible: true } } : d));
  }, []);
  const applyReveal = useCallback(() => {
    const m = managerRef.current; if (!m) return;
    const limit = revealLimitRef.current, hidden = revealHiddenRef.current;
    for (const d of m.getAllDrawings()) {
      // Hidden while its first point is still in the future (a line may extend past it).
      const hide = limit != null && d.anchors.length > 0 && Math.min(...d.anchors.map(a => Number(a.time))) > limit;
      if (hide && !hidden.has(d.id) && d.options.visible !== false) { hidden.add(d.id); d.updateOptions({ visible: false }); d.requestUpdate(); }
      else if (!hide && hidden.has(d.id)) { hidden.delete(d.id); d.updateOptions({ visible: true }); d.requestUpdate(); }
    }
    for (const id of [...hidden]) if (!m.getDrawing(id)) hidden.delete(id);
  }, []);
  // Hidden by the trader (Visibility tab), not by the replay's reveal limit.
  const userHidden = useCallback(() => (managerRef.current?.getAllDrawings() ?? []).filter(d => isUserHidden(d) || (d.options.visible === false && !revealHiddenRef.current.has(d.id))), []);
  const changed = useCallback(() => {
    const m = managerRef.current; if (!m || importingRef.current) return;
    setCount(m.getAllDrawings().length);
    setHiddenCount(userHidden().length);
    setRevision(r => r + 1);
    onChangeRef.current?.(savedDrawings());
  }, [savedDrawings, userHidden]);
  const pushHistory = useCallback(() => {
    const m = managerRef.current; if (!m) return;
    historyRef.current = [...historyRef.current.slice(-29), savedDrawings()];
    setHistoryDepth(historyRef.current.length);
  }, [savedDrawings]);
  const cancelPending = useCallback(() => {
    const p = pendingRef.current;
    if (p) { pendingRef.current = null; managerRef.current?.removeDrawing(p.drawing.id); }
  }, []);
  const activateTool = useCallback((id: string | null) => {
    const m = managerRef.current;
    cancelPending();
    if (!m || !id) { m?.setActiveTool(null); setActiveTool(null); return; }
    setActiveTool(cur => {
      if (cur === id) { m.setActiveTool(null); return null; }
      m.deselectAll();
      m.setActiveTool(id);
      return id;
    });
  }, [cancelPending]);

  // ── Attach to a chart ─────────────────────────────────────────────────────
  const attach = useCallback((chart: IChartApi, series: ISeriesApi<SeriesType>, el: HTMLElement, initial: SerializedDrawing[] = []) => {
    const manager = new DrawingManager();
    // The library's types expect a candlestick series; any series works at runtime.
    manager.attach(chart, series as unknown as ISeriesApi<'Candlestick'>, el);
    managerRef.current = manager; chartRef.current = chart; seriesRef.current = series;
    historyRef.current = []; setHistoryDepth(0); revealHiddenRef.current = new Set();
    if (initial.length) {
      importingRef.current = true;
      try { manager.importDrawings(initial, drawingFactory); } catch { /* skip drawings this version can't read */ }
      importingRef.current = false;
    }
    applyReveal();
    setCount(manager.getAllDrawings().length);
    setHiddenCount(userHidden().length);
    setAttached({ chart, series });

    // At most once a frame: the chart fires these while it repaints, and a
    // re-render per event can feed back into another repaint (and loop).
    let frame = 0;
    const refresh = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; setRevision(r => r + 1); });
    };
    const unsub = [
      manager.on('drawing:added', ev => {
        if (importingRef.current) return;
        if (ev.drawing) {
          setDrawingColor(ev.drawing, colorRef.current);
          if (ev.drawing.type === 'text-annotation') setEditing({ drawingId: ev.drawing.id, drawingName: drawingDisplayName(ev.drawing.type), isNew: true });
        }
        changed();
      }),
      manager.on('drawing:updated', () => changed()),
      manager.on('drawing:removed', () => changed()),
      manager.on('drawing:cleared', () => changed()),
      manager.on('drawing:selected', ev => setSelectedId(ev.drawingId ?? null)),
      manager.on('drawing:deselected', () => setSelectedId(null)),
    ];

    // Drag a selected drawing to move it (the library only drags its anchors).
    let drag: { drawing: IDrawing; startX: number; startY: number; anchors: Anchor[]; moved: boolean } | null = null;
    let draggingHandle = false;
    const local = (ev: MouseEvent) => { const r = el.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    const onDown = (ev: MouseEvent) => {
      if (pendingRef.current || manager.getActiveTool()) return;
      const pt = local(ev);
      if (manager.hitTestAnchor(pt) !== null) {
        draggingHandle = true; pushHistory();
        chart.applyOptions({ handleScroll: false, handleScale: false });
        return;
      }
      const sel = manager.getSelectedDrawing();
      const vp = sel?.getViewport();
      if (!sel || sel.options.locked || !vp || !sel.testHit(pt, vp)) return;
      drag = { drawing: sel, startX: ev.clientX, startY: ev.clientY, anchors: sel.anchors.map(a => ({ ...a })), moved: false };
      chart.applyOptions({ handleScroll: false, handleScale: false });
      el.style.cursor = 'move';
      ev.preventDefault(); ev.stopImmediatePropagation();
    };
    const onMove = (ev: MouseEvent) => {
      if (!drag) return;
      const dx = ev.clientX - drag.startX, dy = ev.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      if (!drag.moved) pushHistory();
      const moved: Anchor[] = [];
      for (const a of drag.anchors) {
        const ax = chart.timeScale().timeToCoordinate(a.time), ay = series.priceToCoordinate(a.price);
        if (ax == null || ay == null) return;
        const time = chart.timeScale().coordinateToTime(ax + dx), price = series.coordinateToPrice(ay + dy);
        if (time == null || price == null) return;
        moved.push({ time, price });
      }
      drag.drawing.setAnchors(moved);
      drag.drawing.requestUpdate();
      drag.moved = true;
      refresh();
      ev.preventDefault(); ev.stopImmediatePropagation();
    };
    const onUp = () => {
      if (!drag && !draggingHandle) return;
      const d = drag; const wasHandle = draggingHandle;
      drag = null; draggingHandle = false;
      chart.applyOptions({ handleScroll: true, handleScale: true });
      el.style.cursor = '';
      if (d) { manager.selectDrawing(d.drawing.id); if (d.moved) changed(); }
      if (wasHandle) changed();
    };
    const onDblClick = (ev: MouseEvent) => {
      const d = manager.hitTest(local(ev));
      if (!d) return;
      manager.selectDrawing(d.id);
      setEditing({ drawingId: d.id, drawingName: drawingDisplayName(d.type), isNew: false });
      ev.preventDefault(); ev.stopImmediatePropagation();
    };
    const onRange = () => refresh();
    el.addEventListener('mousedown', onDown, true);
    el.addEventListener('dblclick', onDblClick, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    chart.subscribeCrosshairMove(onRange);

    return () => {
      unsub.forEach(u => u());
      el.removeEventListener('mousedown', onDown, true);
      el.removeEventListener('dblclick', onDblClick, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      chart.unsubscribeCrosshairMove(onRange);
      pendingRef.current = null;
      if (frame) cancelAnimationFrame(frame);
      manager.detach();
      if (managerRef.current === manager) { managerRef.current = null; chartRef.current = null; seriesRef.current = null; setAttached(null); }
    };
  }, [applyReveal, changed, pushHistory, userHidden]);

  // ── Placing a new drawing (on the capture layer while a tool is active) ───
  const anchorAt = (x: number, y: number): Anchor | null => {
    const chart = chartRef.current, series = seriesRef.current;
    if (!chart || !series) return null;
    const time = chart.timeScale().coordinateToTime(x);
    const rawPrice = series.coordinateToPrice(y);
    if (time == null || rawPrice == null) return null;
    let price = Number(rawPrice);
    if (magnet) {
      const candles = getCandlesRef.current?.() || [];
      const c = candles.find(k => Number(k.time) === Number(time));
      if (c) { const raw = price; price = [c.open, c.high, c.low, c.close].reduce((best, v) => (Math.abs(v - raw) < Math.abs(best - raw) ? v : best), c.close); }
    }
    return { time, price };
  };
  const finishPending = () => {
    const p = pendingRef.current; if (!p) return;
    pendingRef.current = null;
    managerRef.current?.selectDrawing(p.drawing.id);
    managerRef.current?.setActiveTool(null);
    setActiveTool(null);
    changed();
  };
  const constrain = (p: PendingDrawing, a: Anchor, x: number, y: number, shift: boolean): Anchor => {
    if (!shift) return a;
    return Math.abs(x - p.startX) >= Math.abs(y - p.startY) ? { time: a.time, price: p.origin.price } : { time: p.origin.time, price: a.price };
  };
  const moveFree = (p: PendingDrawing, a: Anchor) => {
    for (let i = p.placed; i < p.required; i++) p.drawing.updateAnchor(i, a);
    p.drawing.requestUpdate();
  };
  const point = (e: React.MouseEvent<HTMLElement>) => { const r = e.currentTarget.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    const m = managerRef.current; if (!m || !activeTool) return;
    const { x, y } = point(e);
    const a = anchorAt(x, y); if (!a) return;
    const p = pendingRef.current;
    if (p) {
      moveFree(p, constrain(p, a, x, y, e.shiftKey));
      p.placed += 1;
      if (p.placed >= p.required) finishPending();
      return;
    }
    const registry = getToolRegistry();
    const required = Math.max(1, registry.get(activeTool)?.requiredAnchors ?? 2);
    const id = `${activeTool}-${crypto.randomUUID().slice(0, 8)}`;
    const drawing = registry.createDrawing(activeTool, id, Array.from({ length: required }, () => ({ ...a })), { lineColor: color });
    if (!drawing) return;
    if (drawing.type === 'text-annotation') drawing.updateStyle({ drawingText: '' } as Partial<IDrawing['style']>);
    setDrawingColor(drawing, color);
    pushHistory();
    pendingRef.current = { drawing, required, placed: 1, startX: x, startY: y, origin: a };
    importingRef.current = true; // no save until it's placed
    m.addDrawing(drawing);
    importingRef.current = false;
    if (drawing.type === 'text-annotation') setEditing({ drawingId: id, drawingName: drawingDisplayName(drawing.type), isNew: true });
    if (required === 1) finishPending();
  };
  const onMouseMove = (e: React.MouseEvent<HTMLElement>) => {
    const p = pendingRef.current; if (!p) return;
    const { x, y } = point(e);
    const a = anchorAt(x, y); if (a) moveFree(p, constrain(p, a, x, y, e.shiftKey));
  };
  const onMouseUp = (e: React.MouseEvent<HTMLElement>) => {
    const p = pendingRef.current; if (!p) return;
    const { x, y } = point(e);
    // A press-drag-release fixes the second anchor; a plain click waits for the next click.
    if (p.placed !== 1 || Math.hypot(x - p.startX, y - p.startY) < 5) return;
    const a = anchorAt(x, y); if (a) moveFree(p, constrain(p, a, x, y, e.shiftKey));
    p.placed = 2;
    if (p.placed >= p.required) finishPending();
  };

  // ── Editing ───────────────────────────────────────────────────────────────
  const undo = () => {
    const m = managerRef.current; const last = historyRef.current.pop();
    if (!m || last === undefined) return;
    setHistoryDepth(historyRef.current.length);
    importingRef.current = true;
    m.clearAll(); revealHiddenRef.current = new Set(); m.importDrawings(last, drawingFactory);
    importingRef.current = false;
    applyReveal();
    setSelectedId(null);
    changed();
  };
  const deleteSelected = () => {
    const m = managerRef.current; if (!m || !selectedId) return;
    pushHistory(); m.removeDrawing(selectedId); setSelectedId(null);
  };
  const clearAll = () => {
    const m = managerRef.current; if (!m || !m.getAllDrawings().length) return;
    if (!window.confirm('Remove every drawing from this chart?')) return;
    pushHistory(); m.clearAll(); setSelectedId(null);
  };
  const showHidden = () => {
    const list = userHidden(); if (!list.length) return;
    pushHistory();
    for (const d of list) unhideDrawing(d);
    applyReveal(); // one the replay hasn't reached yet stays hidden until it does
    changed(); setRevision(r => r + 1);
  };
  const pickColor = (c: string) => {
    setColor(c);
    const d = selectedId ? managerRef.current?.getDrawing(selectedId) : null;
    if (d) { pushHistory(); setDrawingColor(d, c); changed(); }
  };
  const editSelected = () => {
    const d = selectedId ? managerRef.current?.getDrawing(selectedId) : null;
    if (d) setEditing({ drawingId: d.id, drawingName: drawingDisplayName(d.type), isNew: false });
  };
  const cancelProperties = () => {
    const e = editing; setEditing(null);
    if (e?.isNew) { managerRef.current?.removeDrawing(e.drawingId); setSelectedId(null); }
  };
  const saveProperties = (value: DrawingPropertiesValue) => {
    const e = editing; const m = managerRef.current;
    const d = e && m ? m.getDrawing(e.drawingId) : null;
    setEditing(null);
    if (!e || !m || !d) return;
    if (!e.isNew) pushHistory();
    if (!value.text && d.type === 'text-annotation') { m.removeDrawing(d.id); setSelectedId(null); return; }
    applyDrawingProperties(d, value);
    m.selectDrawing(d.id);
    changed();
  };
  const replaceDrawings = useCallback((drawings: SerializedDrawing[]) => {
    const m = managerRef.current; if (!m) return;
    cancelPending();
    importingRef.current = true;
    m.clearAll(); revealHiddenRef.current = new Set();
    try { m.importDrawings(drawings, drawingFactory); } catch { /* skip unreadable drawings */ }
    importingRef.current = false;
    applyReveal();
    historyRef.current = []; setHistoryDepth(0); setSelectedId(null);
    setCount(m.getAllDrawings().length); setHiddenCount(userHidden().length); setRevision(r => r + 1);
  }, [applyReveal, cancelPending, userHidden]);

  const setRevealLimit = useCallback((time: number | null) => {
    if (revealLimitRef.current === time) return;
    revealLimitRef.current = time;
    applyReveal(); setRevision(r => r + 1);
  }, [applyReveal]);

  // Keyboard: Esc cancels the tool / deselects; Delete removes the selected drawing.
  useEffect(() => {
    if (!attached) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === 'Escape') { if (activeTool) activateTool(null); else managerRef.current?.deselectAll(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !editing) { e.preventDefault(); deleteSelected(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return {
    attach, activeTool, activateTool, color, pickColor, magnet, setMagnet, selectedId, count,
    canUndo: historyDepth > 0, undo, deleteSelected, clearAll, editSelected,
    hiddenCount, showHidden,
    editing, saveProperties, cancelProperties,
    getDrawing: id => managerRef.current?.getDrawing(id) ?? null,
    exportDrawings: savedDrawings,
    shownDrawings: () => managerRef.current?.exportDrawings() ?? [],
    setRevealLimit,
    replaceDrawings,
    revision,
    chart: attached?.chart ?? null,
    series: attached?.series ?? null,
    capture: { active: Boolean(activeTool), onMouseDown, onMouseMove, onMouseUp },
  };
}
