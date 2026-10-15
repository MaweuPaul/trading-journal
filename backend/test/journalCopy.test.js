const test = require('node:test');
const assert = require('node:assert/strict');
const { hasJournal, journalCopyUpdate } = require('../lib/journalCopy');

const snapshot = { playbookId: 'pb1', versionId: 'v1', versionNumber: 1, name: 'HTF Fib', blocks: [] };
const source = {
  _id: 'a', accountKey: 'ctrader:1', stopLoss: 100, riskUSD: 50, isReEntry: true, parentTradeId: 'p', tradeGroup: 'p',
  notes: 'Fib 61.8 hold', tags: ['A+'], analysisGrade: 'A', executionGrade: 'B', primarySetup: 'HTF Fib',
  checklist: [{ _id: 'c1', rule: 'Bias', complied: true }],
  playbookId: 'pb1', playbookVersionId: 'v1', playbookSnapshot: snapshot, playbookResponses: { r1: true },
  screenshots: [{ _id: 's1', url: 'https://img/1.png', publicId: 'img1', playbookRuleId: 'r1', playbookVersionId: 'v1' }],
};

test('copies what was written, not broker facts or re-entry links', () => {
  const set = journalCopyUpdate(source, { _id: 'b', screenshots: [] });
  assert.equal(set.notes, 'Fib 61.8 hold');
  assert.equal(set.analysisGrade, 'A');
  assert.deepEqual(set.playbookResponses, { r1: true });
  assert.equal(set.playbookSnapshot.versionId, 'v1');
  for (const key of ['stopLoss', 'riskUSD', 'accountKey', 'isReEntry', 'parentTradeId', 'tradeGroup']) assert.equal(key in set, false, key);
  assert.deepEqual(set.checklist, [{ rule: 'Bias', complied: true }]);
  assert.equal(set.screenshots.length, 1);
  assert.equal(set.screenshots[0].publicId, 'img1');
  assert.equal('_id' in set.screenshots[0], false);
});

test('keeps the target screenshots and skips ones it already has', () => {
  const own = { _id: 's9', url: 'https://img/9.png', publicId: 'img9' };
  assert.equal(journalCopyUpdate(source, { screenshots: [own] }).screenshots.length, 2);
  assert.equal('screenshots' in journalCopyUpdate(source, { screenshots: [{ ...source.screenshots[0], _id: 'x' }] }), false);
});

test('refuses a target locked to another playbook version, allows the same one', () => {
  assert.throws(() => journalCopyUpdate(source, { playbookSnapshot: { ...snapshot, versionId: 'v2', versionNumber: 2 } }), err => err.status === 409);
  assert.equal(journalCopyUpdate(source, { playbookSnapshot: snapshot }).playbookId, 'pb1');
});

test('a source without a playbook leaves the target playbook alone', () => {
  const set = journalCopyUpdate({ notes: 'n' }, { playbookSnapshot: snapshot });
  assert.equal('playbookSnapshot' in set, false);
  assert.equal('playbookResponses' in set, false);
});

test('hasJournal', () => {
  assert.equal(hasJournal({ notes: '  ', tags: [] }), false);
  assert.equal(hasJournal(source), true);
  assert.equal(hasJournal({ analysisGrade: 'B' }), true);
});
