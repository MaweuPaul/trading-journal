'use client';
import { useEffect, useState, useCallback } from 'react';
import { PAGE_PURPOSE } from '@/components/pagePurpose';
import { ConfidenceLine, LikelyRange, signedUSD } from '@/components/Confidence';
import type { Confidence } from '@/components/confidenceMath';
import { useRouter } from 'next/navigation';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell
} from 'recharts';
import {
  TrendingUp, TrendingDown, Target, Zap, Shield,
  Award, AlertTriangle, Activity, DollarSign, Calendar
} from 'lucide-react';
import { useAccountKeyFilter } from '@/hooks/useAccountKeyFilter';

const API = '/api';

interface EquityPoint {
  date: string;
  balance: number;
  drawdown: number;
  pnl: number;
  symbol: string;
  direction: string;
}

interface PerfStats {
  confidence?: Confidence;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  rrRatio: number;
  expectancy: number;
  maxDrawdownPct: number;
  maxConsecWins: number;
  maxConsecLosses: number;
  largestWin: number;
  largestLoss: number;
  grossProfit: number;
  grossLoss: number;
  netPnL: number;
  growthPct: number;
  startBalance: number;
  currentBalance: number;
}

interface TradeAccountOption {
  accountKey: string;
  accountName: string;
  accountType: string;
  label: string;
  count: number;
}

function fmt(n: number, digits = 2) {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

function fmtDate(d: unknown) {
  return new Date(String(d || '')).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Custom tooltip for equity curve
function EquityTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '12px 16px', boxShadow: 'var(--shadow-card)',
      minWidth: 180,
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
        {d?.date ? new Date(d.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : label}
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
        {fmt(d?.balance || 0)}
      </div>
      {d?.pnl !== undefined && (
        <div style={{ fontSize: 12, fontWeight: 600, color: d.pnl >= 0 ? 'var(--green)' : 'var(--red)', marginTop: 4 }}>
          {d.pnl >= 0 ? '+' : ''}{fmt(d.pnl)} &nbsp;<span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{d.symbol} {d.direction}</span>
        </div>
      )}
    </div>
  );
}

// Custom tooltip for drawdown
function DrawdownTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '12px 16px', boxShadow: 'var(--shadow-card)',
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
        {d?.date ? fmtDate(d.date) : ''}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>
        {d?.drawdown?.toFixed(2)}%
      </div>
    </div>
  );
}

/**
 * The edge verdict, judged on the 95% range for expectancy rather than on
 * profit factor alone: a high profit factor over a handful of trades says
 * little, so "positive edge" needs the whole likely range above zero.
 */
function edgeVerdict(s: PerfStats | null): { label: string; summary: string } {
  if (!s) return { label: '', summary: '' };
  const c = s.confidence;
  if (c && c.level === 'insufficient') {
    return { label: 'Too few trades to call', summary: `⏳ ${c.n} trade${c.n === 1 ? '' : 's'} is too few to tell skill from luck. Keep trading your plan; a verdict starts to mean something from about 30 trades.` };
  }
  const r = c?.avgRange;
  const range = r ? `${signedUSD(r[0])} to ${signedUSD(r[1])}` : '';
  if (s.profitFactor >= 1) {
    if (r && r[0] > 0) return { label: 'Positive edge ✓', summary: `✅ Positive edge: even the low end of the likely range per trade (${range}) is above zero. Keep executing the system.` };
    return {
      label: s.profitFactor >= 1.5 ? 'Looks positive, not proven yet' : 'Break-even edge',
      summary: r
        ? `⚠️ Profitable so far, but the likely range per trade (${range}) still includes losing money, so this could still be luck. More trades will tell; meanwhile keep cutting losses and letting winners run.`
        : '⚠️ Your edge is marginal. Focus on cutting losses and letting winners run.',
    };
  }
  if (r && r[1] < 0) return { label: 'Losing system ✗', summary: `❌ Unprofitable: even the high end of the likely range per trade (${range}) is below zero. Review your entries and risk management.` };
  return {
    label: 'Losing so far',
    summary: r
      ? `❌ Losing so far, though the likely range per trade (${range}) still reaches a profit. Review your entries and risk management before reading too much into it.`
      : '❌ Your system is currently unprofitable. Review your entries and risk management.',
  };
}

