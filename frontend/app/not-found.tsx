import Link from 'next/link';
import { Compass } from 'lucide-react';
import LogoMark from '@/components/LogoMark';

export default function NotFound() {
  return (
    <div className="login-container">
      <div className="login-card" style={{ maxWidth: 440, textAlign: 'center' }}>
        <div className="login-header">
          <div className="login-logo-mark"><LogoMark size={44} /></div>
          <div style={{ fontSize: 44, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--accent)', lineHeight: 1 }}>404</div>
          <h2 style={{ fontSize: 20 }}>Page not found</h2>
        </div>
        <p style={{ margin: '0 0 18px', fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          <Compass size={14} style={{ verticalAlign: '-2px' }} /> This page doesn&apos;t exist or has moved. Check the address, or head back to your journal.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link href="/" className="btn btn-primary">Go to dashboard</Link>
          <Link href="/trades" className="btn btn-ghost">View trades</Link>
        </div>
      </div>
    </div>
  );
}
