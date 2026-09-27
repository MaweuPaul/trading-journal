'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, Loader2, Mail } from 'lucide-react';
import LogoMark from '@/components/LogoMark';
import AuthShowcase from '@/components/AuthShowcase';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  const [emailEnabled, setEmailEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/auth/password-reset-status')
      .then(r => r.json())
      .then(d => setEmailEnabled(Boolean(d.emailEnabled)))
      .catch(() => setEmailEnabled(true)); // let the request itself report problems
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not send the reset email.');
      setSent(data.message || 'If an account uses that email, a reset link is on its way.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the journal. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-container auth-split">
      <AuthShowcase />
      <div className="auth-form-side">
        <div className="login-card">
          <div className="login-header">
            <div className="login-logo-mark"><LogoMark size={52} /></div>
            <h2>Forgot your password?</h2>
            <p>Enter your email and we&apos;ll send you a link to choose a new one.</p>
          </div>

          {error && <div className="login-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}

          {emailEnabled === false ? (
            <p style={{ margin: 0, textAlign: 'center', fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
              Password reset by email isn&apos;t set up on this journal yet. Ask whoever runs it to reset your password for you.
            </p>
          ) : sent ? (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }} role="status">
              <CheckCircle2 size={18} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 2 }} />
              <span>{sent} Check your spam folder if it doesn&apos;t arrive in a few minutes.</span>
            </div>
          ) : (
            <form className="login-form" onSubmit={submit}>
              <div className="form-group">
                <label htmlFor="email">Email address</label>
                <div className="form-input-wrapper">
                  <Mail size={16} />
                  <input id="email" type="email" className="form-input" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required disabled={loading} autoComplete="email" />
                </div>
              </div>
              <button type="submit" className="login-btn" disabled={loading}>{loading ? <Loader2 size={16} className="animate-spin" /> : 'Send reset link'}</button>
            </form>
          )}

          <div style={{ textAlign: 'center', fontSize: 12 }}><Link href="/login" style={{ color: 'var(--accent)', fontWeight: 700 }}>Back to sign in</Link></div>
        </div>
      </div>
    </div>
  );
}
