'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import {
  AlertCircle, CheckCircle2, ChevronDown, Eye, EyeOff, KeyRound,
  Landmark, Loader2, LockKeyhole, Pencil, Plus, RefreshCw, Server,
  ShieldCheck, Trash2, WifiOff, PlugZap, Unlink, Video, DownloadCloud,
} from 'lucide-react';

type AccountStatus = 'pending' | 'connected' | 'error' | 'disabled';

interface TradingAccount {
  id: string;
  accountKey: string;
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

interface CTraderStatus {
  connected: boolean;
  databaseAvailable?: boolean;
  ctidTraderAccountId?: string;
  isLive?: boolean;
  brokerTitle?: string;
  traderLogin?: string;
  connectedAt?: string;
  hasSelectedAccount?: boolean;
}

interface CTraderAccountOption {
  ctidTraderAccountId: string;
  isLive: boolean;
  brokerTitle: string;
  traderLogin: string;
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

  // ── cTrader connection (Trade Replay candle source) ─────────────────────
  const [ctraderStatus, setCtraderStatus] = useState<CTraderStatus | null>(null);
  const [ctraderLoading, setCtraderLoading] = useState(true);
  const [ctraderError, setCtraderError] = useState('');
  const [ctraderNotice, setCtraderNotice] = useState('');
  const [ctraderAccountOptions, setCtraderAccountOptions] = useState<CTraderAccountOption[]>([]);
  const [ctraderConnecting, setCtraderConnecting] = useState(false);
  const [ctraderSyncing, setCtraderSyncing] = useState(false);
  const [ctraderLastSync, setCtraderLastSync] = useState<{ at: string; summary: string } | null>(null);

