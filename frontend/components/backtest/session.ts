import { useEffect, useState } from 'react';
import type { SerializedDrawing } from 'lightweight-charts-drawing';
import type { OpenTrade } from '../backtest-tools/types';

// Autosaved workspace sessions -- one per strategy -- so leaving mid-backtest
// (drawings, an open hypothetical trade, where the replay was) doesn't lose
// that work, and each strategy can be picked up again later. Stored
// client-side only; nothing is logged until the trader saves a closed trade.
const SESSIONS_KEY = 'backtest-sessions-v2';
const ACTIVE_KEY = 'backtest-active-session';
const LEGACY_KEY = 'backtest-workspace-draft-v1';
const DRAFT_MAX_AGE_MS = 60 * 86_400_000;

export interface WorkspaceDraft {
  /** Slot this session is saved in (see sessionIdFor); a resumed session always saves back to it. */
  id?: string;
  symbol: string; fromDate: string; toDate: string; interval: string;
  replayIdx: number; analysisStartIdx: number;
  /** Open time (unix seconds) of the current replay candle; survives paged loading. */
  replayTime?: number;
  totalBars?: number;
  /** Strategy this session is testing ('' = none). Decides which slot it's saved in. */
  strategy?: string;
  openTrade: OpenTrade | null;
  backtestName: string; notes: string; tags: string[]; drawColor: string;
  drawings: SerializedDrawing[];
  /** Account balance the backtest started with; fixed for the session. */
  startBalance?: number;
  /** P&L of the outcomes logged in this session, so the balance carries on. */
  realizedPnl?: number;
  /** Outcomes logged in this session, newest last (the History tab). */
  sessionLog?: SessionTrade[];
  /** What happened in this session, newest last (the Timeline). */
  timeline?: TimelineEvent[];
  savedAt: number;
}

/** A trade logged during this backtest session. */
export interface SessionTrade {
  id: string; name: string;
  direction: 'long' | 'short'; orderType?: 'market' | 'limit' | 'stop';
  entryTime: number; entryPrice: number; exitTime: number; exitPrice: number;
  lots?: number | null; rMultiple: number; pnlUSD: number;
}
/** One line of the session timeline; `time` is the replay time (unix seconds) it happened at. */
export interface TimelineEvent { time: number; text: string; tone?: 'win' | 'loss' | 'info' }

export const sessionIdFor = (strategy?: string | null) => (strategy?.trim() ? `s:${strategy.trim().toLowerCase()}` : 'none');

function readAll(): Record<string, WorkspaceDraft> {
  try {
    const all = JSON.parse(window.localStorage.getItem(SESSIONS_KEY) || '{}') as Record<string, WorkspaceDraft>;
    // One-time move of the old single-session draft into its strategy slot.
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const d = JSON.parse(legacy) as WorkspaceDraft;
      if (d?.symbol) {
        const strategy = d.strategy ?? d.tags?.[0] ?? '';
        all[sessionIdFor(strategy)] ??= { ...d, strategy };
        window.localStorage.setItem(ACTIVE_KEY, sessionIdFor(strategy));
      }
      window.localStorage.removeItem(LEGACY_KEY);
      window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(all));
    }
    for (const [id, d] of Object.entries(all)) {
      if (!d?.symbol || Date.now() - d.savedAt > DRAFT_MAX_AGE_MS) delete all[id];
      else d.id = id;
    }
    return all;
  } catch { return {}; }
}
function writeAll(all: Record<string, WorkspaceDraft>) {
  try { window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(all)); } catch { /* storage full/unavailable -- autosave is best-effort */ }
  window.dispatchEvent(new Event('bt-session-change'));
}
function activeId() { try { return window.localStorage.getItem(ACTIVE_KEY); } catch { return null; } }

/** A saved session by id, or the most recently active one. */
export function readDraft(id?: string | null): WorkspaceDraft | null {
  const all = readAll();
  const key = id ?? activeId();
  if (key && all[key]) return all[key];
  if (id) return null;
  return Object.values(all).sort((a, b) => b.savedAt - a.savedAt)[0] ?? null;
}
export function writeDraft(draft: WorkspaceDraft) {
  const all = readAll();
  const id = draft.id ?? sessionIdFor(draft.strategy);
  all[id] = { ...draft, id };
  try { window.localStorage.setItem(ACTIVE_KEY, id); } catch { /* ignore */ }
  writeAll(all);
}
/** Remove one session (default: the active one). */
export function clearDraft(id?: string | null) {
  const all = readAll();
  const key = id ?? activeId();
  if (key) delete all[key];
  try { if (!id || id === activeId()) window.localStorage.removeItem(ACTIVE_KEY); } catch { /* ignore */ }
  writeAll(all);
}

function useSessionState<T>(read: () => T, initial: T) {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const sync = () => setValue(read());
    sync();
    window.addEventListener('bt-session-change', sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener('bt-session-change', sync); window.removeEventListener('storage', sync); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return value;
}
/** The most recently active in-progress session, kept current as sessions change. */
export function useActiveSession() {
  return useSessionState<WorkspaceDraft | null>(() => readDraft(), null);
}
/** Every saved session, keyed by session id. */
export function useSessions() {
  return useSessionState<Record<string, WorkspaceDraft>>(readAll, {});
}

/** Replay progress within the session's date range. */
export function draftProgress(d: WorkspaceDraft) {
  const bar = Math.max(0, d.replayIdx - d.analysisStartIdx + 1);
  const from = new Date(d.fromDate).getTime(), to = new Date(d.toDate).getTime() + 86_400_000;
  if (d.replayTime && to > from) {
    const pct = Math.min(100, Math.max(0, ((d.replayTime * 1000 - from) / (to - from)) * 100));
    return { bar, total: null as number | null, pct, at: new Date(d.replayTime * 1000) };
  }
  const total = d.totalBars != null ? Math.max(0, d.totalBars - d.analysisStartIdx) : null;
  return { bar, total, pct: total ? Math.min(100, (bar / total) * 100) : null, at: null as Date | null };
}
