'use client';
import type { SerializedDrawing } from 'lightweight-charts-drawing';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

export const SIM_STARTING_BALANCE = 100_000;
const ACTIVE_SYMBOL_KEY = 'bt-active-symbol';
const CURRENT_STRATEGY_KEY = 'bt-current-strategy';
const AGENT_RUNS_KEY = 'bt-agent-runs';

/** Which backtests the views count: your own, AI agents' (MCP), or both. */
export type AgentRunsView = 'mine' | 'agent' | 'all';

export interface BacktestTrade {
  _id: string;
  name: string;
  strategy: string;
  tags?: string[];
  source?: 'replay' | 'quick' | 'agent';
  /** Agent run in a blind session: the agent never saw the real dates or prices. */
  blind?: boolean;
  /** Version of the strategy's rules the trade was taken under (null/absent = version 1). */
  strategyVersion?: number | null;
  symbol: string;
  interval: string;
  direction: 'long' | 'short';
  entryTime?: number; entryPrice?: number;
  exitTime?: number; exitPrice?: number;
  stopLoss?: number; takeProfit?: number | null;
  outcome: 'win' | 'loss' | 'breakeven';
  riskAmount: number; pnlUSD: number; rMultiple: number;
  notes: string;
  planFollowed?: boolean; setupQuality?: number; executionQuality?: number;
  mistakes?: string[]; lesson?: string; hasSnapshot?: boolean;
  /** Drawings on the chart when it was logged (the shared drawing tools' saved form). */
  chartAnnotations?: SerializedDrawing[];
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

export interface StrategyInfo {
  _id?: string; name: string; description: string; trades: number; winRate: number; avgR: number;
  agentTrades?: number; agentWinRate?: number; agentAvgR?: number;
  /** Rule history saved by AI agents (update_strategy_rules); empty until the rules are first revised. */
  versions?: StrategyVersion[];
  holdoutFrom?: string | null;
}
export interface StrategyVersion { version: number; rules: string; change: string; createdAt?: string; holdoutSeenBefore?: boolean }

interface BacktestData {
  /** The trades the current `agentRuns` view counts -- what every view shows and computes stats from. */
  trades: BacktestTrade[];
  /** Every logged trade, whatever the view. */
  allTrades: BacktestTrade[];
  agentRuns: AgentRunsView;
  setAgentRuns: (view: AgentRunsView) => void;
  agentTradeCount: number;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  removeTrade: (id: string) => Promise<boolean>;
  addTrade: (trade: BacktestTrade) => void;
  updateTrade: (id: string, patch: Partial<BacktestTrade>) => Promise<{ ok: boolean; error?: string }>;
  strategies: string[];
  strategyInfo: StrategyInfo[];
  createStrategy: (name: string, description?: string) => Promise<{ ok: boolean; error?: string }>;
  /** Deletes the strategy definition; logged backtests keep their tag. */
  /** Deletes the strategy (its definition, if any) and removes its tag from every backtest carrying it. */
  removeStrategy: (name: string) => Promise<{ ok: boolean; error?: string; untagged?: number }>;
  simBalance: number;
  activeSymbol: string;
  setActiveSymbol: (symbol: string) => void;
  currentStrategy: string;
  setCurrentStrategy: (name: string) => void;
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
  const [currentStrategy, setCurrentStrategyState] = useState('');
  const [strategyInfo, setStrategyInfo] = useState<StrategyInfo[]>([]);
  const [agentRuns, setAgentRunsState] = useState<AgentRunsView>('mine');

  const reloadStrategies = useCallback(async () => {
    try {
      const res = await fetch('/api/backtest-strategies', { headers: authHeaders() });
      const data = await res.json();
      if (res.ok) setStrategyInfo(Array.isArray(data.strategies) ? data.strategies : []);
    } catch { /* strategies are a nice-to-have list; a failed fetch just leaves it empty */ }
  }, []);

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
    const storedStrategy = localStorage.getItem(CURRENT_STRATEGY_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from localStorage
    if (storedStrategy) setCurrentStrategyState(storedStrategy);
    const storedRuns = localStorage.getItem(AGENT_RUNS_KEY);
    if (storedRuns === 'agent' || storedRuns === 'all') setAgentRunsState(storedRuns);
    void reload();
    void reloadStrategies();
  }, [reload, reloadStrategies]);

