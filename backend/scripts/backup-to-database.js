#!/usr/bin/env node
// Nightly backup: copies the whole live database into a dated database
// (backup_YYYY-MM-DD) on a separate backup cluster, checks the copy, and keeps
// 7 daily, 8 weekly and 12 monthly copies (BACKUP_KEEP, BACKUP_KEEP_WEEKLY,
// BACKUP_KEEP_MONTHLY). Runs from GitHub Actions
// (.github/workflows/db-backup.yml); can also be run by hand:
//
//   MONGODB_URI=... BACKUP_MONGODB_URI=... node scripts/backup-to-database.js [--force] [--list]
//
// MONGODB_DB_NAME picks the live database when the URI doesn't name one.
require('dotenv').config();
const { MongoClient } = require('mongodb');
const { runBackup, listBackups, sourceDbName } = require('../lib/dbBackup');

const args = new Set(process.argv.slice(2));
const { MONGODB_URI, BACKUP_MONGODB_URI, MONGODB_DB_NAME } = process.env;
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Math.max(0, Math.floor(Number(v))));
const RETENTION = {
  daily: Math.max(1, num(process.env.BACKUP_KEEP, 7)),
  weekly: num(process.env.BACKUP_KEEP_WEEKLY, 8),
  monthly: num(process.env.BACKUP_KEEP_MONTHLY, 12),
};

(async () => {
  if (!BACKUP_MONGODB_URI) throw new Error('BACKUP_MONGODB_URI is not set (the backup cluster).');
  if (!args.has('--list')) {
    if (!MONGODB_URI) throw new Error('MONGODB_URI is not set (the live database).');
    if (MONGODB_URI === BACKUP_MONGODB_URI) throw new Error('BACKUP_MONGODB_URI must point at a different cluster than MONGODB_URI.');
  }
  const backup = await MongoClient.connect(BACKUP_MONGODB_URI, { serverSelectionTimeoutMS: 30000 });
  try {
    if (args.has('--list')) {
      for (const b of await listBackups(backup)) {
        const m = b.marker;
        console.log(`${b.name}  ${m?.completedAt ? `complete ${new Date(m.completedAt).toISOString()}, ${m.documents} documents` : 'INCOMPLETE'}`);
      }
      return;
    }
    const live = await MongoClient.connect(MONGODB_URI, { serverSelectionTimeoutMS: 30000 });
    try {
      const sourceDb = live.db(sourceDbName(MONGODB_URI, MONGODB_DB_NAME));
      const result = await runBackup({ sourceDb, backupClient: backup, retention: RETENTION, force: args.has('--force'), log: m => console.log(m) });
      if (!result.skipped) console.log(`Done: ${result.name}, ${result.documents} documents${result.dropped.length ? `; removed ${result.dropped.join(', ')}` : ''}.`);
    } finally { await live.close(); }
  } finally { await backup.close(); }
})().catch(err => { console.error(`Backup failed: ${err.message}`); process.exit(1); });
