import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  buildReminderSchedule,
  normalizeReminderChannels,
  parseReminderDate,
  parseReminderPagination,
  prepareReminderRequest,
} from '../utils/reminderManagement.js';

const customerId = new mongoose.Types.ObjectId();
const now = new Date('2026-11-15T04:30:00.000Z');
const content = {
  subjectEnglish: 'Service reminder',
  subjectHindi: 'सेवा रिमाइंडर',
  bodyEnglish: 'Please return the machine.',
  bodyHindi: 'कृपया मशीन वापस करें।',
};

test('dashboard date/time without an offset is interpreted as Asia/Kolkata', () => {
  assert.equal(
    parseReminderDate('2026-11-15T17:00', 'exactAt').toISOString(),
    '2026-11-15T11:30:00.000Z'
  );
  assert.equal(
    parseReminderDate('2026-11-15T17:00:00.000Z', 'exactAt').toISOString(),
    '2026-11-15T17:00:00.000Z'
  );
  assert.throws(() => parseReminderDate('not-a-dateZ', 'exactAt'), /valid date\/time/);
});

test('rental offset schedules calculate one future occurrence from return time', () => {
  const schedule = buildReminderSchedule(
    { scheduleMode: 'offset_before_return', offsetMinutes: 120 },
    { rental: { expectedReturnAt: new Date('2026-11-16T04:30:00.000Z') }, now }
  );

  assert.equal(schedule.offsetMinutes, 120);
  assert.equal(schedule.dates[0].toISOString(), '2026-11-16T02:30:00.000Z');
});

test('standalone multiple-date schedules are sorted and reject duplicates', () => {
  const schedule = buildReminderSchedule({
    scheduleMode: 'multiple_dates',
    exactDates: ['2026-11-17T17:00', '2026-11-16T17:00'],
  }, { now });

  assert.deepEqual(schedule.dates.map((date) => date.toISOString()), [
    '2026-11-16T11:30:00.000Z',
    '2026-11-17T11:30:00.000Z',
  ]);
  assert.throws(
    () => buildReminderSchedule({
      scheduleMode: 'multiple_dates',
      exactDates: ['2026-11-17T17:00', '2026-11-17T17:00'],
    }, { now }),
    /must be unique/
  );
});

test('repeating schedules support intervals, end dates and occurrence limits', () => {
  const limited = buildReminderSchedule({
    scheduleMode: 'repeating',
    recurrence: {
      frequency: 'week',
      interval: 2,
      startsAt: '2026-11-16T10:00',
      occurrenceLimit: 3,
    },
  }, { now });
  const ended = buildReminderSchedule({
    scheduleMode: 'repeating',
    recurrence: {
      frequency: 'day',
      interval: 1,
      startsAt: '2026-11-16T10:00',
      endsAt: '2026-11-18T10:00',
    },
  }, { now });

  assert.equal(limited.dates.length, 3);
  assert.equal(limited.dates[1].toISOString(), '2026-11-30T04:30:00.000Z');
  assert.equal(ended.dates.length, 3);
});

test('custom schedules reject past times and unbounded or oversized recurrence', () => {
  assert.throws(
    () => buildReminderSchedule({ scheduleMode: 'exact', exactAt: '2026-11-15T09:00' }, { now }),
    /must be in the future/
  );
  assert.throws(
    () => buildReminderSchedule({
      scheduleMode: 'repeating',
      recurrence: { frequency: 'day', startsAt: '2026-11-16T10:00' },
    }, { now }),
    /require endsAt or occurrenceLimit/
  );
  assert.throws(
    () => buildReminderSchedule({
      scheduleMode: 'repeating',
      recurrence: {
        frequency: 'day',
        startsAt: '2026-11-16T10:00',
        occurrenceLimit: 101,
      },
    }, { now }),
    /cannot exceed 100/
  );
  assert.throws(
    () => buildReminderSchedule({
      scheduleMode: 'repeating',
      recurrence: {
        frequency: 'day',
        startsAt: '2026-11-16T10:00',
        endsAt: '2027-11-16T10:00',
      },
    }, { now }),
    /exceeds the 100-occurrence limit/
  );
});

test('prepared standalone requests normalize channels and bilingual content', () => {
  const prepared = prepareReminderRequest({
    customerId: customerId.toString(),
    scheduleMode: 'exact',
    exactAt: '2026-11-16T10:00',
    channels: ['EMAIL', 'whatsapp'],
    content,
  }, { now });

  assert.deepEqual(prepared.channels, ['email', 'whatsapp']);
  assert.equal(prepared.content.templateKey, 'custom_bilingual');
  assert.equal(prepared.schedule.dates[0].toISOString(), '2026-11-16T04:30:00.000Z');
});

test('channel and pagination validation reject ambiguous management requests', () => {
  assert.throws(() => normalizeReminderChannels(['email', 'email']), /unique/);
  assert.throws(() => normalizeReminderChannels(['sms']), /email and\/or whatsapp/);
  assert.deepEqual(parseReminderPagination({ page: '2', limit: '20' }), {
    page: 2,
    limit: 20,
    skip: 20,
  });
  assert.throws(() => parseReminderPagination({ limit: 101 }), /between 1 and 100/);
});
