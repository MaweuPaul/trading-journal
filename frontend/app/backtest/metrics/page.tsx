'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import {
  ArrowLeft, FlaskConical, Zap, Target, TrendingUp, TrendingDown, AlertTriangle, Shield,
} from 'lucide-react';

interface BacktestTrade {
  _id: string;
  symbol: string;
  interval: string;
  direction: 'long' | 'short';
  entryTime: number; entryPrice: number;
  exitTime: number; exitPrice: number;
  stopLoss: number; takeProfit: number | null;
  outcome: 'win' | 'loss' | 'breakeven';
  riskAmount: number; pnlUSD: number; rMultiple: number;
  notes: string;
  createdAt: string;
}

interface EquityPoint {
  index: number;
  date: string;
  cumulativeR: number;
  drawdownR: number;
  rMultiple: number;
  symbol: string;
  direction: string;
}

function EquityTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload as EquityPoint | undefined;
  if (!d) return null;
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '12px 16px', boxShadow: 'var(--shadow-card)', minWidth: 170,
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Trade #{d.index + 1} · {new Date(d.date).toLocaleDateString()}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
        {d.cumulativeR >= 0 ? '+' : ''}{d.cumulativeR.toFixed(2)}R
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: d.rMultiple >= 0 ? 'var(--green)' : 'var(--red)', marginTop: 4 }}>
        {d.rMultiple >= 0 ? '+' : ''}{d.rMultiple.toFixed(2)}R &nbsp;<span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{d.symbol} {d.direction}</span>
      </div>
    </div>
  );
}

function DrawdownTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload as EquityPoint | undefined;
  if (!d) return null;
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px', boxShadow: 'var(--shadow-card)' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Trade #{d.index + 1}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>{d.drawdownR.toFixed(2)}R</div>
    </div>
  );
}

