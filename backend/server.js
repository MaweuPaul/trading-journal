require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const tradesRouter = require('./routes/trades');
const authRouter = require('./routes/auth');
const tradingAccountsRouter = require('./routes/tradingAccounts');
const ctraderRouter = require('./routes/ctrader');
const investorRouter = require('./routes/investor');
const knowledgeRouter = require('./routes/knowledge');
const preTradeAnalysesRouter = require('./routes/preTradeAnalyses');
const backtestTradesRouter = require('./routes/backtestTrades');
const backtestStrategiesRouter = require('./routes/backtestStrategies');

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

// Reflecting every origin (origin: true) lets any website that a browser tab
// happens to have open call this API with the user's stored bearer token.
// Pin to an explicit allowlist instead; ALLOWED_ORIGINS is a comma-separated
// list of exact origins (e.g. "http://localhost:3000,https://myjournal.app").
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    // Same-origin requests, curl, and server-to-server calls send no Origin header.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Origin not allowed by CORS policy'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '25mb' }));

app.use(morgan('dev'));

// Serve offline screenshots as static files (for preview before Cloudinary upload)
app.use('/public', express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/auth', authRouter);
app.use('/api', tradingAccountsRouter);
app.use('/api', ctraderRouter);
app.use('/api', investorRouter);
app.use('/api', knowledgeRouter);
app.use('/api', preTradeAnalysesRouter);
app.use('/api', backtestTradesRouter);
app.use('/api', backtestStrategiesRouter);
app.use('/api', tradesRouter);

// Desktop Sync Agent download — serves the newest built .zip from
// desktop-py/release, which (unlike the git-ignored dist/build folders) is
// committed to the repo so it deploys along with the rest of the backend.
// Shipped as a --onedir build zipped up, not --onefile, since the onefile
// self-extracting stub is a common false-positive trigger for antivirus/
// browser download scanners on small unsigned Python apps.
app.get('/api/downloads/sync-agent', (req, res) => {
  const distDir = path.join(__dirname, '..', 'desktop-py', 'release');
  let installerFile;
  try {
    installerFile = require('fs')
      .readdirSync(distDir)
      .filter(name => name.endsWith('.zip'))
      .sort()
      .pop();
  } catch {
    installerFile = null;
  }
  if (!installerFile) {
    return res.status(404).json({ error: 'No installer has been built yet. Run "python build.py" in desktop-py/.' });
  }
  res.download(path.join(distDir, installerFile), installerFile);
});

// Lets the installed Sync Agent check whether a newer build exists, so it
// can show an "Update available" banner instead of silently going stale.
app.get('/api/downloads/sync-agent-version', (req, res) => {
  try {
    const version = require('fs')
      .readFileSync(path.join(__dirname, '..', 'desktop-py', 'VERSION'), 'utf8')
      .trim();
    res.json({ version });
  } catch {
    res.status(404).json({ error: 'No version file found.' });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// Start server immediately
app.listen(PORT, () => {
  console.log(` API server running on http://localhost:${PORT}`);
});

// Connect to MongoDB asynchronously
if (!process.env.MONGODB_URI) {
  console.warn(
    ' MONGODB_URI is not set or is empty. Operating in OFFLINE mode using local_trades.json.',
  );
} else {
  console.log(' Connecting to MongoDB...');
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
      console.log(' MongoDB connected');

      // Optionally seed the very first account from environment variables
      // (useful for a scripted first deploy); otherwise the database starts
      // empty and anyone can register normally at /signup.
      const User = require('./models/User');
      const bcrypt = require('bcryptjs');
      const crypto = require('crypto');
      try {
        const seedEnabled = String(process.env.SEED_OWNER_ENABLED || 'false').toLowerCase() === 'true';
        const ownerName = process.env.OWNER_NAME || process.env.ADMIN_NAME || 'Journal Owner';
        const ownerEmail = process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || '';
        const ownerPassword = process.env.OWNER_PASSWORD || process.env.ADMIN_PASSWORD || '';
        let owner = await User.findOne({}).sort({ createdAt: 1 }).select('+syncSecretHash');

        if (!owner && seedEnabled) {
          if (!ownerEmail || !ownerPassword || ownerPassword.length < 8) {
            console.warn(' Owner seed skipped: OWNER_EMAIL and an OWNER_PASSWORD of at least 8 characters are required.');
          } else {
            owner = await User.create({
              name: ownerName,
              email: ownerEmail.toLowerCase(),
              password: await bcrypt.hash(ownerPassword, 12),
              syncSecretHash: process.env.SYNC_SECRET
                ? crypto.createHash('sha256').update(process.env.SYNC_SECRET).digest('hex')
                : undefined,
            });
            console.log(` Account created from environment: ${ownerEmail}`);
          }
        } else if (owner) {
          // Pre-multi-user installations authenticated sync.py with one
          // shared SYNC_SECRET env value rather than a per-user secret. Seed
          // that value onto this (the original) account once, so an
          // existing sync.py setup keeps working unchanged after upgrading
          // — new users get their own generated secret from /register instead.
          if (!owner.syncSecretHash && process.env.SYNC_SECRET) {
            owner.syncSecretHash = crypto.createHash('sha256').update(process.env.SYNC_SECRET).digest('hex');
            await owner.save();
            console.log(' Migrated the shared SYNC_SECRET onto the original account.');
          }
          console.log(` Existing account retained: ${owner.email}`);
        } else {
          console.log(' No accounts exist yet. Register the first one at /signup.');
        }

        if (!owner) return;

        // Migration: assign legacy records without an owner to this installation's owner.
        const Trade = require('./models/Trade');
        const AccountEvent = require('./models/AccountEvent');
        const [tradeResult, eventResult] = await Promise.all([
          Trade.updateMany(
          { $or: [{ user: { $exists: false } }, { user: null }] },
          { $set: { user: owner._id } },
          ),
          AccountEvent.updateMany(
            { $or: [{ user: { $exists: false } }, { user: null }] },
            { $set: { user: owner._id } },
          ),
        ]);
        if (tradeResult.modifiedCount || eventResult.modifiedCount) {
          console.log(` Assigned ${tradeResult.modifiedCount} legacy trades and ${eventResult.modifiedCount} account events to the owner.`);
        }

        // MT5 deal tickets are unique inside an account, not across every broker
        // account. Create the account-aware index before retiring the legacy one.
        await Trade.collection.createIndex(
          { user: 1, accountKey: 1, dealId: 1 },
          { unique: true, name: 'user_1_accountKey_1_dealId_1' },
        );
        const tradeIndexes = await Trade.collection.indexes();
        const legacyDealIndex = tradeIndexes.find(index => (
          index.unique
          && index.key?.user === 1
          && index.key?.dealId === 1
          && Object.keys(index.key).length === 2
        ));
        if (legacyDealIndex) {
          await Trade.collection.dropIndex(legacyDealIndex.name);
          console.log(' Upgraded trade uniqueness to include the MT5 account identity.');
        }

        const eventIndexes = await AccountEvent.collection.indexes();
        const legacyEventIndex = eventIndexes.find(index => (
          index.unique
          && index.key?.user === 1
          && index.key?.externalId === 1
          && Object.keys(index.key).length === 2
        ));
        if (legacyEventIndex) await AccountEvent.collection.dropIndex(legacyEventIndex.name);
        await AccountEvent.collection.createIndex(
          { user: 1, accountKey: 1, externalId: 1 },
          { unique: true, partialFilterExpression: { source: 'mt5' }, name: 'user_1_accountKey_1_externalId_1' },
        );
      } catch (e) {
        console.error(' Owner setup or migration failed:', e.message);
      }
    })
    .catch((err) => {
      console.error(
        ' MongoDB connection failed on startup. Operating in OFFLINE mode using local_trades.json.',
      );
      console.error('Error details:', err.message);
    });
}
