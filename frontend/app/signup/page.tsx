'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, Check, Copy, Loader2, Lock, Mail, TrendingUp, UserRound } from 'lucide-react';

const API = '/api';

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [databaseAvailable, setDatabaseAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [syncSecret, setSyncSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (localStorage.getItem('token')) { router.push('/'); return; }
    fetch(`${API}/auth/setup-status`)
      .then(response => response.json())
      .then(status => setDatabaseAvailable(Boolean(status.databaseAvailable)))
      .catch(() => { setDatabaseAvailable(false); setError('Could not contact the journal backend.'); });
  }, [router]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setLoading(true);
    try {
      const response = await fetch(`${API}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not create your account.');
      localStorage.setItem('token', body.token);
      localStorage.setItem('user', JSON.stringify(body.user));
      setSyncSecret(body.syncSecret || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your account.');
    } finally {
      setLoading(false);
    }
  };

  const copySecret = async () => {
    if (!syncSecret) return;
    await navigator.clipboard.writeText(syncSecret);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  if (syncSecret) {
    return (
      <div className="login-container">
        <div className="login-card">
          <div className="login-header">
            <div className="login-logo"><TrendingUp size={24} /></div>
            <h2>Save your sync key</h2>
            <p>This is shown once. Paste it into the Desktop Sync App on the Accounts page to connect it to your account — no manual setup needed.</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', margin: '4px 0 16px' }}>
            <code style={{ flex: 1, fontSize: 12.5, wordBreak: 'break-all', color: 'var(--text-primary)' }}>{syncSecret}</code>
            <button type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: '5px 9px', flexShrink: 0 }} onClick={copySecret}>
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 16 }}>
            You can regenerate this later from the Accounts page if you lose it — but the old one will stop working immediately.
          </p>
          <button type="button" className="login-btn" onClick={() => { router.push('/'); router.refresh(); }}>I've saved it — continue to my journal</button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <div className="login-logo"><TrendingUp size={24} /></div>
          <h2>Create your journal</h2>
          <p>Set up your own private trading journal.</p>
        </div>

        {error && <div className="login-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}

        {databaseAvailable === null ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 28 }}><Loader2 size={20} className="animate-spin" /></div>
        ) : databaseAvailable ? (
          <form className="login-form" onSubmit={submit}>
            <div className="form-group">
              <label htmlFor="owner-name">Your name</label>
              <div className="form-input-wrapper"><UserRound size={16} /><input id="owner-name" className="form-input" value={name} onChange={e => setName(e.target.value)} autoComplete="name" required maxLength={80} placeholder="Your name" /></div>
            </div>
            <div className="form-group">
              <label htmlFor="owner-email">Email address</label>
              <div className="form-input-wrapper"><Mail size={16} /><input id="owner-email" type="email" className="form-input" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" required placeholder="you@example.com" /></div>
            </div>
            <div className="form-group">
              <label htmlFor="owner-password">Password</label>
              <div className="form-input-wrapper"><Lock size={16} /><input id="owner-password" type="password" className="form-input" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} placeholder="At least 8 characters" /></div>
            </div>
            <div className="form-group">
              <label htmlFor="confirm-password">Confirm password</label>
              <div className="form-input-wrapper"><Lock size={16} /><input id="confirm-password" type="password" className="form-input" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" required minLength={8} placeholder="Repeat your password" /></div>
            </div>
            <button type="submit" className="login-btn" disabled={loading}>{loading ? <Loader2 size={16} className="animate-spin" /> : 'Create account'}</button>
          </form>
        ) : (
          <div style={{ padding: '12px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>The backend database is unavailable right now — try again shortly.</div>
        )}

        <div style={{ textAlign: 'center', marginTop: 14, fontSize: 12 }}><Link href="/login" style={{ color: 'var(--accent)', fontWeight: 700 }}>Already have an account? Sign in</Link></div>
      </div>
    </div>
  );
}