  const loadCtraderStatus = useCallback(async () => {
    setCtraderLoading(true);
    try {
      const response = await fetch('/api/ctrader/status', { headers: { Authorization: `Bearer ${token()}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load cTrader connection status.');
      setCtraderStatus(body);
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
        setCtraderStatus(body.connection);
        if (body.accounts?.length > 1 && !body.connection?.hasSelectedAccount) {
          setCtraderAccountOptions(body.accounts);
        } else {
          setCtraderNotice('cTrader connected. Trade Replay will now pull candles from it.');
        }
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

  async function selectCtraderAccount(option: CTraderAccountOption) {
    setCtraderError('');
    try {
      const response = await fetch('/api/ctrader/select-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify(option),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not select the cTrader account.');
      setCtraderStatus(body.connection);
      setCtraderAccountOptions([]);
      setCtraderNotice('cTrader account selected. Trade Replay will now pull candles from it.');
    } catch (caught) {
      setCtraderError(caught instanceof Error ? caught.message : 'Could not select the cTrader account.');
    }
  }

  async function disconnectCtrader() {
    if (!confirm('Disconnect cTrader? Trade Replay will stop working until you reconnect.')) return;
    setCtraderError('');
    try {
      const response = await fetch('/api/ctrader/connection', { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not disconnect cTrader.');
      setCtraderStatus({ connected: false });
      setCtraderNotice('cTrader disconnected.');
    } catch (caught) {
      setCtraderError(caught instanceof Error ? caught.message : 'Could not disconnect cTrader.');
    }
  }

  async function syncCtrader() {
    setCtraderError(''); setCtraderNotice(''); setCtraderSyncing(true);
    try {
      const response = await fetch('/api/ctrader/sync', { method: 'POST', headers: { Authorization: `Bearer ${token()}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not sync cTrader trades.');
      const summary = `${body.inserted} new trade${body.inserted === 1 ? '' : 's'}${body.skipped ? ` (${body.skipped} already synced)` : ''} · ${body.cashFlowInserted} new deposit/withdrawal${body.cashFlowInserted === 1 ? '' : 's'}`;
      setCtraderLastSync({ at: new Date().toISOString(), summary });
      setCtraderNotice(`Synced: ${summary}.`);
    } catch (caught) {
      setCtraderError(caught instanceof Error ? caught.message : 'Could not sync cTrader trades.');
    } finally {
      setCtraderSyncing(false);
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

  return (
    <main className="page-content account-page">
      <header className="account-page-head">
        <div>
          <div className="account-title-line"><Landmark size={27} /><h1>Trading Accounts</h1></div>
          <p>Connect multiple MT5 accounts and keep every trade tied to the account that produced it.</p>
        </div>
        <button className="btn-primary account-add-button" onClick={startCreate}><Plus size={17} /> Add account</button>
      </header>

      <section className="account-security-note" aria-label="Credential security">
        <ShieldCheck size={21} />
        <div><strong>Credentials are encrypted before storage.</strong><span>Login, password and broker server are never returned to this browser. The local MT5 agent receives them through its authenticated connection only.</span></div>
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
            return <article className="account-card" key={account.id}>
              <div className="account-card-top"><div className="account-provider-icon"><Landmark size={19} /></div><div className="account-card-name"><h3>{account.label}</h3><span>MetaTrader 5 · {account.actualAccountType || 'type pending'}</span></div><span className={`account-status ${account.lastStatus}`}><StatusIcon size={13} />{status.label}</span></div>
              {account.lastError && <div className="account-card-error"><AlertCircle size={14} />{account.lastError}</div>}
              <dl className="account-metrics"><div><dt>Trades</dt><dd>{account.tradeCount}</dd></div><div><dt>Balance</dt><dd>{account.lastBalance == null ? '—' : `$${account.lastBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}</dd></div><div><dt>Last sync</dt><dd>{formatDate(account.lastSyncAt)}</dd></div><div><dt>Agent seen</dt><dd>{formatDate(account.lastAgentSeenAt)}</dd></div></dl>
              <div className="account-card-foot"><label className="account-switch"><input type="checkbox" checked={account.enabled} onChange={() => toggleAccount(account)} /><span />{account.enabled ? 'Sync enabled' : 'Sync disabled'}</label><div><button onClick={() => startEdit(account)} aria-label={`Edit ${account.label}`}><Pencil size={15} /> Edit</button><button className="danger" onClick={() => archiveAccount(account)} aria-label={`Archive ${account.label}`}><Trash2 size={15} /> Archive</button></div></div>
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
          <strong>Choose which cTrader account to use for Replay</strong>
          <p>This access token can reach more than one account. Pick the one whose candles you want in Trade Replay.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 420 }}>
            {ctraderAccountOptions.map(option => (
              <button
                key={option.ctidTraderAccountId}
                className="btn-ghost"
                style={{ justifyContent: 'space-between', display: 'flex', width: '100%' }}
                onClick={() => selectCtraderAccount(option)}
              >
                <span>{option.brokerTitle || 'cTrader account'} · login {option.traderLogin}</span>
                <span>{option.isLive ? 'Live' : 'Demo'}</span>
              </button>
            ))}
          </div>
        </div>
      ) : ctraderLoading ? (
        <div className="account-empty"><Loader2 className="spin" /><strong>Checking cTrader connection…</strong></div>
      ) : ctraderStatus?.connected ? (
        <div className="account-card-grid">
          <article className="account-card">
            <div className="account-card-top">
              <div className="account-provider-icon"><Video size={19} /></div>
              <div className="account-card-name"><h3>{ctraderStatus.brokerTitle || 'cTrader'}</h3><span>cTrader Open API · {ctraderStatus.isLive ? 'Live' : 'Demo'}</span></div>
              <span className="account-status connected"><CheckCircle2 size={13} />Connected</span>
            </div>
            <dl className="account-metrics">
              <div><dt>Login</dt><dd>{ctraderStatus.traderLogin || '—'}</dd></div>
              <div><dt>Connected</dt><dd>{formatDate(ctraderStatus.connectedAt || null)}</dd></div>
              <div><dt>Last trade sync</dt><dd>{ctraderLastSync ? formatDate(ctraderLastSync.at) : 'Not yet'}</dd></div>
            </dl>
            {ctraderLastSync && <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>{ctraderLastSync.summary}</p>}
            <div className="account-card-foot">
              <button className="btn-ghost" onClick={syncCtrader} disabled={ctraderSyncing} title="Pull new trades and deposits/withdrawals from cTrader into the journal">
                {ctraderSyncing ? <Loader2 size={15} className="spin" /> : <DownloadCloud size={15} />}
                {ctraderSyncing ? 'Syncing…' : 'Sync Now'}
              </button>
              <div><button className="danger" onClick={disconnectCtrader}><Unlink size={15} /> Disconnect</button></div>
            </div>
          </article>
        </div>
      ) : (
        <div className="account-empty">
          <Video size={32} />
          <strong>cTrader is not connected</strong>
          <p>Connect a cTrader Open API app to power Trade Replay's chart data. Register one at openapi.ctrader.com if you haven't already.</p>
          <button className="btn-primary" onClick={connectCtrader} disabled={ctraderConnecting}>
            {ctraderConnecting ? <Loader2 size={17} className="spin" /> : <PlugZap size={17} />}
            {ctraderConnecting ? 'Connecting…' : 'Connect cTrader'}
          </button>
        </div>
      )}
    </main>
  );
}