export default function BacktestMetricsPage() {
  const router = useRouter();
  const [trades, setTrades] = useState<BacktestTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { router.push('/login'); return; }
    fetch('/api/backtest-trades', { headers: { Authorization: `Bearer ${token}` } })
      .then(async res => {
        if (res.status === 401) { localStorage.removeItem('token'); router.push('/login'); return; }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load backtest log');
        setTrades(data.trades || []);
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Could not load backtest log'))
      .finally(() => setLoading(false));
  }, [router]);

  const chronological = useMemo(
    () => [...trades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [trades],
  );

  const { curve, stats, bySymbol } = useMemo(() => {
    let cumulativeR = 0;
    let peakR = 0;
    let maxDrawdownR = 0;
    let winStreak = 0, lossStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
    const curve: EquityPoint[] = [];
    const symbolMap = new Map<string, { trades: number; wins: number; totalR: number }>();

    for (let i = 0; i < chronological.length; i++) {
      const t = chronological[i];
      cumulativeR += t.rMultiple;
      peakR = Math.max(peakR, cumulativeR);
      const drawdownR = cumulativeR - peakR;
      maxDrawdownR = Math.min(maxDrawdownR, drawdownR);

      if (t.outcome === 'win') { winStreak += 1; lossStreak = 0; }
      else if (t.outcome === 'loss') { lossStreak += 1; winStreak = 0; }
      else { winStreak = 0; lossStreak = 0; }
      maxWinStreak = Math.max(maxWinStreak, winStreak);
      maxLossStreak = Math.max(maxLossStreak, lossStreak);

      curve.push({ index: i, date: t.createdAt, cumulativeR, drawdownR, rMultiple: t.rMultiple, symbol: t.symbol, direction: t.direction });

      const entry = symbolMap.get(t.symbol) || { trades: 0, wins: 0, totalR: 0 };
      entry.trades += 1;
      if (t.outcome === 'win') entry.wins += 1;
      entry.totalR += t.rMultiple;
      symbolMap.set(t.symbol, entry);
    }

    const wins = chronological.filter(t => t.outcome === 'win');
    const losses = chronological.filter(t => t.outcome === 'loss');
    const winRate = chronological.length ? (wins.length / chronological.length) * 100 : 0;
    const avgR = chronological.length ? cumulativeR / chronological.length : 0;
    const avgWinR = wins.length ? wins.reduce((s, t) => s + t.rMultiple, 0) / wins.length : 0;
    const avgLossR = losses.length ? losses.reduce((s, t) => s + t.rMultiple, 0) / losses.length : 0;
    const grossWinR = wins.reduce((s, t) => s + t.rMultiple, 0);
    const grossLossR = Math.abs(losses.reduce((s, t) => s + t.rMultiple, 0));
    const profitFactor = grossLossR > 0 ? grossWinR / grossLossR : grossWinR > 0 ? 999 : 0;
    const bestR = chronological.length ? Math.max(...chronological.map(t => t.rMultiple)) : 0;
    const worstR = chronological.length ? Math.min(...chronological.map(t => t.rMultiple)) : 0;
    const totalPnl = chronological.reduce((s, t) => s + t.pnlUSD, 0);

    const bySymbol = Array.from(symbolMap.entries())
      .map(([symbol, v]) => ({ symbol, trades: v.trades, winRate: (v.wins / v.trades) * 100, avgR: v.totalR / v.trades, totalR: v.totalR }))
      .sort((a, b) => b.trades - a.trades);

    return {
      curve,
      bySymbol,
      stats: {
        totalTrades: chronological.length, winRate, avgR, avgWinR, avgLossR,
        profitFactor, bestR, worstR, maxWinStreak, maxLossStreak, maxDrawdownR,
        totalR: cumulativeR, totalPnl,
      },
    };
  }, [chronological]);

  const hasCurve = curve.length > 0;

  return (
    <main className="page-content">
      <header className="page-header">
        <div className="page-header-inner">
          <div>
            <Link href="/backtest" className="btn-ghost" style={{ marginBottom: 10, display: 'inline-flex' }}>
              <ArrowLeft size={14} /> Back to Backtest
            </Link>
            <h2><FlaskConical size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />Backtest Metrics</h2>
            <p>Edge stats and equity curve for your hypothetical backtest log — separate from your real trade performance.</p>
          </div>
        </div>
      </header>

      {loading ? (
        <div className="loading-wrap"><div className="spinner" /></div>
      ) : error ? (
        <div className="empty-state"><p>{error}</p></div>
      ) : stats.totalTrades === 0 ? (
        <div className="empty-state">
          <h3>No backtests logged yet</h3>
          <p>Log a few hypothetical trades on the Backtest page to see your edge stats and equity curve here.</p>
        </div>
      ) : (
        <>
          <div className="stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
            <div className="stat-card blue-card">
              <div className="stat-label">TRADES LOGGED</div>
              <div className="stat-value">{stats.totalTrades}</div>
            </div>
            <div className="stat-card green-card">
              <div className="stat-label">WIN RATE</div>
              <div className="stat-value">{stats.winRate.toFixed(1)}%</div>
            </div>
            <div className="stat-card blue-card">
              <div className="stat-label">TOTAL R</div>
              <div className={`stat-value ${stats.totalR >= 0 ? 'positive' : 'negative'}`}>{stats.totalR >= 0 ? '+' : ''}{stats.totalR.toFixed(2)}R</div>
            </div>
            <div className={`stat-card ${stats.totalPnl >= 0 ? 'green-card' : 'red-card'}`}>
              <div className="stat-label">TOTAL P&amp;L</div>
              <div className={`stat-value ${stats.totalPnl >= 0 ? 'positive' : 'negative'}`}>{stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)}</div>
            </div>
          </div>

          {/* ── Equity Curve (cumulative R) ──────────────────────────── */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <div>
                <div className="card-title">Equity Curve</div>
                <div className="card-subtitle">Cumulative R over {stats.totalTrades} backtest trades, in the order you logged them</div>
              </div>
            </div>
            <div style={{ height: 280, padding: '8px 0 0' }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={curve} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="btEquityGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={stats.totalR >= 0 ? '#00b074' : '#e8364a'} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={stats.totalR >= 0 ? '#00b074' : '#e8364a'} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="index" tickFormatter={i => `#${Number(i) + 1}`} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => `${v}R`} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} width={50} />
                  <Tooltip content={<EquityTooltip />} />
                  <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 4" />
                  <Area
                    type="monotone" dataKey="cumulativeR"
                    stroke={stats.totalR >= 0 ? '#00b074' : '#e8364a'} strokeWidth={2}
                    fill="url(#btEquityGrad)" dot={false}
                    activeDot={{ r: 4, fill: stats.totalR >= 0 ? '#00b074' : '#e8364a' }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ── Drawdown ──────────────────────────────────────────────── */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <div>
                <div className="card-title">Drawdown Chart</div>
                <div className="card-subtitle">R decline from peak equity — shows your worst losing runs</div>
              </div>
            </div>
            <div style={{ height: 180, padding: '8px 0 0' }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={curve} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="btDdGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#e8364a" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#e8364a" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="index" tickFormatter={i => `#${Number(i) + 1}`} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => `${v}R`} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} width={50} />
                  <Tooltip content={<DrawdownTooltip />} />
                  <Area type="monotone" dataKey="drawdownR" stroke="#e8364a" strokeWidth={2} fill="url(#btDdGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ── Edge stats ────────────────────────────────────────────── */}
          <div className="card" style={{ marginBottom: 20, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
              {[
                {
                  label: 'Profit Factor', value: stats.profitFactor >= 999 ? '∞' : stats.profitFactor.toFixed(2),
                  sub: stats.profitFactor >= 1.5 ? 'Strong edge ✓' : stats.profitFactor >= 1 ? 'Break-even edge' : 'Losing system ✗',
                  good: stats.profitFactor >= 1, icon: <Zap size={14} />,
                },
                {
                  label: 'Expectancy', value: `${stats.avgR >= 0 ? '+' : ''}${stats.avgR.toFixed(2)}R`, sub: 'Avg R per trade',
                  good: stats.avgR >= 0, icon: <Target size={14} />,
                },
                {
                  label: 'Max Drawdown', value: `${stats.maxDrawdownR.toFixed(2)}R`, sub: 'Worst peak-to-trough decline',
                  good: stats.maxDrawdownR >= -3, icon: <Shield size={14} />,
                },
                {
                  label: 'Avg Win', value: `+${stats.avgWinR.toFixed(2)}R`, sub: 'Average winning trade',
                  good: true, icon: <TrendingUp size={14} />,
                },
                {
                  label: 'Avg Loss', value: `${stats.avgLossR.toFixed(2)}R`, sub: 'Average losing trade',
                  good: false, icon: <TrendingDown size={14} />,
                },
                {
                  label: 'Best Trade', value: `${stats.bestR >= 0 ? '+' : ''}${stats.bestR.toFixed(2)}R`, sub: 'Single best trade',
                  good: true, icon: <TrendingUp size={14} />,
                },
                {
                  label: 'Worst Trade', value: `${stats.worstR.toFixed(2)}R`, sub: 'Single worst trade',
                  good: false, icon: <AlertTriangle size={14} />,
                },
                {
                  label: 'Max Win Streak', value: `${stats.maxWinStreak}`, sub: 'Consecutive wins',
                  good: true, icon: <TrendingUp size={14} />,
                },
                {
                  label: 'Max Loss Streak', value: `${stats.maxLossStreak}`, sub: 'Consecutive losses',
                  good: stats.maxLossStreak <= 3, icon: <TrendingDown size={14} />,
                },
              ].map((m, i) => (
                <div key={i} style={{
                  padding: '18px 20px',
                  borderRight: i % 3 !== 2 ? '1px solid var(--border)' : 'none',
                  borderBottom: i < 6 ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, color: 'var(--text-muted)' }}>
                    {m.icon}
                    <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase' }}>{m.label}</span>
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: m.good ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--font-mono)' }}>{m.value}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{m.sub}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── By symbol ─────────────────────────────────────────────── */}
          {bySymbol.length > 0 && (
            <div className="table-wrap">
              <div className="card-header" style={{ padding: '14px 16px 0' }}>
                <div className="card-title">By Symbol</div>
              </div>
              <table className="data-table">
                <thead>
                  <tr><th>Symbol</th><th>Trades</th><th>Win Rate</th><th>Avg R</th><th>Total R</th></tr>
                </thead>
                <tbody>
                  {bySymbol.map(s => (
                    <tr key={s.symbol}>
                      <td>{s.symbol}</td>
                      <td>{s.trades}</td>
                      <td>{s.winRate.toFixed(1)}%</td>
                      <td className={s.avgR >= 0 ? 'positive' : 'negative'}>{s.avgR >= 0 ? '+' : ''}{s.avgR.toFixed(2)}R</td>
                      <td className={s.totalR >= 0 ? 'positive' : 'negative'}>{s.totalR >= 0 ? '+' : ''}{s.totalR.toFixed(2)}R</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}
