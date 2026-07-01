'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, PieChart, Pie, Legend
} from 'recharts';
import { Clock, BarChart2, Smile, Award, Activity, CheckSquare, Calendar } from 'lucide-react';

const API = '/api';

interface Stats {
  totalTrades: number;
  winRate: number;
  avgDurationMin: number;
  bySymbol: { symbol: string; pnl: number; trades: number; wins: number; winRate: number }[];
  byDayOfWeek: { day: string; pnl: number; trades: number }[];
  byMonth: { month: string; pnl: number; trades: number; wins: number }[];
  bySession: { session: string; pnl: number; trades: number; wins: number; winRate: number }[];
  byTag: { tag: string; pnl: number; trades: number; wins: number; winRate: number }[];
  byEmotion: { emotion: string; pnl: number; trades: number; wins: number; winRate: number }[];
  byGrade: { grade: string; pnl: number; trades: number; wins: number; winRate: number }[];
  globalComplianceRate: number;
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
      background: '#fff', border: '1px solid #e4e8f0',
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
        <CartesianGrid strokeDasharray="3 3" stroke="#e4e8f0" vertical={false} />
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

export default function StatsPage() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState('all');
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/login');
      return;
    }
    setHasToken(true);

    setLoading(true);
    fetch(`${API}/stats?range=${range}`, {
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
  }, [range, router]);

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
            <p>Performance breakdown by session, psychology, grades, and checklist confluences</p>
          </div>

          {/* Time Range Selector Tool */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 10px', boxShadow: 'var(--shadow-sm)', marginTop: 8 }}>
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
              <option value="all">All Time History</option>
              <option value="today">Today (UTC)</option>
              <option value="7d">Last 7 Days</option>
              <option value="30d">Last 30 Days</option>
              <option value="3m">Last 3 Months</option>
              <option value="6m">Last 6 Months</option>
            </select>
          </div>
        </div>
      </div>

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
          <div className="stat-label">Checklist Discipline</div>
          <div className="stat-value green">{(stats.globalComplianceRate || 0).toFixed(0)}%</div>
          <div className="stat-sub">Global rules compliance rate</div>
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
                <div className="session-summary-row" key={s.session} style={{ opacity: active ? 1 : 0.55 }}>
                  <div className="session-name">{s.session}</div>
                  <div className="session-stats-group">
                    <span style={{ color: 'var(--text-muted)' }}>{s.trades} trades</span>
                    {active ? (
                      <>
                        <span style={{ color: s.winRate >= 50 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                          {s.winRate.toFixed(0)}% WR
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
                <div className="session-summary-row" key={g.grade}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className={`grade-pill-tag ${g.grade}`}>{g.grade}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Quality Setup</span>
                  </div>
                  <div className="session-stats-group">
                    <span style={{ color: 'var(--text-muted)' }}>{g.trades} trades</span>
                    <span style={{ color: g.winRate >= 50 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{g.winRate.toFixed(0)}% WR</span>
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
                <div className="session-summary-row" key={e.emotion}>
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
                    <span style={{ color: 'var(--text-muted)' }}>{e.trades} trades</span>
                    <span style={{ color: e.winRate >= 50 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{e.winRate.toFixed(0)}% WR</span>
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
              <div className="session-summary-row" key={t.tag}>
                <span className="tag-badge" style={{ border: 'none', background: 'var(--accent-light)', color: 'var(--accent)', fontWeight: 700 }}>
                  #{t.tag}
                </span>
                <div className="session-stats-group">
                  <span style={{ color: 'var(--text-muted)' }}>{t.trades} trades</span>
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
                    contentStyle={{ background:'#fff', border:'1px solid #e4e8f0', borderRadius:10 }}
                    itemStyle={{ color:'var(--text-primary)' }}
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
              <div className="bar-item" key={s.symbol}>
                <div className="bar-label">{s.symbol}</div>
                <div className="bar-track">
                  <div className={`bar-fill ${pct >= 50 ? 'positive' : 'negative'}`} style={{ width: `${pct}%` }} />
                </div>
                <div className={`bar-val pnl ${pct >= 50 ? 'positive' : 'negative'}`}>
                  {pct.toFixed(0)}% <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({s.trades})</span>
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
                  <tr key={m.month}>
                    <td className="text" style={{ fontWeight: 600 }}>{m.month}</td>
                    <td>{m.trades}</td>
                    <td>{m.wins}</td>
                    <td className={`pnl ${wr >= 50 ? 'positive' : 'negative'}`}>{wr.toFixed(1)}%</td>
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
