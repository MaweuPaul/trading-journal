const test = require('node:test');
const assert = require('node:assert/strict');
const { backupName, sourceDbName, runBackup, restoreBackup, listBackups, pruneBackups, backupsToKeep, MARKER } = require('../lib/dbBackup');

// A small in-memory stand-in for the MongoDB driver calls the backup uses.
function fakeClient() {
  const dbs = new Map(); // name -> Map(collection -> { docs: [], indexes: [] })
  const dbFor = name => {
    if (!dbs.has(name)) dbs.set(name, new Map());
    const cols = () => dbs.get(name) || dbs.set(name, new Map()).get(name);
    const collection = cname => {
      const get = () => { if (!cols().has(cname)) cols().set(cname, { docs: [], indexes: [{ name: '_id_', key: { _id: 1 }, v: 2 }] }); return cols().get(cname); };
      return {
        async *find() { for (const d of [...(cols().get(cname)?.docs || [])]) yield structuredClone(d); },
        async insertMany(list) { get().docs.push(...list.map(d => structuredClone(d))); },
        async insertOne(doc) { get().docs.push(structuredClone(doc)); },
        async findOne() { return cols().get(cname)?.docs[0] ?? null; },
        async countDocuments() { return cols().get(cname)?.docs.length ?? 0; },
        async indexes() { return structuredClone(cols().get(cname)?.indexes || []); },
        async createIndex(key, opts) { get().indexes.push({ key, ...opts }); },
        async drop() { if (!cols().has(cname)) { const e = new Error('ns not found'); e.codeName = 'NamespaceNotFound'; throw e; } cols().delete(cname); },
      };
    };
    return {
      databaseName: name,
      collection,
      listCollections: () => ({ toArray: async () => [...cols().keys()].map(n => ({ name: n, type: 'collection' })) }),
      dropDatabase: async () => { dbs.delete(name); },
      admin: () => ({ listDatabases: async () => ({ databases: [...dbs.keys()].filter(n => dbs.get(n).size).map(n => ({ name: n })) }) }),
    };
  };
  return { db: name => dbFor(name || 'admin'), dbs };
}

const seed = async (db) => {
  await db.collection('trades').insertMany(Array.from({ length: 2500 }, (_, i) => ({ _id: `t${i}`, user: i % 3, pnl: i })));
  await db.collection('users').insertMany([{ _id: 'u1', email: 'a@b.c' }, { _id: 'u2', email: 'd@e.f' }]);
  await db.collection('trades').createIndex({ user: 1, closeTime: -1 }, { name: 'user_1_closeTime_-1' });
};

test('names', () => {
  assert.equal(backupName(new Date('2026-10-03T23:59:00Z')), 'backup_2026-10-03');
  assert.equal(sourceDbName('mongodb+srv://u:p@c.mongodb.net/tradejournal?retryWrites=true'), 'tradejournal');
  assert.equal(sourceDbName('mongodb+srv://u:p@c.mongodb.net/?retryWrites=true'), 'test');
  assert.equal(sourceDbName('mongodb://x/y', 'forced'), 'forced');
});

test('backs up every collection and index, checks it, and marks it complete', async () => {
  const live = fakeClient(), backup = fakeClient();
  const src = live.db('tradejournal'); await seed(src);
  const r = await runBackup({ sourceDb: src, backupClient: backup, name: 'backup_2026-10-03' });
  assert.deepEqual(r.counts, { trades: 2500, users: 2 });
  const copy = backup.db('backup_2026-10-03');
  assert.equal(await copy.collection('trades').countDocuments(), 2500);
  assert.ok((await copy.collection('trades').indexes()).some(i => i.name === 'user_1_closeTime_-1'), 'indexes copied');
  const marker = await copy.collection(MARKER).findOne({});
  assert.ok(marker.completedAt);
  assert.equal(marker.documents, 2502);
  // Run again the same day: nothing to do unless forced.
  assert.equal((await runBackup({ sourceDb: src, backupClient: backup, name: 'backup_2026-10-03' })).skipped, true);
});

test('a copy that does not check out is never marked complete', async () => {
  const live = fakeClient(), backup = fakeClient();
  const src = live.db('tradejournal'); await seed(src);
  const real = backup.db;
  // The backup cluster silently drops one document of each batch.
  backup.db = name => { const d = real(name); const coll = d.collection; d.collection = c => { const x = coll(c); const ins = x.insertMany; x.insertMany = list => ins(list.slice(1)); return x; }; return d; };
  await assert.rejects(runBackup({ sourceDb: src, backupClient: backup, name: 'backup_2026-10-03' }), /failed its check/);
  backup.db = real;
  assert.equal(await backup.db('backup_2026-10-03').collection(MARKER).findOne({}), null);
});

