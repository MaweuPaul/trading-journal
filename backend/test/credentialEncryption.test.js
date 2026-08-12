const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ACCOUNT_ENCRYPTION_KEY = 'test-only-account-key-that-is-longer-than-thirty-two-characters';
const { encryptCredential, decryptCredential, safeSecretEqual } = require('../lib/credentialEncryption');

test('encrypts credentials with authenticated encryption and context binding', () => {
  const encrypted = encryptCredential('secret-password', 'user:account:password');
  assert.notEqual(encrypted.data, Buffer.from('secret-password').toString('base64'));
  assert.equal(decryptCredential(encrypted, 'user:account:password'), 'secret-password');
  assert.throws(() => decryptCredential(encrypted, 'user:other-account:password'));
});

test('compares installation secrets without accepting empty values', () => {
  assert.equal(safeSecretEqual('same-secret', 'same-secret'), true);
  assert.equal(safeSecretEqual('same-secret', 'other-secret'), false);
  assert.equal(safeSecretEqual('', ''), false);
});
