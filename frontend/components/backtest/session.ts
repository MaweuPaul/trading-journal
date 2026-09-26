import { useEffect, useState } from 'react';
import type { SerializedDrawing } from 'lightweight-charts-drawing';
import type { OpenTrade } from '../backtest-tools/types';

// Autosaved workspace state -- so leaving mid-backtest (drawings on the
// chart, maybe an open hypothetical trade) doesn't lose that work. Stored
// client-side only; nothing here is logged until the trader explicitly
// saves a closed trade to the Backtest Log.
export const DRAFT_KEY = 'backtest-workspace-draft-v1';
const DRAFT_MAX_AGE_MS = 7 * 86_400_000;

export interface WorkspaceDraft {
  symbol: string; fromDate: string; toDate: string; interval: string;
  replayIdx: number; analysisStartIdx: number;
  totalBars?: number;
  openTrade: OpenTrade | null;
  backtestName: string; notes: string; tags: string[]; drawColor: string;
  drawings: SerializedDrawing[];
  savedAt: number;
}

export function readDraft(): WorkspaceDraft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceDraft;
    if (!parsed?.symbol || Date.now() - parsed.savedAt > DRAFT_MAX_AGE_MS) return null;
    return parsed;
  } catch { return null; }
}
export function writeDraft(draft: WorkspaceDraft) {
  try { window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* storage full/unavailable -- autosave is best-effort */ }
  window.dispatchEvent(new Event('bt-session-change'));
}
export function clearDraft() {
  try { window.localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  window.dispatchEvent(new Event('bt-session-change'));
}

/** The autosaved in-progress session, kept current as the workspace saves or clears it. */
export function useActiveSession() {
  const [draft, setDraft] = useState<WorkspaceDraft | null>(null);
  useEffect(() => {
    const sync = () => setDraft(readDraft());
    sync();
    window.addEventListener('bt-session-change', sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener('bt-session-change', sync); window.removeEventListener('storage', sync); };
  }, []);
  return draft;
}

/** Replay progress within the analysis window ("Bar 142 of 250"). */
export function draftProgress(d: WorkspaceDraft) {
  const bar = Math.max(0, d.replayIdx - d.analysisStartIdx + 1);
  const total = d.totalBars != null ? Math.max(0, d.totalBars - d.analysisStartIdx) : null;
  return { bar, total, pct: total ? Math.min(100, (bar / total) * 100) : null };
}
