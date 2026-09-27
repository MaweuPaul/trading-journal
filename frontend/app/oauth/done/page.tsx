'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, Check, CheckCircle2, Copy } from 'lucide-react';
import LogoMark from '@/components/LogoMark';

// Landing page for OAuth sign-ins started by an agent that has no browser
// callback of its own (a CLI or a chat AI doing the flow by hand): it registers
// this page as its redirect_uri, and the owner copies the code back into it.
// The agent then swaps the code (plus its PKCE verifier) at /api/oauth/token.
// Codes expire after 10 minutes and work once (backend/routes/oauth.js).

function Done() {
  const params = useSearchParams();
  const code = params.get('code') || '';
  const state = params.get('state') || '';
  const error = params.get('error') || '';
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState<'message' | 'code' | null>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only value
  useEffect(() => setOrigin(window.location.origin), []);

  const message = [
    'I approved the TradeJournal connection. Here is the authorization code:',
    '',
    `code: ${code}`,
    ...(state ? [`state: ${state}`] : []),
    '',
    `Exchange it for tokens with POST ${origin}/api/oauth/token (grant_type=authorization_code, the same client_id and redirect_uri ${origin}/oauth/done, and your PKCE code_verifier).`,
    `Then call the MCP server at ${origin}/api/mcp with "Authorization: Bearer <access_token>". The code works once and expires 10 minutes after I approved it.`,
  ].join('\n');

  async function copy(text: string, what: 'message' | 'code') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      // Clipboard can be blocked -- the text is still visible and selectable.
    }
  }

  const codeStyle: React.CSSProperties = {
    display: 'block', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12, color: 'var(--text-primary)', wordBreak: 'break-all', whiteSpace: 'pre-wrap', margin: 0,
  };
  const muted: React.CSSProperties = { margin: 0, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 };

  let body: React.ReactNode;
  if (error) {
    body = (
      <div style={{ display: 'grid', gap: 12, textAlign: 'center' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', color: 'var(--red)', fontSize: 14 }}><AlertCircle size={18} />
          {error === 'access_denied' ? 'You cancelled the connection.' : `The sign-in failed (${error}).`}
        </div>
        <p style={muted}>Nothing was shared. Tell the AI you declined, or ask it to start the sign-in again.</p>
      </div>
    );
  } else if (!code) {
    body = (
      <div style={{ display: 'grid', gap: 12, textAlign: 'center' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', color: 'var(--red)', fontSize: 14 }}><AlertCircle size={18} /> This link has no sign-in code.</div>
        <p style={muted}>Open it from the approval page, or ask the AI to start the sign-in again.</p>
      </div>
    );
  } else {
    body = (
      <div style={{ display: 'grid', gap: 14 }}>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.5, textAlign: 'center' }}>
          <CheckCircle2 size={16} style={{ verticalAlign: '-3px', color: 'var(--green, var(--accent))' }} /> Connection approved.
          <br /><span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>If an AI agent or MCP client asked you to sign in, copy this message and paste it back into that chat or terminal.</span>
        </p>
        <pre style={{ ...codeStyle, maxHeight: 220, overflow: 'auto' }}>{message}</pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => copy(message, 'message')}>
            {copied === 'message' ? <Check size={14} /> : <Copy size={14} />} {copied === 'message' ? 'Copied' : 'Copy for the AI'}
          </button>
          <button className="btn btn-ghost" onClick={() => copy(code, 'code')}>
            {copied === 'code' ? <Check size={14} /> : <Copy size={14} />} {copied === 'code' ? 'Copied' : 'Code only'}
          </button>
        </div>
        <ol style={{ ...muted, paddingLeft: 18, display: 'grid', gap: 4 }}>
          <li>Paste it into the AI that asked you to connect, within <b>10 minutes</b>. The code works once.</li>
          <li>The AI exchanges it for its own access. You don&apos;t need to do anything else.</li>
          <li>You can turn journal access off or disconnect it any time on the <Link href="/accounts" style={{ color: 'var(--accent)' }}>Accounts page</Link> (AI agent access).</li>
        </ol>
        <p style={{ ...muted, fontSize: 11.5, color: 'var(--text-muted)' }}>
          Didn&apos;t start this? Don&apos;t share the code; it&apos;s useless without the secret the requesting app holds, and it expires on its own.
        </p>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-card" style={{ maxWidth: 520 }}>
        <div className="login-header">
          <div className="login-logo-mark"><LogoMark size={44} /></div>
          <h2 style={{ fontSize: 20 }}>{error || !code ? 'Not connected' : 'Almost done'}</h2>
        </div>
        {body}
      </div>
    </div>
  );
}

export default function OAuthDonePage() {
  return <Suspense fallback={null}><Done /></Suspense>;
}
