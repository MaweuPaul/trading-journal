#!/usr/bin/env node
// Restore a nightly backup into the live database.
//
//   node scripts/restore-from-backup.js --list
//   node scripts/restore-from-backup.js --from backup_2026-10-03 --confirm <live database name>
//
// Before anything is replaced, the live database is itself copied to the
// backup cluster as backup_prerestore_<time>, so a restore can be undone.
// Collections in the backup replace the live ones; anything that exists only
// live is left as it is. Stop the backend (or expect a few failed requests)
// while it runs.
require('dotenv').config();
const { MongoClient } = require('mongodb');
const { runBackup, restoreBackup, listBackups, sourceDbName } = require('../lib/dbBackup');

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const { MONGODB_URI, BACKUP_MONGODB_URI, MONGODB_DB_NAME } = process.env;

(async () => {
  if (!BACKUP_MONGODB_URI) throw new Error('BACKUP_MONGODB_URI is not set (the backup cluster).');
  const backup = await MongoClient.connect(BACKUP_MONGODB_URI);
  try {
    const backups = await listBackups(backup);
    if (argv.includes('--list') || !opt('--from')) {
      for (const b of backups) console.log(`${b.name}  ${b.marker?.completedAt ? `complete, ${b.marker.documents} documents` : 'INCOMPLETE'}`);
      if (!argv.includes('--list')) console.log('\nPick one with --from <name> --confirm <live database name>.');
      return;
    }
    const from = opt('--from');
    const chosen = backups.find(b => b.name === from);
    if (!chosen?.marker?.completedAt) throw new Error(`${from} is not a complete backup on the backup cluster (see --list).`);
    if (!MONGODB_URI) throw new Error('MONGODB_URI is not set (the live database).');
    const live = await MongoClient.connect(MONGODB_URI);
    try {
      const liveDb = live.db(sourceDbName(MONGODB_URI, MONGODB_DB_NAME));
      if (opt('--confirm') !== liveDb.databaseName) {
        throw new Error(`This replaces data in the live database "${liveDb.databaseName}". Re-run with --confirm ${liveDb.databaseName} to go ahead.`);
      }
      const safety = `backup_prerestore_${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`;
      console.log(`Saving the current live data as ${safety} first...`);
      await runBackup({ sourceDb: liveDb, backupClient: backup, name: safety, prune: false, force: true, log: m => console.log(m) });
      const counts = await restoreBackup({ backupClient: backup, name: from, liveDb, log: m => console.log(m) });
      console.log(`Restored ${from}: ${Object.values(counts).reduce((a, b) => a + b, 0)} documents. To undo, restore ${safety}.`);
    } finally { await live.close(); }
  } finally { await backup.close(); }
})().catch(err => { console.error(`Restore failed: ${err.message}`); process.exit(1); });
