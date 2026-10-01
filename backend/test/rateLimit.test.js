const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { clientIp, ipKey } = require('../lib/clientIp');

process.env.PROXY_SHARED_SECRET = 'test-proxy-secret';

// Like production: one trusted proxy hop (Render), limits keyed by visitor.
const app = express();
app.set('trust proxy', 1);
app.get('/ip', (req, res) => res.json({ ip: clientIp(req) }));
app.post('/login', rateLimit({ windowMs: 60_000, limit: 2, keyGenerator: ipKey, standardHeaders: true, legacyHeaders: false }), (req, res) => res.json({ ok: true }));
let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const viaWebApp = ip => ({ 'x-tj-client-ip': ip, 'x-tj-proxy-secret': 'test-proxy-secret', 'x-forwarded-for': '3.3.3.3' });
const login = headers => fetch(`${base}/login`, { method: 'POST', headers }).then(r => r.status);

test('visitors coming through the web app each get their own allowance', async () => {
  assert.deepEqual([await login(viaWebApp('10.0.0.1')), await login(viaWebApp('10.0.0.1')), await login(viaWebApp('10.0.0.1'))], [200, 200, 429]);
  assert.equal(await login(viaWebApp('10.0.0.2')), 200, 'one visitor running out does not lock out another');
});

test('the visitor header is ignored without the secret', async () => {
  const r = await fetch(`${base}/ip`, { headers: { 'x-tj-client-ip': '6.6.6.6', 'x-tj-proxy-secret': 'guess', 'x-forwarded-for': '7.7.7.7' } }).then(x => x.json());
  assert.equal(r.ip, '7.7.7.7', 'falls back to the address the proxy saw');
});

test('a faked X-Forwarded-For prefix does not change the address', async () => {
  // Render appends the real caller; only that last entry is trusted.
  const r = await fetch(`${base}/ip`, { headers: { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' } }).then(x => x.json());
  assert.equal(r.ip, '9.9.9.9');
  const spoofs = ['1.1.1.1', '2.2.2.2', '4.4.4.4'].map(fake => login({ 'x-forwarded-for': `${fake}, 8.8.8.8` }));
  assert.deepEqual(await Promise.all(spoofs).then(s => s.sort()), [200, 200, 429], 'rotating fake prefixes shares one allowance');
});