const RANGES = [
  { label: 'All Time', value: 'all' },
  { label: '7 Days',   value: '7d'  },
  { label: '30 Days',  value: '30d' },
  { label: '3 Months', value: '3m'  },
  { label: '6 Months', value: '6m'  },
  { label: '1 Year',   value: '1y'  },
];

export default function PerformancePage() {
  const router = useRouter();
  const [range, setRange] = useState('all');
  const [curve, setCurve] = useState<EquityPoint[]>([]);
  const [stats, setStats] = useState<PerfStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [groupBySetup, setGroupBySetup] = useState(false);
  const [accountKeyFilter, setAccountKeyFilter, accountFilterReady] = useAccountKeyFilter();
  const [tradeAccounts, setTradeAccounts] = useState<TradeAccountOption[]>([]);
  const [mixedAccounts, setMixedAccounts] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch(`${API}/trade-accounts`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.ok ? res.json() : Promise.reject(new Error('Could not load trading accounts')))
      .then(body => setTradeAccounts(body.accounts || []))
      .catch(e => console.error(e));
  }, []);

  const load = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) { router.push('/login'); return; }
    if (!accountFilterReady) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ range, groupBySetup: String(groupBySetup) });
      if (accountKeyFilter) params.set('accountKey', accountKeyFilter);
      const res = await fetch(`${API}/performance?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { localStorage.removeItem('token'); router.push('/login'); return; }
      const data = await res.json();
      setCurve(data.equityCurve || []);
      setStats(data.stats || null);
      setMixedAccounts(Boolean(data.mixedAccounts));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [range, groupBySetup, accountKeyFilter, accountFilterReady, router]);

  useEffect(() => { load(); }, [load]);

  // Thin out curve for chart performance (max 300 points)
  const chartCurve = curve.length > 300
    ? curve.filter((_, i) => i % Math.ceil(curve.length / 300) === 0 || i === curve.length - 1)
    : curve;

  // PnL distribution for bar chart (last 40 trades)
  const recentPnl = curve.slice(-40);

  const hasCurve = chartCurve.length > 0;
  const isGrowth = stats && stats.netPnL >= 0;
  const edge = edgeVerdict(stats);

  return (
    <div>
      {/* Page Header */}
      <div className="page-header">
        <div className="page-header-inner">
          <div>
            <h2>Performance</h2>
            <p><strong style={{ color: 'var(--text-secondary)' }}>{PAGE_PURPOSE['/performance'].question}</strong> {PAGE_PURPOSE['/performance'].detail}</p>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 10px', boxShadow: 'var(--shadow-sm)' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>View:</span>
              <select
                value={String(groupBySetup)}
                onChange={e => { setGroupBySetup(e.target.value === 'true'); setLoading(true); }}
                style={{
                  border: 'none', background: 'transparent', fontSize: 12, fontWeight: 600,
                  color: 'var(--text-secondary)', outline: 'none', cursor: 'pointer'
                }}
              >
                <option value="false">🎫 Tickets (Individual)</option>
                <option value="true">🔁 Setups (Grouped Re-Entries)</option>
              </select>
            </div>

            {tradeAccounts.length > 0 && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 10px', boxShadow: 'var(--shadow-sm)' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>Account:</span>
                <select
                  value={accountKeyFilter}
                  onChange={e => setAccountKeyFilter(e.target.value)}
                  style={{
                    border: 'none', background: 'transparent', fontSize: 12, fontWeight: 600,
                    color: 'var(--text-secondary)', outline: 'none', cursor: 'pointer'
                  }}
                >
                  <option value="">All accounts</option>
                  {tradeAccounts.map(account => (
                    <option key={account.accountKey} value={account.accountKey}>
                      {account.label} ({account.accountType || 'unknown'})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Range pills */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {RANGES.map(r => (
                <button
                  key={r.value}
                  onClick={() => setRange(r.value)}
                  style={{
                    padding: '5px 14px',
                    borderRadius: 20,
                    border: range === r.value ? 'none' : '1px solid var(--border)',
                    background: range === r.value ? 'var(--accent)' : 'var(--bg-card)',
                    color: range === r.value ? '#fff' : 'var(--text-secondary)',
                    fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="loading-wrap" style={{ minHeight: 400 }}><div className="spinner" /></div>
      ) : !stats ? (
        <div className="empty-state" style={{ minHeight: 400 }}>
          <div className="empty-icon"><Activity size={24} /></div>
          <h3>No trade data found</h3>
          <p>Run the sync script to import your MT5 trades.</p>
        </div>
      ) : (
        <>
          {mixedAccounts && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: 'var(--amber-bg, rgba(245,158,11,0.12))', border: '1px solid var(--amber, #f59e0b)',
              borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 16, fontSize: 13,
            }}>
              <AlertTriangle size={16} style={{ flexShrink: 0, color: 'var(--amber, #f59e0b)' }} />
              <span>
                This view blends trades from more than one broker account. runningBalance, equity curve, and
                drawdown are per-account, so these numbers are not a real balance history — pick a single
                account above for accurate figures.
              </span>
            </div>
          )}

          {/* ── Hero KPI Row ──────────────────────────────────────── */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 14, marginBottom: 20,
          }}>
            {/* Net P&L */}
            <div className={`stat-card ${isGrowth ? 'green-card' : 'red-card'}`}>
              <div className={`stat-icon ${isGrowth ? 'green' : 'red'}`}><DollarSign size={14} /></div>
              <div className="stat-label">Net P&L</div>
              <div className={`stat-value ${isGrowth ? 'green' : 'red'}`}>
                {stats.netPnL >= 0 ? '+' : ''}{fmt(stats.netPnL)}
              </div>
              <div className="stat-sub">
                {stats.growthPct >= 0 ? '+' : ''}{stats.growthPct.toFixed(1)}% account growth
              </div>
            </div>

            {/* Profit Factor */}
            <div className={`stat-card ${stats.profitFactor >= 1.5 ? 'green-card' : stats.profitFactor >= 1 ? 'blue-card' : 'red-card'}`}>
              <div className={`stat-icon ${stats.profitFactor >= 1.5 ? 'green' : stats.profitFactor >= 1 ? 'blue' : 'red'}`}><Zap size={14} /></div>
              <div className="stat-label">Profit Factor</div>
              <div className={`stat-value ${stats.profitFactor >= 1.5 ? 'green' : stats.profitFactor >= 1 ? 'blue' : 'red'}`}>
                {stats.profitFactor >= 999 ? '∞' : stats.profitFactor.toFixed(2)}
              </div>
              <div className="stat-sub">
                {edge.label}
              </div>
              <div style={{ marginTop: 6 }}><ConfidenceLine confidence={stats.confidence} /></div>
            </div>

            {/* Expectancy */}
            <div className={`stat-card ${stats.expectancy >= 0 ? 'green-card' : 'red-card'}`}>
              <div className={`stat-icon ${stats.expectancy >= 0 ? 'green' : 'red'}`}><Target size={14} /></div>
              <div className="stat-label">Expectancy</div>
              <div className={`stat-value ${stats.expectancy >= 0 ? 'green' : 'red'}`}>
                {stats.expectancy >= 0 ? '+' : ''}{fmt(stats.expectancy)}
              </div>
              <div className="stat-sub">Avg $ made per trade</div>
              <div style={{ marginTop: 6 }}><ConfidenceLine confidence={stats.confidence} range="avg" format={signedUSD} /></div>
            </div>

            {/* Max Drawdown */}
            <div className={`stat-card ${stats.maxDrawdownPct >= -10 ? 'green-card' : stats.maxDrawdownPct >= -20 ? 'amber-card' : 'red-card'}`}>
              <div className={`stat-icon ${stats.maxDrawdownPct >= -10 ? 'green' : 'red'}`}><Shield size={14} /></div>
              <div className="stat-label">Max Drawdown</div>
              <div className={`stat-value ${stats.maxDrawdownPct >= -10 ? 'green' : 'red'}`}>
                {stats.maxDrawdownPct.toFixed(1)}%
              </div>
              <div className="stat-sub">
                {stats.maxDrawdownPct >= -5 ? 'Excellent control' : stats.maxDrawdownPct >= -15 ? 'Acceptable' : 'High risk'}
              </div>
            </div>
          </div>

          {/* ── Equity Curve ─────────────────────────────────────── */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <div>
                <div className="card-title">Equity Curve</div>
                <div className="card-subtitle">
                  Account balance over {stats.totalTrades} trades &nbsp;·&nbsp;
                  Started at <strong>{fmt(stats.startBalance)}</strong> &nbsp;→&nbsp;
                  Now <strong>{fmt(stats.currentBalance)}</strong>
                </div>
              </div>
            </div>
            {hasCurve ? (
              <div style={{ height: 280, padding: '8px 0 0' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartCurve} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={isGrowth ? '#00b074' : '#e8364a'} stopOpacity={0.25} />
                        <stop offset="100%" stopColor={isGrowth ? '#00b074' : '#e8364a'} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="date" tickFormatter={fmtDate}
                      tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                      axisLine={false} tickLine={false}
                      interval={Math.floor(chartCurve.length / 6)}
                    />
                    <YAxis
                      tickFormatter={v => `$${Math.round(v)}`}
                      tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                      axisLine={false} tickLine={false} width={60}
                    />
                    <Tooltip content={<EquityTooltip />} />
                    <ReferenceLine y={stats.startBalance} stroke="var(--border)" strokeDasharray="4 4" />
                    <Area
                      type="monotone" dataKey="balance"
                      stroke={isGrowth ? '#00b074' : '#e8364a'} strokeWidth={2}
                      fill="url(#balGrad)"
                      dot={false} activeDot={{ r: 4, fill: isGrowth ? '#00b074' : '#e8364a' }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="empty-state" style={{ padding: 40 }}><h3>No data in range</h3></div>
            )}
          </div>

          {/* ── Drawdown + Recent PnL Row ──────────────────────────── */}
          <div className="grid-2" style={{ marginBottom: 20 }}>
            {/* Drawdown chart */}
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Drawdown Chart</div>
                  <div className="card-subtitle">% decline from peak balance — shows losing streaks</div>
                </div>
              </div>
              {hasCurve ? (
                <div style={{ height: 200, padding: '8px 0 0' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartCurve} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#e8364a" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#e8364a" stopOpacity={0.05} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="date" tickFormatter={fmtDate}
                        tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                        axisLine={false} tickLine={false}
                        interval={Math.floor(chartCurve.length / 4)} />
                      <YAxis
                        tickFormatter={v => `${v.toFixed(0)}%`}
                        tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                        axisLine={false} tickLine={false} width={44} />
                      <Tooltip content={<DrawdownTooltip />} />
                      <ReferenceLine y={0} stroke="var(--border)" />
                      <Area type="monotone" dataKey="drawdown"
                        stroke="#e8364a" strokeWidth={1.5}
                        fill="url(#ddGrad)" dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="empty-state" style={{ padding: 32 }}><h3>No data</h3></div>
              )}
            </div>

            {/* Recent 40 trades P&L bars */}
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Recent Trade P&L</div>
                  <div className="card-subtitle">Last {recentPnl.length} individual trade results</div>
                </div>
              </div>
              {recentPnl.length > 0 ? (
                <div style={{ height: 200, padding: '8px 0 0' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={recentPnl} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="date" tickFormatter={fmtDate}
                        tick={{ fill: 'var(--text-muted)', fontSize: 9 }}
                        axisLine={false} tickLine={false}
                        interval={Math.floor(recentPnl.length / 5)} />
                      <YAxis tickFormatter={v => `$${v}`}
                        tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                        axisLine={false} tickLine={false} width={48} />
                      <Tooltip
                        formatter={(v: any) => [fmt(Number(v)), 'P&L']}
                        contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10 }}
                        labelFormatter={fmtDate}
                      />
                      <ReferenceLine y={0} stroke="var(--border)" />
                      <Bar dataKey="pnl" radius={[3, 3, 0, 0]} maxBarSize={18}>
                        {recentPnl.map((d, i) => (
                          <Cell key={i} fill={d.pnl >= 0 ? '#00b074' : '#e8364a'} fillOpacity={0.85} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="empty-state" style={{ padding: 32 }}><h3>No data</h3></div>
              )}
            </div>
          </div>

          {/* ── Risk Metrics Grid ─────────────────────────────────── */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <div>
                <div className="card-title">Risk Metrics</div>
                <div className="card-subtitle">The numbers that define your trading edge</div>
              </div>
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 0,
            }}>
              {[
                {
                  label: 'Win Rate',
                  value: `${stats.winRate.toFixed(1)}%`,
                  sub: stats.confidence?.winRateRange ? <>{stats.totalTrades} trades · <LikelyRange range={stats.confidence.winRateRange} format={v => `${v.toFixed(0)}%`} /></> : `${stats.totalTrades} trades`,
                  good: stats.winRate >= 50,
                  icon: <TrendingUp size={14} />,
                },
                {
                  label: 'Avg Win',
                  value: fmt(stats.avgWin),
                  sub: `vs avg loss ${fmt(stats.avgLoss)}`,
                  good: stats.avgWin >= stats.avgLoss,
                  icon: <Award size={14} />,
                },
                {
                  label: 'Avg R:R',
                  value: `${stats.rrRatio.toFixed(2)}:1`,
                  sub: stats.rrRatio >= 1.5 ? 'Good risk/reward' : stats.rrRatio >= 1 ? 'Breakeven R:R' : 'Poor risk/reward',
                  good: stats.rrRatio >= 1.5,
                  icon: <Target size={14} />,
                },
                {
                  label: 'Gross Profit',
                  value: fmt(stats.grossProfit),
                  sub: `Gross loss: ${fmt(stats.grossLoss)}`,
                  good: true,
                  icon: <DollarSign size={14} />,
                },
                {
                  label: 'Largest Win',
                  value: `+${fmt(stats.largestWin)}`,
                  sub: 'Single best trade',
                  good: true,
                  icon: <Zap size={14} />,
                },
                {
                  label: 'Largest Loss',
                  value: fmt(stats.largestLoss),
                  sub: 'Single worst trade',
                  good: false,
                  icon: <AlertTriangle size={14} />,
                },
                {
                  label: 'Max Consec. Wins',
                  value: `${stats.maxConsecWins}`,
                  sub: 'Winning streak',
                  good: true,
                  icon: <TrendingUp size={14} />,
                },
                {
                  label: 'Max Consec. Losses',
                  value: `${stats.maxConsecLosses}`,
                  sub: 'Losing streak',
                  good: stats.maxConsecLosses <= 3,
                  icon: <TrendingDown size={14} />,
                },
              ].map((m, i) => (
                <div key={i} style={{
                  padding: '18px 20px',
                  borderRight: i % 4 !== 3 ? '1px solid var(--border)' : 'none',
                  borderBottom: i < 4 ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <span style={{ color: m.good ? 'var(--green)' : 'var(--red)' }}>{m.icon}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                      {m.label}
                    </span>
                  </div>
                  <div style={{
                    fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-mono)',
                    color: m.good ? 'var(--text-primary)' : 'var(--red)',
                    letterSpacing: '-0.5px', marginBottom: 4,
                  }}>
                    {m.value}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{m.sub}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Edge Summary Card ─────────────────────────────────── */}
          <div className="card" style={{
            background: stats.profitFactor >= 1.5
              ? 'linear-gradient(135deg, rgba(0,176,116,0.08) 0%, var(--bg-card) 100%)'
              : stats.profitFactor >= 1
              ? 'linear-gradient(135deg, rgba(59,130,246,0.06) 0%, var(--bg-card) 100%)'
              : 'linear-gradient(135deg, rgba(232,54,74,0.08) 0%, var(--bg-card) 100%)',
            border: stats.profitFactor >= 1.5 ? '1px solid rgba(0,176,116,0.2)' : '1px solid var(--border)',
          }}>
            <div style={{ padding: '20px 24px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                  background: stats.profitFactor >= 1.5 ? 'rgba(0,176,116,0.15)' : stats.profitFactor >= 1 ? 'rgba(59,130,246,0.1)' : 'rgba(232,54,74,0.1)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: stats.profitFactor >= 1.5 ? 'var(--green)' : stats.profitFactor >= 1 ? 'var(--accent)' : 'var(--red)',
                }}>
                  <Activity size={20} />
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
                    Edge Summary
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    Over <strong>{stats.totalTrades}</strong> trades you have a <strong>{stats.winRate.toFixed(1)}% win rate</strong> with an average winner of <strong>{fmt(stats.avgWin)}</strong> and average loser of <strong>{fmt(stats.avgLoss)}</strong>.{' '}
                    Your profit factor is <strong style={{ color: stats.profitFactor >= 1.5 ? 'var(--green)' : stats.profitFactor >= 1 ? 'var(--accent)' : 'var(--red)' }}>
                      {stats.profitFactor >= 999 ? '∞' : stats.profitFactor.toFixed(2)}
                    </strong> — for every $1 lost you make <strong>${stats.profitFactor >= 999 ? '∞' : stats.profitFactor.toFixed(2)}</strong>.{' '}
                    Your system expectancy is <strong style={{ color: stats.expectancy >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(stats.expectancy)}</strong> per trade.{' '}
                    {edge.summary}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
