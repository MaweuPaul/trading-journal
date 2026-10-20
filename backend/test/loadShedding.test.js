const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createLoadShedder } = require('../lib/loadShedding');

function fakeRes() {
  const res = new EventEmitter();
  res.headers = {};
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}

test('refuses with 503 and Retry-After once too many requests are in progress', t => {
  const shedder = createLoadShedder({ maxInFlight: 2 });
  t.after(() => shedder.stop());
  const open = [fakeRes(), fakeRes()];
  let passed = 0;
  for (const res of open) shedder.middleware({ path: '/api/x' }, res, () => { passed += 1; });
  assert.equal(passed, 2);

  const third = fakeRes();
  shedder.middleware({ path: '/api/x' }, third, () => { passed += 1; });
  assert.equal(passed, 2);
  assert.equal(third.statusCode, 503);
  assert.equal(third.headers['Retry-After'], '5');

  open[0].emit('finish');
  open[0].emit('close'); // both fire for one response; counted once
  const fourth = fakeRes();
  shedder.middleware({ path: '/api/x' }, fourth, () => { passed += 1; });
  assert.equal(passed, 3, 'a finished request frees its slot');
  assert.deepEqual(
    { inFlight: shedder.stats().inFlight, shed: shedder.stats().shed, peak: shedder.stats().peakInFlight },
    { inFlight: 2, shed: 1, peak: 2 },
  );
});

test('never refuses exempt paths like the health check', t => {
  const shedder = createLoadShedder({ maxInFlight: 0, exempt: req => req.path === '/health' });
  t.after(() => shedder.stop());
  let passed = false;
  shedder.middleware({ path: '/health' }, fakeRes(), () => { passed = true; });
  assert.equal(passed, true);
});
