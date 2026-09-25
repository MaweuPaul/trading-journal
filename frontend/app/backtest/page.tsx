'use client';
import './backtest.css';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FlaskConical, Plus, Trash2, X, LineChart } from 'lucide-react';
import BacktestChart from '@/components/BacktestChart';

interface BacktestTrade {
  _id: string;
  name: string;
  strategy: string;
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

function fmtPrice(n: number) { return n.toFixed(n >= 100 ? 2 : 5); }

export default function BacktestPage() {
  const router = useRouter();
  const [trades, setTrades] = useState<BacktestTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showChart, setShowChart] = useState(false);
  const [chartKey, setChartKey] = useState(0);
  const [strategyFilter, setStrategyFilter] = useState('');

  const load = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) { router.push('/login'); return; }
    try {
      const res = await fetch('/api/backtest-trades', { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { localStorage.removeItem('token'); router.push('/login'); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load backtest log');
      setTrades(data.trades || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load backtest log');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  const handleSaved = () => {
    setShowChart(false);
    void load();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this backtest trade?')) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    const res = await fetch(`/api/backtest-trades/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setTrades(current => current.filter(t => t._id !== id));
  };

  const strategies = Array.from(new Set(trades.map(t => t.strategy).filter(Boolean))).sort();
  const visibleTrades = strategyFilter ? trades.filter(t => t.strategy === strategyFilter) : trades;

  const wins = visibleTrades.filter(t => t.outcome === 'win').length;

  const winRate = visibleTrades.length ? (wins / visibleTrades.length) * 100 : 0;
  const totalR = visibleTrades.reduce((sum, t) => sum + t.rMultiple, 0);
  const avgR = visibleTrades.length ? totalR / visibleTrades.length : 0;
  const totalPnl = visibleTrades.reduce((sum, t) => sum + t.pnlUSD, 0);

  return (
    <main className="page-content bt-page">
      <header className="page-header bt-page-header">
        <div className="page-header-inner">
          <div>
            <div className="bt-eyebrow">STRATEGY LAB / BACKTEST</div>
            <h2><FlaskConical size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />{showChart ? 'Backtest Workspace' : 'Backtest Log'}</h2>
            <p>Replay your own historical data and log hypothetical trades — kept separate from your real trade history.</p>
          </div>
          <div className="bt-header-actions">
            {strategies.length > 0 && (
              <select aria-label="Filter by strategy" value={strategyFilter} onChange={e => setStrategyFilter(e.target.value)} style={{ minHeight: 38, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }}>
                <option value="">All strategies</option>
                {strategies.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
            <Link href="/backtest/metrics" className="btn-ghost">
              <LineChart size={15} /> View Metrics
            </Link>
            {!showChart && (
              <button className="btn-primary" onClick={() => { setChartKey(k => k + 1); setShowChart(true); }}>
                <Plus size={15} /> New Backtest
              </button>
            )}
            {showChart && (
              <button className="btn-ghost" onClick={() => setShowChart(false)}>
                <X size={15} /> Close
              </button>
            )}
          </div>
        </div>
      </header>

      {showChart && <BacktestChart key={chartKey} onSaved={handleSaved} />}

      {!showChart && !loading && !error && (
        <div className="stats-grid bt-summary" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
          <div className="stat-card blue-card">
            <div className="stat-label">TRADES LOGGED</div>
            <div className="stat-value">{visibleTrades.length}</div>
          </div>
          <div className="stat-card green-card">
            <div className="stat-label">WIN RATE</div>
            <div className="stat-value">{winRate.toFixed(1)}%</div>
          </div>
          <div className="stat-card blue-card">
            <div className="stat-label">AVG R</div>
            <div className="stat-value">{avgR >= 0 ? '+' : ''}{avgR.toFixed(2)}R</div>
          </div>
          <div className={`stat-card ${totalPnl >= 0 ? 'green-card' : 'red-card'}`}>
            <div className="stat-label">TOTAL P&amp;L</div>
            <div className={`stat-value ${totalPnl >= 0 ? 'positive' : 'negative'}`}>{totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}</div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading-wrap"><div className="spinner" /></div>
      ) : error ? (
        <div className="empty-state"><p>{error}</p></div>
      ) : trades.length === 0 && !showChart ? (
        <div className="empty-state">
          <h3>No backtests logged yet</h3>
          <p>Click &quot;New Backtest&quot; to replay a symbol&apos;s history from your own connected broker data and log your first hypothetical trade.</p>
        </div>
      ) : !showChart && visibleTrades.length > 0 ? (
        <div className="table-wrap"><div className="bt-table-heading"><h3>Trade history</h3><span>{visibleTrades.length} trades · {strategyFilter || 'All strategies'}</span></div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th><th>Strategy</th><th>Symbol</th><th>Direction</th><th>Timeframe</th><th>Entry</th><th>Exit</th>
                <th>R</th><th>P&amp;L</th><th>Outcome</th><th>Logged</th><th />
              </tr>
            </thead>
            <tbody>
              {visibleTrades.map(t => (
                <tr key={t._id}>
                  <td>{t.name || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td>{t.strategy || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td>{t.symbol}</td>
                  <td><span className={`badge ${t.direction === 'long' ? 'buy' : 'sell'}`}>{t.direction === 'long' ? 'LONG' : 'SHORT'}</span></td>
                  <td>{t.interval}</td>
                  <td>{fmtPrice(t.entryPrice)}</td>
                  <td>{fmtPrice(t.exitPrice)}</td>
                  <td className={t.rMultiple >= 0 ? 'positive' : 'negative'}>{t.rMultiple >= 0 ? '+' : ''}{t.rMultiple.toFixed(2)}R</td>
                  <td className={t.pnlUSD >= 0 ? 'positive' : 'negative'}>{t.riskAmount > 0 ? `${t.pnlUSD >= 0 ? '+' : ''}$${t.pnlUSD.toFixed(2)}` : '—'}</td>
                  <td><span className={`badge ${t.outcome === 'win' ? 'buy' : t.outcome === 'loss' ? 'sell' : ''}`}>{t.outcome.toUpperCase()}</span></td>
                  <td>{new Date(t.createdAt).toLocaleDateString()}</td>
                  <td>
                    <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 9px' }} onClick={() => handleDelete(t._id)} aria-label={`Delete ${t.name || t.symbol} backtest`} title="Delete this backtest trade">
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !showChart && strategyFilter ? <div className="empty-state"><h3>No trades for this strategy</h3><button className="btn-ghost" onClick={() => setStrategyFilter('')}>Clear filter</button></div> : null}
    </main>
  );
}
