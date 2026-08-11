const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReplayAnnotations, normalizeReplayEvents, normalizeQuickReview, normalizeReplayDraft } = require('../lib/replayAnnotations');

test('normalizes valid text, line, and zone annotations', () => {
  const annotations = normalizeReplayAnnotations('15min', [
    { id: 'text-1', type: 'text', time: 100, price: 200, text: '  Wait for confirmation  ', color: '#10b981' },
    { id: 'line-1', type: 'line', time1: 100, time2: 200, price1: 10, price2: 20, color: '#ef4444' },
    { id: 'rect-1', type: 'rect', time1: 100, time2: 200, price1: 10, price2: 20, color: 'invalid' },
  ]);
  assert.equal(annotations[0].text, 'Wait for confirmation');
  assert.equal(annotations[2].color, '#3b82f6');
  assert.equal(annotations.length, 3);
});

test('rejects unsupported timeframes and duplicate IDs', () => {
  assert.throws(() => normalizeReplayAnnotations('2h', []), /Unsupported/);
  assert.throws(() => normalizeReplayAnnotations('5min', [
    { id: 'same', type: 'text', time: 1, price: 1, text: 'A' },
    { id: 'same', type: 'text', time: 2, price: 2, text: 'B' },
  ]), /duplicated/);
});

test('rejects empty text and non-numeric chart coordinates', () => {
  assert.throws(() => normalizeReplayAnnotations('1h', [{ id: 'empty', type: 'text', time: 1, price: 1, text: ' ' }]), /cannot be empty/);
  assert.throws(() => normalizeReplayAnnotations('1h', [{ id: 'bad', type: 'line', time1: 'x', time2: 2, price1: 1, price2: 2 }]), /finite number/);
});

test('normalizes Replay timeline events', () => {
  const [event] = normalizeReplayEvents([{ eventId: 'event-1', timeframe: '5min', candleTime: 100, price: 200, eventType: 'mistake', title: 'Entered too early', note: 'Wait for confirmation', severity: 'critical' }]);
  assert.equal(event.title, 'Entered too early');
  assert.equal(event.severity, 'critical');
  assert.equal(event.timeframe, '5min');
});

test('rejects invalid Replay timeline events', () => {
  assert.throws(() => normalizeReplayEvents([{ eventId: 'event-1', timeframe: '2h', candleTime: 1, price: 1, eventType: 'mistake', title: 'Bad timeframe' }]), /unsupported timeframe/);
  assert.throws(() => normalizeReplayEvents([{ eventId: 'event-1', timeframe: '5min', candleTime: 1, price: 1, eventType: 'unknown', title: 'Bad type' }]), /unsupported type/);
  assert.throws(() => normalizeReplayEvents([{ eventId: 'event-1', timeframe: '5min', candleTime: 1, price: 1, eventType: 'lesson', title: '' }]), /needs a title/);
});

test('supports Quick Review drafts and validates completion', () => {
  const draft = normalizeQuickReview({ followedPlan: false, primaryEmotion: 'FOMO' });
  assert.equal(draft.completedAt, null);
  assert.throws(() => normalizeQuickReview({ followedPlan: false, processGrade: 'C', lesson: 'Wait', completedAt: new Date().toISOString() }), /main mistake/);
  const complete = normalizeQuickReview({ followedPlan: true, primaryStrength: 'Waited for confirmation', lesson: 'Repeat the process', processGrade: 'A', completedAt: new Date().toISOString() });
  assert.equal(complete.processGrade, 'A');
  assert.ok(complete.completedAt);
});

test('normalizes unfinished Replay drafts without accepting unsafe sizes', () => {
  const draft = normalizeReplayDraft({ notes: 'unfinished', tags: ['focus'], selectedInterval: '15min', replayIdx: 42, speed: 2, journalPhase: 'manage', playbookResponses: { rule: true } });
  assert.equal(draft.selectedInterval, '15min'); assert.equal(draft.replayIdx, 42); assert.equal(draft.journalPhase, 'manage');
  assert.throws(() => normalizeReplayDraft({ playbookResponses: { large: 'x'.repeat(100001) } }), /too large/);
});
