// Copying one trade's journal onto another: the same trade taken on several
// accounts has the same analysis, so it shouldn't have to be filled in twice.
// Only what the trader wrote is copied. Broker facts (prices, stop, risk)
// and links that belong to one account's trade (re-entry parent, group)
// stay as they are.

const JOURNAL_FIELDS = [
  'notes', 'tags', 'emotion', 'grade',
  'analysisGrade', 'executionGrade', 'plannedRR', 'exitReason', 'manuallyIntervened', 'confidenceRating',
  'primarySetup', 'setupConfirmations', 'checklist', 'executionChecklist',
];

const plain = value => JSON.parse(JSON.stringify(value ?? null));

/** True when a trade has anything journaled worth copying. */
function hasJournal(trade) {
  if (!trade) return false;
  return Boolean(
    String(trade.notes || '').trim() || trade.analysisGrade || trade.executionGrade || trade.grade
    || trade.playbookSnapshot || trade.primarySetup || trade.emotion
    || (trade.tags || []).length || (trade.setupConfirmations || []).length
    || (trade.screenshots || []).length,
  );
}

/**
 * The $set that copies `source`'s journal onto `target`. Throws (status 409)
 * when the target is already locked to another playbook version, since a
 * trade's playbook snapshot can never be replaced.
 */
function journalCopyUpdate(source, target) {
  const set = {};
  for (const key of JOURNAL_FIELDS) {
    if (source[key] !== undefined) set[key] = plain(source[key]);
  }
  // Checklists are subdocuments: drop their ids so the copy gets its own.
  for (const key of ['checklist', 'executionChecklist']) {
    if (Array.isArray(set[key])) set[key] = set[key].map(({ _id, ...item }) => item);
  }

  const from = source.playbookSnapshot, locked = target.playbookSnapshot;
  if (from) {
    if (locked && (String(locked.playbookId) !== String(from.playbookId) || String(locked.versionId) !== String(from.versionId))) {
      const err = new Error(`This trade is permanently attached to ${locked.name} v${locked.versionNumber}, so a journal written against ${from.name} v${from.versionNumber} can't be copied onto it.`);
      err.status = 409;
      throw err;
    }
    set.playbookId = source.playbookId || from.playbookId || '';
    set.playbookVersionId = source.playbookVersionId || from.versionId || '';
    set.playbookSnapshot = plain(from);
    set.playbookResponses = plain(source.playbookResponses || {});
  }

  // Screenshots point at the same stored image; ones the target already has are skipped.
  const have = new Set((target.screenshots || []).map(s => s.publicId));
  const added = (source.screenshots || [])
    .filter(s => s.publicId && !have.has(s.publicId))
    .map(({ _id, ...shot }) => plain(shot));
  if (added.length) set.screenshots = [...plain(target.screenshots || []), ...added];

  return set;
}

module.exports = { JOURNAL_FIELDS, hasJournal, journalCopyUpdate };
