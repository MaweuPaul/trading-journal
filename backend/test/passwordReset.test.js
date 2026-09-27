const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-longer-than-thirty-two-characters';
process.env.MAIL_TRANSPORT = 'json';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.PUBLIC_APP_URL = 'https://journal.example.com';
const H = require('../fixtures/agentReplayHarness');
const mailer = require('../lib/mailer');
const express = require('express');

const app = express();
app.use(express.json());
app.use('/api/auth', require('../routes/auth'));
let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api/auth`; r(); }); }));
test.after(() => server.close());

const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function seedUser(email, password) {
  const u = await H.models.User.create({ name: 'Paul', email, password: await bcrypt.hash(password, 4) });
  return String(u._id);
}

test('forgot password: same answer for unknown emails; the link always points at the real site', async () => {
  await seedUser('paul@example.com', 'old-password-1');
  const before = mailer.sent.length;
  const unknown = await post('/forgot-password', { email: 'nobody@example.com' });
  assert.equal(unknown.status, 200);
  assert.equal(mailer.sent.length, before, 'no email for unknown accounts');
  const known = await post('/forgot-password', { email: 'PAUL@example.com' }, { 'x-tj-public-origin': 'https://evil.example' });
  assert.equal(known.status, 200);
  assert.deepEqual(await known.json(), await unknown.json(), 'no way to tell which emails have accounts');
  const mail = mailer.sent[mailer.sent.length - 1];
  assert.equal(mail.to, 'paul@example.com');
  assert.match(mail.text, /https:\/\/journal\.example\.com\/reset-password\?token=/);
  assert.equal(mail.text.includes('evil.example'), false, 'a forged address header is ignored');
});

test('reset: bad links fail, a good link sets the password once and signs you in', async () => {
  await seedUser('reset@example.com', 'old-password-1');
  await post('/forgot-password', { email: 'reset@example.com' });
  const token = decodeURIComponent(/token=([^\s]+)/.exec(mailer.sent[mailer.sent.length - 1].text)[1]);
  assert.equal((await post('/reset-password', { token: 'nope', password: 'new-password-1' })).status, 400);
  assert.equal((await post('/reset-password', { token, password: 'short' })).status, 400);
  const ok = await post('/reset-password', { token, password: 'new-password-1' });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).token);
  assert.equal((await post('/reset-password', { token, password: 'another-pass-2' })).status, 400, 'links work once');
  assert.equal((await post('/login', { email: 'reset@example.com', password: 'new-password-1' })).status, 200);
  assert.equal((await post('/login', { email: 'reset@example.com', password: 'old-password-1' })).status, 400, 'the old password no longer works');
});

test('change password needs the current one and signs out older logins', async () => {
  const id = await seedUser('change@example.com', 'old-password-1');
  const old = jwt.sign({ userId: id, email: 'change@example.com', iat: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
  const me = t => fetch(`${base}/me`, { headers: { Authorization: `Bearer ${t}` } });
  assert.equal((await me(old)).status, 200);
  const wrong = await post('/change-password', { currentPassword: 'nope', newPassword: 'new-password-1' }, { Authorization: `Bearer ${old}` });
  assert.equal(wrong.status, 400);
  const ok = await post('/change-password', { currentPassword: 'old-password-1', newPassword: 'new-password-1' }, { Authorization: `Bearer ${old}` });
  assert.equal(ok.status, 200);
  const { token } = await ok.json();
  assert.equal((await me(old)).status, 401, 'the old login is signed out');
  assert.equal((await me(token)).status, 200, 'the new login works');
});

test('without email set up, forgot password says so', async () => {
  const saved = process.env.MAIL_TRANSPORT;
  delete process.env.MAIL_TRANSPORT;
  try {
    assert.deepEqual(await (await fetch(`${base}/password-reset-status`)).json(), { emailEnabled: false });
    const res = await post('/forgot-password', { email: 'paul@example.com' });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /isn't set up/);
  } finally {
    process.env.MAIL_TRANSPORT = saved;
  }
});
