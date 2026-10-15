'use client';
import { useEffect, useState } from 'react';
import { PAGE_PURPOSE } from '@/components/pagePurpose';
import { LikelyRange, SampleTag, thinRowStyle } from '@/components/Confidence';
import type { Confidence } from '@/components/confidenceMath';
import { useRouter } from 'next/navigation';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, PieChart, Pie, Legend
} from 'recharts';
import { Clock, BarChart2, Smile, Award, Activity, CheckSquare, Calendar, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';
import { useAccountKeyFilter } from '@/hooks/useAccountKeyFilter';

const API = '/api';

interface Stats {
  totalTrades: number;
  winRate: number;
  avgDurationMin: number;
  bySymbol: { symbol: string; pnl: number; trades: number; wins: number; winRate: number; confidence?: Confidence }[];
  byDayOfWeek: { day: string; pnl: number; trades: number; confidence?: Confidence }[];
  byMonth: { month: string; pnl: number; trades: number; wins: number; confidence?: Confidence }[];
  bySession: { session: string; pnl: number; trades: number; wins: number; winRate: number; confidence?: Confidence }[];
  byDirection: { direction: string; pnl: number; trades: number; wins: number; winRate: number; avgPnL: number; confidence?: Confidence }[];
  byTag: { tag: string; pnl: number; trades: number; wins: number; winRate: number; confidence?: Confidence }[];
  byEmotion: { emotion: string; pnl: number; trades: number; wins: number; winRate: number; confidence?: Confidence }[];
  byGrade: { grade: string; pnl: number; trades: number; wins: number; winRate: number; confidence?: Confidence }[];
  globalComplianceRate: number | null;
  tradesWithPlaybookData?: number;
  mixedAccounts?: boolean;
  accountKeys?: string[];
  avgR?: number | null;
  avgWinR?: number | null;
  avgLossR?: number | null;
  tradesWithRiskData?: number;
}

interface TradeAccountOption {
  accountKey: string;
  accountName: string;
  accountType: string;
  label: string;
  count: number;
}

const DAY_SHORT: Record<string, string> = {
  Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue',
  Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat',
};

const PIE_COLORS = ['#3b82f6','#00b074','#e8364a','#f59e0b','#06b6d4','#0d9488','#0284c7','#10b981'];

function PnLTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const pnl = d.pnl ?? payload[0].value;
  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '10px 14px',
      boxShadow: '0 4px 16px rgba(15,22,41,0.1)',
    }}>
      <div style={{ color: '#8b95b0', fontSize: 11, marginBottom: 4 }}>
        {d.symbol || d.day || d.month || d.session || d.tag || d.emotion || d.grade}
      </div>
      <div style={{
        color: pnl >= 0 ? 'var(--green)' : 'var(--red)',
        fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700
      }}>
        {pnl >= 0 ? '+' : ''}${Math.abs(pnl).toFixed(2)}
      </div>
      {d.trades != null && (
        <div style={{ color: '#8b95b0', fontSize: 11, marginTop: 2 }}>{d.trades} trades</div>
      )}
    </div>
  );
}

