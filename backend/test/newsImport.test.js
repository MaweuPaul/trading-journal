const test = require('node:test');
const assert = require('node:assert/strict');
const { eventsFromExport, detectServerClock, parseExport, splitCsvLine } = require('../lib/newsImport');
const { wallToUtc, zoneOffsetMinutes } = require('../lib/newsCalendar');

const HEADER = 'time,currency,importance,name,actual,forecast,previous';
const pad = n => String(n).padStart(2, '0');
const wallText = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

// Thursdays through 2024 (jobless claims, 08:30 New York), written in a broker clock.
function claimsCsv(serverWallOf) {
  const lines = [HEADER];
  for (let t = Date.UTC(2024, 0, 4); t < Date.UTC(2025, 0, 1); t += 7 * 86400000) {
    const utc = wallToUtc(t + 8.5 * 3600000, 'America/New_York');
    lines.push(`${wallText(serverWallOf(utc))},USD,MODERATE,Initial Jobless Claims,212K,215K,210K`);
  }
  return lines;
}
// Server time = New York wall clock + 7h.
const nyPlus7 = utc => utc + (zoneOffsetMinutes(utc, 'America/New_York') + 420) * 60000;

test('a New York + 7 broker: every release lands back on its real UTC time', () => {
  const lines = claimsCsv(nyPlus7);
  lines.push('2024.07.05 15:30,USD,HIGH,Nonfarm Payrolls,206K,190K,218K');
  lines.push('2024.01.25 15:15,EUR,HIGH,"ECB Interest Rate Decision, Main",4.50%,4.50%,4.50%');
  lines.push('2024.01.25 10:00,EUR,LOW,Some low thing,,,');
  const { events, clock } = eventsFromExport(lines.join('\n'));
  assert.deepEqual(clock, { timeZone: 'America/New_York', shiftMinutes: 420 });
  const nfp = events.find(e => e.name === 'Nonfarm Payrolls');
  assert.equal(nfp.time.toISOString(), '2024-07-05T12:30:00.000Z');
  assert.equal(nfp.actual, '206K');
  // ECB at 14:15 Frankfurt in winter = 13:15 UTC = 08:15 New York = 15:15 server.
  assert.equal(events.find(e => e.currency === 'EUR').time.toISOString(), '2024-01-25T13:15:00.000Z');
  assert.equal(events.find(e => e.currency === 'EUR').name, 'ECB Interest Rate Decision, Main');
  assert.equal(events.some(e => e.impact === 'Low'), false, 'low impact is left out');
  assert.ok(events.every(e => e.key.startsWith('mql5|')));
});

test('a fixed UTC+2 broker is told apart from New York + 7', () => {
  const lines = claimsCsv(utc => utc + 2 * 3600000);
  assert.deepEqual(detectServerClock(parseExport(lines.join('\n'))), { timeZone: 'UTC', shiftMinutes: 120 });
});

test('refuses files it can\'t place in time', () => {
  assert.throws(() => eventsFromExport(`${HEADER}\n2024.01.25 15:15,EUR,HIGH,ECB,,,`), /broker's clock/);
  assert.throws(() => eventsFromExport('a,b,c\n1,2,3'), /NewsExport\.mq5/);
});

test('splitCsvLine handles quotes', () => {
  assert.deepEqual(splitCsvLine('a,"b, c","say ""hi"""'), ['a', 'b, c', 'say "hi"']);
});
