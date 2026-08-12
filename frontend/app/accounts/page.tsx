'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import {
  AlertCircle, CheckCircle2, ChevronDown, Eye, EyeOff, KeyRound,
  Landmark, Loader2, LockKeyhole, Pencil, Plus, RefreshCw, Server,
  ShieldCheck, Trash2, WifiOff,
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
    </main>
  );
}
