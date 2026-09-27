'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Loader2, Lock } from 'lucide-react';
import LogoMark from '@/components/LogoMark';
import AuthShowcase from '@/components/AuthShowcase';

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) { setError('The passwords don’t match.'); return; }
    if (password.length < 8) { setError('Choose a password of at least 8 characters.'); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not reset the password.');
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      router.push('/');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the journal. Check your connection and try again.');
      setLoading(false);
    }
  }

  return (
    <div className="login-card">
      <div className="login-header">
        <div className="login-logo-mark"><LogoMark size={52} /></div>
        <h2>Choose a new password</h2>
        <p>You&apos;ll be signed in straight after, and signed out everywhere else.</p>
      </div>
      {!token ? (
        <p style={{ margin: 0, textAlign: 'center', fontSize: 13, color: 'var(--text-secondary)' }}>This link is incomplete. Use the link from your email, or ask for a new one.</p>
      ) : (
        <>
          {error && <div className="login-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
          <form className="login-form" onSubmit={submit}>
            <div className="form-group">
              <label htmlFor="new-password">New password</label>
              <div className="form-input-wrapper"><Lock size={16} /><input id="new-password" type="password" className="form-input" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" placeholder="At least 8 characters" disabled={loading} /></div>
            </div>
            <div className="form-group">
              <label htmlFor="confirm-password">Confirm new password</label>
              <div className="form-input-wrapper"><Lock size={16} /><input id="confirm-password" type="password" className="form-input" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" placeholder="Repeat it" disabled={loading} /></div>
            </div>
            <button type="submit" className="login-btn" disabled={loading}>{loading ? <Loader2 size={16} className="animate-spin" /> : 'Set new password'}</button>
          </form>
        </>
      )}
      <div style={{ textAlign: 'center', fontSize: 12 }}><Link href="/forgot-password" style={{ color: 'var(--accent)', fontWeight: 700 }}>Ask for a new link</Link></div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="login-container auth-split">
      <AuthShowcase />
      <div className="auth-form-side">
        <Suspense fallback={null}><ResetForm /></Suspense>
      </div>
    </div>
  );
}
