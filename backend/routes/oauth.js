const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const mongoose = require('mongoose');
const { rateLimit } = require('express-rate-limit');
const ApiKey = require('../models/ApiKey');
const OAuthClient = require('../models/OAuthClient');
const OAuthCode = require('../models/OAuthCode');
const auth = require('../middleware/auth');

// OAuth 2.1 sign-in for the MCP endpoint, so apps that can't send a custom
// header (claude.ai custom connectors on web and mobile) can connect:
//   1. the app registers itself          POST /api/oauth/register (RFC 7591)
//   2. the owner approves it              /oauth/authorize page -> POST /api/oauth/authorize
//   3. the app swaps the code for tokens  POST /api/oauth/token (PKCE S256)
// The discovery documents live on the frontend (app/.well-known/*), next to the
// /api/mcp URL the app was given. Each approval becomes an ApiKey of kind
// 'oauth', listed and revocable on the Accounts page like any access key.

const ACCESS_TTL_S = 60 * 60;             // 1 hour
const REFRESH_TTL_S = 90 * 24 * 60 * 60;  // 90 days, rotated on every use
const CODE_TTL_S = 10 * 60;
const MAX_OAUTH_GRANTS = 20;              // per user; the oldest is revoked beyond this
const SCOPES = ['backtest', 'journal'];

const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const random = bytes => crypto.randomBytes(bytes).toString('base64url');
const clientIp = req => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
const limiter = rateLimit({ windowMs: 60_000, limit: 30, keyGenerator: clientIp, validate: false, standardHeaders: 'draft-8', legacyHeaders: false });

function oauthError(res, status, error, description) {
  return res.status(status).set('Cache-Control', 'no-store').json({ error, error_description: description });
}
function dbReady(res) {
  if (mongoose.connection.readyState === 1) return true;
  oauthError(res, 503, 'temporarily_unavailable', 'The journal database is offline.');
  return false;
}

/** https anywhere, or http only on this machine (desktop apps' loopback redirects). */
function validRedirect(uri) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

// ── 1. Dynamic client registration ─────────────────────────────────────────
router.post('/oauth/register', limiter, async (req, res) => {
  if (!dbReady(res)) return;
  const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) {
    return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be 1-10 https URLs (or http on localhost).');
  }
  const client = await OAuthClient.create({
    clientId: `tjc_${random(18)}`,
    name: String(req.body.client_name || 'An app').slice(0, 100),
    redirectUris: uris,
  });
  res.status(201).json({
    client_id: client.clientId, client_name: client.name, redirect_uris: client.redirectUris,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  });
});

async function checkClient(clientId, redirectUri) {
  const client = clientId && await OAuthClient.findOne({ clientId: String(clientId) }).lean();
  if (!client) return { error: 'This app is not registered with the journal. Remove the connector and add it again.' };
  if (!client.redirectUris.includes(String(redirectUri))) return { error: 'The redirect address does not match what this app registered.' };
  return { client };
}

// ── 2. The consent page (owner logged in) ──────────────────────────────────
function ownerOnly(req, res, next) {
  if (req.user.role === 'sync_agent' || req.user.role === 'investor') return res.status(403).json({ error: 'Owner session required.' });
  next();
}

// What the consent page shows before the owner approves.
router.get('/oauth/authorize-info', auth, ownerOnly, async (req, res) => {
  if (!dbReady(res)) return;
  const { client, error } = await checkClient(req.query.client_id, req.query.redirect_uri);
  if (error) return res.status(400).json({ error });
  res.json({ clientName: client.name, redirectHost: new URL(req.query.redirect_uri).host, requestedScopes: String(req.query.scope || '').split(' ').filter(s => SCOPES.includes(s)) });
});

