'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, AlertTriangle, ExternalLink, ImagePlus, Trash2 } from 'lucide-react';
import { createChart, CandlestickSeries, ColorType, CrosshairMode } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { SerializedDrawing } from 'lightweight-charts-drawing';
import { useTheme } from './ThemeProvider';
import { useChartDrawings } from './chart-drawing/useChartDrawings';
import ChartDrawingToolbar from './chart-drawing/ChartDrawingToolbar';
import ChartDrawingLayer from './chart-drawing/ChartDrawingLayer';
import { snapToCandles, splitAnnotations, toDrawingEntries } from './chart-drawing/drawingKit';

const API = '/api';

interface Candle { time: UTCTimestamp; open: number; high: number; low: number; close: number; }
interface DrawnImage { id: string; time: number; price: number; url: string; caption: string; screenshotId: string; color: string; }
// Saved in chartAnnotations: shared-tool drawings ({ type: 'drawing' }) and pinned images.
// Older shapes (rect/line/horizontal/arrow/text/fib) are converted to drawings on load.
export type ChartAnnotation = { type: string; id: string } & Record<string, unknown>;

const CHART_INTERVALS = [
  { value: '1min', label: '1m' }, { value: '5min', label: '5m' }, { value: '15min', label: '15m' },
  { value: '1h', label: '1H' }, { value: '4h', label: '4H' }, { value: '1day', label: '1D' },
] as const;

interface Props {
  analysisId: string;
  symbol: string;
  initialInterval?: string;
  initialAnnotations?: ChartAnnotation[];
}

