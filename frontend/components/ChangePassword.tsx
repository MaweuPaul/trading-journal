'use client';
import { FormEvent, useState } from 'react';
import { AlertCircle, Check, KeyRound, Loader2 } from 'lucide-react';

/** Accounts page: change your login password while signed in. */
export default function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(''); setDone('');
    if (next !== confirm) { setError('The new passwords don’t match.'); return; }
    if (next.length < 8) { setError('Choose a new password of at least 8 characters.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not change the password.');
      localStorage.setItem('token', data.token); // this device stays signed in
      setCurrent(''); setNext(''); setConfirm('');
      setDone(data.message || 'Password changed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  }

  const field: React.CSSProperties = { flex: 1, minWidth: 180, minHeight: 40, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 13 };
  return (
    <>
      <section className="account-list-head" style={{ marginTop: 32 }}>
        <div>
          <div className="account-title-line"><KeyRound size={22} /><h2>Password</h2></div>
          <p>Change the password you sign in with. Other devices are signed out; this one stays signed in.</p>
        </div>
      </section>
      {error && <div className="account-alert error" role="alert"><AlertCircle size={17} />{error}</div>}
      {done && <div className="account-alert" role="status" style={{ color: 'var(--green)' }}><Check size={17} />{done}</div>}
      <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input type="password" aria-label="Current password" placeholder="Current password" value={current} onChange={e => setCurrent(e.target.value)} required autoComplete="current-password" style={field} />
        <input type="password" aria-label="New password" placeholder="New password (8+ characters)" value={next} onChange={e => setNext(e.target.value)} required minLength={8} autoComplete="new-password" style={field} />
        <input type="password" aria-label="Confirm new password" placeholder="Confirm new password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" style={field} />
        <button className="btn-primary" disabled={busy || !current || !next || !confirm}>{busy ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />} Change password</button>
      </form>
    </>
  );
}
