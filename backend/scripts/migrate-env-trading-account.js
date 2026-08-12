const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const User = require('../models/User');
const Trade = require('../models/Trade');
const AccountEvent = require('../models/AccountEvent');
const TradingAccount = require('../models/TradingAccount');
const { encryptCredential } = require('../lib/credentialEncryption');

async function main() {
  const login = String(process.env.MT5_LOGIN || '').trim();
  const password = String(process.env.MT5_PASSWORD || '');
  const server = String(process.env.MT5_SERVER || '').trim();
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured.');
  if (!login || !password || !server) throw new Error('Legacy MT5_LOGIN, MT5_PASSWORD and MT5_SERVER are required for this one-time migration.');
  await mongoose.connect(process.env.MONGODB_URI);
  const owner = await User.findOne({}).sort({ createdAt: 1 });
  if (!owner) throw new Error('Create the journal owner before migrating an account.');

  const alreadyManaged = await TradingAccount.findOne({ user: owner._id, archivedAt: null });
  if (alreadyManaged) {
    console.log('A database-managed trading account already exists; no credentials or trades were changed.');
    return;
  }

  const accountId = new mongoose.Types.ObjectId();
  const context = field => `${owner._id}:${accountId}:${field}`;
  const accountKey = `mt5:${accountId}`;
  const label = process.env.MT5_ACCOUNT_LABEL || 'Primary MT5 Account';
  const legacyKey = `${server.toLowerCase()}::${login}`;
  const liveCount = await Trade.countDocuments({ user: owner._id, accountType: 'live' });
  const demoCount = await Trade.countDocuments({ user: owner._id, accountType: 'demo' });

  await TradingAccount.create({
    _id: accountId,
    user: owner._id,
    accountKey,
    provider: 'mt5',
    label,
    credentials: {
      login: encryptCredential(login, context('login')),
      password: encryptCredential(password, context('password')),
      server: encryptCredential(server, context('server')),
    },
    enabled: true,
    requireRealAccount: String(process.env.MT5_REQUIRE_REAL_ACCOUNT || 'false').toLowerCase() === 'true',
    symbolAliases: process.env.MT5_SYMBOL_ALIASES || '',
    actualAccountType: liveCount >= demoCount ? 'live' : 'demo',
    lastStatus: 'pending',
  });

  const tradeResult = await Trade.updateMany(
    { user: owner._id, $or: [{ accountKey: legacyKey }, { accountKey: '' }, { accountKey: null }, { accountKey: { $exists: false } }] },
    { $set: { accountKey, tradingAccount: accountId, accountName: label, accountLogin: '', accountServer: '' } },
  );
  const eventResult = await AccountEvent.updateMany(
    { user: owner._id, source: 'mt5' },
    { $set: { accountKey, tradingAccount: accountId } },
  );
  console.log(`Encrypted one MT5 account and linked ${tradeResult.modifiedCount} trades plus ${eventResult.modifiedCount} account events.`);
  console.log('Remove MT5_LOGIN, MT5_PASSWORD and MT5_SERVER from the root .env after verifying the Accounts page.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
