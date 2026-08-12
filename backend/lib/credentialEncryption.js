const crypto = require('crypto');

const VERSION = 1;

function credentialSecret() {
  const secret = process.env.ACCOUNT_ENCRYPTION_KEY || '';
  if (secret.length < 32) {
    throw new Error('ACCOUNT_ENCRYPTION_KEY must be at least 32 characters');
  }
  return secret;
}

function encryptionKey() {
  return crypto.createHash('sha256').update(`trade-journal-accounts:v${VERSION}:${credentialSecret()}`).digest();
}

function encryptCredential(value, context) {
  const plaintext = String(value || '');
  if (!plaintext) throw new Error(`${context} is required`);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(String(context)));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    version: VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptCredential(payload, context) {
  if (!payload || Number(payload.version) !== VERSION) throw new Error('Unsupported encrypted credential version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAAD(Buffer.from(String(context)));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function safeSecretEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

module.exports = { encryptCredential, decryptCredential, safeSecretEqual };
