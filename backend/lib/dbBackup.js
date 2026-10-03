// Database-to-database backups: the live MongoDB database is copied, every
// collection and index, into a dated database on a separate backup cluster
// (backup_YYYY-MM-DD). Each copy is counted against the source and marked
// complete only once it checks out; older copies beyond the retention count
// are dropped. Used by scripts/backup-to-database.js (nightly, from GitHub
// Actions) and scripts/restore-from-backup.js.

const PREFIX = 'backup_';
const MARKER = '_backup_meta';            // one document in each backup: what, when, counts
const DAY_NAME = /^backup_\d{4}-\d{2}-\d{2}$/;

const backupName = (date = new Date()) => `${PREFIX}${date.toISOString().slice(0, 10)}`;

/** The live database's name: MONGODB_DB_NAME, else the URI's path, else Mongo's default. */
function sourceDbName(uri, override) {
  if (override) return override;
  const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(String(uri || ''));
  return m && m[1] ? decodeURIComponent(m[1]) : 'test';
}

async function collectionNames(db) {
  const list = await db.listCollections({}, { nameOnly: false }).toArray();
  return list
    .filter(c => (c.type || 'collection') === 'collection' && !c.name.startsWith('system.') && c.name !== MARKER)
    .map(c => c.name)
    .sort();
}

/** Copy every collection (documents, then indexes) from src to dst. Returns { name: copiedCount }. */
async function copyCollections(src, dst, { batchSize = 1000, log = () => {} } = {}) {
  const counts = {};
  for (const name of await collectionNames(src)) {
    const from = src.collection(name), to = dst.collection(name);
    let batch = [], copied = 0;
    for await (const doc of from.find({}, { batchSize })) {
      batch.push(doc);
      if (batch.length >= batchSize) { await to.insertMany(batch, { ordered: false }); copied += batch.length; batch = []; }
    }
    if (batch.length) { await to.insertMany(batch, { ordered: false }); copied += batch.length; }
    for (const index of await from.indexes()) {
      if (index.name === '_id_') continue;
      const { key, v, ns, ...options } = index;
      try { await to.createIndex(key, options); } catch (err) { log(`  index ${name}.${index.name} not copied: ${err.message}`); }
    }
    counts[name] = copied;
    log(`  ${name}: ${copied}`);
  }
  return counts;
}

/**
 * Every collection in dst holds what was copied, and the source still holds at
 * least that many (it can grow while the copy runs, but not lose documents).
 */
async function verifyCopy(src, dst, counts) {
  const problems = [];
  for (const [name, copied] of Object.entries(counts)) {
    const inBackup = await dst.collection(name).countDocuments();
    if (inBackup !== copied) problems.push(`${name}: copied ${copied}, backup holds ${inBackup}`);
    const inSource = await src.collection(name).countDocuments();
    if (inSource < copied) problems.push(`${name}: source now holds ${inSource}, fewer than the ${copied} copied`);
  }
  return problems;
}

/** Backups on the backup cluster, newest first, with their markers (null = incomplete). */
async function listBackups(backupClient) {
  const { databases } = await backupClient.db().admin().listDatabases({ nameOnly: true });
  const names = databases.map(d => d.name).filter(n => n.startsWith(PREFIX)).sort().reverse();
  const out = [];
  for (const name of names) {
    const marker = await backupClient.db(name).collection(MARKER).findOne({}).catch(() => null);
    out.push({ name, marker });
  }
  return out;
}

/** Drop dated backups beyond the newest `keep` complete ones (incomplete leftovers too). Returns dropped names. */
async function pruneBackups(backupClient, keep, { today = backupName(), log = () => {} } = {}) {
  const all = await listBackups(backupClient);
  const dated = all.filter(b => DAY_NAME.test(b.name));
  const complete = dated.filter(b => b.marker?.completedAt);
  const keepNames = new Set(complete.slice(0, Math.max(1, keep)).map(b => b.name));
  const dropped = [];
  for (const b of dated) {
    if (keepNames.has(b.name) || b.name === today) continue;
    await backupClient.db(b.name).dropDatabase();
    dropped.push(b.name);
    log(`  dropped ${b.name}${b.marker?.completedAt ? '' : ' (incomplete)'}`);
  }
  return dropped;
}

/**
 * Back up `sourceDb` into `backupClient`'s database `name`. An earlier
 * incomplete (or, with force, complete) copy of the same name is replaced.
 */
async function runBackup({ sourceDb, backupClient, name = backupName(), keep = 7, force = false, log = () => {} }) {
  const started = Date.now();
  const target = backupClient.db(name);
  const existing = await target.collection(MARKER).findOne({}).catch(() => null);
  if (existing?.completedAt && !force) {
    log(`${name} already exists and is complete; nothing to do (use --force to redo it).`);
    return { name, skipped: true };
  }
  await target.dropDatabase();
  log(`Copying "${sourceDb.databaseName}" into ${name}...`);
  const counts = await copyCollections(sourceDb, target, { log });
  const problems = await verifyCopy(sourceDb, target, counts);
  if (problems.length) {
    const err = new Error(`Backup ${name} failed its check:\n  ${problems.join('\n  ')}`);
    err.problems = problems;
    throw err; // left without a marker: never treated as a usable backup, pruned next time
  }
  const documents = Object.values(counts).reduce((a, b) => a + b, 0);
  await target.collection(MARKER).insertOne({
    source: sourceDb.databaseName, startedAt: new Date(started), completedAt: new Date(),
    collections: counts, documents, seconds: Math.round((Date.now() - started) / 1000),
  });
  log(`${name}: ${Object.keys(counts).length} collections, ${documents} documents, checked.`);
  const dropped = await pruneBackups(backupClient, keep, { today: name, log });
  return { name, counts, documents, dropped };
}

/**
 * Restore backup `name` into `liveDb`: each collection in the backup replaces
 * the live one (documents and indexes). Collections that only exist live are
 * left alone. Refuses an incomplete backup.
 */
async function restoreBackup({ backupClient, name, liveDb, log = () => {} }) {
  const source = backupClient.db(name);
  const marker = await source.collection(MARKER).findOne({});
  if (!marker?.completedAt) throw new Error(`${name} is not a complete backup.`);
  for (const coll of await collectionNames(source)) {
    try { await liveDb.collection(coll).drop(); } catch (err) { if (err.codeName !== 'NamespaceNotFound' && err.code !== 26) throw err; }
  }
  log(`Restoring ${name} into "${liveDb.databaseName}"...`);
  const counts = await copyCollections(source, liveDb, { log });
  const problems = [];
  for (const [coll, copied] of Object.entries(counts)) {
    const inLive = await liveDb.collection(coll).countDocuments();
    if (inLive !== copied) problems.push(`${coll}: restored ${copied}, live holds ${inLive}`);
    if (marker.collections && marker.collections[coll] != null && marker.collections[coll] !== copied) problems.push(`${coll}: backup recorded ${marker.collections[coll]}, restored ${copied}`);
  }
  if (problems.length) throw new Error(`Restore of ${name} did not check out:\n  ${problems.join('\n  ')}`);
  return counts;
}

module.exports = { PREFIX, MARKER, backupName, sourceDbName, collectionNames, copyCollections, verifyCopy, listBackups, pruneBackups, runBackup, restoreBackup };
