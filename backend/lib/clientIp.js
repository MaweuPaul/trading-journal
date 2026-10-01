// The visitor's address, for per-IP rate limits.
//
// Requests normally arrive browser -> the web app's /api proxy (Vercel) ->
// Render -> here. Render's proxy is one hop (TRUST_PROXY_HOPS, set in
// server.js), so req.ip is whoever connected to Render: for proxied requests
// that's the web app's server, shared by every visitor. The web app passes the
// visitor's address in x-tj-client-ip together with a secret only it knows
// (PROXY_SHARED_SECRET); without the matching secret that header is ignored,
// so calling the backend directly can't fake an address.
const crypto = require('crypto');
const { ipKeyGenerator } = require('express-rate-limit');

function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function clientIp(req) {
  const secret = process.env.PROXY_SHARED_SECRET;
  const forwarded = String(req.headers['x-tj-client-ip'] || '').trim();
  if (secret && forwarded && sameSecret(req.headers['x-tj-proxy-secret'] || '', secret)) return forwarded;
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** Rate-limit key: the address, with IPv6 grouped by /56 so one machine can't rotate through addresses. */
const ipKey = req => ipKeyGenerator(clientIp(req));

module.exports = { clientIp, ipKey };
