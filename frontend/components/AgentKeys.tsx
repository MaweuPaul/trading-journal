'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AlertCircle, Bot, Check, Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';

interface AccessKey {
  _id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
async function fetchKeys(): Promise<AccessKey[]> {
  const res = await fetch('/api/api-keys', { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not load access keys');
  return data.keys || [];
}
function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never';
}

const codeStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
  borderRadius: 6, padding: '6px 8px', wordBreak: 'break-all', display: 'block', color: 'var(--text-primary)',
};
const small: React.CSSProperties = { fontSize: 11, padding: '4px 9px' };

/**
 * Access keys that let AI agents (Claude Code, Claude Desktop, custom agents)
 * run backtests through the journal's MCP endpoint. A key only works there --
 * it can't read or change anything else in the journal.
 */
export default function AgentKeys() {
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState<'key' | 'command' | 'desktop' | null>(null);

  const load = useCallback(() => fetchKeys().then(setKeys, err => setError(err instanceof Error ? err.message : 'Could not load access keys')), []);
  useEffect(() => {
    fetchKeys()
      .then(setKeys, err => setError(err instanceof Error ? err.message : 'Could not load access keys'))
      .finally(() => setLoading(false));
  }, []);

  const endpoint = typeof window !== 'undefined' ? `${window.location.origin}/api/mcp` : '/api/mcp';
  const command = created ? `claude mcp add --transport http tradejournal ${endpoint} --header "Authorization: Bearer ${created.key}"` : '';
  // Claude Desktop can't send a custom header itself, so it goes through the
  // mcp-remote bridge. The "Bearer ..." value lives in env because Claude
  // Desktop on Windows doesn't escape spaces inside args.
  const desktopConfig = created ? JSON.stringify({
    mcpServers: {
      tradejournal: {
        command: 'npx',
        args: ['-y', 'mcp-remote', endpoint, '--transport', 'http-only', ...(endpoint.startsWith('http://') ? ['--allow-http'] : []), '--header', 'Authorization:${TJ_AUTH}'],
        env: { TJ_AUTH: `Bearer ${created.key}` },
      },
    },
  }, null, 2) : '';

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ name }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not create the key');
      setCreated({ name: data.name, key: data.key });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the key');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: AccessKey) {
    if (!window.confirm(`Revoke "${key.name}"? Agents using it lose access immediately.`)) return;
    setError('');
    const res = await fetch(`/api/api-keys/${key._id}`, { method: 'DELETE', headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setError(data.error || 'Could not revoke the key');
    await load();
  }

  async function copy(text: string, what: 'key' | 'command' | 'desktop') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      // Clipboard API can be unavailable -- the value is still visible/selectable.
    }
  }

  const active = keys.filter(k => !k.revoked);

  return (
    <>
      <section className="account-list-head" style={{ marginTop: 32 }}>
        <div>
          <div className="account-title-line"><Bot size={22} /><h2>AI agent access</h2></div>
          <p>Let an AI agent backtest your strategies on cTrader history, bar by bar with the future hidden. Its trades land in the Backtest Log marked AGENT and stay out of your own stats.</p>
        </div>
      </section>

      {error && <div className="account-alert error" role="alert"><AlertCircle size={17} />{error}</div>}

      {created && (
        <div className="account-card" style={{ marginBottom: 16, borderColor: 'var(--accent-mid)' }}>
          <div style={{ display: 'grid', gap: 10 }}>
            <strong style={{ color: 'var(--text-primary)', fontSize: 13 }}>Key &ldquo;{created.name}&rdquo; created. Copy it now: it won&apos;t be shown again.</strong>
            <code style={codeStyle}>{created.key}</code>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-ghost" style={small} onClick={() => copy(created.key, 'key')}>
                {copied === 'key' ? <Check size={12} /> : <Copy size={12} />} {copied === 'key' ? 'Copied' : 'Copy key'}
              </button>
            </div>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Connect Claude Code with:</span>
            <code style={codeStyle}>{command}</code>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn-ghost" style={small} onClick={() => copy(command, 'command')}>
                {copied === 'command' ? <Check size={12} /> : <Copy size={12} />} {copied === 'command' ? 'Copied' : 'Copy command'}
              </button>
            </div>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5 }}>
              Connect Claude Desktop: open Settings → Developer → Edit Config, add this to <code>claude_desktop_config.json</code> (merge it into
              any existing <code>mcpServers</code>), then quit and reopen Claude. Needs Node.js installed.
            </span>
            <pre style={{ ...codeStyle, margin: 0, whiteSpace: 'pre-wrap' }}>{desktopConfig}</pre>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn-ghost" style={small} onClick={() => copy(desktopConfig, 'desktop')}>
                {copied === 'desktop' ? <Check size={12} /> : <Copy size={12} />} {copied === 'desktop' ? 'Copied' : 'Copy config'}
              </button>
              <button className="btn-ghost" style={small} onClick={() => setCreated(null)}>I&apos;ve saved it</button>
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: 11.5, lineHeight: 1.5 }}>
              Custom agents send JSON-RPC to <code>{endpoint}</code> with an <code>Authorization: Bearer</code> header.
              Custom connectors on claude.ai (web) need OAuth sign-in, which this journal doesn&apos;t offer yet.
            </span>
          </div>
        </div>
      )}

      <form onSubmit={create} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <input value={name} onChange={e => setName(e.target.value)} maxLength={60} placeholder='Key name, e.g. "Claude Code laptop"' aria-label="New key name"
          style={{ flex: 1, minWidth: 200, minHeight: 42, padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 13 }} />
        <button className="btn-primary" disabled={busy || !name.trim()}>
          {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />} Create access key
        </button>
      </form>

      {loading ? null : active.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>No access keys yet. Agents can&apos;t reach your journal until you create one.</p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {active.map(k => (
            <div key={k._id} className="account-card" style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <KeyRound size={17} style={{ color: 'var(--accent)' }} />
              <div style={{ flex: 1, minWidth: 180, display: 'grid', gap: 2 }}>
                <strong style={{ color: 'var(--text-primary)', fontSize: 13 }}>{k.name}</strong>
                <span style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>
                  <code>{k.prefix}…</code> · created {when(k.createdAt)} · last used {when(k.lastUsedAt)}
                </span>
              </div>
              <button className="btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }} onClick={() => revoke(k)} aria-label={`Revoke ${k.name}`}><Trash2 size={14} /> Revoke</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
