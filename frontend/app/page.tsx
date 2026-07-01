'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer
} from 'recharts';
import {
  DollarSign, TrendingUp, TrendingDown, Activity,
  Award, AlertTriangle, Percent, BarChart2, ShieldAlert, Zap, Calendar,
  Database, RefreshCw, Trash2
} from 'lucide-react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

interface Stats {
  error?: string;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  netPnL: number;
  biggestWin: number;
  biggestLoss: number;
  currentDrawdown: number;
  equityCurve: { date: string; balance: number; pnl: number }[];
  avgWinUSD: number;
  avgLossUSD: number;
  winLossRatio: number;
  expectancyUSD: number;
  maxWinStreak: number;
  maxLossStreak: number;
  sharpeRatio: number;
  maxDrawdownPct?: number;
}

interface BalanceData { balance: number; asOf: string | null }

function fmtUSD(n: number) {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{
      background: '#fff', border: '1px solid #e4e8f0',
      borderRadius: 10, padding: '12px 16px',
      boxShadow: '0 4px 20px rgba(15,22,41,0.1)',
    }}>
      <div style={{ color: '#8b95b0', fontSize: 11, marginBottom: 6 }}>
        {new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
      </div>
      <div style={{ color: '#0f1629', fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600 }}>
        {fmtUSD(d.balance)}
      </div>
      <div style={{
        color: d.pnl >= 0 ? 'var(--green)' : 'var(--red)',
        fontFamily: 'var(--font-mono)', fontSize: 12, marginTop: 2
      }}>
        Trade P&L: {d.pnl >= 0 ? '+' : ''}{fmtUSD(d.pnl)}
      </div>
    </div>
  );
};

