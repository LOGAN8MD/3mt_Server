import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import Rental from '../models/Rental.js';
import { buildReminderPlanRecords } from '../services/reminderPlanService.js';
import { prepareRentalReminderSettings } from '../utils/rentalReminderSettings.js';

const ids = {
  admin: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
  machine: new mongoose.Types.ObjectId(),
  rental: new mongoose.Types.ObjectId(),
  plan: new mongoose.Types.ObjectId(),
};
const now = new Date('2026-11-15T04:30:00.000Z');
const customer = {
  _id: ids.customer,
  name: 'Deepak Mishra',
  email: 'deepak@example.com',
  phone: '+919876543210',
};
const rentalContext = {
  _id: ids.rental,
  rentalCode: 'RNT-20261115-ABC123',
  customer: ids.customer,
  customerSnapshot: customer,
  machineSnapshot: { name: 'Bosch Drill 2' },
  handoverAt: new Date('2026-11-15T04:30:00.000Z'),
  expectedReturnAt: new Date('2026-11-17T04:30:00.000Z'),
  billingPeriod: 'day',
  agreedRatePaise: 50000,
  plannedRentalChargePaise: 100000,
  rentalPaymentsReceivedPaise: 25000,
  securityDepositReceivedPaise: 200000,
  currency: 'INR',
};
const content = (label) => ({
  subjectEnglish: `${label} reminder`,
  subjectHindi: `${label} रिमाइंडर`,
  bodyEnglish: `${label} English message`,
  bodyHindi: `${label} हिन्दी संदेश`,
});

test('rental settings normalize defaults and preserve custom draft rows', () => {
  const defaults = prepareRentalReminderSettings(undefined, {
    rental: rentalContext,
    customer,
    now,
  });
  const custom = prepareRentalReminderSettings({
    mode: 'custom',
    reminders: [
      { offsetMinutes: 180, channels: ['whatsapp'], content: content('Three hour') },
      { offsetMinutes: 60, channels: ['email', 'whatsapp'], content: content('One hour') },
    ],
  }, { rental: rentalContext, customer, now });

  assert.deepEqual(defaults.settings, { mode: 'default', reminders: [] });
  assert.equal(custom.settings.mode, 'custom');
  assert.deepEqual(custom.settings.reminders.map(({ offsetMinutes }) => offsetMinutes), [180, 60]);
  assert.equal(custom.prepared.reminders[1].scheduledAt.toISOString(), '2026-11-17T03:30:00.000Z');
});

test('rental settings reject duplicate offsets and unavailable selected contacts', () => {
  assert.throws(
    () => prepareRentalReminderSettings({
      mode: 'custom',
      reminders: [
        { offsetMinutes: 60, channels: ['email'], content: content('First') },
        { offsetMinutes: 60, channels: ['email'], content: content('Second') },
      ],
    }, { rental: rentalContext, customer, now }),
    /must be unique/
  );
  assert.throws(
    () => prepareRentalReminderSettings({
      mode: 'custom',
      reminders: [{ offsetMinutes: 60, channels: ['whatsapp'], content: content('Phone') }],
    }, { rental: rentalContext, customer: { ...customer, phone: '' }, now }),
    /does not have a phone number/
  );
});

test('Rental model stores custom settings but defaults legacy rentals safely', async () => {
  const base = {
    rentalCode: 'RNT-20261115-MODEL1',
    machine: ids.machine,
    customer: ids.customer,
    machineSnapshot: {
      name: 'Bosch Drill 2', condition: 'used', availabilityType: 'rent',
    },
    customerSnapshot: customer,
    status: 'draft',
    handoverAt: rentalContext.handoverAt,
    expectedReturnAt: rentalContext.expectedReturnAt,
    billingPeriod: 'day',
    agreedRatePaise: 50000,
    plannedBillablePeriods: 2,
    derivedDailyRatePaise: 50000,
    plannedRentalChargePaise: 100000,
    dailyLateRatePaise: 50000,
    createdBy: ids.admin,
  };
  const legacy = new Rental(base);
  const custom = new Rental({
    ...base,
    rentalCode: 'RNT-20261115-MODEL2',
    reminderSettings: {
      mode: 'custom',
      reminders: [{ offsetMinutes: 60, channels: ['email'], content: content('Return') }],
    },
  });

  await legacy.validate();
  await custom.validate();
  assert.equal(legacy.reminderSettings.mode, 'default');
  assert.equal(custom.reminderSettings.reminders[0].offsetMinutes, 60);
});

test('extension record generation excludes only channels already delivered', () => {
  const { prepared } = prepareRentalReminderSettings({
    mode: 'custom',
    reminders: [{
      offsetMinutes: 60,
      channels: ['email', 'whatsapp'],
      content: content('Return'),
    }],
  }, { rental: rentalContext, customer, now });
  const records = buildReminderPlanRecords({
    planId: ids.plan,
    planCode: 'RPL-EXTENSION-1',
    version: 2,
    prepared,
    rental: rentalContext,
    customer,
    adminId: ids.admin,
    now,
    excludedChannelsByRowKey: new Map([['OFFSET-60M', ['email']]]),
  });

  assert.deepEqual(records.planRows[0].channels, ['email', 'whatsapp']);
  assert.deepEqual(records.definitions[0].channels, ['whatsapp']);
  assert.equal(records.occurrences[0].emailDelivery.status, 'not_selected');
  assert.equal(records.occurrences[0].whatsappDelivery.status, 'pending');
});
