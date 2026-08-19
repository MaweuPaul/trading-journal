'use client';
import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, LineStyle, ColorType, CrosshairMode } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { X, Loader2, AlertTriangle } from 'lucide-react';
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

export default function InvestorReplayModal({ tradeId, tradeSummary, onClose }: Props) {
  const { resolvedTheme } = useTheme();
  const [replayData, setReplayData] = useState<ReplayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

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
      } catch (caught) {
        if (caught instanceof Error && caught.name !== 'AbortError') setError(caught.message);
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [tradeId]);

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
    series.setData(replayData.candles);
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
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, [replayData, resolvedTheme]);

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
    </div>
  );
}
