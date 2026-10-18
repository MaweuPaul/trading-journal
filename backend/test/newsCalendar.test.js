const test = require('node:test');
const assert = require('node:assert/strict');
const { currenciesForSymbol } = require('../lib/newsCalendar');
const { eventFromFeed } = require('../lib/newsSync');

test('Forex Factory feed rows become stored events in UTC', () => {
  // The feed's times carry New York's offset: 08:30 EDT = 12:30 UTC.
  const e = eventFromFeed({ title: 'CPI m/m', country: 'CAD', date: '2026-10-19T08:30:00-04:00', impact: 'High', forecast: '0.2%', previous: '' });
  assert.equal(e.time.toISOString(), '2026-10-19T12:30:00.000Z');
  assert.equal(e.key, 'forex-factory|CAD|CPI m/m|2026-10-19T12:30:00.000Z');
  assert.equal(e.impact, 'High');
  assert.equal(e.forecast, '0.2%');
  assert.equal(e.previous, null);
  assert.equal(eventFromFeed({ title: 'Bank Holiday', country: 'GBP', date: '2026-12-25T03:00:00-05:00', impact: 'Holiday' }).impact, 'None');
  assert.equal(eventFromFeed({ title: 'IMF Meetings', country: 'All', date: '2026-10-18T10:15:00-04:00', impact: 'Low' }), null);
  assert.equal(eventFromFeed({ title: 'x', country: 'USD', date: 'soon' }), null);
});

test('currenciesForSymbol', () => {
  assert.deepEqual(currenciesForSymbol('EURUSD'), ['EUR', 'USD']);
  assert.deepEqual(currenciesForSymbol('gbpjpy.pro'), ['GBP', 'JPY']);
  assert.deepEqual(currenciesForSymbol('XAUUSD'), ['USD']);
  assert.deepEqual(currenciesForSymbol('US30.pro'), ['USD']);
  assert.deepEqual(currenciesForSymbol('Nasdaq100'), ['USD']);
  assert.deepEqual(currenciesForSymbol('GER40'), ['EUR']);
  assert.deepEqual(currenciesForSymbol('UK100'), ['GBP']);
  assert.deepEqual(currenciesForSymbol('Germany 40'), ['EUR']);
  assert.deepEqual(currenciesForSymbol('Japan 225'), ['JPY']);
  assert.deepEqual(currenciesForSymbol('China A50'), ['CNY']);
  assert.deepEqual(currenciesForSymbol('SWI20'), ['CHF']);
  assert.deepEqual(currenciesForSymbol('UKOIL'), ['USD'], 'Brent is priced in dollars, not a UK index');
  assert.deepEqual(currenciesForSymbol('USTEC'), ['USD']);
});