export default function PreTradeChart({ analysisId, symbol, initialInterval, initialAnnotations }: Props) {
  const { resolvedTheme } = useTheme();
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const [interval, setInterval_] = useState(initialInterval && CHART_INTERVALS.some(t => t.value === initialInterval) ? initialInterval : '15min');
  const [days, setDays] = useState(5);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isSetupError, setIsSetupError] = useState(false);

  const initial = useMemo(() => splitAnnotations(initialAnnotations || []), [initialAnnotations]);
  const drawingsRef = useRef<SerializedDrawing[]>(initial.drawings);
  const [drawings, setDrawings] = useState<SerializedDrawing[]>(initial.drawings);
  const [images, setImages] = useState<DrawnImage[]>(() => initial.other.filter(a => a.type === 'image') as unknown as DrawnImage[]);
  const [pendingImage, setPendingImage] = useState<Omit<DrawnImage, 'id' | 'time' | 'price' | 'color'> | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [showImages, setShowImages] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [saveError, setSaveError] = useState('');
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const redrawRef = useRef<() => void>(() => undefined);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const baselineRef = useRef('');
  const candlesRef = useRef<Candle[] | null>(null);
  useEffect(() => { candlesRef.current = candles; }, [candles]);

  const engine = useChartDrawings({
    onChange: next => { drawingsRef.current = next; setDrawings(next); },
    getCandles: () => candlesRef.current,
  });
  const { attach } = engine;

  // ── Load candles for the current symbol/interval/days ──────────────────
  useEffect(() => {
    const trimmed = symbol.trim();
    if (!trimmed) { setCandles(null); setError(''); return; }
    const token = localStorage.getItem('token');
    if (!token) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setIsSetupError(false);
    const timer = setTimeout(() => {
      (async () => {
        try {
          const res = await fetch(`${API}/pre-trade-analyses/chart?symbol=${encodeURIComponent(trimmed)}&interval=${interval}&days=${days}`, {
            headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
          });
          const data = await res.json();
          if (!res.ok) { setError(data.error || 'Failed to load chart data'); setIsSetupError(Boolean(data.setup)); setLoading(false); return; }
          setCandles((data.candles || []).map((c: Candle) => ({ ...c, time: Number(c.time) as UTCTimestamp })));
          setLoading(false);
        } catch (e) {
          if ((e as Error).name !== 'AbortError') { setError((e as Error).message || 'Network error'); setLoading(false); }
        }
      })();
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [symbol, interval, days]);

  // ── Chart creation (drawings re-attached on every rebuild) ─────────────
  useEffect(() => {
    if (!candles || !chartContainerRef.current) return;
    const chartTheme = resolvedTheme === 'dark'
      ? { background: '#0d1117', text: '#8e9bb0', grid: '#1f2a3c' }
      : { background: '#f8fafc', text: '#5b6780', grid: '#dfe5ee' };
    const el = chartContainerRef.current;
    const chart = createChart(el, {
      width: el.clientWidth, height: el.clientHeight,
      layout: { background: { type: ColorType.Solid, color: chartTheme.background }, textColor: chartTheme.text },
      grid: { vertLines: { color: chartTheme.grid }, horzLines: { color: chartTheme.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { borderColor: chartTheme.grid, timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: chartTheme.grid },
    });
    chartRef.current = chart;
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981', downColor: '#ef4444', borderVisible: false,
      wickUpColor: '#10b981', wickDownColor: '#ef4444',
    });
    seriesRef.current = series;
    series.setData(candles);
    chart.timeScale().fitContent();
    const detach = attach(chart, series, el, snapToCandles(drawingsRef.current, candles.map(c => Number(c.time))));
    const syncCanvas = () => { if (canvasRef.current) { canvasRef.current.width = el.clientWidth; canvasRef.current.height = el.clientHeight; } };
    syncCanvas();
    const redraw = () => requestAnimationFrame(() => redrawRef.current());
    const ro = new ResizeObserver(() => { chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }); syncCanvas(); redraw(); });
    ro.observe(el);
    chart.timeScale().subscribeVisibleTimeRangeChange(redraw);
    return () => {
      ro.disconnect(); chart.timeScale().unsubscribeVisibleTimeRangeChange(redraw);
      detach(); chart.remove(); chartRef.current = null; seriesRef.current = null;
    };
  }, [candles, resolvedTheme, attach]);

  // ── Pinned images (evidence cards) ──────────────────────────────────────
  const redrawImages = useCallback(() => {
    const canvas = canvasRef.current, chart = chartRef.current, series = seriesRef.current;
    if (!canvas || !chart || !series) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const pin of images) {
      const x = chart.timeScale().timeToCoordinate(pin.time as UTCTimestamp); const y = series.priceToCoordinate(pin.price);
      if (x == null || y == null) continue;
      const cardX = Math.min(canvas.width - 110, Math.max(8, x + 10)); const cardY = Math.max(8, y - 78);
      let image = imageCacheRef.current.get(pin.url);
      if (!image) {
        image = new window.Image(); image.crossOrigin = 'anonymous'; image.onload = () => redrawRef.current(); image.src = pin.url;
        imageCacheRef.current.set(pin.url, image);
      }
      ctx.save(); ctx.fillStyle = resolvedTheme === 'dark' ? '#0a0e14ee' : '#ffffffee'; ctx.strokeStyle = pin.color; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(cardX, cardY + 58); ctx.stroke();
      ctx.fillRect(cardX, cardY, 100, 66);
      if (image.complete && image.naturalWidth > 0) ctx.drawImage(image, cardX + 3, cardY + 3, 94, 48);
      else { ctx.fillStyle = resolvedTheme === 'dark' ? '#182033' : '#e8edf5'; ctx.fillRect(cardX + 3, cardY + 3, 94, 48); }
      ctx.strokeRect(cardX, cardY, 100, 66); ctx.fillStyle = resolvedTheme === 'dark' ? '#cbd5e1' : '#334155'; ctx.font = '600 9px sans-serif';
      ctx.fillText((pin.caption || 'Chart evidence').slice(0, 18), cardX + 5, cardY + 61); ctx.restore();
    }
  }, [images, resolvedTheme]);
  useEffect(() => { redrawRef.current = redrawImages; redrawImages(); }, [redrawImages, engine.revision]);

  const placeImage = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const chart = chartRef.current, series = seriesRef.current;
    if (!pendingImage || !chart || !series) return;
    const r = e.currentTarget.getBoundingClientRect();
    const time = chart.timeScale().coordinateToTime(e.clientX - r.left); const price = series.coordinateToPrice(e.clientY - r.top);
    if (time == null || price == null) return;
    setImages(cur => [...cur, { id: `image-${Date.now()}`, time: Number(time), price, color: engine.color, ...pendingImage }]);
    setPendingImage(null);
  };
  const uploadChartImage = async (file: File) => {
    if (!file.type.startsWith('image/')) { alert('Choose an image file to attach to the chart.'); return; }
    if (file.size > 8 * 1024 * 1024) { alert('Please keep chart images under 8MB.'); return; }
    const token = localStorage.getItem('token'); if (!token) return;
    setUploadingImage(true); setPendingImage(null);
    try {
      const imageData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read the image')); reader.readAsDataURL(file);
      });
      const caption = file.name.replace(/\.[^.]+$/, '').slice(0, 160) || 'Chart evidence';
      const response = await fetch(`${API}/pre-trade-analyses/${analysisId}/screenshots`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ imageData, caption }),
      });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not upload chart image');
      const screenshots = Array.isArray(body.screenshots) ? body.screenshots : [];
      const uploaded = screenshots[screenshots.length - 1];
      if (!uploaded?.url) throw new Error('The image uploaded but no image URL was returned');
      engine.activateTool(null);
      setPendingImage({ url: String(uploaded.url), caption, screenshotId: String(uploaded._id || uploaded.publicId || '') });
    } catch (uploadError) {
      alert(uploadError instanceof Error ? uploadError.message : 'Could not upload chart image');
    } finally { setUploadingImage(false); }
  };

  // ── Autosave (debounced): drawings + pinned images ─────────────────────
  const annotations = useMemo(
    () => [...images.map(i => ({ ...i, type: 'image' as const })), ...toDrawingEntries(drawings)],
    [images, drawings],
  );
  useEffect(() => {
    const serialized = JSON.stringify(annotations);
    if (!baselineRef.current) { baselineRef.current = serialized; return; }
    if (serialized === baselineRef.current) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    setSaveState('saving'); setSaveError('');
    const timer = setTimeout(() => {
      saveQueueRef.current = saveQueueRef.current.then(async () => {
        const response = await fetch(`${API}/pre-trade-analyses/${analysisId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ chartSymbol: symbol, chartInterval: interval, chartAnnotations: JSON.parse(serialized) }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not save chart drawings');
        baselineRef.current = serialized; setSaveState('saved');
      }).catch(err => { setSaveState('error'); setSaveError(err.message || 'Could not save chart drawings'); });
    }, 700);
    return () => clearTimeout(timer);
  }, [annotations, analysisId, symbol, interval]);

  return (
    <div className="card" style={{ padding: 0, marginBottom: 16, overflow: 'hidden' }}>
      <div className="replay-workspace-toolbar" aria-label="Pre-trade chart tools">
        <div className="replay-tool-group timeframe-group">
          <span className="replay-tool-group-label">Timeframe</span>
          <div className="replay-timeframes" role="group" aria-label="Chart timeframe">
            {CHART_INTERVALS.map(tf => <button type="button" key={tf.value} aria-pressed={interval === tf.value} className={interval === tf.value ? 'active' : ''} onClick={() => setInterval_(tf.value)}>{tf.label}</button>)}
          </div>
        </div>
        <div className="replay-toolbar-divider" />
        <div className="replay-tool-group">
          <span className="replay-tool-group-label">Lookback</span>
          <select value={days} onChange={e => setDays(Number(e.target.value))} style={{ minHeight: 30, borderRadius: 6, border: '1px solid #303b55', background: '#151b26', color: '#c9d2e8', fontSize: 11.5, padding: '0 6px' }}>
            {[2, 5, 10, 20, 30].map(d => <option key={d} value={d}>{d}d</option>)}
          </select>
        </div>
        <div className="replay-toolbar-divider" />
        <div className="replay-tool-group">
          <span className="replay-tool-group-label">Evidence</span>
          <input ref={imageInputRef} className="replay-hidden-file" type="file" accept="image/*" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadChartImage(f); }} />
          <button type="button" disabled={uploadingImage} aria-pressed={Boolean(pendingImage)} className={`replay-tool-btn${pendingImage ? ' active' : ''}`} onClick={() => imageInputRef.current?.click()} title="Upload and pin visual evidence to the chart"><ImagePlus size={16} /> {uploadingImage ? 'Uploading…' : 'Pin image'}</button>
          {images.length > 0 && <button type="button" aria-pressed={showImages} className={`replay-tool-btn${showImages ? ' active' : ''}`} onClick={() => setShowImages(v => !v)}>Images ({images.length})</button>}
        </div>
        <span className="replay-toolbar-spacer" />
        <span className={`replay-annotation-status ${saveState}`} role="status" title={saveError || 'Chart drawings save automatically'}>{saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : 'Saved'}</span>
      </div>

      <div style={{ display: 'flex', height: 460 }}>
        <ChartDrawingToolbar engine={engine} />
        <div className="replay-chart-wrap" style={{ position: 'relative', flex: 1, minWidth: 0, height: '100%' }}>
          <div ref={chartContainerRef} className="replay-chart-container" />
          <ChartDrawingLayer engine={engine} />
          <canvas ref={canvasRef} onMouseDown={placeImage}
            style={{ position: 'absolute', inset: 0, zIndex: 6, pointerEvents: pendingImage ? 'auto' : 'none', cursor: pendingImage ? 'crosshair' : undefined }}
            aria-label="Pinned chart images" />
          {pendingImage && (
            <div className="replay-chart-image-placer" role="status" style={{ zIndex: 7 }}>
              <ImagePlus size={16} /><div><strong>Image ready to place</strong><input aria-label="Image caption" maxLength={180} value={pendingImage.caption} onChange={event => setPendingImage(cur => cur ? { ...cur, caption: event.target.value } : cur)} /><span>Describe the evidence, then click the candle and price where it belongs.</span></div>
              <button type="button" onClick={() => setPendingImage(null)}>Cancel</button>
            </div>
          )}
          {showImages && images.length > 0 && (
            <div className="replay-annotation-manager" aria-label="Pinned images" style={{ zIndex: 7 }}>
              <div className="replay-annotation-manager-head"><strong>Pinned images</strong></div>
              {images.map(img => (
                <div className="replay-annotation-row" key={img.id}>
                  <button type="button" className="replay-annotation-select" onClick={() => {
                    const caption = window.prompt('Caption for this image:', img.caption);
                    if (caption != null) setImages(cur => cur.map(i => i.id === img.id ? { ...i, caption: caption.trim().slice(0, 180) } : i));
                  }}>
                    <i style={{ background: img.color }} /><span><b>Image</b> — {img.caption || 'Chart evidence'}</span>
                  </button>
                  <button type="button" onClick={() => setImages(cur => cur.filter(i => i.id !== img.id))} aria-label="Delete image"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}
          {!symbol.trim() && (
            <div className="replay-chart-state"><h4>Enter a symbol</h4><p>Type a symbol above to load its chart.</p></div>
          )}
          {symbol.trim() && loading && (
            <div className="replay-chart-state"><Loader2 className="spin" size={22} /><h4>Loading chart…</h4><p>Requesting {symbol} candles from cTrader</p></div>
          )}
          {symbol.trim() && !loading && error && (
            <div className="replay-chart-state">
              <AlertTriangle size={32} color="#f59e0b" />
              <h4>{isSetupError ? 'Chart Not Configured' : 'Chart Data Unavailable'}</h4>
              <p>{error}</p>
              {isSetupError && <a href="/accounts" className="replay-setup-link">Connect cTrader on the Accounts page <ExternalLink size={12} /></a>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
