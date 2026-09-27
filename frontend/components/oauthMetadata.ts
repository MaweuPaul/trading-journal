// OAuth discovery documents for the MCP endpoint (RFC 9728 / RFC 8414), served
// from the frontend origin that apps are given (…/api/mcp). The endpoints they
// name are proxied to the backend (routes/oauth.js), except the consent page.
import { NextRequest, NextResponse } from 'next/server';

const SCOPES = ['backtest', 'journal'];

function origin(request: NextRequest) {
  const configured = process.env.PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/$/, '');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || request.nextUrl.host;
  const proto = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '');
  return `${proto}://${host}`;
}

function json(body: unknown) {
  return NextResponse.json(body, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' } });
}

export function protectedResource(request: NextRequest) {
  const o = origin(request);
  return json({
    resource: `${o}/api/mcp`,
    authorization_servers: [o],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'TradeJournal',
  });
}

export function authorizationServer(request: NextRequest) {
  const o = origin(request);
  return json({
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/api/oauth/token`,
    registration_endpoint: `${o}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES,
  });
}
