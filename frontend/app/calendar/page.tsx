'use client';
import { Fragment, useEffect, useState, useCallback } from 'react';
import { PAGE_PURPOSE } from '@/components/pagePurpose';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft, ChevronRight, Calendar as CalendarIcon, X, Info,
  SlidersHorizontal, AlertTriangle, Play,
} from 'lucide-react';
import { useAccountKeyFilter } from '@/hooks/useAccountKeyFilter';
import TradeReplayModal from '@/components/TradeReplayModal';

const API = '/api';

interface DailyStats {
  pnl: number;
  tradesCount: number;
  wins: number;
  date: string;
  avgR: number | null;
  winRate: number;
}

interface TradeAccountOption {
  accountKey: string;
  accountName: string;
  accountType: string;
  label: string;
  count: number;
}

interface Trade {
  _id: string;
  dealId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  lotSize: number;
  pnlUSD: number;
  pnlPct: number;
  commission: number;
  swap: number;
  openTime: string;
  closeTime: string;
  durationMinutes: number;
  runningBalance: number;
  grade?: string;
  emotion?: string;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtUSD(n: number) {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

export default function CalendarPage() {
  const router = useRouter();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [calendarStats, setCalendarStats] = useState<Record<string, DailyStats>>({});
  const [loading, setLoading] = useState(true);
  const [hasToken, setHasToken] = useState(false);

  // Filters State
  const [filterSymbol, setFilterSymbol] = useState('');
  const [filterGrade, setFilterGrade] = useState('');
  const [symbols, setSymbols] = useState<string[]>([]);
  const [accountKeyFilter, setAccountKeyFilter, accountFilterReady] = useAccountKeyFilter();
  const [tradeAccounts, setTradeAccounts] = useState<TradeAccountOption[]>([]);
  const [mixedAccounts, setMixedAccounts] = useState(false);

  // Daily trades list modal/drawer state
  const [selectedDateStr, setSelectedDateStr] = useState<string | null>(null);
  const [dailyTrades, setDailyTrades] = useState<Trade[]>([]);
  const [loadingTrades, setLoadingTrades] = useState(false);
  const [replayTradeId, setReplayTradeId] = useState<string | null>(null);

  // Auth checking
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/login');
      return;
    }
    setHasToken(true);
  }, [router]);

  // Load the account filter's options once
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch(`${API}/trade-accounts`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('Could not load trading accounts')))
      .then(body => setTradeAccounts(body.accounts || []))
      .catch(console.error);
  }, []);

  // Load active symbols dynamically from stats endpoint
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch(`${API}/stats`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(r => {
        if (r.status === 401) {
          localStorage.removeItem('token');
          router.push('/login');
          return;
        }
        return r.json();
      })
      .then(data => {
        if (data && data.bySymbol) {
          setSymbols(data.bySymbol.map((s: any) => s.symbol).sort());
        }
      })
      .catch(console.error);
  }, [router]);

  // Load calendar daily statistics with filter query params
  const loadCalendar = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    if (!accountFilterReady) return;
    setLoading(true);
    const params = new URLSearchParams({
      ...(filterSymbol && { symbol: filterSymbol }),
      ...(filterGrade && { grade: filterGrade }),
      ...(accountKeyFilter && { accountKey: accountKeyFilter }),
    });
    try {
      const res = await fetch(`${API}/calendar?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.status === 401) {
        localStorage.removeItem('token');
        router.push('/login');
        return;
      }
      const data = await res.json();
      setCalendarStats(data?.days || {});
      setMixedAccounts(Boolean(data?.mixedAccounts));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [filterSymbol, filterGrade, accountKeyFilter, accountFilterReady, router]);

  useEffect(() => { loadCalendar(); }, [loadCalendar]);

  // Load trades for clicked day
  const handleDayClick = async (dateStr: string, statsExist: boolean) => {
    if (!statsExist) return; // ignore empty days
    const token = localStorage.getItem('token');
    if (!token) return;
    setSelectedDateStr(dateStr);
    setLoadingTrades(true);
    setDailyTrades([]);
    
    try {
      const fromStr = `${dateStr}T00:00:00.000Z`;
      const toStr = `${dateStr}T23:59:59.999Z`;
      const params = new URLSearchParams({
        from: fromStr,
        to: toStr,
        limit: '100',
        ...(filterSymbol && { symbol: filterSymbol }),
        ...(filterGrade && { grade: filterGrade }),
        ...(accountKeyFilter && { accountKey: accountKeyFilter }),
      });
      const res = await fetch(`${API}/trades?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.status === 401) {
        localStorage.removeItem('token');
        router.push('/login');
        return;
      }
      const data = await res.json();
      setDailyTrades(data.trades || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingTrades(false);
    }
  };

  // Jump to specific selected date directly
  const handleJumpToDate = (dateVal: string) => {
    if (!dateVal) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    const selected = new Date(dateVal);
    setCurrentDate(selected);

    const y = selected.getFullYear();
    const m = String(selected.getMonth() + 1).padStart(2, '0');
    const d = String(selected.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;

    // Force open the trades drawer for this day
    setSelectedDateStr(dateStr);
    setLoadingTrades(true);
    setDailyTrades([]);

    const fromStr = `${dateStr}T00:00:00.000Z`;
    const toStr = `${dateStr}T23:59:59.999Z`;
    const params = new URLSearchParams({
      from: fromStr,
      to: toStr,
      limit: '100',
      ...(filterSymbol && { symbol: filterSymbol }),
      ...(filterGrade && { grade: filterGrade }),
      ...(accountKeyFilter && { accountKey: accountKeyFilter }),
    });

    fetch(`${API}/trades?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(r => {
        if (r.status === 401) {
          localStorage.removeItem('token');
          router.push('/login');
          return;
        }
        return r.json();
      })
      .then(data => {
        if (data) setDailyTrades(data.trades || []);
      })
      .catch(console.error)
      .finally(() => setLoadingTrades(false));
  };

  const resetFilters = () => {
    setFilterSymbol('');
    setFilterGrade('');
    setAccountKeyFilter('');
  };

  // Nav Month shifts
  const prevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  };

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const todayStr = new Date().toISOString().split('T')[0];

  // Calendar cells generation logic
  const firstDayOfMonth = new Date(year, month, 1);
  const startDayOfWeek = firstDayOfMonth.getDay(); // 0 (Sun) - 6 (Sat)
  const totalDays = new Date(year, month + 1, 0).getDate();

  const cells = [];
  // 1. Padding leading empty cells
  for (let i = 0; i < startDayOfWeek; i++) {
    cells.push({ isEmpty: true, day: 0, dateStr: '' });
  }
  // 2. Add actual days in month
  for (let day = 1; day <= totalDays; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    cells.push({ isEmpty: false, day, dateStr });
  }

  // Weekly P&L rollup: each row of the grid (7 cells) is one calendar week.
  const weeklyRollup: { pnl: number; days: number }[] = [];
  for (let i = 0; i < cells.length; i += 7) {
    const week = cells.slice(i, i + 7);
    let pnl = 0, days = 0;
    for (const cell of week) {
      if (cell.isEmpty) continue;
      const stats = calendarStats[cell.dateStr];
      if (stats && stats.tradesCount > 0) { pnl += stats.pnl; days++; }
    }
    weeklyRollup.push({ pnl, days });
  }

  // Calculate Monthly Summary Stats dynamically for the selected month
  const monthlyStats = Object.values(calendarStats).filter(s => {
    const d = new Date(s.date);
    return d.getFullYear() === year && d.getMonth() === month;
  });

  const monthlyPnL = monthlyStats.reduce((sum, s) => sum + s.pnl, 0);
  const monthlyTrades = monthlyStats.reduce((sum, s) => sum + s.tradesCount, 0);
  const totalTradingDays = monthlyStats.length;
  const greenDays = monthlyStats.filter(s => s.pnl > 0).length;
  const redDays = monthlyStats.filter(s => s.pnl < 0).length;
  const dailyWinRate = totalTradingDays > 0 ? (greenDays / totalTradingDays) * 100 : 0;


  if (!hasToken) return null;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-inner">
          <div>
            <h2>Daily Calendar</h2>
            <p><strong style={{ color: 'var(--text-secondary)' }}>{PAGE_PURPOSE['/calendar'].question}</strong> {PAGE_PURPOSE['/calendar'].detail}</p>
          </div>
        </div>
      </div>

      {/* Calendar Filter Tools Row */}
      <div className="filters-bar">
        <div className="filter-group">
          <label>Symbol / Instrument</label>
          <select value={filterSymbol} onChange={e => { setFilterSymbol(e.target.value); }}>
            <option value="">All instruments</option>
            {symbols.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="filter-group">
          <label>Setup Grade Filter</label>
          <select value={filterGrade} onChange={e => { setFilterGrade(e.target.value); }}>
            <option value="">All setup grades</option>
            <option value="A">Grade A Setups</option>
            <option value="B">Grade B Setups</option>
            <option value="C">Grade C Setups</option>
            <option value="D">Grade D Setups</option>
            <option value="F">Grade F (Boredom) Setups</option>
          </select>
        </div>
        {tradeAccounts.length > 0 && (
          <div className="filter-group">
            <label>Trading Account</label>
            <select value={accountKeyFilter} onChange={e => setAccountKeyFilter(e.target.value)}>
              <option value="">All trading accounts</option>
              {tradeAccounts.map(account => (
                <option key={account.accountKey} value={account.accountKey}>{account.label} ({account.accountType}, {account.count})</option>
              ))}
            </select>
          </div>
        )}
        <button className="btn btn-ghost" onClick={resetFilters} style={{ alignSelf: 'flex-end', flexShrink: 0 }}>
          <SlidersHorizontal size={13} />
          Reset Filters
        </button>
      </div>

      {mixedAccounts && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'var(--amber-bg, rgba(245,158,11,0.12))', border: '1px solid var(--amber, #f59e0b)',
          borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 16, fontSize: 13,
        }}>
          <AlertTriangle size={16} style={{ flexShrink: 0, color: 'var(--amber, #f59e0b)' }} />
          <span>
            This calendar blends trades from more than one broker account. Daily P&amp;L and R-multiples
            are per-account and not meaningful when merged — pick a single account above for accurate figures.
          </span>
        </div>
      )}

      {/* Monthly Grid Card */}
      <div className="calendar-card">
        <div className="calendar-main">
            {/* Calendar Navigation Toolbar */}
            <div className="calendar-toolbar">
              <div className="calendar-month-title">
                {MONTHS[month]} {year}
              </div>

              <div className="calendar-controls" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {/* Jump to Specific Date Picker Tool */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 10px' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>Jump to:</span>
                  <input
                    type="date"
                    onChange={e => handleJumpToDate(e.target.value)}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--text-secondary)',
                      outline: 'none',
                      cursor: 'pointer',
                      padding: 0
                    }}
                  />
                </div>

                <button className="page-btn" onClick={prevMonth}>
                  <ChevronLeft size={16} />
                </button>
                <button className="page-btn" onClick={() => { setCurrentDate(new Date()); setSelectedDateStr(null); }} style={{ fontSize: 11, fontWeight: 600 }}>
                  Today
                </button>
                <button className="page-btn" onClick={nextMonth}>
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>

            {/* Days of week header */}
            <div className="calendar-weekday-row">
              {WEEKDAYS.map(day => <div key={day}>{day}</div>)}
              <div className="calendar-weekday-pnl-label">P&amp;L</div>
            </div>

            {/* Grid Cells -- a week's box shares the same grid row as its 7 days, so it always lines up. */}
            {loading ? (
              <div className="loading-wrap" style={{ minHeight: 280 }}><div className="spinner" /></div>
            ) : (
              <div className="calendar-grid">
                {cells.map((cell, idx) => {
                  const dayCell = cell.isEmpty ? (
                    <div key={`empty-${idx}`} className="calendar-day empty" />
                  ) : (() => {
                    const stats = calendarStats[cell.dateStr];
                    const statsExist = !!stats && stats.tradesCount > 0;
                    const isProfit = statsExist && stats.pnl >= 0;

                    return (
                      <div
                        key={cell.dateStr}
                        className={`calendar-day ${statsExist ? 'active-day' : ''} ${statsExist ? (isProfit ? 'profit-day' : 'loss-day') : ''} ${cell.dateStr === todayStr ? 'is-today' : ''}`}
                        onClick={() => handleDayClick(cell.dateStr, statsExist)}
                      >
                        <span className="day-num">{cell.day}</span>

                        {statsExist && (
                          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'flex-end' }}>
                            <span className="day-pnl">
                              {stats.pnl >= 0 ? '+' : '-'}${Math.abs(stats.pnl).toFixed(2)}
                            </span>
                            <span className="day-trades-lbl">{stats.tradesCount} trade{stats.tradesCount > 1 ? 's' : ''}</span>
                            <span className="day-sub-metric">
                              {stats.avgR !== null
                                ? `${stats.avgR >= 0 ? '+' : ''}${stats.avgR.toFixed(2)}R`
                                : `${stats.winRate.toFixed(1)}%`}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })();

                  // Every 7th cell closes out a calendar week -- append that week's box
                  // right after it, so it lands in the same grid row via CSS grid auto-flow.
                  if ((idx + 1) % 7 !== 0) return dayCell;
                  const week = weeklyRollup[Math.floor(idx / 7)];
                  return (
                    <Fragment key={`row-${idx}`}>
                      {dayCell}
                      <div className={`calendar-week-box ${week.days === 0 ? '' : week.pnl >= 0 ? 'profit' : 'loss'}`}>
                        <span className="calendar-weekly-label">Week {Math.floor(idx / 7) + 1}</span>
                        <span className={`calendar-weekly-pnl ${week.days === 0 ? 'muted' : week.pnl >= 0 ? 'positive' : 'negative'}`}>
                          {week.days === 0 ? '—' : `${week.pnl >= 0 ? '+' : ''}$${Math.abs(week.pnl).toFixed(1)}`}
                        </span>
                        <span className="calendar-weekly-days">{week.days} day{week.days === 1 ? '' : 's'}</span>
                      </div>
                    </Fragment>
                  );
                })}
              </div>
            )}
        </div>

        {/* Flat monthly stats bar, below the calendar */}
        {!loading && (
          <div className="calendar-stats-bar">
            <span>Month P&amp;L: <strong className={monthlyPnL >= 0 ? 'positive' : 'negative'}>{monthlyPnL >= 0 ? '+' : '-'}{fmtUSD(Math.abs(monthlyPnL))}</strong></span>
            <span>Total Trades: <strong>{monthlyTrades}</strong></span>
            <span>Profit Days: <strong className="positive">{greenDays}</strong></span>
            <span>Loss Days: <strong className="negative">{redDays}</strong></span>
            <span>Day Win Rate: <strong>{dailyWinRate.toFixed(0)}%</strong></span>
          </div>
        )}
      </div>

      {/* ══════════════════════════════
         DAILY TRADES VIEWER PANEL (MODAL DRAWER)
      ══════════════════════════════ */}
      {selectedDateStr && (
        <>
          <div className="drawer-overlay" onClick={() => setSelectedDateStr(null)} />
          <div className="drawer" style={{ width: 500 }}>
            <div className="drawer-header">
              <div>
                <h3>Daily Closed Trades</h3>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Date: {new Date(selectedDateStr).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                </span>
              </div>
              <button className="drawer-close" onClick={() => setSelectedDateStr(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="drawer-body" style={{ padding: 20 }}>
              {loadingTrades ? (
                <div className="loading-wrap" style={{ minHeight: 200 }}><div className="spinner" /></div>
              ) : dailyTrades.length === 0 ? (
                <div className="empty-state" style={{ minHeight: 180 }}>
                  <div className="empty-icon"><CalendarIcon size={20} /></div>
                  <h3>No trades found</h3>
                  <p>There are no recorded trades closed on this specific date.</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div className="drawer-section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Info size={12} /> Closed Trades Count: {dailyTrades.length}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {dailyTrades.map((t) => {
                      const isProfit = t.pnlUSD >= 0;
                      return (
                        <div 
                          key={t._id} 
                          className="session-summary-row"
                          style={{ borderLeft: `3px solid ${isProfit ? 'var(--green)' : 'var(--red)'}`, background: 'var(--bg-surface)' }}
                        >
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                              {t.symbol} · <span className={`badge ${t.direction.toLowerCase()}`} style={{ fontSize: 9, padding: '1px 5px' }}>{t.direction}</span>
                              {t.grade && <span className={`grade-pill-tag ${t.grade}`} style={{ marginLeft: 6, transform: 'scale(0.85)', transformOrigin: 'left center' }}>{t.grade}</span>}
                            </span>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                              Lots: {t.lotSize.toFixed(2)} · Close: {new Date(t.closeTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                          
                          <div className="session-stats-group" style={{ alignItems: 'flex-end', flexDirection: 'column', gap: 6 }}>
                            <span className={`pnl ${isProfit ? 'positive' : 'negative'}`} style={{ fontSize: 14, fontWeight: 700 }}>
                              {isProfit ? '+' : ''}${t.pnlUSD.toFixed(2)}
                            </span>
                            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                              {t.durationMinutes} mins duration
                            </span>
                            <button
                              className="btn btn-ghost"
                              style={{ fontSize: 10.5, padding: '3px 8px' }}
                              onClick={() => setReplayTradeId(t._id)}
                              title="Open chart replay for this trade"
                            >
                              <Play size={11} /> Replay
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="drawer-footer">
              <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setSelectedDateStr(null)}>
                Close Panel
              </button>
            </div>
          </div>
        </>
      )}

      {replayTradeId && (() => {
        const replayTrade = dailyTrades.find(t => t._id === replayTradeId);
        if (!replayTrade) return null;
        const index = dailyTrades.findIndex(t => t._id === replayTradeId);
        return (
          <TradeReplayModal
            key={replayTradeId}
            tradeId={replayTradeId}
            tradeSummary={{
              symbol: replayTrade.symbol,
              direction: replayTrade.direction,
              pnlUSD: replayTrade.pnlUSD,
              pnlPct: replayTrade.pnlPct,
              entryPrice: replayTrade.entryPrice,
              exitPrice: replayTrade.exitPrice,
              openTime: replayTrade.openTime,
              closeTime: replayTrade.closeTime,
              durationMinutes: replayTrade.durationMinutes,
              lotSize: replayTrade.lotSize,
            }}
            onClose={() => setReplayTradeId(null)}
            onSaved={updates => {
              setDailyTrades(current => current.map(t => t._id === replayTradeId ? { ...t, ...updates } : t));
              setReplayTradeId(null);
            }}
            onNavigate={direction => {
              const target = dailyTrades[direction === 'prev' ? index - 1 : index + 1];
              if (target) setReplayTradeId(target._id);
            }}
            canNavigatePrev={index > 0}
            canNavigateNext={index >= 0 && index < dailyTrades.length - 1}
          />
        );
      })()}
    </div>
  );
}
