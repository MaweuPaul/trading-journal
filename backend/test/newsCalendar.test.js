const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCalendarDate, normalizeEvent, currenciesForSymbol, monthRange, nextMonthToFetch } = require('../lib/newsCalendar');

test('calendar times are New York + 7h: US releases land on 08:30 New York in UTC', () => {
  // Winter (EST, UTC-5): 15:30 server = 08:30 New York = 13:30 UTC. The API docs' own CPI example.
  assert.equal(parseCalendarDate('2024.02.08 15:30:00').toISOString(), '2024-02-08T13:30:00.000Z');
  // Summer (EDT, UTC-4): NFP 2024-07-05 at 08:30 New York = 12:30 UTC.
  assert.equal(parseCalendarDate('2024.07.05 15:30:00').toISOString(), '2024-07-05T12:30:00.000Z');
  // The weeks when the US has changed clocks and Europe hasn't still follow New York.
  assert.equal(parseCalendarDate('2024.03.15 15:30:00').toISOString(), '2024-03-15T12:30:00.000Z');
  assert.equal(parseCalendarDate('2024-11-01 15:30').toISOString(), '2024-11-01T12:30:00.000Z');
  assert.equal(parseCalendarDate('garbage'), null);
});

test('normalizeEvent keeps what the chart needs and tidies values', () => {
  const e = normalizeEvent({ Name: 'Core CPI m/m', Currency: 'usd', Impact: 'High', Date: '2024.02.08 15:30:00', Actual: 0.4, Forecast: '', Previous: '0.2%' });
  assert.equal(e.currency, 'USD');
  assert.equal(e.impact, 'High');
  assert.equal(e.actual, 0.4);
  assert.equal(e.forecast, null);
  assert.equal(e.previous, '0.2%');
  assert.equal(e.key, 'forex-factory|USD|Core CPI m/m|2024-02-08T13:30:00.000Z');
  assert.equal(normalizeEvent({ Name: 'x', Currency: 'USD', Impact: 'Holiday', Date: '2024.01.01 00:00:00' }).impact, 'None');
  assert.equal(normalizeEvent({ Name: '', Currency: 'USD', Date: '2024.01.01 00:00:00' }), null);
});

test('currenciesForSymbol', () => {
  assert.deepEqual(currenciesForSymbol('EURUSD'), ['EUR', 'USD']);
  assert.deepEqual(currenciesForSymbol('gbpjpy.pro'), ['GBP', 'JPY']);
  assert.deepEqual(currenciesForSymbol('XAUUSD'), ['USD']);
  assert.deepEqual(currenciesForSymbol('US30.pro'), ['USD']);
  assert.deepEqual(currenciesForSymbol('Nasdaq100'), ['USD']);
  assert.deepEqual(currenciesForSymbol('GER40'), ['EUR']);
  assert.deepEqual(currenciesForSymbol('UK100'), ['GBP']);
});

test('monthRange', () => {
  assert.deepEqual(monthRange('2024-02'), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(monthRange('2025-12'), { from: '2025-12-01', to: '2025-12-31' });
});

test('nextMonthToFetch: current month hourly, last month once after it ends, then backfill oldest first', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const at = iso => new Date(iso);
  assert.equal(nextMonthToFetch(new Map(), now, '2026-07'), '2026-10');
  const fresh = new Map([['2026-10', at('2026-10-17T11:30:00Z')]]);
  assert.equal(nextMonthToFetch(fresh, now, '2026-07'), '2026-09');
  fresh.set('2026-09', at('2026-09-30T20:00:00Z')); // fetched before September was over
  assert.equal(nextMonthToFetch(fresh, now, '2026-07'), '2026-09');
  fresh.set('2026-09', at('2026-10-02T00:00:00Z'));
  assert.equal(nextMonthToFetch(fresh, now, '2026-07'), '2026-07');
  fresh.set('2026-07', at('2026-10-02T00:00:00Z')).set('2026-08', at('2026-10-02T00:00:00Z'));
  assert.equal(nextMonthToFetch(fresh, now, '2026-07'), null);
  fresh.set('2026-10', at('2026-10-17T10:00:00Z')); // over an hour old
  assert.equal(nextMonthToFetch(fresh, now, '2026-07'), '2026-10');
});
