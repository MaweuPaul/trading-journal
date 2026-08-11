const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReplayAnnotations } = require('../lib/replayAnnotations');

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
