import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import ReminderDefinition from '../models/ReminderDefinition.js';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import ReminderPlan from '../models/ReminderPlan.js';
import { createRentalLifecycleReminders } from '../services/rentalReminderService.js';

const ids = {
  admin: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
  rental: new mongoose.Types.ObjectId(),
};
const now = new Date('2026-11-15T04:30:00.000Z');
const content = (label) => ({
  subjectEnglish: `${label} reminder`,
  subjectHindi: `${label} रिमाइंडर`,
  bodyEnglish: `${label} English message`,
  bodyHindi: `${label} हिन्दी संदेश`,
});
const rental = (reminderSettings) => ({
  _id: ids.rental,
  rentalCode: 'RNT-20261115-LIFE01',
  customer: ids.customer,
  customerSnapshot: {
    name: 'Deepak Mishra',
    email: 'deepak@example.com',
    phone: '+919876543210',
  },
  machineSnapshot: { name: 'Bosch Drill 2' },
  handoverAt: new Date('2026-11-15T04:30:00.000Z'),
  expectedReturnAt: new Date('2026-11-17T04:30:00.000Z'),
  billingPeriod: 'day',
  agreedRatePaise: 50000,
  plannedRentalChargePaise: 100000,
  rentalPaymentsReceivedPaise: 25000,
  securityDepositReceivedPaise: 200000,
  currency: 'INR',
  reminderSettings,
});

const mockLifecyclePersistence = (t, existingPlan = null) => {
  const captured = { definitions: [], occurrences: [], planCreates: [] };
  t.mock.method(mongoose.connection, 'transaction', async (callback) => callback({ id: 'session' }));
  t.mock.method(ReminderPlan, 'findOne', () => ({ session: async () => existingPlan }));
  t.mock.method(ReminderPlan, 'create', async (documents) => {
    captured.planCreates.push(...documents);
    return documents;
  });
  t.mock.method(ReminderDefinition, 'insertMany', async (documents) => {
    captured.definitions.push(...documents);
    return documents;
  });
  t.mock.method(ReminderOccurrence, 'insertMany', async (documents) => {
    captured.occurrences.push(...documents);
    return documents;
  });
  t.mock.method(ReminderDefinition, 'findOneAndUpdate', async (filter, update) => ({
    _id: new mongoose.Types.ObjectId(),
    ...update.$setOnInsert,
  }));
  t.mock.method(ReminderOccurrence, 'findOneAndUpdate', async (filter, update) =>
    update.$setOnInsert);
  return captured;
};

test('active rental lifecycle creates one confirmation and the selected custom plan', async (t) => {
  const captured = mockLifecyclePersistence(t);
  const selected = rental({
    mode: 'custom',
    reminders: [
      { offsetMinutes: 180, channels: ['email'], content: content('Three hour') },
      { offsetMinutes: 60, channels: ['whatsapp'], content: content('One hour') },
    ],
  });

  const confirmation = await createRentalLifecycleReminders(selected, ids.admin, { now });

  assert.equal(captured.planCreates.length, 1);
  assert.equal(captured.planCreates[0].reminderMode, 'custom');
  assert.equal(captured.planCreates[0].rows.length, 2);
  assert.equal(captured.definitions.length, 2);
  assert.equal(captured.occurrences.length, 2);
  assert.equal(confirmation.definitionType, 'rental_activation_confirmation');
});

test('default activation keeps 12-hour and 1-hour behavior', async (t) => {
  const captured = mockLifecyclePersistence(t);

  await createRentalLifecycleReminders(
    rental({ mode: 'default', reminders: [] }),
    ids.admin,
    { now }
  );

  assert.equal(captured.planCreates[0].reminderMode, 'default');
  assert.deepEqual(
    captured.planCreates[0].rows.map(({ offsetMinutes }) => offsetMinutes),
    [720, 60]
  );
});

test('repeated activation request reuses the existing return plan', async (t) => {
  const existingPlan = { _id: new mongoose.Types.ObjectId(), status: 'active' };
  const captured = mockLifecyclePersistence(t, existingPlan);

  await createRentalLifecycleReminders(
    rental({ mode: 'default', reminders: [] }),
    ids.admin,
    { now }
  );

  assert.equal(captured.planCreates.length, 0);
  assert.equal(captured.definitions.length, 0);
  assert.equal(captured.occurrences.length, 0);
});
