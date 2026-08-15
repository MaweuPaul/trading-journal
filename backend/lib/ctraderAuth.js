// cTrader Open API OAuth2 helpers. Verified against the live endpoints:
// - Authorize: GET https://openapi.ctrader.com/apps/auth (browser redirect)
// - Token:     GET https://openapi.ctrader.com/apps/token (query-string params,
//              not a POST body — unusual for OAuth2, but that is what cTrader's
//              endpoint actually accepts; confirmed by probing it directly).
const AUTHORIZE_URL = 'https://openapi.ctrader.com/apps/auth';
const TOKEN_URL = 'https://openapi.ctrader.com/apps/token';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured on the backend`);
  return value;
}

function buildAuthorizationUrl() {
  const clientId = requireEnv('CTRADER_CLIENT_ID');
  const redirectUri = requireEnv('CTRADER_REDIRECT_URI');
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: 'trading' });
  return `${AUTHORIZE_URL}?${params}`;
}

async function callTokenEndpoint(extraParams) {
  const clientId = requireEnv('CTRADER_CLIENT_ID');
  const clientSecret = requireEnv('CTRADER_CLIENT_SECRET');
  const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...extraParams });
  const response = await fetch(`${TOKEN_URL}?${params}`, { signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errorCode) {
    throw new Error(body.description || body.errorCode || `cTrader token request failed (HTTP ${response.status})`);
  }
  return {
    accessToken: body.accessToken || body.access_token,
    refreshToken: body.refreshToken || body.refresh_token,
    expiresIn: Number(body.expiresIn || body.expires_in || 2592000), // cTrader access tokens are typically long-lived (~30 days)
    tokenType: body.tokenType || body.token_type || 'bearer',
  };
}

function exchangeCodeForToken(code) {
  const redirectUri = requireEnv('CTRADER_REDIRECT_URI');
  return callTokenEndpoint({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
}

function refreshAccessToken(refreshToken) {
  return callTokenEndpoint({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

module.exports = { buildAuthorizationUrl, exchangeCodeForToken, refreshAccessToken };
