import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  DEFAULT_RENTAL_PLAN_OFFSETS_MINUTES,
  MAX_REMINDER_PLAN_ROWS,
  prepareReminderPlan,
} from '../utils/reminderPlan.js';

const ids = {
  customer: new mongoose.Types.ObjectId(),
  rental: new mongoose.Types.ObjectId(),
};
const now = new Date('2026-11-15T04:30:00.000Z');
const customer = {
  _id: ids.customer,
  email: 'customer@example.com',
  phone: '9876543210',
};
const rental = {
  _id: ids.rental,
  customer: ids.customer,
  handoverAt: new Date('2026-11-15T04:30:00.000Z'),
  expectedReturnAt: new Date('2026-11-17T04:30:00.000Z'),
};
const content = (label) => ({
  subjectEnglish: `${label} reminder`,
  subjectHindi: `${label} रिमाइंडर`,
  bodyEnglish: `${label} English message`,
  bodyHindi: `${label} हिन्दी संदेश`,
});

test('rental custom plan prepares several independent offsets in chronological order', () => {
  const plan = prepareReminderPlan({
    reminderMode: 'custom',
    reminders: [
      { offsetMinutes: 60, channels: ['email'], content: content('One hour') },
      { offsetMinutes: 1440, channels: ['email', 'whatsapp'], content: content('One day') },
      { offsetMinutes: 180, channels: ['whatsapp'], content: content('Three hours') },
    ],
  }, { rental, customer, now });

  assert.equal(plan.planType, 'rental');
  assert.equal(plan.reminderMode, 'custom');
  assert.equal(plan.rentalId, ids.rental.toString());
  assert.deepEqual(plan.reminders.map(({ offsetMinutes }) => offsetMinutes), [1440, 180, 60]);
  assert.deepEqual(plan.reminders.map(({ scheduleMode }) => scheduleMode), [
    'offset_before_return',
    'offset_before_return',
    'offset_before_return',
  ]);
  assert.deepEqual(plan.reminders[0].channels, ['email', 'whatsapp']);
  assert.equal(plan.reminders[1].content.bodyEnglish, 'Three hours English message');
  assert.equal(plan.reminders[2].scheduledAt.toISOString(), '2026-11-17T03:30:00.000Z');
});

test('rental default plan preserves 12-hour and 1-hour behavior including missed rows', () => {
  const normal = prepareReminderPlan({}, { rental, customer, now });
  const shortRental = {
    ...rental,
    expectedReturnAt: new Date('2026-11-15T06:30:00.000Z'),
  };
  const short = prepareReminderPlan({}, { rental: shortRental, customer, now });

  assert.deepEqual(
    normal.reminders.map(({ offsetMinutes }) => offsetMinutes),
    DEFAULT_RENTAL_PLAN_OFFSETS_MINUTES
  );
  assert.deepEqual(normal.reminders.map(({ status }) => status), ['pending', 'pending']);
  assert.deepEqual(short.reminders.map(({ status }) => status), ['missed', 'pending']);
  assert.equal(short.reminders[0].missedAt.toISOString(), now.toISOString());
});

test('standalone plan derives multiple reminder times from the selected end time', () => {
  const plan = prepareReminderPlan({
    customerId: ids.customer.toString(),
    startAt: '2026-11-16T09:00',
    endAt: '2026-11-16T18:00',
    channels: ['EMAIL', 'whatsapp'],
    content: content('Service'),
    reminders: [
      { offsetMinutes: 360 },
      { offsetMinutes: 120 },
      { offsetMinutes: 30 },
    ],
  }, { customer, now });

  assert.equal(plan.planType, 'standalone');
  assert.equal(plan.reminderMode, 'custom');
  assert.equal(plan.startsAt.toISOString(), '2026-11-16T03:30:00.000Z');
  assert.equal(plan.endsAt.toISOString(), '2026-11-16T12:30:00.000Z');
  assert.deepEqual(plan.reminders.map(({ scheduledAt }) => scheduledAt.toISOString()), [
    '2026-11-16T06:30:00.000Z',
    '2026-11-16T10:30:00.000Z',
    '2026-11-16T12:00:00.000Z',
  ]);
  assert.ok(plan.reminders.every(({ scheduleMode }) => scheduleMode === 'exact'));
  assert.ok(plan.reminders.every(({ content: rowContent }) => rowContent.bodyHindi));
});

test('custom plans reject duplicate, past, and out-of-period reminders', () => {
  const base = {
    reminderMode: 'custom',
    channels: ['email'],
    content: content('Return'),
  };
  assert.throws(
    () => prepareReminderPlan({
      ...base,
      reminders: [{ offsetMinutes: 60 }, { offsetMinutes: 60 }],
    }, { rental, customer, now }),
    /must be unique/
  );
  assert.throws(
    () => prepareReminderPlan({
      ...base,
      reminders: [{ offsetMinutes: 3000 }],
    }, { rental, customer, now }),
    /scheduled in the future/
  );
  assert.throws(
    () => prepareReminderPlan({
      startAt: '2026-11-16T09:00',
      endAt: '2026-11-16T18:00',
      channels: ['email'],
      content: content('Service'),
      reminders: [{ offsetMinutes: 600 }],
    }, { customer, now }),
    /within the selected period/
  );
});

test('plans enforce row bounds, customer identity, contacts, and bilingual content', () => {
  const tooMany = Array.from(
    { length: MAX_REMINDER_PLAN_ROWS + 1 },
    (_, index) => ({ offsetMinutes: index + 1, channels: ['email'], content: content('Many') })
  );
  assert.throws(
    () => prepareReminderPlan({ reminderMode: 'custom', reminders: tooMany }, {
      rental: { ...rental, expectedReturnAt: new Date('2026-12-15T04:30:00.000Z') },
      customer,
      now,
    }),
    /at most 20/
  );
  assert.throws(
    () => prepareReminderPlan({}, {
      rental: { ...rental, customer: new mongoose.Types.ObjectId() },
      customer,
      now,
    }),
    /does not match/
  );
  assert.throws(
    () => prepareReminderPlan({
      reminderMode: 'custom',
      reminders: [{ offsetMinutes: 60, channels: ['whatsapp'], content: content('Phone') }],
    }, { rental, customer: { ...customer, phone: '' }, now }),
    /does not have a phone number/
  );
  assert.throws(
    () => prepareReminderPlan({
      reminderMode: 'custom',
      reminders: [{ offsetMinutes: 60, channels: ['email'], content: { bodyEnglish: 'Only English' } }],
    }, { rental, customer, now }),
    /bodyHindi is required/
  );
});
