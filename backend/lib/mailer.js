// Outgoing email (password reset links). Configure one of:
//   SMTP_URL=smtps://user:pass@smtp.example.com:465
//   SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS, SMTP_SECURE (true for 465)
// plus MAIL_FROM ("TradeJournal <no-reply@example.com>"). Works with Gmail
// (app password), Resend, Brevo, Mailgun or any SMTP provider. Without it,
// features that need email say so instead of pretending to send.
// MAIL_TRANSPORT=json keeps messages in memory (tests).
const nodemailer = require('nodemailer');

let transport = null;
const sent = []; // json transport only
function mailConfigured() {
  return process.env.MAIL_TRANSPORT === 'json' || Boolean(process.env.SMTP_URL || process.env.SMTP_HOST);
}
function getTransport() {
  if (transport) return transport;
  if (process.env.MAIL_TRANSPORT === 'json') transport = nodemailer.createTransport({ jsonTransport: true });
  else if (process.env.SMTP_URL) transport = nodemailer.createTransport(process.env.SMTP_URL);
  else transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}
async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) throw Object.assign(new Error('Email is not set up on this journal.'), { code: 'MAIL_NOT_CONFIGURED' });
  const from = process.env.MAIL_FROM || process.env.SMTP_USER || 'TradeJournal <no-reply@localhost>';
  const info = await getTransport().sendMail({ from, to, subject, text, html });
  if (process.env.MAIL_TRANSPORT === 'json') sent.push({ to, subject, text, html });
  return info;
}
module.exports = { mailConfigured, sendMail, sent };
