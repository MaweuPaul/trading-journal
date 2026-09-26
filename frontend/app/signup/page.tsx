'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2, Lock, Mail, TrendingUp, UserRound } from 'lucide-react';

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
      router.push('/');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your account.');
    } finally {
      setLoading(false);
    }
  };

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
        <div style={{ textAlign: 'center', marginTop: 8, fontSize: 11 }}><Link href="/privacy" style={{ color: 'var(--text-muted)' }}>Privacy &amp; data use</Link></div>
      </div>
    </div>
  );
}
