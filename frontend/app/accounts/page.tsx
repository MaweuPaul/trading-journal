'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import {
  AlertCircle, CheckCircle2, ChevronDown, Eye, EyeOff, KeyRound,
  Landmark, Loader2, LockKeyhole, Pencil, Plus, RefreshCw, Server,
  ShieldCheck, Trash2, WifiOff, PlugZap, Unlink, Video, DownloadCloud,
  Users, Copy, ShieldOff, Check, TerminalSquare,
} from 'lucide-react';

type AccountStatus = 'pending' | 'connected' | 'error' | 'disabled';

interface TradingAccount {
  id: string;
  accountKey: string;
  provider: 'mt5' | 'ctrader';
  label: string;
  enabled: boolean;
  requireRealAccount: boolean;
  symbolAliases: string;
  lastStatus: AccountStatus;
  lastError: string;
  lastConnectedAt: string | null;
  lastSyncAt: string | null;
  lastAgentSeenAt: string | null;
  lastBalance: number | null;
  actualAccountType: 'live' | 'demo' | '';
  tradeCount: number;
  investor: { enabled: boolean; code: string | null; lastViewedAt: string | null };
}

interface AccountForm {
  label: string;
  login: string;
  password: string;
  server: string;
  enabled: boolean;
  requireRealAccount: boolean;
  symbolAliases: string;
}

const emptyForm: AccountForm = {
  label: '', login: '', password: '', server: '', enabled: true,
  requireRealAccount: false, symbolAliases: '',
};

interface CTraderConnectionInfo {
  ctidTraderAccountId: string;
  isLive: boolean;
  brokerTitle: string;
  traderLogin: string;
  connectedAt: string;
}

interface CTraderAccountOption {
  ctidTraderAccountId: string;
  isLive: boolean;
  brokerTitle: string;
  traderLogin: string;
  alreadyConnected: boolean;
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Not yet';
}

function statusCopy(account: TradingAccount) {
  if (!account.enabled) return { label: 'Disabled', icon: WifiOff };
  if (account.lastStatus === 'connected') return { label: 'Connected', icon: CheckCircle2 };
  if (account.lastStatus === 'error') return { label: 'Needs attention', icon: AlertCircle };
  return { label: 'Waiting for agent', icon: RefreshCw };
}

