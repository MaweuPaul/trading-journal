'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, LineStyle, ColorType, CrosshairMode } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { X, Loader2, AlertTriangle, Play, Pause, SkipBack, SkipForward, LogIn, LogOut } from 'lucide-react';
import { useTheme } from './ThemeProvider';

const API = '/api';

interface ReplayData {
  candles: { time: UTCTimestamp; open: number; high: number; low: number; close: number }[];
  interval: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  entryIndex: number;
  exitIndex: number;
  pnlUSD: number;
}

interface Props {
  tradeId: string;
  tradeSummary: { symbol: string; direction: 'BUY' | 'SELL'; pnlUSD: number; pnlPct: number };
  onClose: () => void;
}

function fmt(n: number, dp = 2) { return n.toFixed(dp); }

const SPEEDS = [0.5, 1, 2, 5, 10];

export default function InvestorReplayModal({ tradeId, tradeSummary, onClose }: Props) {
  const { resolvedTheme } = useTheme();
  const [replayData, setReplayData] = useState<ReplayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [replayIdx, setReplayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('investorToken');
    if (!token) { setError('Session expired. Please sign in again.'); setLoading(false); return; }
    const controller = new AbortController();
    (async () => {
      setLoading(true); setError('');
      try {
        const response = await fetch(`${API}/investor/trades/${tradeId}/replay`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not load the chart for this trade.');
        setReplayData({ ...body, candles: body.candles.map((c: any) => ({ ...c, time: Number(c.time) as UTCTimestamp })) });
        setReplayIdx(0);
        setPlaying(false);
      } catch (caught) {
        if (caught instanceof Error && caught.name !== 'AbortError') setError(caught.message);
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [tradeId]);

  // Chart/series/price-lines are created once per trade+theme -- they don't
  // need to be rebuilt on every playback tick, only the revealed candle
  // range does (see the next effect).
  useEffect(() => {
    if (!replayData || !chartContainerRef.current) return;
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
    series.createPriceLine({
      price: replayData.entryPrice,
      color: replayData.direction === 'BUY' ? '#10b981' : '#ef4444',
      lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,
      title: `Entry ${replayData.direction}`,
    });
    series.createPriceLine({
      price: replayData.exitPrice,
      color: replayData.pnlUSD >= 0 ? '#10b981' : '#ef4444',
      lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'Exit',
    });

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, [replayData, resolvedTheme]);

  // Reveals candles up to replayIdx, replaying the trade forward.
  useEffect(() => {
    if (!replayData || !seriesRef.current) return;
    seriesRef.current.setData(replayData.candles.slice(0, replayIdx + 1));
    if (replayIdx === 0) chartRef.current?.timeScale().fitContent();
  }, [replayData, replayIdx]);

  const jumpToReplayIndex = useCallback((index: number) => {
    if (!replayData) return;
    const clamped = Math.max(0, Math.min(replayData.candles.length - 1, index));
    setPlaying(false);
    setReplayIdx(clamped);
    chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, clamped - 30), to: Math.min(replayData.candles.length - 1, clamped + 10) });
  }, [replayData]);

  useEffect(() => {
    if (!replayData) return;
    if (playing) {
      const ms = Math.max(50, 300 / speed);
      intervalRef.current = setInterval(() => {
        setReplayIdx(prev => {
          if (prev >= replayData.candles.length - 1) { setPlaying(false); return prev; }
          return prev + 1;
        });
      }, ms);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [playing, speed, replayData]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!replayData) return;
      if (event.code === 'Space') { event.preventDefault(); setPlaying(p => !p); return; }
      if (event.key === 'ArrowLeft') { event.preventDefault(); jumpToReplayIndex(replayIdx - 1); return; }
      if (event.key === 'ArrowRight') { event.preventDefault(); jumpToReplayIndex(replayIdx + 1); return; }
      const key = event.key.toLowerCase();
      if (key === 'e') { event.preventDefault(); jumpToReplayIndex(replayData.entryIndex); return; }
      if (key === 'x') { event.preventDefault(); jumpToReplayIndex(replayData.exitIndex); return; }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [replayData, replayIdx, jumpToReplayIndex]);

  const totalCandles = replayData?.candles.length || 0;
  const progressPct = totalCandles > 0 ? ((replayIdx + 1) / totalCandles) * 100 : 0;

  return (
    <div className="replay-overlay" role="dialog" aria-modal="true">
      <div className="replay-topbar">
        <div className="replay-trade-summary">
          <strong>{tradeSummary.symbol}</strong>
          <span className={`badge ${tradeSummary.direction.toLowerCase()}`}>{tradeSummary.direction}</span>
          <span className={tradeSummary.pnlUSD >= 0 ? 'positive' : 'negative'}>
            {tradeSummary.pnlUSD >= 0 ? '+' : ''}${fmt(tradeSummary.pnlUSD)} ({tradeSummary.pnlUSD >= 0 ? '+' : ''}{fmt(tradeSummary.pnlPct)}%)
          </span>
          {replayData && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{replayData.interval}</span>}
        </div>
        <button className="replay-close-btn" onClick={onClose} title="Close"><X size={16} /> Close</button>
      </div>

      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {loading && (
          <div className="loading-wrap" style={{ position: 'absolute', inset: 0 }}>
            <Loader2 className="spin" size={22} />
            <p style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>Loading chart data…</p>
          </div>
        )}
        {error && !loading && (
          <div className="empty-state" style={{ position: 'absolute', inset: 0 }}>
            <div className="empty-icon"><AlertTriangle size={22} color="var(--amber, #f59e0b)" /></div>
            <h3>Chart Data Unavailable</h3>
            <p>{error}</p>
          </div>
        )}
        <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />
      </div>

      {replayData && !loading && !error && (
        <div className="replay-bottombar">
          <button className="replay-ctrl-btn" disabled={replayIdx === 0} onClick={() => jumpToReplayIndex(0)} title="Reset to start"><SkipBack size={14} /></button>
          <button className="replay-ctrl-btn" disabled={replayIdx === 0} onClick={() => jumpToReplayIndex(replayIdx - 1)} title="Step back (Left arrow)">‹</button>
          <button className={`replay-ctrl-btn play${playing ? ' is-playing' : ''}`} onClick={() => setPlaying(p => !p)} title="Play/Pause (Space)">
            {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}
          </button>
          <button className="replay-ctrl-btn" disabled={replayIdx >= totalCandles - 1} onClick={() => jumpToReplayIndex(replayIdx + 1)} title="Step forward (Right arrow)">›</button>
          <button className="replay-ctrl-btn" disabled={replayIdx >= totalCandles - 1} onClick={() => jumpToReplayIndex(totalCandles - 1)} title="Jump to end"><SkipForward size={14} /></button>

          <div className="replay-marker-controls">
            <button className="replay-ctrl-btn marker-entry" onClick={() => jumpToReplayIndex(replayData.entryIndex)} title="Jump to trade entry (E)"><LogIn size={14} /> Entry</button>
            <button className="replay-ctrl-btn marker-exit" onClick={() => jumpToReplayIndex(replayData.exitIndex)} title="Jump to trade exit (X)"><LogOut size={14} /> Exit</button>
          </div>

          <select className="replay-speed-select" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
            {SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}
          </select>

          <div className="replay-progress-wrap" style={{ flex: 1 }}>
            <div className="replay-progress-track" onClick={event => {
              const rect = event.currentTarget.getBoundingClientRect();
              const ratio = (event.clientX - rect.left) / rect.width;
              jumpToReplayIndex(Math.round(ratio * (totalCandles - 1)));
            }}>
              <div className="replay-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
