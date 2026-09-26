'use client';
import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Hash, Lock, Eye, Loader2, AlertCircle } from 'lucide-react';

const API = '/api';

function InvestorLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('investorToken');
    if (token) { router.push('/investor'); return; }
    const prefilled = searchParams.get('code');
    if (prefilled) setCode(prefilled);
  }, [router, searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${API}/investor/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invalid account number or password');
      localStorage.setItem('investorToken', data.token);
      localStorage.setItem('investorAccount', JSON.stringify(data.account));
      router.push('/investor');
    } catch (err: any) {
      setError(err.message || 'Connection failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <div className="login-logo"><Eye size={24} /></div>
          <h2>Investor View</h2>
          <p>Read-only access to a shared trading account</p>
        </div>

        {error && (
          <div className="login-error">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="code">Account Number</label>
            <div className="form-input-wrapper">
              <Hash size={16} />
              <input
                id="code" type="text" inputMode="numeric" placeholder="e.g. 48219043"
                className="form-input" value={code}
                onChange={e => setCode(e.target.value.trim())}
                required disabled={loading}
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <div className="form-input-wrapper">
              <Lock size={16} />
              <input
                id="password" type="password" placeholder="••••••••"
                className="form-input" value={password}
                onChange={e => setPassword(e.target.value)}
                required disabled={loading}
              />
            </div>
          </div>

          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? <Loader2 size={16} className="animate-spin" /> : 'View Account'}
          </button>
        </form>

        <div style={{ textAlign: 'center', fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
          🔒 Read-only — no changes can be made from this view
        </div>
        <div style={{ textAlign: 'center', fontSize: '11px', marginTop: '10px' }}>
          <Link href="/privacy" style={{ color: 'var(--text-muted)' }}>What data can I see here?</Link>
        </div>
      </div>
    </div>
  );
}

export default function InvestorLoginPage() {
  return (
    <Suspense fallback={null}>
      <InvestorLoginForm />
    </Suspense>
  );
}
