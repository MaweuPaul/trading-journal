const test = require('node:test');
const assert = require('node:assert/strict');
const { pacedTrendbarRequest } = require('../lib/ctraderReplay');

// A fake cTrader client: answers "rate limited" the first `failures` times.
function fakeClient(failures, error = { errorCode: 'REQUEST_FREQUENCY_EXCEEDED', message: 'You are being rate limited' }) {
  const calls = [];
  return {
    calls,
    request: async () => {
      calls.push(Date.now());
      if (calls.length <= failures) throw Object.assign(new Error(error.message), error);
      return { trendbar: [] };
    },
  };
}

test('a rate-limited candle request is waited out and retried', async () => {
  const client = fakeClient(1);
  const res = await pacedTrendbarRequest(client, 'pace-a', {});
  assert.deepEqual(res, { trendbar: [] });
  assert.equal(client.calls.length, 2);
  assert.ok(client.calls[1] - client.calls[0] >= 900, 'waited before retrying');
});

test('retryAfter from cTrader decides the wait', async () => {
  const client = fakeClient(1, { errorCode: 'BLOCKED_PAYLOAD_TYPE', message: 'blocked', retryAfter: 2 });
  await pacedTrendbarRequest(client, 'pace-b', {});
  assert.ok(client.calls[1] - client.calls[0] >= 1900);
});

test('other errors are not retried', async () => {
  const client = fakeClient(1, { errorCode: 'SYMBOL_NOT_FOUND', message: 'no such symbol' });
  await assert.rejects(pacedTrendbarRequest(client, 'pace-c', {}), /no such symbol/);
  assert.equal(client.calls.length, 1);
});

test('requests on one account are spaced out', async () => {
  const client = fakeClient(0);
  await Promise.all([1, 2, 3, 4].map(() => pacedTrendbarRequest(client, 'pace-d', {})));
  const gaps = client.calls.slice(1).map((t, i) => t - client.calls[i]);
  assert.ok(gaps.every(g => g >= 230), `gaps ${gaps}`);
});
