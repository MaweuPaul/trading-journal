#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const apiBase = String(process.env.API_BASE || 'http://localhost:4000/api').replace(/\/$/, '');
const appBase = String(process.env.APP_BASE || 'http://localhost:3000').replace(/\/$/, '');
const email = process.env.TEST_USER_EMAIL || process.env.USER_EMAIL;
const password = process.env.TEST_USER_PASSWORD || process.env.USER_PASSWORD;
const fixturePath = path.join(__dirname, '../fixtures/visual-playbook-test.json');

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body;
}

async function main() {
  if (!email || !password) {
    throw new Error('Set TEST_USER_EMAIL and TEST_USER_PASSWORD (or USER_EMAIL and USER_PASSWORD) before running this script.');
  }

  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const login = await jsonRequest(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  const existing = await jsonRequest(`${apiBase}/playbooks`, { headers });
  const match = (existing.playbooks || []).find(playbook => playbook.name === fixture.name);

  if (match) {
    console.log(`Test playbook already exists: ${match.name} (v${match.versions?.length || 1}). No duplicate was created.`);
    return;
  }

  const created = await jsonRequest(`${apiBase}/playbooks`, {
    method: 'POST',
    headers,
    body: JSON.stringify(fixture),
  });
  console.log(`Created test playbook: ${created.playbook.name} v${created.playbook.versions[0].versionNumber}`);
  console.log(`Open ${appBase}/rules to edit it or attach it to a test trade.`);
}

main().catch(error => {
  console.error(`Could not seed test playbook: ${error.message}`);
  process.exitCode = 1;
});