function BarGroup({ data, dataKey = 'pnl', labelKey = 'symbol' }: {
  data: any[]; dataKey?: string; labelKey?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey={labelKey}
          tick={{ fill: '#8b95b0', fontSize: 10 }}
          axisLine={false} tickLine={false}
        />
        <YAxis
          tickFormatter={v => `$${Math.round(v)}`}
          tick={{ fill: '#8b95b0', fontSize: 10 }}
          axisLine={false} tickLine={false} width={52}
        />
        <Tooltip content={<PnLTooltip />} />
        <Bar dataKey={dataKey} radius={[5, 5, 0, 0]} maxBarSize={40}>
          {data.map((d, i) => (
            <Cell key={i} fill={d[dataKey] >= 0 ? '#00b074' : '#e8364a'} fillOpacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function formatDuration(m: number) {
  if (m < 60) return `${Math.round(m)}m`;
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
}

/** "12 trades · early" when the backend sent confidence, else the plain count. */
function TradeCount({ n, confidence }: { n: number; confidence?: Confidence }) {
  return confidence ? <SampleTag n={n} level={confidence.level} /> : <span style={{ color: 'var(--text-muted)' }}>{n} trades</span>;
}
const pct = (v: number) => `${v.toFixed(0)}%`;

export default function StatsPage() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState('all');
  const [hasToken, setHasToken] = useState(false);
  const [groupBySetup, setGroupBySetup] = useState(false);
  const [accountKeyFilter, setAccountKeyFilter, accountFilterReady, setKnownAccounts] = useAccountKeyFilter();
  const [tradeAccounts, setTradeAccounts] = useState<TradeAccountOption[]>([]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch(`${API}/trade-accounts`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('Could not load trading accounts')))
      .then(body => { setTradeAccounts(body.accounts || []); setKnownAccounts(body.accounts || [], Number(body.unassignedCount || 0)); })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/login');
      return;
    }
    setHasToken(true);
    if (!accountFilterReady) return;

    setLoading(true);
    const params = new URLSearchParams({ range, groupBySetup: String(groupBySetup) });
    if (accountKeyFilter) params.set('accountKey', accountKeyFilter);
    fetch(`${API}/stats?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(r => {
        if (r.status === 401) {
          localStorage.removeItem('token');
          router.push('/login');
          throw new Error('Unauthorized');
        }
        return r.json();
      })
      .then(setStats)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [range, groupBySetup, accountKeyFilter, accountFilterReady, router]);

  if (loading) return <div className="loading-wrap"><div className="spinner" /></div>;
  if (!hasToken) return null;
  if (!stats)  return (
    <div className="empty-state">
      <div className="empty-icon"><BarChart2 size={22} /></div>
      <h3>Failed to load analytics</h3>
      <p>Make sure the backend is running on port 4000</p>
    </div>
  );

  const bySymbol = stats.bySymbol || [];
  const byDayOfWeek = stats.byDayOfWeek || [];
  const byMonth = stats.byMonth || [];
  const bySession = stats.bySession || [];
  const byDirection = stats.byDirection || [];
  const byTag = stats.byTag || [];
  const byEmotion = stats.byEmotion || [];
  const byGrade = stats.byGrade || [];

  const topSymbols = [...bySymbol].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, 8);
  const pieData = topSymbols.map(s => ({ name: s.symbol, value: Math.abs(s.pnl) }));
  
  const bestDay = byDayOfWeek.length > 0 && byDayOfWeek.some(d => d.trades > 0)
    ? byDayOfWeek.reduce((a, b) => a.pnl > b.pnl ? a : b).day
    : null;
  const bestMonth = byMonth.length > 0
    ? byMonth.reduce((a, b) => a.pnl > b.pnl ? a : b).month
    : null;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-inner">
          <div>
            <h2>Analytics</h2>
            <p><strong style={{ color: 'var(--text-secondary)' }}>{PAGE_PURPOSE['/stats'].question}</strong> {PAGE_PURPOSE['/stats'].detail}</p>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
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
                  onChange={e => { setAccountKeyFilter(e.target.value); setLoading(true); }}
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
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 10px', boxShadow: 'var(--shadow-sm)' }}>
              <Calendar size={14} style={{ color: 'var(--text-muted)' }} />
              <select
                value={range}
                onChange={e => { setRange(e.target.value); setLoading(true); }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  outline: 'none',
                  cursor: 'pointer'
                }}
              >
                <option value="all">All-Time History</option>
                <option value="today">Today</option>
                <option value="7d">Last 7 Days</option>
                <option value="30d">Last 30 Days</option>
                <option value="3m">Last 3 Months</option>
                <option value="6m">Last 6 Months</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {stats.mixedAccounts && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'var(--amber-bg, rgba(245,158,11,0.12))', border: '1px solid var(--amber, #f59e0b)',
          borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 16, fontSize: 13,
        }}>
          <AlertTriangle size={16} style={{ flexShrink: 0, color: 'var(--amber, #f59e0b)' }} />
          <span>This view blends trades from more than one broker account. Pick a single account above for accurate per-account figures.</span>
        </div>
      )}

      {/* Summary row */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card blue-card">
          <div className="stat-icon blue"><Clock size={14} /></div>
          <div className="stat-label">Avg Trade Duration</div>
          <div className="stat-value blue">{formatDuration(stats.avgDurationMin)}</div>
          <div className="stat-sub">Per closed position</div>
        </div>
        <div className="stat-card green-card">
          <div className="stat-icon green"><CheckSquare size={14} /></div>
          <div className="stat-label">Playbook Discipline</div>
          <div className="stat-value green">{stats.globalComplianceRate == null ? '—' : `${stats.globalComplianceRate.toFixed(0)}%`}</div>
          <div className="stat-sub">
            {stats.globalComplianceRate == null
              ? 'No required playbook fields answered yet'
              : `Required fields completed across ${stats.tradesWithPlaybookData} journaled trade${stats.tradesWithPlaybookData === 1 ? '' : 's'}`}
          </div>
        </div>
        <div className="stat-card green-card">
          <div className="stat-icon green"><Activity size={14} /></div>
          <div className="stat-label">Best Day</div>
          <div className="stat-value green">{bestDay ? DAY_SHORT[bestDay] : '—'}</div>
          <div className="stat-sub">Highest P&L weekday</div>
        </div>
        <div className="stat-card green-card">
          <div className="stat-icon green"><BarChart2 size={14} /></div>
          <div className="stat-label">Best Month</div>
          <div className="stat-value green">{bestMonth || '—'}</div>
          <div className="stat-sub">Highest P&L month</div>
        </div>
      </div>

      {/* Realized R — replaces "Sharpe on $ P&L", which isn't a meaningful
         risk-adjusted metric per-trade. R needs the stop-based riskUSD MT5
         records at entry, so only trades synced with that field count. */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className={`stat-card ${(stats.avgR ?? 0) >= 0 ? 'green-card' : 'red-card'}`}>
          <div className={`stat-icon ${(stats.avgR ?? 0) >= 0 ? 'green' : 'red'}`}><TrendingUp size={14} /></div>
          <div className="stat-label">Avg R</div>
          <div className={`stat-value ${(stats.avgR ?? 0) >= 0 ? 'green' : 'red'}`}>
            {stats.avgR == null ? '—' : `${stats.avgR >= 0 ? '+' : ''}${stats.avgR.toFixed(2)}R`}
          </div>
          <div className="stat-sub">
            {stats.tradesWithRiskData
              ? `From ${stats.tradesWithRiskData} of ${stats.totalTrades} trades with a recorded stop`
              : 'No trades with a recorded stop yet'}
          </div>
        </div>
        <div className="stat-card green-card">
          <div className="stat-icon green"><TrendingUp size={14} /></div>
          <div className="stat-label">Avg Win</div>
          <div className="stat-value green">{stats.avgWinR == null ? '—' : `+${stats.avgWinR.toFixed(2)}R`}</div>
          <div className="stat-sub">Average R on winning trades</div>
        </div>
        <div className="stat-card red-card">
          <div className="stat-icon red"><TrendingDown size={14} /></div>
          <div className="stat-label">Avg Loss</div>
          <div className="stat-value red">{stats.avgLossR == null ? '—' : `${stats.avgLossR.toFixed(2)}R`}</div>
          <div className="stat-sub">Average R on losing trades</div>
        </div>
      </div>

      {/* Financial Session Performance Analysis */}
      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">P&L by Session</div>
              <div className="card-subtitle">Performance per global financial trading session</div>
            </div>
          </div>
          {bySession.some(s => s.trades > 0) ? (
            <div className="chart-wrap">
              <BarGroup data={bySession} dataKey="pnl" labelKey="session" />
            </div>
          ) : <div className="empty-state" style={{ padding: 32 }}><h3>No session data in range</h3></div>}
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Session Performance Breakdown</div>
              <div className="card-subtitle">Trade frequency & Win rate by hour session</div>
            </div>
          </div>
          <div className="session-summary-box">
            {bySession.map(s => {
              const active = s.trades > 0;
              return (
                <div className="session-summary-row" key={s.session} style={{ opacity: active ? 1 : 0.55, ...(active ? thinRowStyle(s.confidence) : {}) }}>
                  <div className="session-name">{s.session}</div>
                  <div className="session-stats-group">
                    <TradeCount n={s.trades} confidence={s.confidence} />
                    {active ? (
                      <>
                        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.25 }}>
                          <span style={{ color: s.winRate >= 50 ? 'var(--green)' : 'var(--red)', fontWeight: 600, whiteSpace: 'nowrap' }}>{s.winRate.toFixed(0)}% WR</span>
                          <LikelyRange range={s.confidence?.winRateRange} format={pct} style={{ fontSize: 10 }} />
                        </span>
                        <span className={`pnl ${s.pnl >= 0 ? 'positive' : 'negative'}`}>
                          {s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)}
                        </span>
                      </>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Buy vs Sell Profitability */}
      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Buy vs Sell</div>
              <div className="card-subtitle">Which direction is more profitable</div>
            </div>
          </div>
          {byDirection.some(d => d.trades > 0) ? (
            <div className="chart-wrap">
              <BarGroup data={byDirection} dataKey="pnl" labelKey="direction" />
            </div>
          ) : <div className="empty-state" style={{ padding: 32 }}><h3>No direction data in range</h3></div>}
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Direction Breakdown</div>
              <div className="card-subtitle">Trade count, win rate & average P&L per direction</div>
            </div>
          </div>
          {(() => {
            const buy = byDirection.find(d => d.direction === 'BUY');
            const sell = byDirection.find(d => d.direction === 'SELL');
            const winner = buy && sell && (buy.trades > 0 || sell.trades > 0)
              ? (buy.pnl === sell.pnl ? null : buy.pnl > sell.pnl ? 'BUY' : 'SELL')
              : null;
            return (
              <>
                {winner && (
                  <div style={{ padding: '8px 12px', marginBottom: 10, borderRadius: 8, background: 'var(--bg-elevated)', fontSize: 12.5 }}>
                    <strong style={{ color: winner === 'BUY' ? '#3b82f6' : '#e8364a' }}>{winner}</strong> trades have been more profitable overall.
                  </div>
                )}
                <div className="session-summary-box">
                  {byDirection.map(d => {
                    const active = d.trades > 0;
                    return (
                      <div className="session-summary-row" key={d.direction} style={{ opacity: active ? 1 : 0.55, ...(active ? thinRowStyle(d.confidence) : {}) }}>
                        <div className="session-name">{d.direction}</div>
                        <div className="session-stats-group">
                          <TradeCount n={d.trades} confidence={d.confidence} />
                          {active ? (
                            <>
                              <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.25 }}>
                                <span style={{ color: d.winRate >= 50 ? 'var(--green)' : 'var(--red)', fontWeight: 600, whiteSpace: 'nowrap' }}>{d.winRate.toFixed(0)}% WR</span>
                                <LikelyRange range={d.confidence?.winRateRange} format={pct} style={{ fontSize: 10 }} />
                              </span>
                              <span style={{ color: 'var(--text-muted)' }}>
                                avg {d.avgPnL >= 0 ? '+' : ''}${d.avgPnL.toFixed(2)}
                              </span>
                              <span className={`pnl ${d.pnl >= 0 ? 'positive' : 'negative'}`}>
                                {d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}
                              </span>
                            </>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>—</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {/* Psychology and Grades Impact Analysis */}
      <div className="grid-2">
        {/* Setup grade performance impact */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Setup Grade Performance</div>
              <div className="card-subtitle">Are A-setups more profitable than boredom (F) trades?</div>
            </div>
          </div>
          {byGrade.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {byGrade.map(g => (
                <div className="session-summary-row" key={g.grade} style={thinRowStyle(g.confidence)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className={`grade-pill-tag ${g.grade}`}>{g.grade}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Quality Setup</span>
                  </div>
                  <div className="session-stats-group">
                    <TradeCount n={g.trades} confidence={g.confidence} />
                    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.25 }}>
                      <span style={{ color: g.winRate >= 50 ? 'var(--green)' : 'var(--red)', fontWeight: 600, whiteSpace: 'nowrap' }}>{g.winRate.toFixed(0)}% WR</span>
                      <LikelyRange range={g.confidence?.winRateRange} format={pct} style={{ fontSize: 10 }} />
                    </span>
                    <span className={`pnl ${g.pnl >= 0 ? 'positive' : 'negative'}`}>
                      {g.pnl >= 0 ? '+' : ''}${g.pnl.toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state" style={{ padding: 40 }}>
              <div className="empty-icon"><Award size={20} /></div>
              <h3>No grade data in range</h3>
              <p>Click on any trade in the Trades list to assign a Setup Quality Grade (A-F).</p>
            </div>
          )}
        </div>

        {/* Emotion mindset impact */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Psychology & Emotional Mindset Impact</div>
              <div className="card-subtitle">P&L performance based on your mindset state</div>
            </div>
          </div>
          {byEmotion.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {byEmotion.map(e => (
                <div className="session-summary-row" key={e.emotion} style={thinRowStyle(e.confidence)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
                      {e.emotion === 'Calm' ? '😊 Calm' :
                       e.emotion === 'Disciplined' ? '🧠 Disciplined' :
                       e.emotion === 'Anxious' ? '😰 Anxious' :
                       e.emotion === 'Greedy' ? '🤑 Greedy' :
                       e.emotion === 'Fearful' ? '😨 Fearful' :
                       e.emotion === 'FOMO' ? '💥 FOMO' : e.emotion}
                    </span>
                  </div>
                  <div className="session-stats-group">
                    <TradeCount n={e.trades} confidence={e.confidence} />
                    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.25 }}>
                      <span style={{ color: e.winRate >= 50 ? 'var(--green)' : 'var(--red)', fontWeight: 600, whiteSpace: 'nowrap' }}>{e.winRate.toFixed(0)}% WR</span>
                      <LikelyRange range={e.confidence?.winRateRange} format={pct} style={{ fontSize: 10 }} />
                    </span>
                    <span className={`pnl ${e.pnl >= 0 ? 'positive' : 'negative'}`}>
                      {e.pnl >= 0 ? '+' : ''}${e.pnl.toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state" style={{ padding: 40 }}>
              <div className="empty-icon"><Smile size={20} /></div>
              <h3>No psychological logs in range</h3>
              <p>Open the journal drawer on your trades to record your executing mindsets.</p>
            </div>
          )}
        </div>
      </div>

      {/* Strategy Tags performance */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Strategy Confluence Conformance</div>
            <div className="card-subtitle">Which strategy tags yield the highest returns</div>
          </div>
        </div>
        {byTag.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {byTag.map(t => (
              <div className="session-summary-row" key={t.tag} style={thinRowStyle(t.confidence)}>
                <span className="tag-badge" style={{ border: 'none', background: 'var(--accent-light)', color: 'var(--accent)', fontWeight: 700 }}>
                  #{t.tag}
                </span>
                <div className="session-stats-group">
                  <TradeCount n={t.trades} confidence={t.confidence} />
                  <span className={`pnl ${t.pnl >= 0 ? 'positive' : 'negative'}`}>
                    {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state" style={{ padding: 32 }}>
            <h3>No confluences tagged in range</h3>
            <p>Add tags to your trades in the journal drawer (e.g. #double-bottom, #fomc) to isolate what works.</p>
          </div>
        )}
      </div>

      {/* Charts row 1 */}
      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">P&L by Pair</div>
              <div className="card-subtitle">Net profit per instrument</div>
            </div>
          </div>
          {topSymbols.length > 0 ? (
            <div className="chart-wrap">
              <BarGroup data={topSymbols} dataKey="pnl" labelKey="symbol" />
            </div>
          ) : <div className="empty-state" style={{ padding: 32 }}><h3>No data in range</h3></div>}
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Volume by Pair</div>
              <div className="card-subtitle">Absolute P&L distribution</div>
            </div>
          </div>
          {pieData.length > 0 ? (
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="45%" outerRadius={82} stroke="none">
                    {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Legend
                    formatter={v => <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{v}</span>}
                  />
                  <Tooltip
                    formatter={(v: any) => [`$${Number(v).toFixed(2)}`, 'Volume']}
                    contentStyle={{ background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius:10 }}
                    itemStyle={{ color:'var(--text-primary)' }}
                    labelStyle={{ color:'var(--text-primary)' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : <div className="empty-state" style={{ padding: 32 }}><h3>No data in range</h3></div>}
        </div>
      </div>

      {/* Win rate by pair */}
      {bySymbol.length > 0 && (
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Win Rate by Pair</div>
              <div className="card-subtitle">% of profitable trades per instrument</div>
            </div>
          </div>
          {[...bySymbol].sort((a, b) => b.winRate - a.winRate).map(s => {
            const pct = Math.min(100, s.winRate);
            return (
              <div className="bar-item" key={s.symbol} style={thinRowStyle(s.confidence)}>
                <div className="bar-label">{s.symbol}</div>
                <div className="bar-track">
                  <div className={`bar-fill ${pct >= 50 ? 'positive' : 'negative'}`} style={{ width: `${pct}%` }} />
                </div>
                <div className={`bar-val pnl ${pct >= 50 ? 'positive' : 'negative'}`}>
                  {pct.toFixed(0)}% <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({s.trades})</span>
                  {s.confidence?.winRateRange && (
                    <div style={{ fontWeight: 400 }}><LikelyRange range={s.confidence.winRateRange} format={v => `${v.toFixed(0)}%`} style={{ fontSize: 10 }} /></div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Charts row 2 */}
      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">P&L by Day of Week</div>
              <div className="card-subtitle">Best and worst trading days</div>
            </div>
          </div>
          {byDayOfWeek.some(d => d.trades > 0) ? (
            <div className="chart-wrap">
              <BarGroup
                data={byDayOfWeek.map(d => ({ ...d, day: DAY_SHORT[d.day] }))}
                dataKey="pnl" labelKey="day"
              />
            </div>
          ) : <div className="empty-state" style={{ padding: 32 }}><h3>No data in range</h3></div>}
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Monthly P&L</div>
              <div className="card-subtitle">Net profit per calendar month</div>
            </div>
          </div>
          {byMonth.length > 0 ? (
            <div className="chart-wrap">
              <BarGroup data={byMonth} dataKey="pnl" labelKey="month" />
            </div>
          ) : <div className="empty-state" style={{ padding: 32 }}><h3>No data in range</h3></div>}
        </div>
      </div>

      {/* Monthly table */}
      {byMonth.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Trades</th>
                <th>Wins</th>
                <th>Win Rate</th>
                <th>Net P&L</th>
              </tr>
            </thead>
            <tbody>
              {[...byMonth].reverse().map(m => {
                const wr = m.trades > 0 ? (m.wins / m.trades) * 100 : 0;
                return (
                  <tr key={m.month} style={thinRowStyle(m.confidence)}>
                    <td className="text" style={{ fontWeight: 600 }}>{m.month}</td>
                    <td>{m.trades}</td>
                    <td>{m.wins}</td>
                    <td className={`pnl ${wr >= 50 ? 'positive' : 'negative'}`}>
                      {wr.toFixed(1)}%
                      {m.confidence?.winRateRange && <div><LikelyRange range={m.confidence.winRateRange} format={v => `${v.toFixed(0)}%`} style={{ fontSize: 10 }} /></div>}
                    </td>
                    <td className={`pnl ${m.pnl >= 0 ? 'positive' : 'negative'}`}>
                      {m.pnl >= 0 ? '+' : ''}${Math.abs(m.pnl).toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
