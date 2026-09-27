'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Mail, Lock, Loader2, AlertCircle } from 'lucide-react';
import LogoMark from '@/components/LogoMark';
import AuthShowcase from '@/components/AuthShowcase';

const API = '/api';

// Where to go after signing in: ?next=/some/path (same site only), e.g. back to an app's sign-in request.
function nextPath() {
  const next = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('next') : null;
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [signupAvailable, setSignupAvailable] = useState(true);

  // If already logged in, redirect to dashboard
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      router.push(nextPath());
      return;
    }
    fetch(`${API}/auth/setup-status`)
      .then(response => response.json())
      .then(status => setSignupAvailable(Boolean(status.signupAvailable)))
      .catch(() => undefined);
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Invalid email or password');
      }

      // Save token and user details to localStorage
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));

      // Back to where the user was headed, or the dashboard
      router.push(nextPath());
      router.refresh();
    } catch (err: any) {
      setError(err.message || 'Could not reach the journal. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container auth-split">
      <AuthShowcase />
      <div className="auth-form-side">
      <p className="auth-mobile-tagline">Sync your trades, journal them against your playbook, and see what&apos;s really working.</p>
      <div className="login-card">
        <div className="login-header">
          <div className="login-logo-mark"><LogoMark size={52} /></div>
          <h2>Welcome back</h2>
          <p>Sign in to your trading journal.</p>
        </div>

        {error && (
          <div className="login-error">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="email">Email Address</label>
            <div className="form-input-wrapper">
              <Mail size={16} />
              <input
                id="email"
                type="email"
                placeholder="you@example.com"
                className="form-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
              />
            </div>
          </div>

          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label htmlFor="password">Password</label>
              <Link href="/forgot-password" style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>Forgot password?</Link>
            </div>
            <div className="form-input-wrapper">
              <Lock size={16} />
              <input
                id="password"
                type="password"
                placeholder="••••••••"
                className="form-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
                minLength={6}
              />
            </div>
          </div>

          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        {signupAvailable && (
          <div style={{ textAlign: 'center', marginTop: 14, fontSize: 12, color: 'var(--text-muted)' }}>
            New here? <Link href="/signup" style={{ color: 'var(--accent)', fontWeight: 700 }}>Create an account</Link>
          </div>
        )}

        <div style={{ textAlign: 'center', fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
          🔒 Your journal is private to you.
        </div>
        <div style={{ textAlign: 'center', fontSize: '11px', marginTop: '6px' }}>
          <Link href="/privacy" style={{ color: 'var(--text-muted)' }}>Privacy &amp; data use</Link>
          <span style={{ color: 'var(--text-muted)' }}> · </span>
          <Link href="/manual" style={{ color: 'var(--text-muted)' }}>Read the manual</Link>
        </div>
      </div>
      </div>
    </div>
  );
}
