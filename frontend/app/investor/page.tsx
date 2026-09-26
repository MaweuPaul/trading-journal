'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  DollarSign, TrendingUp, TrendingDown, Percent, Award, AlertTriangle,
  LogOut, Loader2, Eye, Play,
} from 'lucide-react';
import InvestorReplayModal from '@/components/InvestorReplayModal';

const API = '/api';

interface Summary {
  account: { label: string; provider: string; accountType: string };
  balance: number;
  asOf: string | null;
  tradeCount: number;
  netPnL: number;
  winRate: number;
  profitFactor: number;
  avgWinUSD: number;
  avgLossUSD: number;
  expectancyUSD: number;
  maxDrawdownPct: number;
  currentDrawdown: number;
  equityCurve: { date: string; balance: number }[];
}

interface InvestorTrade {
  _id: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  lotSize: number;
  pnlUSD: number;
  pnlPct: number;
  openTime: string;
  closeTime: string;
  durationMinutes: number;
}

function fmtUSD(n: number) {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

export default function InvestorDashboardPage() {
  const router = useRouter();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [trades, setTrades] = useState<InvestorTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [replayTradeId, setReplayTradeId] = useState<string | null>(null);

  const token = () => localStorage.getItem('investorToken');

  const load = useCallback(async () => {
    const t = token();
    if (!t) { router.push('/investor/login'); return; }
    setLoading(true); setError('');
    try {
      const [summaryRes, tradesRes] = await Promise.all([
        fetch(`${API}/investor/summary`, { headers: { Authorization: `Bearer ${t}` } }),
        fetch(`${API}/investor/trades?limit=50`, { headers: { Authorization: `Bearer ${t}` } }),
      ]);
      if (summaryRes.status === 401 || tradesRes.status === 401) {
        localStorage.removeItem('investorToken');
        localStorage.removeItem('investorAccount');
        router.push('/investor/login');
        return;
      }
      const summaryBody = await summaryRes.json();
      const tradesBody = await tradesRes.json();
      if (!summaryRes.ok) throw new Error(summaryBody.error || 'Could not load account summary.');
      if (!tradesRes.ok) throw new Error(tradesBody.error || 'Could not load trades.');
      setSummary(summaryBody);
      setTrades(tradesBody.trades || []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load investor view.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  function exit() {
    localStorage.removeItem('investorToken');
    localStorage.removeItem('investorAccount');
    router.push('/investor/login');
  }

  if (loading && !summary) {
    return <main className="page-content investor-view"><div className="loading-wrap" style={{ minHeight: '60vh' }}><Loader2 className="spin" size={22} /></div></main>;
  }

  if (error) {
    return (
      <main className="page-content investor-view">
        <div className="empty-state">
          <div className="empty-icon"><AlertTriangle size={24} color="var(--red)" /></div>
          <h3>Couldn't load this view</h3>
          <p>{error}</p>
          <button className="btn btn-ghost" onClick={exit} style={{ marginTop: 12 }}><LogOut size={14} /> Back to login</button>
        </div>
      </main>
    );
  }
  if (!summary) return null;

  const isProfit = summary.netPnL >= 0;
  const cards = [
    { label: 'Account Balance', icon: DollarSign, iconCls: 'blue', value: fmtUSD(summary.balance), cardCls: 'blue-card' },
    { label: 'Net P&L', icon: isProfit ? TrendingUp : TrendingDown, iconCls: isProfit ? 'green' : 'red', value: `${isProfit ? '+' : ''}${fmtUSD(summary.netPnL)}`, cls: isProfit ? 'green' : 'red', cardCls: isProfit ? 'green-card' : 'red-card' },
    { label: 'Win Rate', icon: Percent, iconCls: 'green', value: `${summary.winRate.toFixed(1)}%`, cardCls: 'green-card' },
    { label: 'Profit Factor', icon: Award, iconCls: 'amber', value: summary.profitFactor >= 999 ? '∞' : summary.profitFactor.toFixed(2), cardCls: 'blue-card' },
    { label: 'Max Drawdown', icon: AlertTriangle, iconCls: summary.maxDrawdownPct > 10 ? 'red' : 'amber', value: `${summary.maxDrawdownPct.toFixed(2)}%`, cls: summary.maxDrawdownPct > 10 ? 'red' : '', cardCls: 'red-card' },
    { label: 'Avg Win', icon: TrendingUp, iconCls: 'green', value: fmtUSD(summary.avgWinUSD), cls: 'green', cardCls: 'green-card' },
    { label: 'Avg Loss', icon: TrendingDown, iconCls: 'red', value: fmtUSD(summary.avgLossUSD), cls: 'red', cardCls: 'red-card' },
    { label: 'Expectancy', icon: DollarSign, iconCls: summary.expectancyUSD >= 0 ? 'green' : 'red', value: `${summary.expectancyUSD >= 0 ? '+' : ''}${fmtUSD(summary.expectancyUSD)}`, cls: summary.expectancyUSD >= 0 ? 'green' : 'red', cardCls: summary.expectancyUSD >= 0 ? 'green-card' : 'red-card' },
  ];

  return (
    <main className="page-content investor-view">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Eye size={18} color="var(--accent)" />
            <h1 style={{ fontSize: 20, margin: 0 }}>{summary.account.label}</h1>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Read-only investor view · {summary.account.accountType || 'account'} · {summary.tradeCount} closed trades
          </p>
        </div>
        <button className="btn btn-ghost" onClick={exit}><LogOut size={14} /> Exit</button>
      </div>

      <div className="stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
        {cards.map(c => (
          <div className={`stat-card ${c.cardCls}`} key={c.label}>
            <div className={`stat-icon ${c.iconCls}`}><c.icon size={16} /></div>
            <div className="stat-label">{c.label.toUpperCase()}</div>
            <div className={`stat-value ${c.cls || ''}`}>{c.value}</div>
          </div>
        ))}
      </div>

      {summary.equityCurve.length > 1 && (
        <div className="chart-wrap" style={{ height: 260, marginBottom: 24 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={summary.equityCurve} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="investorBalGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="date" tickFormatter={v => new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => `$${(v / 1000).toFixed(1)}k`} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} width={48} />
              <Tooltip content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                return (
                  <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
                    <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label ? new Date(label).toLocaleString() : ''}</div>
                    <strong>{fmtUSD(Number(payload[0].value))}</strong>
                  </div>
                );
              }} />
              <Area type="monotone" dataKey="balance" stroke="#2563eb" strokeWidth={2.5} fill="url(#investorBalGrad)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Symbol</th><th>Direction</th><th>Entry</th><th>Exit</th><th>Lots</th>
              <th>P&amp;L (USD)</th><th>P&amp;L (%)</th><th>Opened</th><th>Closed</th><th />
            </tr>
          </thead>
          <tbody>
            {trades.map(t => {
              const profit = t.pnlUSD >= 0;
              return (
                <tr key={t._id}>
                  <td>{t.symbol}</td>
                  <td><span className={`badge ${t.direction.toLowerCase()}`}>{t.direction}</span></td>
                  <td>{t.entryPrice}</td>
                  <td>{t.exitPrice}</td>
                  <td>{t.lotSize.toFixed(2)}</td>
                  <td className={`pnl ${profit ? 'positive' : 'negative'}`}>{profit ? '+' : ''}{fmtUSD(t.pnlUSD)}</td>
                  <td className={profit ? 'positive' : 'negative'}>{profit ? '+' : ''}{t.pnlPct.toFixed(2)}%</td>
                  <td>{new Date(t.openTime).toLocaleString()}</td>
                  <td>{new Date(t.closeTime).toLocaleString()}</td>
                  <td>
                    <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 9px' }} onClick={() => setReplayTradeId(t._id)} title="View chart replay for this trade">
                      <Play size={12} /> Replay
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {trades.length === 0 && (
          <div className="empty-state" style={{ minHeight: 140 }}>
            <p>No closed trades yet.</p>
          </div>
        )}
      </div>

      {replayTradeId && (() => {
        const replayTrade = trades.find(t => t._id === replayTradeId);
        if (!replayTrade) return null;
        return (
          <InvestorReplayModal
            key={replayTradeId}
            tradeId={replayTradeId}
            tradeSummary={{ symbol: replayTrade.symbol, direction: replayTrade.direction, pnlUSD: replayTrade.pnlUSD, pnlPct: replayTrade.pnlPct }}
            onClose={() => setReplayTradeId(null)}
          />
        );
      })()}
    </main>
  );
}
