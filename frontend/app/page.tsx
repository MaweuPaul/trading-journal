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
  Database, RefreshCw, Trash2, Wallet, ArrowDownCircle, ArrowUpCircle, Plus, X
} from 'lucide-react';

const API = '/api';

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
  avgR?: number | null;
  tradesWithRiskData?: number;
  mixedAccounts?: boolean;
  accountKeys?: string[];
}

interface BalanceData { balance: number; asOf: string | null; mixedAccounts?: boolean }

interface TradeAccountOption {
  accountKey: string;
  accountName: string;
  accountType: string;
  label: string;
  count: number;
}

interface AccountEvent {
  _id: string;
  type: 'deposit' | 'withdrawal' | 'adjustment';
  amount: number;
  currency: string;
  occurredAt: string;
  note?: string;
  source: 'manual' | 'mt5';
}

interface AccountEventsData {
  events: AccountEvent[];
  summary: {
    deposits: number;
    withdrawals: number;
    adjustments: number;
    netCashFlow: number;
    totalEvents: number;
  };
}

function fmtUSD(n: number) {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '12px 16px',
      boxShadow: '0 4px 20px rgba(15,22,41,0.1)',
    }}>
      <div style={{ color: '#8b95b0', fontSize: 11, marginBottom: 6 }}>
        {new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
      </div>
      <div style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600 }}>
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
  const [cashFlow, setCashFlow] = useState<AccountEventsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState('all');
  const [hasToken, setHasToken] = useState(false);
  const [maintenanceBusy, setMaintenanceBusy] = useState<string | null>(null);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');
  const [eventType, setEventType] = useState<'deposit' | 'withdrawal' | null>(null);
  const [eventAmount, setEventAmount] = useState('');
  const [eventDate, setEventDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [eventNote, setEventNote] = useState('');
  const [eventBusy, setEventBusy] = useState(false);
  const [eventMessage, setEventMessage] = useState('');
  const [groupBySetup, setGroupBySetup] = useState(false);
  const [accountKeyFilter, setAccountKeyFilter] = useState('');
  const [tradeAccounts, setTradeAccounts] = useState<TradeAccountOption[]>([]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch(`${API}/trade-accounts`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('Could not load trading accounts')))
      .then(body => setTradeAccounts(body.accounts || []))
      .catch(e => console.error(e));
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;
      const headers = { 'Authorization': `Bearer ${token}` };
      const acct = accountKeyFilter ? `&accountKey=${encodeURIComponent(accountKeyFilter)}` : '';

      const [s, b, c] = await Promise.all([
        fetch(`${API}/stats?range=${range}&groupBySetup=${groupBySetup}${acct}`, { headers }).then(r => {
          if (r.status === 401) {
            localStorage.removeItem('token');
            router.push('/login');
            throw new Error('Unauthorized');
          }
          return r.json();
        }),
        fetch(`${API}/balance${accountKeyFilter ? `?accountKey=${encodeURIComponent(accountKeyFilter)}` : ''}`, { headers }).then(r => {
          if (r.status === 401) {
            localStorage.removeItem('token');
            router.push('/login');
            throw new Error('Unauthorized');
          }
          return r.json();
        }),
        fetch(`${API}/account-events?range=${range}${acct}`, { headers }).then(r => {
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
      setCashFlow(c);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [range, groupBySetup, accountKeyFilter, router]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('token');
      if (!token) {
        router.push('/login');
        return;
      }
      setHasToken(true);
    }
    loadDashboard();
    const t = setInterval(loadDashboard, 30000);
    return () => clearInterval(t);
  }, [loadDashboard, router]);

  const callMaintenance = async (action: 'dedupe' | 'resync' | 'clear' | 'fixbalances' | 'recoverscreenshots') => {
    const token = localStorage.getItem('token');
    if (!token) return;

    if (action === 'clear') {
      const confirmed = window.confirm(
        'Clear all synced trades from the database? Your MT5 history stays safe, but the dashboard will be empty until sync.py imports again.'
      );
      if (!confirmed) return;
    }

    if (action === 'recoverscreenshots') {
      const ok = window.confirm(
        'Scan Cloudinary for all your uploaded screenshots and re-link any that are missing from trades?\n\nThis is safe to run at any time — it never deletes or overwrites anything.'
      );
      if (!ok) return;
      setMaintenanceBusy('recoverscreenshots');
      setMaintenanceMessage('');
      try {
        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
        const res = await fetch(`${API}/maintenance/recover-screenshots`, { method: 'POST', headers });
        if (res.status === 401) { localStorage.removeItem('token'); router.push('/login'); return; }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Recovery failed');
        setMaintenanceMessage(data.message || `✅ Recovered ${data.recovered} screenshot(s) from Cloudinary.`);
        await loadDashboard();
      } catch (e) {
        setMaintenanceMessage(e instanceof Error ? e.message : 'Screenshot recovery failed');
      } finally {
        setMaintenanceBusy(null);
      }
      return;
    }

    if (action === 'fixbalances') {
      // runningBalance is per broker account — recalculating it needs to know
      // which account, once there's more than one. Require the dashboard's
      // own account filter to be set first rather than guessing.
      if (tradeAccounts.length > 1 && !accountKeyFilter) {
        setMaintenanceMessage('Select a single trading account above (View filter) before fixing balances — running balance is per account.');
        return;
      }
      const input = window.prompt(
        'Enter your CURRENT MT5 account balance (e.g. 627.94).\nThis is used to back-calculate each trade\'s correct running balance.\n\nLeave blank to use the latest stored balance as the anchor.'
      );
      if (input === null) return; // user cancelled
      const parsed = input.trim() === '' ? null : parseFloat(input.trim());
      if (input.trim() !== '' && (isNaN(parsed!) || parsed! <= 0)) {
        setMaintenanceMessage('Invalid balance entered.');
        return;
      }
      setMaintenanceBusy('fixbalances');
      setMaintenanceMessage('');
      try {
        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
        const res = await fetch(`${API}/maintenance/recalculate-balances`, {
          method: 'POST', headers,
          body: JSON.stringify({ currentBalance: parsed, accountKey: accountKeyFilter || undefined }),
        });
        if (res.status === 401) { localStorage.removeItem('token'); router.push('/login'); return; }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Balance fix failed');
        setMaintenanceMessage(`✅ Fixed running balance on ${data.updated || 0} trade(s). Anchor: $${(data.latestBalance || 0).toFixed(2)}`);
        await loadDashboard();
      } catch (e) {
        setMaintenanceMessage(e instanceof Error ? e.message : 'Balance fix failed');
      } finally {
        setMaintenanceBusy(null);
      }
      return;
    }

    if (action === 'dedupe') {
      const confirmed = window.confirm(
        'Remove duplicate trade rows? A backup of your current trades is written to disk first, but removed rows are gone from the live database.'
      );
      if (!confirmed) return;
    }

    setMaintenanceBusy(action);
    setMaintenanceMessage('');
    try {
      const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
      let res: Response;

      if (action === 'dedupe') {
        res = await fetch(`${API}/maintenance/dedupe-trades`, { method: 'POST', headers, body: JSON.stringify({ confirm: true }) });
      } else if (action === 'resync') {
        res = await fetch(`${API}/maintenance/resync-request`, { method: 'POST', headers });
      } else {
        res = await fetch(`${API}/maintenance/trades`, { method: 'DELETE', headers, body: JSON.stringify({ confirm: 'DELETE ALL TRADES' }) });
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

  const openEventForm = (type: 'deposit' | 'withdrawal') => {
    setEventType(type);
    setEventAmount('');
    setEventDate(new Date().toISOString().slice(0, 10));
    setEventNote('');
    setEventMessage('');
  };

  const submitAccountEvent = async () => {
    const token = localStorage.getItem('token');
    if (!token || !eventType) return;

    const amount = Number(eventAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setEventMessage('Enter an amount greater than 0.');
      return;
    }

    setEventBusy(true);
    setEventMessage('');
    try {
      const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      };
      const res = await fetch(`${API}/account-events`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: eventType,
          amount,
          occurredAt: eventDate,
          note: eventNote,
        }),
      });

      if (res.status === 401) {
        localStorage.removeItem('token');
        router.push('/login');
        return;
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save cash-flow event');

      setEventMessage(`${eventType === 'deposit' ? 'Deposit' : 'Withdrawal'} recorded.`);
      setEventType(null);
      setEventAmount('');
      setEventNote('');
      await loadDashboard();
    } catch (e) {
      setEventMessage(e instanceof Error ? e.message : 'Could not save cash-flow event');
    } finally {
      setEventBusy(false);
    }
  };

  const deleteAccountEvent = async (event: AccountEvent) => {
    if (event.source !== 'manual') return;
    const token = localStorage.getItem('token');
    if (!token) return;
    const confirmed = window.confirm('Remove this manually recorded cash-flow event?');
    if (!confirmed) return;

    setEventBusy(true);
    setEventMessage('');
    try {
      const res = await fetch(`${API}/account-events/${event._id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.status === 401) {
        localStorage.removeItem('token');
        router.push('/login');
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not delete cash-flow event');
      setEventMessage(`Removed ${data.deleted || 0} event.`);
      await loadDashboard();
    } catch (e) {
      setEventMessage(e instanceof Error ? e.message : 'Could not delete cash-flow event');
    } finally {
      setEventBusy(false);
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
      // Sharpe on per-trade $ P&L isn't a meaningful risk-adjusted metric for
      // a discretionary journal (yours reads ~0.01) — Avg R is the number
      // that slot was standing in for. Needs the stop-based riskUSD MT5
      // records at entry, so it's only available for trades synced with it.
      label: 'Avg R', icon: ShieldAlert, iconCls: (s.avgR ?? 0) >= 0 ? 'green' : 'red',
      value: s.avgR == null ? '—' : `${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)}R`,
      cls: (s.avgR ?? 0) >= 0 ? 'green' : 'red',
      sub: s.tradesWithRiskData ? `${s.tradesWithRiskData} of ${s.totalTrades} trades have a recorded stop` : 'No trades with a recorded stop yet',
      cardCls: (s.avgR ?? 0) >= 0 ? 'green-card' : '',
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

  const cashSummary = cashFlow?.summary || {
    deposits: 0,
    withdrawals: 0,
    adjustments: 0,
    netCashFlow: 0,
    totalEvents: 0,
  };
  const recentEvents = cashFlow?.events || [];

  return (
    <div>
      <div className="page-header">
        <div className="page-header-inner">
          <div>
            <h2>Dashboard</h2>
            <p>Live performance synced from your connected MT5 account</p>
          </div>

          <div className="dashboard-actions">
            {/* 'Recover Screenshots' and 'Clear database' are intentionally not
               exposed as buttons — rarely needed day-to-day and, in the case
               of Clear database, the most destructive action on this page.
               Both callMaintenance('recoverscreenshots'/'clear') handlers and
               their backend routes are still fully intact if needed again. */}
            <button className="btn btn-ghost" onClick={() => callMaintenance('dedupe')} disabled={Boolean(maintenanceBusy)}>
              <Database size={14} />
              {maintenanceBusy === 'dedupe' ? 'Cleaning...' : 'Remove duplicates'}
            </button>
            <button className="btn btn-ghost" onClick={() => callMaintenance('fixbalances')} disabled={Boolean(maintenanceBusy)} title="Re-calculate running balance for all trades from your actual MT5 balance">
              <Wallet size={14} />
              {maintenanceBusy === 'fixbalances' ? 'Fixing...' : 'Fix Balances'}
            </button>
            <button className="btn btn-primary" onClick={() => callMaintenance('resync')} disabled={Boolean(maintenanceBusy)}>
              <RefreshCw size={14} />
              {maintenanceBusy === 'resync' ? 'Requesting...' : 'Resync'}
            </button>

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

            {/* Time Range Selector Tool */}
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

      {(stats.mixedAccounts || bal?.mixedAccounts) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'var(--amber-bg, rgba(245,158,11,0.12))', border: '1px solid var(--amber, #f59e0b)',
          borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 16, fontSize: 13,
        }}>
          <AlertTriangle size={16} style={{ flexShrink: 0, color: 'var(--amber, #f59e0b)' }} />
          <span>
            This dashboard blends trades from more than one broker account. Balance and drawdown
            are per-account and not meaningful when merged — pick a single account above for accurate figures.
          </span>
        </div>
      )}

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

      <div className="card cash-flow-card">
        <div className="card-header">
          <div>
            <div className="card-title">Cash Flow</div>
            <div className="card-subtitle">Deposits, withdrawals, and broker account movements</div>
          </div>
          <div className="cash-flow-actions">
            <button className="btn btn-ghost" onClick={() => openEventForm('deposit')} disabled={eventBusy}>
              <ArrowDownCircle size={14} />
              Deposit
            </button>
            <button className="btn btn-ghost" onClick={() => openEventForm('withdrawal')} disabled={eventBusy}>
              <ArrowUpCircle size={14} />
              Withdrawal
            </button>
          </div>
        </div>

        <div className="cash-flow-grid">
          <div className="cash-flow-metric">
            <div className="stat-icon green"><ArrowDownCircle size={14} /></div>
            <span>Deposits</span>
            <strong className="green">{fmtUSD(cashSummary.deposits)}</strong>
          </div>
          <div className="cash-flow-metric">
            <div className="stat-icon red"><ArrowUpCircle size={14} /></div>
            <span>Withdrawals</span>
            <strong className="red">{fmtUSD(cashSummary.withdrawals)}</strong>
          </div>
          <div className="cash-flow-metric">
            <div className="stat-icon blue"><Wallet size={14} /></div>
            <span>Net Cash Flow</span>
            <strong className={cashSummary.netCashFlow >= 0 ? 'green' : 'red'}>
              {cashSummary.netCashFlow >= 0 ? '+' : ''}{fmtUSD(cashSummary.netCashFlow)}
            </strong>
          </div>
        </div>

        {eventType && (
          <div className="cash-flow-form">
            <div className="cash-flow-form-title">
              <Plus size={14} />
              {eventType === 'deposit' ? 'Record deposit' : 'Record withdrawal'}
            </div>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Amount"
              value={eventAmount}
              onChange={e => setEventAmount(e.target.value)}
            />
            <input
              type="date"
              value={eventDate}
              onChange={e => setEventDate(e.target.value)}
            />
            <input
              type="text"
              placeholder="Optional note"
              value={eventNote}
              onChange={e => setEventNote(e.target.value)}
            />
            <button className="btn btn-primary" onClick={submitAccountEvent} disabled={eventBusy}>
              {eventBusy ? 'Saving...' : 'Save'}
            </button>
            <button className="btn btn-ghost" onClick={() => setEventType(null)} disabled={eventBusy} aria-label="Cancel cash-flow entry">
              <X size={14} />
            </button>
          </div>
        )}

        {eventMessage && <div className="maintenance-status">{eventMessage}</div>}

        <div className="cash-flow-events">
          {recentEvents.length === 0 ? (
            <div className="cash-flow-empty">No deposits or withdrawals recorded for this range.</div>
          ) : recentEvents.slice(0, 5).map(event => {
            const isWithdrawal = event.type === 'withdrawal';
            const signedAmount = event.type === 'deposit' ? event.amount : event.type === 'withdrawal' ? -event.amount : event.amount;
            return (
              <div className="cash-flow-event" key={event._id}>
                <div className={`cash-flow-event-icon ${isWithdrawal ? 'red' : signedAmount >= 0 ? 'green' : 'red'}`}>
                  {isWithdrawal ? <ArrowUpCircle size={14} /> : <ArrowDownCircle size={14} />}
                </div>
                <div className="cash-flow-event-main">
                  <strong>{event.type}</strong>
                  <span>
                    {new Date(event.occurredAt).toLocaleDateString()} · {event.source.toUpperCase()}
                    {event.note ? ` · ${event.note}` : ''}
                  </span>
                </div>
                <div className={`cash-flow-event-amount ${signedAmount >= 0 ? 'green' : 'red'}`}>
                  {signedAmount >= 0 ? '+' : ''}{fmtUSD(signedAmount)}
                </div>
                {event.source === 'manual' && (
                  <button
                    className="cash-flow-delete"
                    onClick={() => deleteAccountEvent(event)}
                    disabled={eventBusy}
                    aria-label="Delete cash-flow event"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
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
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
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
                  activeDot={{ r: 5, fill: '#3b82f6', stroke: 'var(--bg-surface)', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="empty-state" style={{ padding: '40px 20px' }}>
            <div className="empty-icon"><Activity size={22} /></div>
            <h3>No equity data yet</h3>
            <p>Run <code style={{ background: 'var(--bg-hover)', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>python sync.py</code> to pull trades from MT5</p>
          </div>
        )}
      </div>
    </div>
  );
}
