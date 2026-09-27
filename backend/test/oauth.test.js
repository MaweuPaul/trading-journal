const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-longer-than-thirty-two-characters';
const H = require('../fixtures/agentReplayHarness');
const express = require('express');

const app = express();
app.use(express.json());
for (const name of ['apiKeys', 'mcp', 'oauth']) app.use('/api', require(`../routes/${name}`));
const userId = H.newUserId();
const ownerToken = jwt.sign({ userId, role: 'owner' }, process.env.JWT_SECRET);
let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api`; r(); }); }));
test.after(() => server.close());

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const owner = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}`, ...init.headers } });
const form = body => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
const mcp = (token, method = 'tools/list') => fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', 'X-Forwarded-Host': 'journal.example.com', 'X-Forwarded-Proto': 'https' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
});
const pkce = () => { const verifier = crypto.randomBytes(40).toString('base64url'); return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }; };

async function register() {
  const res = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }) });
  assert.equal(res.status, 201);
  return (await res.json()).client_id;
}
async function approve(clientId, { journal = false, approveIt = true } = {}) {
  const { verifier, challenge } = pkce();
  const res = await owner('/oauth/authorize', { method: 'POST', body: JSON.stringify({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', approve: approveIt, journal }) });
  assert.equal(res.status, 200);
  const url = new URL((await res.json()).redirect);
  return { url, code: url.searchParams.get('code'), verifier };
}

test('the MCP 401 points apps at the discovery document', async () => {
  const res = await mcp(null);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /resource_metadata="https:\/\/journal\.example\.com\/\.well-known\/oauth-protected-resource"/);
});

test('registration only accepts https (or localhost) redirects', async () => {
  const bad = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
  assert.equal(bad.status, 400);
  const local = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:33418/callback'] }) });
  assert.equal(local.status, 201);
});

test('full sign-in: consent, PKCE code exchange, MCP access, refresh rotation, expiry and revoke', async () => {
  const clientId = await register();
  const info = await (await owner(`/oauth/authorize-info?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}`)).json();
  assert.equal(info.clientName, 'Claude');
  assert.equal(info.redirectHost, 'claude.ai');
  assert.equal((await owner(`/oauth/authorize-info?client_id=${clientId}&redirect_uri=${encodeURIComponent('https://other.example/cb')}`)).status, 400);

  const { url, code, verifier } = await approve(clientId, { journal: true });
  assert.equal(url.searchParams.get('state'), 'xyz');
  assert.equal((await form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: 'x'.repeat(43) })).status, 400, 'wrong verifier');
  // A failed attempt used up the code (one try only); get a fresh one.
  const fresh = await approve(clientId, { journal: true });
  const tok = await (await form({ grant_type: 'authorization_code', code: fresh.code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: fresh.verifier })).json();
  assert.match(tok.access_token, /^tjo_/);
  assert.match(tok.refresh_token, /^tjr_/);
  assert.equal(tok.scope, 'backtest journal');
  assert.equal((await form({ grant_type: 'authorization_code', code: fresh.code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: fresh.verifier })).status, 400, 'codes are single use');
  assert.equal(verifier.length > 0, true);

  const tools = (await (await mcp(tok.access_token)).json()).result.tools.map(t => t.name);
  assert.ok(tools.includes('run_strategy') && tools.includes('list_trades'));

  const next = await (await form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId })).json();
  assert.ok(next.access_token && next.access_token !== tok.access_token);
  assert.equal((await mcp(tok.access_token)).status, 401, 'old access token dies on refresh');
  assert.equal((await form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token })).status, 400, 'refresh tokens rotate');
  assert.equal((await mcp(next.access_token)).status, 200);

  const grant = [...H.models.ApiKey.store.values()].find(k => k.kind === 'oauth' && String(k.user) === userId);
  const saved = grant.expiresAt;
  grant.expiresAt = new Date(Date.now() - 1000);
  assert.equal((await mcp(next.access_token)).status, 401, 'expired access token');
  grant.expiresAt = saved;

  const listed = (await (await owner('/api-keys')).json()).keys.find(k => k.kind === 'oauth');
  assert.equal(listed.name, 'Claude');
  assert.equal(listed.journal, true);
  await owner(`/api-keys/${listed._id}`, { method: 'DELETE' });
  assert.equal((await mcp(next.access_token)).status, 401, 'revoked on the Accounts page');
  assert.equal((await form({ grant_type: 'refresh_token', refresh_token: next.refresh_token })).status, 400);
});

test('journal access is opt-in on the consent page; deny sends access_denied back', async () => {
  const clientId = await register();
  const { code, verifier } = await approve(clientId, { journal: false });
  const tok = await (await form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier })).json();
  assert.equal(tok.scope, 'backtest');
  const tools = (await (await mcp(tok.access_token)).json()).result.tools.map(t => t.name);
  assert.equal(tools.includes('list_trades'), false);
  const denied = await approve(clientId, { approveIt: false });
  assert.equal(denied.url.searchParams.get('error'), 'access_denied');
  assert.equal(denied.code, null);
});