router.post('/oauth/authorize', auth, ownerOnly, async (req, res) => {
  if (!dbReady(res)) return;
  const b = req.body || {};
  const { client, error } = await checkClient(b.client_id, b.redirect_uri);
  if (error) return res.status(400).json({ error });
  if (b.response_type !== 'code') return res.status(400).json({ error: 'Only response_type=code is supported.' });
  if (!b.code_challenge || b.code_challenge_method !== 'S256') return res.status(400).json({ error: 'The app must use PKCE (S256).' });
  const redirect = new URL(b.redirect_uri);
  if (b.state) redirect.searchParams.set('state', String(b.state));
  if (b.approve !== true) {
    redirect.searchParams.set('error', 'access_denied');
    return res.json({ redirect: redirect.toString() });
  }
  const code = random(32);
  await OAuthCode.create({
    codeHash: sha256(code), user: req.user.userId, clientId: client.clientId, redirectUri: String(b.redirect_uri),
    codeChallenge: String(b.code_challenge), scopes: b.journal === true ? ['backtest', 'journal'] : ['backtest'],
    expiresAt: new Date(Date.now() + CODE_TTL_S * 1000),
  });
  redirect.searchParams.set('code', code);
  res.json({ redirect: redirect.toString() });
});

// ── 3. Tokens ──────────────────────────────────────────────────────────────
function tokenResponse(res, grant, access, refresh) {
  res.set('Cache-Control', 'no-store').json({
    access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S,
    refresh_token: refresh, scope: grant.scopes.join(' '),
  });
}
function newTokens() {
  return { access: `tjo_${random(32)}`, refresh: `tjr_${random(32)}` };
}

router.post('/oauth/token', limiter, express.urlencoded({ extended: false }), async (req, res) => {
  if (!dbReady(res)) return;
  const b = req.body || {};
  const now = Date.now();
  try {
    if (b.grant_type === 'authorization_code') {
      const row = b.code && await OAuthCode.findOneAndUpdate(
        { codeHash: sha256(String(b.code)), usedAt: null },
        { $set: { usedAt: new Date() } },
      );
      if (!row || row.expiresAt.getTime() < now) return oauthError(res, 400, 'invalid_grant', 'The code is invalid, used or expired.');
      if (b.client_id && String(b.client_id) !== row.clientId) return oauthError(res, 400, 'invalid_grant', 'The code was issued to another app.');
      if (String(b.redirect_uri || '') !== row.redirectUri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match.');
      const verifier = String(b.code_verifier || '');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || crypto.createHash('sha256').update(verifier).digest('base64url') !== row.codeChallenge) {
        return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.');
      }
      const client = await OAuthClient.findOne({ clientId: row.clientId }).lean();
      const { access, refresh } = newTokens();
      const grant = await ApiKey.create({
        user: row.user, kind: 'oauth', clientId: row.clientId, name: (client?.name || 'Connected app').slice(0, 60),
        keyHash: sha256(access), prefix: access.slice(0, 10), scopes: row.scopes,
        expiresAt: new Date(now + ACCESS_TTL_S * 1000), refreshHash: sha256(refresh), refreshExpiresAt: new Date(now + REFRESH_TTL_S * 1000),
      });
      // Reconnecting creates a new grant; keep the list from growing without bound.
      const grants = await ApiKey.find({ user: row.user, kind: 'oauth', revokedAt: null }).sort({ createdAt: -1 }).lean();
      for (const old of grants.slice(MAX_OAUTH_GRANTS)) await ApiKey.updateOne({ _id: old._id }, { $set: { revokedAt: new Date() } });
      return tokenResponse(res, grant, access, refresh);
    }
    if (b.grant_type === 'refresh_token') {
      const grant = b.refresh_token && await ApiKey.findOne({ refreshHash: sha256(String(b.refresh_token)), kind: 'oauth', revokedAt: null });
      if (!grant || !grant.refreshExpiresAt || grant.refreshExpiresAt.getTime() < now) return oauthError(res, 400, 'invalid_grant', 'The refresh token is invalid, revoked or expired. Connect again.');
      if (b.client_id && String(b.client_id) !== grant.clientId) return oauthError(res, 400, 'invalid_grant', 'The refresh token belongs to another app.');
      const { access, refresh } = newTokens();
      await ApiKey.updateOne({ _id: grant._id }, { $set: {
        keyHash: sha256(access), prefix: access.slice(0, 10), expiresAt: new Date(now + ACCESS_TTL_S * 1000),
        refreshHash: sha256(refresh), refreshExpiresAt: new Date(now + REFRESH_TTL_S * 1000),
      } });
      return tokenResponse(res, grant, access, refresh);
    }
    return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  } catch (err) {
    console.error('OAuth token error:', err);
    return oauthError(res, 500, 'server_error', 'Could not issue tokens.');
  }
});

module.exports = router;
module.exports.validRedirect = validRedirect;