export default function DashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [bal, setBal] = useState<BalanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState('all');
  const [hasToken, setHasToken] = useState(false);
  const [maintenanceBusy, setMaintenanceBusy] = useState<string | null>(null);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');

  const loadDashboard = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;
      const headers = { 'Authorization': `Bearer ${token}` };

      const [s, b] = await Promise.all([
        fetch(`${API}/stats?range=${range}`, { headers }).then(r => {
          if (r.status === 401) {
            localStorage.removeItem('token');
            router.push('/login');
            throw new Error('Unauthorized');
          }
          return r.json();
        }),
        fetch(`${API}/balance`, { headers }).then(r => {
          if (r.status === 401) {
            localStorage.removeItem('token');
            router.push('/login');
            throw new Error('Unauthorized');
          }
          return r.json();
        }),
      ]);
      setStats(s);
      setBal(b);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [range, router]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/login');
      return;
    }
    setHasToken(true);
    loadDashboard();
    const t = setInterval(loadDashboard, 30000);
    return () => clearInterval(t);
  }, [loadDashboard, router]);

  const callMaintenance = async (action: 'dedupe' | 'resync' | 'clear') => {
    const token = localStorage.getItem('token');
    if (!token) return;

    if (action === 'clear') {
      const confirmed = window.confirm(
        'Clear all synced trades from the database? Your MT5 history stays safe, but the dashboard will be empty until sync.py imports again.'
      );
      if (!confirmed) return;
    }

    setMaintenanceBusy(action);
    setMaintenanceMessage('');
    try {
      const headers = { 'Authorization': `Bearer ${token}` };
      let res: Response;

      if (action === 'dedupe') {
        res = await fetch(`${API}/maintenance/dedupe-trades`, { method: 'POST', headers });
      } else if (action === 'resync') {
        res = await fetch(`${API}/maintenance/resync-request`, { method: 'POST', headers });
      } else {
        res = await fetch(`${API}/maintenance/trades`, { method: 'DELETE', headers });
      }

      if (res.status === 401) {
        localStorage.removeItem('token');
        router.push('/login');
        return;
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Maintenance action failed');

      if (action === 'dedupe') {
        setMaintenanceMessage(`Removed ${data.removed || 0} duplicate trade row(s).`);
      } else if (action === 'resync') {
        setMaintenanceMessage('Full resync requested. Keep sync.py running so it can pull MT5 history.');
      } else {
        setMaintenanceMessage(`Cleared ${data.deleted || 0} trade row(s). Run resync with sync.py active to rebuild cleanly.`);
      }

      await loadDashboard();
    } catch (e) {
      setMaintenanceMessage(e instanceof Error ? e.message : 'Maintenance action failed');
    } finally {
      setMaintenanceBusy(null);
    }
  };

  if (loading) return (
    <div className="loading-wrap">
      <div className="spinner" />
      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading dashboard metrics…</span>
    </div>
  );

  if (!hasToken) return null;

  if (!stats) return (
    <div className="empty-state">
      <div className="empty-icon"><Activity size={24} /></div>
      <h3>Cannot reach API</h3>
      <p>Make sure the backend is running on port 4000</p>
    </div>
  );

  if (stats.error) return (
    <div className="empty-state">
      <div className="empty-icon"><AlertTriangle size={24} color="var(--red)" /></div>
      <h3>Error Loading Stats</h3>
      <p>{stats.error}</p>
    </div>
  );

  const s = stats;
  const equityData = (s.equityCurve || []).map(p => ({
    ...p,
    balance: Number((p.balance || 0).toFixed(2)),
  }));

  const statCards = [
    {
      label: 'Account Balance', icon: DollarSign, iconCls: 'blue',
      value: fmtUSD(bal?.balance || 0), cls: '',
      sub: bal?.asOf ? `As of ${new Date(bal.asOf).toLocaleDateString()}` : 'No trades yet',
      cardCls: 'blue-card',
    },
    {
      label: 'Net P&L', icon: TrendingUp, iconCls: s.netPnL >= 0 ? 'green' : 'red',
      value: (s.netPnL >= 0 ? '+' : '') + fmtUSD(s.netPnL),
      cls: s.netPnL >= 0 ? 'green' : 'red',
      sub: `${s.totalTrades} total trades in range`,
      cardCls: s.netPnL >= 0 ? 'green-card' : 'red-card',
    },
    {
      label: 'Win Rate', icon: Percent, iconCls: s.winRate >= 50 ? 'green' : 'red',
      value: `${(s.winRate || 0).toFixed(1)}%`, cls: s.winRate >= 50 ? 'green' : 'red',
      sub: `Avg Win: $${(s.avgWinUSD || 0).toFixed(0)} / Loss: $${(s.avgLossUSD || 0).toFixed(0)}`,
      cardCls: s.winRate >= 50 ? 'green-card' : 'red-card',
    },
    {
      label: 'Trade Expectancy', icon: Zap, iconCls: s.expectancyUSD >= 0 ? 'green' : 'red',
      value: (s.expectancyUSD >= 0 ? '+' : '') + fmtUSD(s.expectancyUSD || 0),
      cls: s.expectancyUSD >= 0 ? 'green' : 'red',
      sub: 'Avg return per closed trade',
      cardCls: s.expectancyUSD >= 0 ? 'green-card' : 'red-card',
    },
    {
      label: 'Sharpe Ratio', icon: ShieldAlert, iconCls: s.sharpeRatio >= 1.5 ? 'green' : s.sharpeRatio >= 0 ? 'blue' : 'red',
      value: isFinite(s.sharpeRatio) ? (s.sharpeRatio || 0).toFixed(2) : '0.00',
      cls: s.sharpeRatio >= 1.5 ? 'green' : s.sharpeRatio >= 0 ? 'blue' : 'red',
      sub: 'Risk-adjusted return ratio',
      cardCls: s.sharpeRatio >= 1.5 ? 'green-card' : '',
    },
    {
      label: 'Win / Loss Streaks', icon: Award, iconCls: 'blue',
      value: `W: ${s.maxWinStreak} / L: ${s.maxLossStreak}`,
      cls: 'blue',
      sub: 'Longest consecutive streaks',
      cardCls: 'blue-card',
    },
    {
      label: 'Current Drawdown', icon: AlertTriangle, iconCls: s.currentDrawdown > 10 ? 'red' : 'amber',
      value: `${(s.currentDrawdown || 0).toFixed(2)}%`,
      cls: s.currentDrawdown > 10 ? 'red' : '',
      sub: `Max DD: ${(s.maxDrawdownPct || 0).toFixed(2)}% peak-to-trough`,
      cardCls: s.currentDrawdown > 10 ? 'red-card' : '',
    },
    {
      label: 'Profit Factor', icon: BarChart2, iconCls: s.profitFactor >= 1 ? 'green' : 'red',
      value: isFinite(s.profitFactor) ? (s.profitFactor || 0).toFixed(2) : '∞',
      cls: s.profitFactor >= 1 ? 'green' : 'red',
      sub: `Gross Win/Loss: ${(s.winLossRatio || 0).toFixed(2)} RRR`,
      cardCls: s.profitFactor >= 1 ? 'green-card' : 'red-card',
    },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-header-inner">
          <div>
            <h2>Dashboard</h2>
            <p>Live performance synced from your MT5 · Exness account</p>
          </div>

          <div className="dashboard-actions">
            <button className="btn btn-ghost" onClick={() => callMaintenance('dedupe')} disabled={Boolean(maintenanceBusy)}>
              <Database size={14} />
              {maintenanceBusy === 'dedupe' ? 'Cleaning...' : 'Remove duplicates'}
            </button>
            <button className="btn btn-primary" onClick={() => callMaintenance('resync')} disabled={Boolean(maintenanceBusy)}>
              <RefreshCw size={14} />
              {maintenanceBusy === 'resync' ? 'Requesting...' : 'Resync'}
            </button>
            <button className="btn btn-danger" onClick={() => callMaintenance('clear')} disabled={Boolean(maintenanceBusy)}>
              <Trash2 size={14} />
              {maintenanceBusy === 'clear' ? 'Clearing...' : 'Clear database'}
            </button>

            {/* Time Range Selector Tool */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 10px', boxShadow: 'var(--shadow-sm)' }}>
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
        {maintenanceMessage && (
          <div className="maintenance-status">
            {maintenanceMessage}
          </div>
        )}
      </div>

      <div className="stat-grid">
        {statCards.map(c => (
          <div className={`stat-card ${c.cardCls}`} key={c.label}>
            <div className={`stat-icon ${c.iconCls}`}>
              <c.icon size={14} />
            </div>
            <div className="stat-label">{c.label}</div>
            <div className={`stat-value ${c.cls}`}>{c.value}</div>
            <div className="stat-sub">{c.sub}</div>
          </div>
        ))}
      </div>

      {/* Equity Curve */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Equity Curve</div>
            <div className="card-subtitle">Account balance over time</div>
          </div>
          {equityData.length > 0 && (
            <div style={{
              background: 'var(--accent-light)', color: 'var(--accent)',
              padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600
            }}>
              {equityData.length} data points
            </div>
          )}
        </div>

        {equityData.length > 1 ? (
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={equityData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e8f0" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={v => new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  tick={{ fill: '#8b95b0', fontSize: 10 }}
                  axisLine={false} tickLine={false}
                />
                <YAxis
                  tickFormatter={v => `$${(v / 1000).toFixed(1)}k`}
                  tick={{ fill: '#8b95b0', fontSize: 10 }}
                  axisLine={false} tickLine={false} width={48}
                />
                <Tooltip content={<CustomTooltip />} />
                <Area
                  type="monotone" dataKey="balance"
                  stroke="#3b82f6" strokeWidth={2.5}
                  fill="url(#balGrad)"
                  dot={false}
                  activeDot={{ r: 5, fill: '#3b82f6', stroke: '#fff', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="empty-state" style={{ padding: '40px 20px' }}>
            <div className="empty-icon"><Activity size={22} /></div>
            <h3>No equity data yet</h3>
            <p>Run <code style={{ background: '#f0f4ff', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>python sync.py</code> to pull trades from MT5</p>
          </div>
        )}
      </div>
    </div>
  );
}
