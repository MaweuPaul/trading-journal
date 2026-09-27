'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AlertCircle, Bot, Check, Copy, Globe, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';

interface AccessKey {
  _id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
  journal: boolean;
  kind?: 'key' | 'oauth';
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
 * run backtests through the journal's MCP endpoint. A key only works there.
 * Journal access (reading real trades, never changing them) is opt-in per key.
 */
export default function AgentKeys() {
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [journal, setJournal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState<'key' | 'command' | 'desktop' | 'url' | 'codex' | 'codexLogin' | null>(null);

  const load = useCallback(() => fetchKeys().then(setKeys, err => setError(err instanceof Error ? err.message : 'Could not load access keys')), []);
  useEffect(() => {
    fetchKeys()
      .then(setKeys, err => setError(err instanceof Error ? err.message : 'Could not load access keys'))
      .finally(() => setLoading(false));
  }, []);

  // The origin is only known in the browser; reading it during render would
  // keep the server-rendered "/api/mcp" after hydration.
  const [endpoint, setEndpoint] = useState('/api/mcp');
  // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only value
  useEffect(() => setEndpoint(`${window.location.origin}/api/mcp`), []);
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
  // Codex (CLI and IDE extension) reads ~/.codex/config.toml and speaks
  // Streamable HTTP natively; the key stays in an environment variable.
  const codexConfig = `[mcp_servers.tradejournal]\nurl = "${endpoint}"\nbearer_token_env_var = "TRADEJOURNAL_KEY"`;
  const codexLogin = `codex mcp add tradejournal --url ${endpoint}\ncodex mcp login tradejournal`;

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ name, journal }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not create the key');
      setCreated({ name: data.name, key: data.key });
      setName('');
      setJournal(false);
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

  async function setJournalAccess(key: AccessKey, on: boolean) {
    if (on && !window.confirm(`Let agents using "${key.name}" read your real trades, notes and screenshots? They can't change anything.`)) return;
    setError('');
    const res = await fetch(`/api/api-keys/${key._id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ journal: on }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setError(data.error || 'Could not change journal access');
    await load();
  }

  async function copy(text: string, what: 'key' | 'command' | 'desktop' | 'url' | 'codex' | 'codexLogin') {
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
          <div className="account-title-line">
            <Bot size={22} /><h2>AI agent access</h2>
            <span title="New and still being tested: expect changes" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--amber, #b7791f)', border: '1px solid currentColor', borderRadius: 999, padding: '2px 8px', lineHeight: 1.4 }}>Experimental</span>
          </div>
          <p>Let an AI agent backtest your strategies on cTrader history, bar by bar with the future hidden. Its trades land in the Backtest Log marked AGENT and stay out of your own stats.
            Turn on journal access for a key to also let the agent read your real trades (notes, grades, checklists, screenshots, candles around each trade) and review your trading. Read-only: it can&apos;t change anything.</p>
          <p style={{ marginTop: 6 }}><b>Needs cTrader:</b> bar replay and backtesting use candles from your own cTrader connection, so connect at least a (free) cTrader demo account above first. Reviewing your journal works without it.</p>
        </div>
      </section>

      {error && <div className="account-alert error" role="alert"><AlertCircle size={17} />{error}</div>}

      <div className="account-card" style={{ marginBottom: 16, display: 'grid', gap: 8 }}>
        <strong style={{ color: 'var(--text-primary)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}><Globe size={15} /> Connect claude.ai (web and phone app), no key needed</strong>
        <span style={{ color: 'var(--text-secondary)', fontSize: 12.5, lineHeight: 1.55 }}>
          In claude.ai open <b>Settings → Connectors → Add custom connector</b>, paste this address, then click <b>Connect</b>. You&apos;ll be sent here to sign in and allow it
          (tick journal access there if you want Claude to read your trades). It then appears in the list below, where you can turn journal access off or disconnect it.
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <code style={{ ...codeStyle, flex: 1, minWidth: 220 }}>{endpoint}</code>
          <button className="btn-ghost" style={small} onClick={() => copy(endpoint, 'url')}>
            {copied === 'url' ? <Check size={12} /> : <Copy size={12} />} {copied === 'url' ? 'Copied' : 'Copy address'}
          </button>
        </div>
        <span style={{ color: 'var(--text-secondary)', fontSize: 12.5, lineHeight: 1.55, marginTop: 4 }}>
          <b>Codex</b> (CLI or IDE extension) can use the same sign-in: run these two commands, then allow it in the browser page that opens.
        </span>
        <pre style={{ ...codeStyle, margin: 0, whiteSpace: 'pre-wrap' }}>{codexLogin}</pre>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn-ghost" style={small} onClick={() => copy(codexLogin, 'codexLogin')}>
            {copied === 'codexLogin' ? <Check size={12} /> : <Copy size={12} />} {copied === 'codexLogin' ? 'Copied' : 'Copy commands'}
          </button>
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>Claude Code, Claude Desktop, Codex and your own agents can use the same sign-in, or an access key created below.</span>
      </div>

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
            </div>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5 }}>
              Connect Codex (CLI or IDE extension): add this to <code>~/.codex/config.toml</code>, set the environment variable
              <code> TRADEJOURNAL_KEY</code> to the key above, then restart Codex.
            </span>
            <pre style={{ ...codeStyle, margin: 0, whiteSpace: 'pre-wrap' }}>{codexConfig}</pre>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn-ghost" style={small} onClick={() => copy(codexConfig, 'codex')}>
                {copied === 'codex' ? <Check size={12} /> : <Copy size={12} />} {copied === 'codex' ? 'Copied' : 'Copy Codex config'}
              </button>
              <button className="btn-ghost" style={small} onClick={() => setCreated(null)}>I&apos;ve saved it</button>
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: 11.5, lineHeight: 1.5 }}>
              Custom agents send JSON-RPC to <code>{endpoint}</code> with an <code>Authorization: Bearer</code> header.
              For claude.ai (web and phone), use the connector address above instead of a key.
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
        <label style={{ flexBasis: '100%', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={journal} onChange={e => setJournal(e.target.checked)} />
          Also let this key read my real trade journal (read-only)
        </label>
      </form>

      {loading ? null : active.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>No access keys yet. Agents can&apos;t reach your journal until you create one.</p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {active.map(k => (
            <div key={k._id} className="account-card" style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              {k.kind === 'oauth' ? <Globe size={17} style={{ color: 'var(--accent)' }} /> : <KeyRound size={17} style={{ color: 'var(--accent)' }} />}
              <div style={{ flex: 1, minWidth: 180, display: 'grid', gap: 2 }}>
                <strong style={{ color: 'var(--text-primary)', fontSize: 13 }}>{k.name}</strong>
                <span style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>
                  {k.kind === 'oauth' ? 'Connected app (signed in)' : <><code>{k.prefix}…</code></>} · {k.kind === 'oauth' ? 'connected' : 'created'} {when(k.createdAt)} · last used {when(k.lastUsedAt)}
                </span>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: k.journal ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer' }}>
                <input type="checkbox" checked={k.journal} onChange={e => setJournalAccess(k, e.target.checked)} aria-label={`Journal access for ${k.name}`} />
                Journal access
              </label>
              <button className="btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }} onClick={() => revoke(k)} aria-label={`${k.kind === 'oauth' ? 'Disconnect' : 'Revoke'} ${k.name}`}><Trash2 size={14} /> {k.kind === 'oauth' ? 'Disconnect' : 'Revoke'}</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
