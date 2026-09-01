#!/usr/bin/env node
// Full MongoDB backup using mongodump -- covers every collection (trades,
// accounts, credentials, journals, everything), unlike the in-app "Download
// JSON" export on the Backup page, which only covers trades/account
// events/Replay journals. Restore with:
//   mongorestore --uri="<MONGODB_URI>" --drop <dump-folder>/trade_journal
//
// Usage:
//   node scripts/backup-database.js
//
// Requires the MongoDB Database Tools (mongodump) to be installed and on
// PATH -- https://www.mongodb.com/try/download/database-tools

require('dotenv').config();
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set in backend/.env -- nothing to back up.');
  process.exit(1);
}

const BACKUPS_ROOT = path.join(__dirname, '..', 'db-backups');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(BACKUPS_ROOT, timestamp);
fs.mkdirSync(outDir, { recursive: true });

console.log(`Backing up database to ${outDir} ...`);
const result = spawnSync('mongodump', ['--uri', MONGODB_URI, '--out', outDir], {
  stdio: 'inherit',
});

if (result.error) {
  console.error('Could not run mongodump -- is it installed and on PATH?');
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`mongodump exited with code ${result.status}.`);
  process.exit(result.status || 1);
}

console.log(`Backup complete: ${outDir}`);
