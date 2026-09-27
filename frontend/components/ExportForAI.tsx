'use client';

import { useState } from 'react';
import { AlertCircle, Check, Copy, Download, Loader2, Sparkles, X } from 'lucide-react';

export interface ExportFilters {
  symbol?: string;
  direction?: string;
  accountType?: string;
  accountKey?: string;
  from?: string;
  to?: string;
}

const TRADE_LIMITS = [
  { value: 0, label: 'Statistics only' },
  { value: 50, label: 'Newest 50 trades' },
  { value: 100, label: 'Newest 100 trades' },
  { value: 300, label: 'Newest 300 trades' },
  { value: 1000, label: 'Newest 1,000 trades' },
];

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * "Export for AI": the filtered trades, statistics (with likely ranges) and
 * playbooks as one Markdown document with a review brief, to paste or upload
 * into any AI chat -- for chats that can't connect to the MCP server.
 */
export default function ExportForAI({ filters, onClose }: { filters: ExportFilters; onClose: () => void }) {
  const [maxTrades, setMaxTrades] = useState(100);
  const [notes, setNotes] = useState(true);
  const [busy, setBusy] = useState<'copy' | 'download' | null>(null);
  const [done, setDone] = useState<string>('');
  const [error, setError] = useState('');

  const active = Object.entries(filters).filter(([, v]) => v);
  const describe = ([k, v]: [string, string | undefined]) => `${{ symbol: 'Symbol', direction: 'Direction', accountType: 'Live/demo', accountKey: 'Account', from: 'From', to: 'To' }[k] || k}: ${k === 'accountKey' && v === '__unassigned__' ? 'unassigned' : v}`;

  async function build() {
    const params = new URLSearchParams({ maxTrades: String(maxTrades), notes: notes ? '1' : '0' });
    for (const [k, v] of active) params.set(k, String(v));
    const res = await fetch(`/api/export/ai?${params}`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not build the export');
    return data as { markdown: string; trades: number; listed: number };
  }

  async function run(mode: 'copy' | 'download') {
    setBusy(mode); setError(''); setDone('');
    try {
      const data = await build();
      const summary = `${data.trades.toLocaleString()} trades in the statistics${data.listed ? `, ${data.listed.toLocaleString()} listed in full` : ''}`;
      if (mode === 'copy') {
        try {
          await navigator.clipboard.writeText(data.markdown);
        } catch {
          throw new Error('The browser blocked the clipboard. Use Download instead.');
        }
        setDone(`Copied (${summary}). Paste it into a new chat with any AI.`);
      } else {
        const blob = new Blob([data.markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `trading-journal-${new Date().toISOString().slice(0, 10)}.md`;
        a.click();
        URL.revokeObjectURL(url);
        setDone(`Downloaded (${summary}). Upload the file to a new chat with any AI.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build the export');
    } finally {
      setBusy(null);
    }
  }

  const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 };
  const field: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 13 };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" style={{ width: 460 }} onClick={e => e.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Sparkles size={16} /> Export for AI</h3>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Get an AI to tell you what&apos;s going wrong</span>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="drawer-body" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            Builds one document with your statistics (with likely ranges), breakdowns by setup, session, emotion and rules followed,
            your playbooks, and each trade with its journal. It starts with instructions telling the AI to review it like a coach,
            so you can paste it into ChatGPT, Claude, Gemini or any other chat and just hit send.
          </p>

          <div>
            <span style={label}>Trades included</span>
            <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
              {active.length ? active.map(describe).join(' · ') : 'All trades (no filters)'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Uses the filters on this page. Change them first to focus on one account, symbol or period.</div>
          </div>

          <div>
            <label style={label} htmlFor="ai-export-limit">Trades listed in full</label>
            <select id="ai-export-limit" style={field} value={maxTrades} onChange={e => setMaxTrades(Number(e.target.value))}>
              {TRADE_LIMITS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>The statistics always cover every matching trade. Fewer listed trades keep the document small enough to paste.</div>
          </div>

          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={notes} onChange={e => setNotes(e.target.checked)} style={{ marginTop: 2 }} />
            <span>Include my notes, playbook answers and screenshot links<br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Turn off to share only numbers, grades, emotions and checklists.</span></span>
          </label>

          {error && <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--red)', fontSize: 12.5 }} role="alert"><AlertCircle size={15} /> {error}</div>}
          {done && <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--green)', fontSize: 12.5 }} role="status"><Check size={15} /> {done}</div>}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => run('copy')} disabled={busy !== null}>
              {busy === 'copy' ? <Loader2 size={14} className="spin" /> : <Copy size={14} />} Copy to clipboard
            </button>
            <button className="btn btn-ghost" onClick={() => run('download')} disabled={busy !== null}>
              {busy === 'download' ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Download .md
            </button>
          </div>
          <p style={{ margin: 0, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Using Claude Desktop or Claude Code? Connect it to the journal instead (Accounts → AI agent access, with journal access on):
            it can then pull any trade, stat and chart itself.
          </p>
        </div>
      </div>
    </div>
  );
}
