'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

export const SIM_STARTING_BALANCE = 100_000;
const ACTIVE_SYMBOL_KEY = 'bt-active-symbol';

export interface BacktestTrade {
  _id: string;
  name: string;
  strategy: string;
  tags?: string[];
  source?: 'replay' | 'quick';
  symbol: string;
  interval: string;
  direction: 'long' | 'short';
  entryTime?: number; entryPrice?: number;
  exitTime?: number; exitPrice?: number;
  stopLoss?: number; takeProfit?: number | null;
  outcome: 'win' | 'loss' | 'breakeven';
  riskAmount: number; pnlUSD: number; rMultiple: number;
  notes: string;
  createdAt: string;
}

/** A trade's strategy tags; older backtests only have a single `strategy`. */
export function tagsOf(t: Pick<BacktestTrade, 'tags' | 'strategy'>): string[] {
  if (t.tags && t.tags.length) return t.tags;
  return t.strategy ? [t.strategy] : [];
}
/** "ICT Silver Bullet" -> "#ICT-SilverBullet"-style display, as in the design. */
export function hashTag(tag: string) {
  return `#${tag.trim().replace(/\s+(\w)/g, (_, c: string) => c.toUpperCase()).replace(/\s+/g, '')}`;
}

export function fmtPrice(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: Math.abs(n) >= 100 ? 2 : 4, maximumFractionDigits: Math.abs(n) >= 100 ? 2 : 5 });
}
export function fmtUSD(n: number, signed = true) {
  const s = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!signed) return `$${s}`;
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}$${s}`;
}
export function fmtR(n: number, digits = 2) {
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n).toFixed(digits)}R`;
}
export function intervalLabel(interval: string) {
  const map: Record<string, string> = { '1min': '1M', '5min': '5M', '15min': '15M', '1h': '1H', '4h': '4H', '1day': '1D' };
  return map[interval] ?? (interval ? interval.toUpperCase() : '—');
}
export function fmtDate(iso: string | number) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

interface BacktestData {
  trades: BacktestTrade[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  removeTrade: (id: string) => Promise<boolean>;
  addTrade: (trade: BacktestTrade) => void;
  strategies: string[];
  simBalance: number;
  activeSymbol: string;
  setActiveSymbol: (symbol: string) => void;
}

const BacktestContext = createContext<BacktestData | null>(null);

export function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function BacktestProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [trades, setTrades] = useState<BacktestTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeSymbol, setActiveSymbolState] = useState('XAUUSD');

  const reload = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) { router.push('/login'); return; }
    try {
      const res = await fetch('/api/backtest-trades', { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { localStorage.removeItem('token'); router.push('/login'); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load backtest log');
      setTrades(data.trades || []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load backtest log');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const stored = localStorage.getItem(ACTIVE_SYMBOL_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from localStorage
    if (stored) setActiveSymbolState(stored);
    void reload();
  }, [reload]);

  const setActiveSymbol = useCallback((symbol: string) => {
    const clean = symbol.trim().toUpperCase();
    if (!clean) return;
    setActiveSymbolState(clean);
    try { localStorage.setItem(ACTIVE_SYMBOL_KEY, clean); } catch { /* storage unavailable */ }
  }, []);

  const removeTrade = useCallback(async (id: string) => {
    const res = await fetch(`/api/backtest-trades/${id}`, { method: 'DELETE', headers: authHeaders() });
    if (res.ok) setTrades(current => current.filter(t => t._id !== id));
    return res.ok;
  }, []);
  const addTrade = useCallback((trade: BacktestTrade) => setTrades(current => [trade, ...current]), []);

  const value = useMemo<BacktestData>(() => {
    const strategies = Array.from(new Set(trades.flatMap(tagsOf))).sort((a, b) => a.localeCompare(b));
    const simBalance = SIM_STARTING_BALANCE + trades.reduce((sum, t) => sum + (t.pnlUSD || 0), 0);
    return { trades, loading, error, reload, removeTrade, addTrade, strategies, simBalance, activeSymbol, setActiveSymbol };
  }, [trades, loading, error, reload, removeTrade, addTrade, activeSymbol, setActiveSymbol]);

  return <BacktestContext.Provider value={value}>{children}</BacktestContext.Provider>;
}

export function useBacktest() {
  const ctx = useContext(BacktestContext);
  if (!ctx) throw new Error('useBacktest must be used inside <BacktestProvider>');
  return ctx;
}
