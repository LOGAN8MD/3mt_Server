import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUSINESS_TIME_ZONE,
  formatInBusinessTimeZone,
  indiaLocalDateTimeToUtc,
} from '../utils/businessTime.js';

test('India local date/time is converted to the correct UTC instant for storage', () => {
  const storedDate = indiaLocalDateTimeToUtc('2026-11-15T17:00');

  assert.equal(BUSINESS_TIME_ZONE, 'Asia/Kolkata');
  assert.equal(storedDate.toISOString(), '2026-11-15T11:30:00.000Z');
});

test('UTC instants are formatted using the India business time zone', () => {
  const display = formatInBusinessTimeZone('2026-11-15T11:30:00.000Z', {
    dateStyle: undefined,
    timeStyle: undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  assert.match(display, /15\/11\/2026/);
  assert.match(display, /17:00/);
});

test('India local date/time conversion rejects invalid input', () => {
  assert.throws(
    () => indiaLocalDateTimeToUtc('2026-02-30T10:00'),
    /invalid calendar value/
  );
  assert.throws(() => indiaLocalDateTimeToUtc('15-11-2026 17:00'), /must use/);
  assert.throws(() => indiaLocalDateTimeToUtc(new Date('invalid')), /valid date/);
});
