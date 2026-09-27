'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, Bot, Check, Loader2, ShieldCheck } from 'lucide-react';
import LogoMark from '@/components/LogoMark';

// The OAuth consent page: an app (e.g. claude.ai adding the journal as a
// custom connector) sends the owner here; approving hands the app a code it
// exchanges for tokens at /api/oauth/token. See backend/routes/oauth.js.

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function Consent() {
  const params = useSearchParams();
  const [info, setInfo] = useState<{ clientName: string; redirectHost: string; requestedScopes: string[] } | null>(null);
  const [error, setError] = useState('');
  const [journal, setJournal] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);

  const q = (k: string) => params.get(k) || '';
  const incomplete = !params.get('client_id') || !params.get('redirect_uri');
  const shownError = error || (incomplete ? 'This sign-in link is incomplete. Start again from the app you are connecting.' : '');

  useEffect(() => {
    if (!localStorage.getItem('token')) {
      window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    const clientId = params.get('client_id') || '', redirectUri = params.get('redirect_uri') || '';
    if (!clientId || !redirectUri) return; // shown as `incomplete` below
    fetch(`/api/oauth/authorize-info?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: params.get('scope') || '' })}`, { headers: authHeaders() })
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) { localStorage.removeItem('token'); window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`); return; }
        if (!res.ok) throw new Error(data.error || 'This app could not be verified.');
        setInfo(data);
        if (data.requestedScopes?.includes('journal')) setJournal(true);
      })
      .catch(err => setError(err instanceof Error ? err.message : 'This app could not be verified.'));
  }, [params]);

  async function decide(approve: boolean) {
    setBusy(approve ? 'approve' : 'deny'); setError('');
    try {
      const res = await fetch('/api/oauth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          client_id: q('client_id'), redirect_uri: q('redirect_uri'), response_type: q('response_type'),
          code_challenge: q('code_challenge'), code_challenge_method: q('code_challenge_method'), state: params.get('state') ?? undefined,
          approve, journal: approve && journal,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.redirect) throw new Error(data.error || 'Could not complete the sign-in.');
      window.location.href = data.redirect;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete the sign-in.');
      setBusy(null);
    }
  }

  const item: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 };

  return (
    <div className="login-container">
      <div className="login-card" style={{ maxWidth: 460 }}>
        <div className="login-header">
          <div className="login-logo-mark"><LogoMark size={44} /></div>
          <h2 style={{ fontSize: 20 }}>Connect an app</h2>
        </div>

        {!info && !shownError && <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Loader2 className="spin" size={22} /></div>}

        {info && (
          <div style={{ display: 'grid', gap: 16 }}>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.5, textAlign: 'center' }}>
              <b>{info.clientName}</b> wants to connect to your TradeJournal.
              <br /><span style={{ fontSize: 12, color: 'var(--text-muted)' }}>You&apos;ll be sent back to {info.redirectHost}.</span>
            </p>
            <div style={{ display: 'grid', gap: 10, padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-elevated)' }}>
              <div style={item}><Bot size={16} style={{ flexShrink: 0, marginTop: 2, color: 'var(--accent)' }} />
                <span><b style={{ color: 'var(--text-primary)' }}>Backtesting</b>: replay cTrader history and run strategy code, logging its trades to your Backtest Log as agent runs (kept out of your own stats).</span>
              </div>
              <label style={{ ...item, cursor: 'pointer' }}>
                <input type="checkbox" checked={journal} onChange={e => setJournal(e.target.checked)} style={{ marginTop: 3 }} />
                <span><b style={{ color: 'var(--text-primary)' }}>Read my trade journal</b> (optional): real trades, notes, grades, checklists, screenshots, stats, playbooks, knowledge base. Read-only; it can&apos;t change anything.</span>
              </label>
            </div>
            <p style={{ margin: 0, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              <ShieldCheck size={12} style={{ verticalAlign: '-2px' }} /> It can never place real trades or see your password. You can disconnect it any time on the Accounts page (AI agent access).
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => decide(false)} disabled={busy !== null}>
                {busy === 'deny' ? <Loader2 size={14} className="spin" /> : null} Cancel
              </button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => decide(true)} disabled={busy !== null}>
                {busy === 'approve' ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Allow
              </button>
            </div>
          </div>
        )}

        {shownError && <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--red)', fontSize: 13, marginTop: 12 }} role="alert"><AlertCircle size={16} /> {shownError}</div>}
      </div>
    </div>
  );
}

export default function AuthorizePage() {
  return <Suspense fallback={null}><Consent /></Suspense>;
}