  const setActiveSymbol = useCallback((symbol: string) => {
    const clean = symbol.trim().toUpperCase();
    if (!clean) return;
    setActiveSymbolState(clean);
    try { localStorage.setItem(ACTIVE_SYMBOL_KEY, clean); } catch { /* storage unavailable */ }
  }, []);

  const setCurrentStrategy = useCallback((name: string) => {
    const clean = name.trim();
    setCurrentStrategyState(clean);
    try {
      if (clean) localStorage.setItem(CURRENT_STRATEGY_KEY, clean);
      else localStorage.removeItem(CURRENT_STRATEGY_KEY);
    } catch { /* storage unavailable */ }
  }, []);

  const setAgentRuns = useCallback((view: AgentRunsView) => {
    setAgentRunsState(view);
    try { localStorage.setItem(AGENT_RUNS_KEY, view); } catch { /* storage unavailable */ }
  }, []);

  const removeTrade = useCallback(async (id: string) => {
    const res = await fetch(`/api/backtest-trades/${id}`, { method: 'DELETE', headers: authHeaders() });
    if (res.ok) setTrades(current => current.filter(t => t._id !== id));
    return res.ok;
  }, []);
  const addTrade = useCallback((trade: BacktestTrade) => setTrades(current => [trade, ...current]), []);
  const updateTrade = useCallback(async (id: string, patch: Partial<BacktestTrade>) => {
    try {
      const res = await fetch(`/api/backtest-trades/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(patch) });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || 'Could not update backtest' };
      // The PATCH response omits the snapshot flag; keep the one already known.
      setTrades(current => current.map(t => (t._id === id ? { ...t, ...data, hasSnapshot: t.hasSnapshot } : t)));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not update backtest' };
    }
  }, []);

  const createStrategy = useCallback(async (name: string, description = '') => {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: 'Strategy name is required' };
    try {
      const res = await fetch('/api/backtest-strategies', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name: trimmed, description }),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || 'Could not create strategy' };
      await reloadStrategies();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not create strategy' };
    }
  }, [reloadStrategies]);

  const removeStrategy = useCallback(async (name: string) => {
    try {
      const res = await fetch(`/api/backtest-strategies/by-name/${encodeURIComponent(name)}?untag=1`, { method: 'DELETE', headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || 'Could not delete strategy' };
      if (currentStrategy === name) setCurrentStrategy('');
      await Promise.all([reloadStrategies(), data.untagged ? reload() : Promise.resolve()]);
      return { ok: true, untagged: Number(data.untagged) || 0 };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not delete strategy' };
    }
  }, [reloadStrategies, reload, currentStrategy, setCurrentStrategy]);

  const value = useMemo<BacktestData>(() => {
    // Merge backend-defined strategies with any ad-hoc tags used on trades
    // before this feature existed, so older data keeps showing up.
    const strategies = Array.from(new Set([...strategyInfo.map(s => s.name), ...trades.flatMap(tagsOf)])).sort((a, b) => a.localeCompare(b));
    // AI agents' runs (MCP) stay out of your numbers unless the view asks for them.
    const agentTradeCount = trades.filter(t => t.source === 'agent').length;
    const visible = agentRuns === 'all' ? trades : trades.filter(t => (t.source === 'agent') === (agentRuns === 'agent'));
    const simBalance = SIM_STARTING_BALANCE + visible.reduce((sum, t) => sum + (t.pnlUSD || 0), 0);
    return { trades: visible, allTrades: trades, agentRuns, setAgentRuns, agentTradeCount, loading, error, reload, removeTrade, addTrade, updateTrade, strategies, strategyInfo, createStrategy, removeStrategy, simBalance, activeSymbol, setActiveSymbol, currentStrategy, setCurrentStrategy };
  }, [trades, agentRuns, setAgentRuns, loading, error, reload, removeTrade, addTrade, updateTrade, strategyInfo, createStrategy, removeStrategy, activeSymbol, setActiveSymbol, currentStrategy, setCurrentStrategy]);

  return <BacktestContext.Provider value={value}>{children}</BacktestContext.Provider>;
}

export function useBacktest() {
  const ctx = useContext(BacktestContext);
  if (!ctx) throw new Error('useBacktest must be used inside <BacktestProvider>');
  return ctx;
}
