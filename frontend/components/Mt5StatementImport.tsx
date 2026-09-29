'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, FileUp, Loader2, X } from 'lucide-react';

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface Target { id: string; label: string; provider: string }
interface Summary {
  account: { login: string; server: string; currency: string; accountType: string; name: string; company: string } | null;
  period: { from: string; to: string } | null;
  positions: number; newTrades: number; alreadyInJournal: number;
  cashMovements: number; newCashMovements: number;
  matchedAccount: Target | null; target: Target;
  inserted?: number; eventsInserted?: number;
}
interface AccountOption { id: string; label: string; provider: string }

/** MT5 saves reports as UTF-16 (with a byte-order mark); older ones as UTF-8. */
async function readReport(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) throw new Error('That\'s the Excel version of the report. In MT5 save the report as HTML instead (Report → HTML).');
  const utf16le = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes.length > 3 && bytes[1] === 0 && bytes[3] === 0);
  const utf16be = bytes[0] === 0xfe && bytes[1] === 0xff;
  return new TextDecoder(utf16le ? 'utf-16le' : utf16be ? 'utf-16be' : 'utf-8').decode(bytes);
}

const fmtDate = (s: string) => new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * Import trades from an MT5 report (History → Report → HTML): for MT5 on a
 * Mac, or anyone not running the Windows sync app. Shows what's new first,
 * then adds it; trades already in the journal are left as they are.
 */
export default function Mt5StatementImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [target, setTarget] = useState('auto');
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [busy, setBusy] = useState<'read' | 'import' | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Summary | null>(null);

  useEffect(() => {
    fetch('/api/trading-accounts', { headers: authHeaders() })
      .then(r => (r.ok ? r.json() : { accounts: [] }))
      .then(d => setAccounts((d.accounts || []).filter((a: AccountOption) => a.provider !== 'ctrader')))
      .catch(() => {});
  }, []);

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch('/api/trades/import/mt5-statement', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not read this report');
    return data as Summary;
  };

  async function pick(file: File) {
    setBusy('read'); setError(''); setSummary(null); setResult(null); setFileName(file.name);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('That file is over 20 MB. Save a shorter period in MT5 and import it in parts.');
      const text = await readReport(file);
      setContent(text);
      const s = await post({ content: text, target: 'auto' });
      setSummary(s);
      setTarget(s.matchedAccount ? s.matchedAccount.id : 'new');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read this report');
    } finally { setBusy(null); }
  }

  async function changeTarget(next: string) {
    setTarget(next);
    if (!content) return;
    setBusy('read'); setError('');
    try { setSummary(await post({ content, target: next })); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not read this report'); }
    finally { setBusy(null); }
  }

  async function runImport() {
    setBusy('import'); setError('');
    try {
      const r = await post({ content, target, commit: true });
      setResult(r);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import this report');
    } finally { setBusy(null); }
  }

  const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 };
  const field: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 13 };
  const newLabel = summary?.account ? `New account: MT5 ${summary.account.login}${summary.account.server ? ` · ${summary.account.server}` : ''}` : 'New account';

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" style={{ width: 480 }} onClick={e => e.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><FileUp size={16} /> Import MT5 statement</h3>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>For MT5 on a Mac, or without the Windows sync app</span>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="drawer-body" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            <li>In MT5, open the <b>History</b> tab (View → Toolbox on a Mac).</li>
            <li>Right-click it → <b>Custom Period</b>, and pick the dates you want (or <b>All History</b>).</li>
            <li>Right-click again → <b>Report</b> → <b>HTML</b>, and save the file.</li>
            <li>Upload it here. Trades already in your journal are skipped, so importing again later is safe.</li>
          </ol>

          <input ref={fileRef} type="file" accept=".htm,.html,text/html" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pick(f); }} />
          <button className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => fileRef.current?.click()} disabled={busy !== null}>
            {busy === 'read' && !summary ? <Loader2 size={14} className="spin" /> : <FileUp size={14} />} {fileName ? 'Choose another file' : 'Choose report file'}
          </button>
          {fileName && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: -8 }}>{fileName}</div>}

          {summary && !result && (
            <>
              <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, display: 'grid', gap: 6, fontSize: 12.5, color: 'var(--text-secondary)' }}>
                {summary.account && (
                  <div><b style={{ color: 'var(--text-primary)' }}>MT5 {summary.account.login}</b>{summary.account.server ? ` · ${summary.account.server}` : ''}{summary.account.accountType ? ` · ${summary.account.accountType}` : ''}{summary.account.currency ? ` · ${summary.account.currency}` : ''}</div>
                )}
                {summary.period && <div>Trades closed {fmtDate(summary.period.from)} – {fmtDate(summary.period.to)}</div>}
                <div>
                  <b style={{ color: 'var(--text-primary)' }}>{summary.newTrades.toLocaleString()} new</b> of {summary.positions.toLocaleString()} closed positions
                  {summary.alreadyInJournal ? ` · ${summary.alreadyInJournal.toLocaleString()} already in your journal` : ''}
                </div>
                {summary.cashMovements > 0 && <div>{summary.newCashMovements} new {summary.newCashMovements === 1 ? 'deposit or withdrawal' : 'deposits and withdrawals'}</div>}
              </div>

              <div>
                <label style={label} htmlFor="mt5-import-account">Add them to</label>
                <select id="mt5-import-account" style={field} value={target} onChange={e => changeTarget(e.target.value)} disabled={busy !== null}>
                  <option value="new">{newLabel}</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.label}{a.provider === 'mt5_import' ? ' (imported)' : ' (synced MT5)'}{summary.matchedAccount?.id === a.id ? ' · matches this report' : ''}</option>)}
                </select>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  {summary.matchedAccount ? 'Matched by the account number in the report.' : 'No account with this number yet, so a new one is created. It shows under Accounts and in the account filter.'}
                </div>
              </div>

              <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={runImport} disabled={busy !== null || (summary.newTrades === 0 && summary.newCashMovements === 0)}>
                {busy === 'import' ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                {summary.newTrades === 0 && summary.newCashMovements === 0 ? 'Nothing new to import' : `Import ${summary.newTrades.toLocaleString()} trade${summary.newTrades === 1 ? '' : 's'}`}
              </button>
            </>
          )}

          {result && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', color: 'var(--green)', fontSize: 12.5, lineHeight: 1.5 }} role="status">
              <Check size={15} style={{ flex: 'none', marginTop: 2 }} />
              <span>
                Imported {result.inserted?.toLocaleString()} trade{result.inserted === 1 ? '' : 's'}{result.eventsInserted ? ` and ${result.eventsInserted} ${result.eventsInserted === 1 ? 'deposit or withdrawal' : 'deposits and withdrawals'}` : ''} into <b>{result.target.label}</b>.
                Journal them like any other trade. Stop loss and take profit are the levels at close, as MT5 reports them.
              </span>
            </div>
          )}

          {error && <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', color: 'var(--red)', fontSize: 12.5, lineHeight: 1.5 }} role="alert"><AlertCircle size={15} style={{ flex: 'none', marginTop: 2 }} /> {error}</div>}

          <p style={{ margin: 0, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Each position becomes one trade, even if you closed it in parts. The file is read to add your trades and isn&apos;t kept.
          </p>
        </div>
      </div>
    </div>
  );
}