export default function TradingAccountsPage() {
  const [accounts, setAccounts] = useState<TradingAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState<AccountForm>(emptyForm);

  const token = () => localStorage.getItem('token');

  // ── Personal MT5 sync-agent secret ───────────────────────────────────────
  // Each user has their own secret (issued at signup) that their local
  // sync.py uses to authenticate as them specifically. It's never readable
  // after issuance -- only rotate returns the plaintext, once, same as the
  // investor password below.
  const [syncSecretReveal, setSyncSecretReveal] = useState<string | null>(null);
  const [syncSecretBusy, setSyncSecretBusy] = useState(false);
  const [syncSecretCopied, setSyncSecretCopied] = useState(false);
  const [syncSecretError, setSyncSecretError] = useState('');

  async function rotateSyncSecret() {
    setSyncSecretBusy(true); setSyncSecretError('');
    try {
      const response = await fetch('/api/auth/sync-secret/rotate', { method: 'POST', headers: { Authorization: `Bearer ${token()}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not generate a sync secret.');
      setSyncSecretReveal(body.syncSecret);
    } catch (caught) {
      setSyncSecretError(caught instanceof Error ? caught.message : 'Could not generate a sync secret.');
    } finally {
      setSyncSecretBusy(false);
    }
  }

  async function copySyncSecret() {
    if (!syncSecretReveal) return;
    try {
      await navigator.clipboard.writeText(syncSecretReveal);
      setSyncSecretCopied(true);
      setTimeout(() => setSyncSecretCopied(false), 1800);
    } catch {
      // Clipboard API can be unavailable -- the value is still visible/selectable.
    }
  }

  // ── cTrader connections (candle source for Trade Replay + trade sync) ───
  // An owner can hold several cTrader connections at once, even under
  // different cTrader logins (e.g. one under their own name, another under a
  // partner's), so this is a list rather than a single status object.
  const [ctraderConnections, setCtraderConnections] = useState<CTraderConnectionInfo[]>([]);
  const [ctraderLoading, setCtraderLoading] = useState(true);
  const [ctraderError, setCtraderError] = useState('');
  const [ctraderNotice, setCtraderNotice] = useState('');
  const [ctraderAccountOptions, setCtraderAccountOptions] = useState<CTraderAccountOption[]>([]);
  const [ctraderSelectedOptionIds, setCtraderSelectedOptionIds] = useState<string[]>([]);
  const [ctraderConnecting, setCtraderConnecting] = useState(false);
  const [ctraderSyncingId, setCtraderSyncingId] = useState<string | null>(null);
  const [ctraderLastSync, setCtraderLastSync] = useState<Record<string, { at: string; summary: string }>>({});

  const loadCtraderStatus = useCallback(async () => {
    setCtraderLoading(true);
    try {
      const response = await fetch('/api/ctrader/status', { headers: { Authorization: `Bearer ${token()}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load cTrader connection status.');
      setCtraderConnections(body.connections || []);
    } catch (caught) {
      setCtraderError(caught instanceof Error ? caught.message : 'Could not load cTrader connection status.');
    } finally {
      setCtraderLoading(false);
    }
  }, []);

  useEffect(() => { void loadCtraderStatus(); }, [loadCtraderStatus]);

  // cTrader redirects back here with ?code=... after the owner authorizes.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return;
    window.history.replaceState({}, '', window.location.pathname);
    (async () => {
      setCtraderConnecting(true);
      setCtraderError('');
      setCtraderNotice('');
      try {
        const response = await fetch('/api/ctrader/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
          body: JSON.stringify({ code }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not complete the cTrader authorization.');
        const options: CTraderAccountOption[] = body.accounts || [];
        setCtraderAccountOptions(options);
        setCtraderSelectedOptionIds(options.filter(o => !o.alreadyConnected).map(o => o.ctidTraderAccountId));
      } catch (caught) {
        setCtraderError(caught instanceof Error ? caught.message : 'Could not complete the cTrader authorization.');
      } finally {
        setCtraderConnecting(false);
      }
    })();
  }, []);

  async function connectCtrader() {
    setCtraderError('');
    try {
      const response = await fetch('/api/ctrader/auth-url', { headers: { Authorization: `Bearer ${token()}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not start cTrader authorization.');
      window.location.href = body.url;
    } catch (caught) {
      setCtraderError(caught instanceof Error ? caught.message : 'Could not start cTrader authorization.');
    }
  }

  function toggleCtraderOption(id: string) {
    setCtraderSelectedOptionIds(current => current.includes(id) ? current.filter(x => x !== id) : [...current, id]);
  }

  async function confirmCtraderAccounts() {
    if (ctraderSelectedOptionIds.length === 0) return;
    setCtraderError('');
    try {
      const response = await fetch('/api/ctrader/select-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ ctidTraderAccountIds: ctraderSelectedOptionIds }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not connect the selected cTrader accounts.');
      setCtraderConnections(body.connections || []);
      setCtraderAccountOptions([]);
      setCtraderSelectedOptionIds([]);
      setCtraderNotice(`Connected ${ctraderSelectedOptionIds.length} cTrader account${ctraderSelectedOptionIds.length === 1 ? '' : 's'}.`);
    } catch (caught) {
      setCtraderError(caught instanceof Error ? caught.message : 'Could not connect the selected cTrader accounts.');
    }
  }

  async function disconnectCtrader(connection: CTraderConnectionInfo) {
    if (!confirm(`Disconnect ${connection.brokerTitle || 'this cTrader account'} (login ${connection.traderLogin})? Its already-synced trades stay in the journal, but Replay and new syncing stop until you reconnect.`)) return;
    setCtraderError('');
    try {
      const response = await fetch(`/api/ctrader/connection/${encodeURIComponent(connection.ctidTraderAccountId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not disconnect cTrader.');
      setCtraderConnections(current => current.filter(c => c.ctidTraderAccountId !== connection.ctidTraderAccountId));
      setCtraderNotice('cTrader account disconnected.');
    } catch (caught) {
      setCtraderError(caught instanceof Error ? caught.message : 'Could not disconnect cTrader.');
    }
  }

  async function syncCtrader(ctidTraderAccountId: string) {
    setCtraderError(''); setCtraderNotice(''); setCtraderSyncingId(ctidTraderAccountId);
    try {
      const response = await fetch(`/api/ctrader/sync/${encodeURIComponent(ctidTraderAccountId)}`, { method: 'POST', headers: { Authorization: `Bearer ${token()}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not sync cTrader trades.');
      const account = body.accounts?.[0];
      if (account?.error) throw new Error(account.error);
      const summary = `${body.inserted} new trade${body.inserted === 1 ? '' : 's'}${body.skipped ? ` (${body.skipped} already synced)` : ''} · ${body.cashFlowInserted} new deposit/withdrawal${body.cashFlowInserted === 1 ? '' : 's'}`;
      setCtraderLastSync(current => ({ ...current, [ctidTraderAccountId]: { at: new Date().toISOString(), summary } }));
      setCtraderNotice(`Synced: ${summary}.`);
      // A first sync creates this account's row (and its Trades count) in
      // "Your accounts" -- refresh so it shows up without a manual reload.
      void loadAccounts();
    } catch (caught) {
      setCtraderError(caught instanceof Error ? caught.message : 'Could not sync cTrader trades.');
    } finally {
      setCtraderSyncingId(null);
    }
  }

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/trading-accounts', { headers: { Authorization: `Bearer ${token()}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load trading accounts.');
      setAccounts(body.accounts || []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load trading accounts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadAccounts(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAccounts]);

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setAdvancedOpen(false);
    setShowPassword(false);
    setFormOpen(true);
    setError('');
  }

  function startEdit(account: TradingAccount) {
    setEditingId(account.id);
    setForm({
      label: account.label, login: '', password: '', server: '', enabled: account.enabled,
      requireRealAccount: account.requireRealAccount, symbolAliases: account.symbolAliases || '',
    });
    setAdvancedOpen(Boolean(account.symbolAliases));
    setShowPassword(false);
    setFormOpen(true);
    setError('');
  }

  async function saveAccount(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(editingId ? `/api/trading-accounts/${editingId}` : '/api/trading-accounts', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify(form),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not save trading account.');
      setNotice(editingId ? 'Account updated. The agent will verify changed credentials.' : 'Account saved. Keep the MT5 agent running to verify it.');
      setFormOpen(false);
      await loadAccounts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save trading account.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleAccount(account: TradingAccount) {
    setError('');
    const response = await fetch(`/api/trading-accounts/${account.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ label: account.label, enabled: !account.enabled }),
    });
    const body = await response.json();
    if (!response.ok) return setError(body.error || 'Could not update account.');
    await loadAccounts();
  }

  async function archiveAccount(account: TradingAccount) {
    if (!confirm(`Archive “${account.label}”? Its ${account.tradeCount} historical trades will remain unchanged.`)) return;
    const response = await fetch(`/api/trading-accounts/${account.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token()}` },
    });
    const body = await response.json();
    if (!response.ok) return setError(body.error || 'Could not archive account.');
    setNotice('Account archived. Historical trades still keep their account link.');
    await loadAccounts();
  }

  // ── Investor access (read-only, no-login view for someone you share
  // results with) — modeled on MT5's own investor password: one stable
  // account number (code) plus a password that can only be rotated, never
  // recovered, and that's shown here exactly once. ────────────────────────
  const [investorOpenId, setInvestorOpenId] = useState<string | null>(null);
  const [investorBusyId, setInvestorBusyId] = useState<string | null>(null);
  const [investorReveal, setInvestorReveal] = useState<{ accountId: string; code: string; password: string } | null>(null);
  const [investorCopyState, setInvestorCopyState] = useState<'link' | 'password' | null>(null);

  async function enableOrRotateInvestor(account: TradingAccount) {
    setError(''); setInvestorBusyId(account.id);
    try {
      const response = await fetch(`/api/trading-accounts/${account.id}/investor-access`, {
        method: 'POST', headers: { Authorization: `Bearer ${token()}` },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not enable investor access.');
      setInvestorReveal({ accountId: account.id, code: body.code, password: body.password });
      await loadAccounts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not enable investor access.');
    } finally {
      setInvestorBusyId(null);
    }
  }

  async function disableInvestor(account: TradingAccount) {
    if (!confirm(`Revoke investor access for "${account.label}"? Whoever has the link and password will immediately lose view access.`)) return;
    setError(''); setInvestorBusyId(account.id);
    try {
      const response = await fetch(`/api/trading-accounts/${account.id}/investor-access`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token()}` },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not revoke investor access.');
      if (investorReveal?.accountId === account.id) setInvestorReveal(null);
      setNotice('Investor access revoked.');
      await loadAccounts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not revoke investor access.');
    } finally {
      setInvestorBusyId(null);
    }
  }

  function investorLoginUrl(code: string) {
    return `${window.location.origin}/investor/login?code=${code}`;
  }

  async function copyInvestorText(text: string, kind: 'link' | 'password') {
    try {
      await navigator.clipboard.writeText(text);
      setInvestorCopyState(kind);
      setTimeout(() => setInvestorCopyState(current => current === kind ? null : current), 1800);
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context) -- the
      // value is still selectable/visible in the field, so this is non-fatal.
    }
  }

  return (
    <main className="page-content account-page">
      <header className="account-page-head">
        <div>
          <div className="account-title-line"><Landmark size={27} /><h1>Trading Accounts</h1></div>
          <p>Connect MT5 and cTrader accounts and keep every trade tied to the account that produced it.</p>
        </div>
        <button className="btn-primary account-add-button" onClick={startCreate}><Plus size={17} /> Add account</button>
      </header>

      <section className="account-security-note" aria-label="Credential security">
        <ShieldCheck size={21} />
        <div><strong>Credentials are encrypted before storage.</strong><span>Login, password and broker server are never returned to this browser. The local MT5 agent receives them through its authenticated connection only.</span></div>
      </section>

      <section className="account-security-note" aria-label="MT5 sync secret" style={{ flexWrap: 'wrap' }}>
        <TerminalSquare size={21} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <strong>Your personal MT5 sync secret.</strong>
          <span>This is your own installation's key for the local <code>sync.py</code> worker — it only ever syncs trades into your account, never anyone else's. Copy it into that machine's <code>.env</code> as <code>SYNC_SECRET</code>.</span>
          {syncSecretError && <div className="account-alert error" role="alert" style={{ marginTop: 8 }}><AlertCircle size={14} />{syncSecretError}</div>}
          {syncSecretReveal ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 700, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', wordBreak: 'break-all' }}>{syncSecretReveal}</code>
              <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 9px' }} onClick={copySyncSecret}>
                {syncSecretCopied ? <Check size={12} /> : <Copy size={12} />} {syncSecretCopied ? 'Copied' : 'Copy'}
              </button>
              <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 9px' }} onClick={() => setSyncSecretReveal(null)}>I've saved it</button>
            </div>
          ) : (
            <button className="btn-ghost" style={{ fontSize: 12, marginTop: 10 }} disabled={syncSecretBusy} onClick={rotateSyncSecret}>
              {syncSecretBusy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Generate / rotate my sync secret
            </button>
          )}
        </div>
      </section>

      {error && <div className="account-alert error" role="alert"><AlertCircle size={17} />{error}</div>}
      {notice && <div className="account-alert success" aria-live="polite"><CheckCircle2 size={17} />{notice}</div>}

      {formOpen && (
        <section className="account-editor" aria-labelledby="account-editor-title">
          <div className="account-editor-head">
            <div><h2 id="account-editor-title">{editingId ? 'Edit trading account' : 'Add an MT5 account'}</h2><p>{editingId ? 'Leave credential fields empty to keep the encrypted values already stored.' : 'Use the exact login and server shown inside your broker terminal.'}</p></div>
            <button className="btn-ghost" type="button" onClick={() => setFormOpen(false)}>Cancel</button>
          </div>
          <form onSubmit={saveAccount}>
            <div className="account-form-grid">
              <label><span>Account label *</span><input required maxLength={80} value={form.label} onChange={event => setForm({ ...form, label: event.target.value })} placeholder="e.g. Exness main account" /></label>
              <label><span>MT5 login {editingId ? '' : '*'}</span><input required={!editingId} inputMode="numeric" autoComplete="off" value={form.login} onChange={event => setForm({ ...form, login: event.target.value.replace(/\D/g, '') })} placeholder={editingId ? 'Unchanged' : 'Account number'} /></label>
              <label><span>Broker server {editingId ? '' : '*'}</span><div className="account-input-icon"><Server size={16} /><input required={!editingId} autoComplete="off" value={form.server} onChange={event => setForm({ ...form, server: event.target.value })} placeholder={editingId ? 'Unchanged' : 'e.g. Broker-MT5Real'} /></div></label>
              <label><span>MT5 password {editingId ? '' : '*'}</span><div className="account-input-icon"><KeyRound size={16} /><input required={!editingId} type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} placeholder={editingId ? 'Unchanged' : 'Trading password'} /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
            </div>
            <div className="account-toggle-row">
              <label className="account-switch"><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} /><span />Sync this account</label>
              <label className="account-switch"><input type="checkbox" checked={form.requireRealAccount} onChange={event => setForm({ ...form, requireRealAccount: event.target.checked })} /><span />Reject demo logins</label>
            </div>
            <button className="account-advanced-toggle" type="button" onClick={() => setAdvancedOpen(value => !value)} aria-expanded={advancedOpen}><ChevronDown size={16} className={advancedOpen ? 'open' : ''} /> Advanced symbol mapping</button>
            {advancedOpen && <label className="account-alias-field"><span>Symbol aliases</span><textarea rows={3} value={form.symbolAliases} onChange={event => setForm({ ...form, symbolAliases: event.target.value })} placeholder="XAUUSD:XAUUSDm, USTEC:USTECm" /><small>Optional comma-separated journal-symbol:broker-symbol pairs.</small></label>}
            <div className="account-form-actions"><button type="button" className="btn-ghost" onClick={() => setFormOpen(false)}>Cancel</button><button className="btn-primary" disabled={saving}>{saving ? <Loader2 size={17} className="spin" /> : <LockKeyhole size={17} />}{saving ? 'Encrypting…' : editingId ? 'Save changes' : 'Encrypt & save account'}</button></div>
          </form>
        </section>
      )}

      <section className="account-list-head"><div><h2>Your accounts</h2><p>{accounts.length} configured · {accounts.filter(account => account.enabled).length} enabled</p></div><button className="btn-ghost" onClick={loadAccounts} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh</button></section>

      {loading && accounts.length === 0 ? <div className="account-empty"><Loader2 className="spin" /><strong>Loading trading accounts…</strong></div> : accounts.length === 0 ? (
        <div className="account-empty"><Landmark size={32} /><strong>No trading accounts yet</strong><p>Add your first MT5 account. The local agent will test it and begin importing its trades.</p><button className="btn-primary" onClick={startCreate}><Plus size={17} /> Add first account</button></div>
      ) : (
        <div className="account-card-grid">
          {accounts.map(account => {
            const status = statusCopy(account); const StatusIcon = status.icon;
            const isCtrader = account.provider === 'ctrader';
            return <article className="account-card" key={account.id}>
              <div className="account-card-top"><div className="account-provider-icon">{isCtrader ? <Video size={19} /> : <Landmark size={19} />}</div><div className="account-card-name"><h3>{account.label}</h3><span>{isCtrader ? 'cTrader Open API · OAuth' : 'MetaTrader 5'} · {account.actualAccountType || 'type pending'}</span></div><span className={`account-status ${account.lastStatus}`}><StatusIcon size={13} />{status.label}</span></div>
              {account.lastError && <div className="account-card-error"><AlertCircle size={14} />{account.lastError}</div>}
              <dl className="account-metrics"><div><dt>Trades</dt><dd>{account.tradeCount}</dd></div><div><dt>Balance</dt><dd>{account.lastBalance == null ? '—' : `$${account.lastBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}</dd></div><div><dt>Last sync</dt><dd>{formatDate(account.lastSyncAt)}</dd></div>{!isCtrader && <div><dt>Agent seen</dt><dd>{formatDate(account.lastAgentSeenAt)}</dd></div>}</dl>
              <div className="account-card-foot">
                <label className="account-switch"><input type="checkbox" checked={account.enabled} onChange={() => toggleAccount(account)} /><span />{account.enabled ? 'Sync enabled' : 'Sync disabled'}</label>
                <div>
                  {isCtrader
                    ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }} title="This account is authorized via OAuth in the cTrader section below — there's no login to edit.">Managed via cTrader connection below</span>
                    : <button onClick={() => startEdit(account)} aria-label={`Edit ${account.label}`}><Pencil size={15} /> Edit</button>}
                  <button onClick={() => setInvestorOpenId(current => current === account.id ? null : account.id)} aria-expanded={investorOpenId === account.id} aria-label={`Investor access for ${account.label}`}>
                    <Users size={15} /> Investor{account.investor.enabled ? ' · on' : ''}
                  </button>
                  <button className="danger" onClick={() => archiveAccount(account)} aria-label={`Archive ${account.label}`}><Trash2 size={15} /> Archive</button>
                </div>
              </div>

              {investorOpenId === account.id && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <p style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    Read-only view for someone you share results with — no account of theirs, no login on this app. Works like an MT5 investor password: one account number, one password, no edit access, and you can revoke it instantly.
                  </p>

                  {account.investor.enabled ? (
                    <>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Account number</span>
                        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px' }}>{account.investor.code}</code>
                        <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 9px' }} onClick={() => copyInvestorText(investorLoginUrl(account.investor.code || ''), 'link')}>
                          <Copy size={12} /> {investorCopyState === 'link' && investorReveal?.accountId !== account.id ? 'Copied!' : 'Copy investor link'}
                        </button>
                      </div>
                      {account.investor.lastViewedAt && (
                        <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>Last viewed {formatDate(account.investor.lastViewedAt)}</span>
                      )}
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn-ghost" style={{ fontSize: 12 }} disabled={investorBusyId === account.id} onClick={() => enableOrRotateInvestor(account)}>
                          {investorBusyId === account.id ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />} Rotate password
                        </button>
                        <button className="danger" style={{ fontSize: 12 }} disabled={investorBusyId === account.id} onClick={() => disableInvestor(account)}>
                          <ShieldOff size={14} /> Revoke access
                        </button>
                      </div>
                    </>
                  ) : (
                    <button className="btn-primary" style={{ fontSize: 12, alignSelf: 'flex-start' }} disabled={investorBusyId === account.id} onClick={() => enableOrRotateInvestor(account)}>
                      {investorBusyId === account.id ? <Loader2 size={14} className="spin" /> : <Users size={14} />} Enable investor access
                    </button>
                  )}

                  {investorReveal?.accountId === account.id && (
                    <div style={{ background: 'var(--amber-bg, rgba(212,175,55,0.12))', border: '1px solid var(--gold, #d4af37)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <strong style={{ fontSize: 11.5 }}>Save this now — the password won't be shown again</strong>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Password</span>
                        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px' }}>{investorReveal.password}</code>
                        <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 9px' }} onClick={() => copyInvestorText(investorReveal.password, 'password')}>
                          <Copy size={12} /> {investorCopyState === 'password' ? 'Copied!' : 'Copy password'}
                        </button>
                      </div>
                      <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                        Send the investor this link, then the password separately: {investorLoginUrl(investorReveal.code)}
                      </span>
                      <button className="btn-ghost" style={{ fontSize: 11, alignSelf: 'flex-start' }} onClick={() => setInvestorReveal(null)}>I've saved it</button>
                    </div>
                  )}
                </div>
              )}
            </article>;
          })}
        </div>
      )}

      <section className="account-list-head" style={{ marginTop: 32 }}>
        <div>
          <div className="account-title-line"><Video size={22} /><h2>cTrader</h2></div>
          <p>Supplies Trade Replay's candles, and can sync your cTrader trade history and cash flow into the journal alongside MT5.</p>
        </div>
      </section>

      {ctraderError && <div className="account-alert error" role="alert"><AlertCircle size={17} />{ctraderError}</div>}
      {ctraderNotice && <div className="account-alert success" aria-live="polite"><CheckCircle2 size={17} />{ctraderNotice}</div>}

      {ctraderAccountOptions.length > 0 ? (
        <div className="account-empty">
          <PlugZap size={28} />
          <strong>Choose which cTrader account(s) to connect</strong>
          <p>This authorization can reach more than one account. Pick every one you want candles and trade sync for — already-connected accounts are shown but locked in.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 420 }}>
            {ctraderAccountOptions.map(option => (
              <label
                key={option.ctidTraderAccountId}
                className="btn-ghost"
                style={{ justifyContent: 'space-between', display: 'flex', width: '100%', cursor: option.alreadyConnected ? 'default' : 'pointer', opacity: option.alreadyConnected ? 0.6 : 1 }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={option.alreadyConnected || ctraderSelectedOptionIds.includes(option.ctidTraderAccountId)}
                    disabled={option.alreadyConnected}
                    onChange={() => toggleCtraderOption(option.ctidTraderAccountId)}
                  />
                  {option.brokerTitle || 'cTrader account'} · login {option.traderLogin}{option.alreadyConnected ? ' · already connected' : ''}
                </span>
                <span>{option.isLive ? 'Live' : 'Demo'}</span>
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-ghost" onClick={() => { setCtraderAccountOptions([]); setCtraderSelectedOptionIds([]); }}>Cancel</button>
            <button className="btn-primary" onClick={confirmCtraderAccounts} disabled={ctraderSelectedOptionIds.length === 0}>
              Connect {ctraderSelectedOptionIds.length || ''} account{ctraderSelectedOptionIds.length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      ) : ctraderLoading ? (
        <div className="account-empty"><Loader2 className="spin" /><strong>Checking cTrader connection…</strong></div>
      ) : ctraderConnections.length > 0 ? (
        <div className="account-card-grid">
          {ctraderConnections.map(connection => {
            const syncing = ctraderSyncingId === connection.ctidTraderAccountId;
            const sessionSync = ctraderLastSync[connection.ctidTraderAccountId];
            // The matching TradingAccount row is the durable record of when
            // this account last synced -- ctraderLastSync only knows about a
            // sync that happened in this browser tab since the page loaded.
            const matchingAccount = accounts.find(a => a.accountKey === `ctrader:${connection.ctidTraderAccountId}`);
            const lastSyncAt = sessionSync?.at || matchingAccount?.lastSyncAt || null;
            const tradeCount = matchingAccount?.tradeCount ?? 0;
            return (
              <article className="account-card" key={connection.ctidTraderAccountId}>
                <div className="account-card-top">
                  <div className="account-provider-icon"><Video size={19} /></div>
                  <div className="account-card-name"><h3>{connection.brokerTitle || 'cTrader'}</h3><span>cTrader Open API · {connection.isLive ? 'Live' : 'Demo'}</span></div>
                  <span className="account-status connected"><CheckCircle2 size={13} />Connected</span>
                </div>
                <dl className="account-metrics">
                  <div><dt>Login</dt><dd>{connection.traderLogin || '—'}</dd></div>
                  <div><dt>Trades</dt><dd>{matchingAccount ? tradeCount : '—'}</dd></div>
                  <div><dt>Last trade sync</dt><dd>{formatDate(lastSyncAt)}</dd></div>
                </dl>
                {sessionSync && <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>{sessionSync.summary}</p>}
                {matchingAccount && tradeCount === 0 && !syncing && (
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 12px' }}>Synced, but this account has no closed trades yet — it won&apos;t appear in the Account filter until it does.</p>
                )}
                <div className="account-card-foot">
                  <button className="btn-ghost" onClick={() => syncCtrader(connection.ctidTraderAccountId)} disabled={syncing} title="Pull new trades and deposits/withdrawals from cTrader into the journal">
                    {syncing ? <Loader2 size={15} className="spin" /> : <DownloadCloud size={15} />}
                    {syncing ? 'Syncing…' : 'Sync Now'}
                  </button>
                  <div><button className="danger" onClick={() => disconnectCtrader(connection)}><Unlink size={15} /> Disconnect</button></div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="account-empty">
          <Video size={32} />
          <strong>cTrader is not connected</strong>
          <p>Connect a cTrader Open API app to power Trade Replay's chart data and sync trade history. Register one at openapi.ctrader.com if you haven't already.</p>
          <button className="btn-primary" onClick={connectCtrader} disabled={ctraderConnecting}>
            {ctraderConnecting ? <Loader2 size={17} className="spin" /> : <PlugZap size={17} />}
            {ctraderConnecting ? 'Connecting…' : 'Connect cTrader'}
          </button>
        </div>
      )}
      {!ctraderLoading && ctraderConnections.length > 0 && ctraderAccountOptions.length === 0 && (
        <button className="btn-ghost" style={{ marginTop: 12 }} onClick={connectCtrader} disabled={ctraderConnecting}>
          {ctraderConnecting ? <Loader2 size={15} className="spin" /> : <PlugZap size={15} />}
          {ctraderConnecting ? 'Connecting…' : 'Connect another cTrader account'}
        </button>
      )}
    </main>
  );
}
