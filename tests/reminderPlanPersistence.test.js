import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import ReminderPlan from '../models/ReminderPlan.js';
import {
  buildReminderPlanRecords,
  normalizeSubmissionKey,
  reminderPlanFingerprint,
} from '../services/reminderPlanService.js';
import { prepareReminderPlan } from '../utils/reminderPlan.js';

const ids = {
  admin: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
  rental: new mongoose.Types.ObjectId(),
  plan: new mongoose.Types.ObjectId(),
  product: new mongoose.Types.ObjectId(),
};
const now = new Date('2026-11-15T04:30:00.000Z');
const customer = {
  _id: ids.customer,
  name: 'Deepak Mishra',
  email: 'DEEPAK@EXAMPLE.COM',
  phone: '+919876543210',
};
const rental = {
  _id: ids.rental,
  rentalCode: 'RNT-20261115-ABC123',
  customer: ids.customer,
  customerSnapshot: {
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
  },
  machineSnapshot: { name: 'AI Machine 2' },
  handoverAt: new Date('2026-11-15T04:30:00.000Z'),
  expectedReturnAt: new Date('2026-11-17T04:30:00.000Z'),
  billingPeriod: 'day',
  agreedRatePaise: 50000,
  plannedRentalChargePaise: 100000,
  rentalPaymentsReceivedPaise: 25000,
  securityDepositReceivedPaise: 200000,
  currency: 'INR',
};
const content = (label = 'Return') => ({
  subjectEnglish: `${label} reminder`,
  subjectHindi: `${label} रिमाइंडर`,
  bodyEnglish: `${label} English body`,
  bodyHindi: `${label} हिन्दी संदेश`,
});

test('fingerprints are deterministic and change with plan content', () => {
  const prepared = prepareReminderPlan({
    reminderMode: 'custom',
    reminders: [{ offsetMinutes: 60, channels: ['email'], content: content() }],
  }, { rental, customer, now });
  const same = prepareReminderPlan({
    reminderMode: 'custom',
    reminders: [{ offsetMinutes: 60, channels: ['email'], content: content() }],
  }, { rental, customer, now });
  const changed = prepareReminderPlan({
    reminderMode: 'custom',
    reminders: [{ offsetMinutes: 60, channels: ['email'], content: content('Changed') }],
  }, { rental, customer, now });

  assert.equal(reminderPlanFingerprint(prepared), reminderPlanFingerprint(same));
  assert.notEqual(reminderPlanFingerprint(prepared), reminderPlanFingerprint(changed));
  assert.equal(normalizeSubmissionKey('  browser-request-1  '), 'browser-request-1');
  assert.equal(normalizeSubmissionKey('   '), undefined);
});

test('standalone fingerprint includes optional product context', () => {
  const base = prepareReminderPlan({
    customerId: ids.customer.toString(),
    startAt: '2026-11-16T09:00',
    endAt: '2026-11-16T18:00',
    reminders: [{ offsetMinutes: 60, channels: ['email'], content: content('Service') }],
  }, { customer, now });
  const withoutProduct = reminderPlanFingerprint(base);
  const withProduct = reminderPlanFingerprint({ ...base, productId: ids.product.toString() });

  assert.notEqual(withProduct, withoutProduct);
});

test('record builder links every plan row to one definition and occurrence', () => {
  const prepared = prepareReminderPlan({
    reminderMode: 'custom',
    reminders: [
      { offsetMinutes: 180, channels: ['whatsapp'], content: content('Three hour') },
      { offsetMinutes: 60, channels: ['email', 'whatsapp'], content: content('One hour') },
    ],
  }, { rental, customer, now });
  const records = buildReminderPlanRecords({
    planId: ids.plan,
    planCode: 'RPL-TEST-1',
    version: 3,
    prepared,
    rental,
    customer,
    adminId: ids.admin,
    now,
  });

  assert.equal(records.planRows.length, 2);
  assert.equal(records.definitions.length, 2);
  assert.equal(records.occurrences.length, 2);
  assert.ok(records.definitions.every(({ plan, scheduleVersion }) =>
    plan.equals(ids.plan) && scheduleVersion === 3));
  assert.ok(records.occurrences.every(({ definition, plan }) =>
    definition instanceof mongoose.Types.ObjectId && plan.equals(ids.plan)));
  assert.equal(records.occurrences[0].emailDelivery.status, 'not_selected');
  assert.equal(records.occurrences[0].whatsappDelivery.status, 'pending');
  assert.equal(records.occurrences[1].emailDelivery.status, 'pending');
  assert.equal(records.recipientSnapshot.email, 'deepak@example.com');
});