test('keeps the newest N complete backups and clears incomplete leftovers', async () => {
  const live = fakeClient(), backup = fakeClient();
  const src = live.db('tradejournal'); await seed(src);
  for (const day of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']) await runBackup({ sourceDb: src, backupClient: backup, name: `backup_${day}`, prune: false });
  await backup.db('backup_2026-09-27').collection('trades').insertOne({ _id: 'half' }); // an interrupted run, no marker
  await backup.db('backup_prerestore_20261001T10').collection('x').insertOne({ _id: 1 });
  const dropped = await pruneBackups(backup, { daily: 2, weekly: 0, monthly: 0 }, { today: 'backup_2026-10-01' });
  assert.deepEqual(dropped.sort(), ['backup_2026-09-27', 'backup_2026-09-28', 'backup_2026-09-29']);
  const left = (await listBackups(backup)).map(b => b.name);
  assert.deepEqual(left, ['backup_prerestore_20261001T10', 'backup_2026-10-01', 'backup_2026-09-30'], 'safety copies are never pruned');
});

test('restore replaces collections from a complete backup and refuses an incomplete one', async () => {
  const live = fakeClient(), backup = fakeClient();
  const src = live.db('tradejournal'); await seed(src);
  await runBackup({ sourceDb: src, backupClient: backup, name: 'backup_2026-10-03' });
  // Disaster: trades wiped, a stray collection added.
  await src.collection('trades').drop();
  await src.collection('trades').insertOne({ _id: 'only-one' });
  await src.collection('scratch').insertOne({ _id: 's' });
  const counts = await restoreBackup({ backupClient: backup, name: 'backup_2026-10-03', liveDb: src });
  assert.deepEqual(counts, { trades: 2500, users: 2 });
  assert.equal(await src.collection('trades').countDocuments(), 2500);
  assert.equal(await src.collection('scratch').countDocuments(), 1, 'collections only in the live database are left alone');
  await backup.db('backup_2026-10-04').collection('trades').insertOne({ _id: 'x' });
  await assert.rejects(restoreBackup({ backupClient: backup, name: 'backup_2026-10-04', liveDb: src }), /not a complete backup/);
});

test('a year of nightly runs keeps 7 daily, 8 weekly and 12 monthly copies', () => {
  // Simulate the prune after every night for a year; a backup, once dropped, is gone.
  let held = [];
  const start = Date.UTC(2025, 9, 4); // 2025-10-04
  for (let d = 0; d < 366; d++) {
    const name = backupName(new Date(start + d * 864e5));
    held = [name, ...held];                       // newest first
    const keep = backupsToKeep(held);
    held = held.filter(n => keep.has(n));
  }
  const days = held.map(n => n.slice(7));
  assert.equal(days[0], '2026-10-04');
  assert.deepEqual(days.slice(0, 7), ['2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01', '2026-09-30', '2026-09-29', '2026-09-28'], 'last 7 days');
  assert.ok(held.length <= 7 + 8 + 12 && held.length >= 20, `kept ${held.length}`);
  const months = new Set(days.map(d => d.slice(0, 7)));
  assert.ok(months.size >= 12, 'one copy in each of the last 12 months');
  assert.ok(days.some(d => d.startsWith('2025-11')), 'reaches back about a year');
  // Weekly copies: each of the last 8 weeks has one.
  const weeks = new Set(days.filter(d => d >= '2026-08-10').map(d => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); }));
  assert.ok(weeks.size >= 8, `weeks covered: ${weeks.size}`);
});

test('a missed night does not lose the weekly or monthly copy', () => {
  // No backup on Sunday 2026-09-27 or on 2026-08-31: the newest of that week/month stands in.
  const names = ['2026-10-04', '2026-09-26', '2026-09-25', '2026-08-30', '2026-08-29'].map(d => `backup_${d}`);
  const keep = backupsToKeep(names, { daily: 1, weekly: 3, monthly: 3 });
  assert.deepEqual([...keep.keys()].sort(), ['backup_2026-08-30', 'backup_2026-09-26', 'backup_2026-10-04']);
});