test('default rental records persist rendered bilingual content and missed history', async () => {
  const shortRental = {
    ...rental,
    expectedReturnAt: new Date('2026-11-15T06:30:00.000Z'),
  };
  const prepared = prepareReminderPlan({}, { rental: shortRental, customer, now });
  const records = buildReminderPlanRecords({
    planId: ids.plan,
    planCode: 'RPL-SHORT-1',
    version: 1,
    prepared,
    rental: shortRental,
    customer,
    adminId: ids.admin,
    now,
  });
  const plan = new ReminderPlan({
    _id: ids.plan,
    planCode: 'RPL-SHORT-1',
    planType: prepared.planType,
    reminderMode: prepared.reminderMode,
    rental: ids.rental,
    customer: ids.customer,
    recipientSnapshot: records.recipientSnapshot,
    startsAt: prepared.startsAt,
    endsAt: prepared.endsAt,
    rows: records.planRows,
    fingerprint: reminderPlanFingerprint(prepared),
    createdBy: ids.admin,
  });

  await plan.validate();
  assert.equal(records.occurrences[0].status, 'missed');
  assert.ok(records.occurrences[0].missedAt);
  assert.match(records.planRows[0].content.bodyEnglish, /AI Machine 2/);
  assert.ok(records.planRows[0].content.bodyHindi);
});

test('standalone plan records use exact scheduling and reject malformed persisted rows', async () => {
  const prepared = prepareReminderPlan({
    customerId: ids.customer.toString(),
    startAt: '2026-11-16T09:00',
    endAt: '2026-11-16T18:00',
    reminders: [{ offsetMinutes: 60, channels: ['email'], content: content('Service') }],
  }, { customer, now });
  const records = buildReminderPlanRecords({
    planId: ids.plan,
    planCode: 'RPL-STANDALONE-1',
    version: 1,
    prepared,
    customer,
    adminId: ids.admin,
    now,
  });
  assert.equal(records.definitions[0].type, 'standalone_custom');
  assert.equal(records.definitions[0].scheduleMode, 'exact');
  assert.equal(records.definitions[0].rental, undefined);

  const contextualPlan = new ReminderPlan({
    planCode: 'RPL-CONTEXT-1',
    planType: 'standalone',
    reminderMode: 'custom',
    product: ids.product,
    productContextSnapshot: { name: 'Bosch Drill', brand: 'BOSCH', model: 'D1' },
    customer: ids.customer,
    recipientSnapshot: records.recipientSnapshot,
    startsAt: prepared.startsAt,
    endsAt: prepared.endsAt,
    rows: records.planRows,
    fingerprint: reminderPlanFingerprint({ ...prepared, productId: ids.product.toString() }),
    createdBy: ids.admin,
  });
  await contextualPlan.validate();
  assert.equal(contextualPlan.productContextSnapshot.name, 'Bosch Drill');

  const invalid = new ReminderPlan({
    planCode: 'RPL-INVALID-1',
    planType: 'standalone',
    reminderMode: 'default',
    customer: ids.customer,
    recipientSnapshot: records.recipientSnapshot,
    startsAt: prepared.startsAt,
    endsAt: prepared.endsAt,
    rows: [...records.planRows, { ...records.planRows[0] }],
    fingerprint: reminderPlanFingerprint(prepared),
    createdBy: ids.admin,
  });
  await assert.rejects(invalid.validate(), /standalone reminder plans must be custom|must be unique/);
});
