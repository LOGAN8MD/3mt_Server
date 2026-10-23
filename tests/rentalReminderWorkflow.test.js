import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  buildDefaultReturnReminderPlans,
  buildRentalActivationReminderPlan,
  DEFAULT_RETURN_REMINDER_OFFSETS_MINUTES,
} from '../utils/rentalReminderWorkflow.js';

const ids = {
  admin: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
  rental: new mongoose.Types.ObjectId(),
};

const rental = {
  _id: ids.rental,
  rentalCode: 'RNT-20261023-ABC123',
  customer: ids.customer,
  customerSnapshot: {
    name: 'Rahul Customer',
    email: 'RAHUL@EXAMPLE.COM',
    phone: '+919876543210',
  },
  machineSnapshot: { name: 'Second-Hand Bosch Drill 1' },
  handoverAt: new Date('2026-11-15T04:30:00.000Z'),
  expectedReturnAt: new Date('2026-11-16T04:30:00.000Z'),
  billingPeriod: 'day',
  agreedRatePaise: 50000,
  plannedRentalChargePaise: 50000,
  rentalPaymentsReceivedPaise: 20000,
  securityDepositReceivedPaise: 200000,
  currency: 'INR',
};

test('activation plan creates one immediate bilingual-channel reminder snapshot', () => {
  const now = new Date('2026-11-15T04:30:00.000Z');
  const plan = buildRentalActivationReminderPlan(rental, ids.admin, { now });

  assert.equal(plan.definition.type, 'rental_activation_confirmation');
  assert.equal(plan.definition.scheduleMode, 'immediate');
  assert.deepEqual(plan.definition.channels, ['email', 'whatsapp']);
  assert.equal(plan.definition.recipientSnapshot.email, 'rahul@example.com');
  assert.equal(plan.occurrence.status, 'pending');
  assert.equal(plan.occurrence.scheduledAt.toISOString(), now.toISOString());
  assert.equal(plan.occurrence.contentSnapshot.variables.machineName, rental.machineSnapshot.name);
  assert.equal(plan.occurrence.contentSnapshot.variables.remainingPlannedBalancePaise, 30000);
});

test('default plans create 12-hour and 1-hour return reminders', () => {
  const plans = buildDefaultReturnReminderPlans(rental, ids.admin, {
    now: new Date('2026-11-15T00:00:00.000Z'),
  });

  assert.deepEqual(
    plans.map((plan) => plan.definition.offsetMinutes),
    DEFAULT_RETURN_REMINDER_OFFSETS_MINUTES
  );
  assert.equal(plans[0].occurrence.scheduledAt.toISOString(), '2026-11-15T16:30:00.000Z');
  assert.equal(plans[1].occurrence.scheduledAt.toISOString(), '2026-11-16T03:30:00.000Z');
  assert.deepEqual(plans.map((plan) => plan.occurrence.status), ['pending', 'pending']);
});

test('short rentals preserve already-passed default reminders as missed', () => {
  const now = new Date('2026-11-15T04:30:00.000Z');
  const shortRental = {
    ...rental,
    expectedReturnAt: new Date('2026-11-15T06:30:00.000Z'),
  };
  const plans = buildDefaultReturnReminderPlans(shortRental, ids.admin, { now });

  assert.equal(plans[0].occurrence.status, 'missed');
  assert.equal(plans[0].occurrence.missedAt.toISOString(), now.toISOString());
  assert.equal(plans[1].occurrence.status, 'pending');
  assert.equal(plans[1].occurrence.missedAt, undefined);
});

test('deadline extension versions produce new deterministic occurrence identities', () => {
  const extendedRental = {
    ...rental,
    expectedReturnAt: new Date('2026-11-18T04:30:00.000Z'),
    plannedRentalChargePaise: 150000,
  };
  const firstVersion = buildDefaultReturnReminderPlans(rental, ids.admin, {
    now: new Date('2026-11-15T00:00:00.000Z'),
    scheduleVersion: 1,
  });
  const secondVersion = buildDefaultReturnReminderPlans(extendedRental, ids.admin, {
    now: new Date('2026-11-15T00:00:00.000Z'),
    scheduleVersion: 2,
  });

  assert.notEqual(
    firstVersion[0].occurrence.occurrenceKey,
    secondVersion[0].occurrence.occurrenceKey
  );
  assert.match(secondVersion[0].occurrence.occurrenceKey, /-V2$/);
  assert.equal(secondVersion[0].occurrence.scheduleVersion, 2);
  assert.equal(
    secondVersion[0].occurrence.contentSnapshot.variables.expectedReturnAt,
    extendedRental.expectedReturnAt
  );
});

test('rental reminder plans reject incomplete rental identity and invalid dates', () => {
  assert.throws(
    () => buildRentalActivationReminderPlan({ ...rental, _id: undefined }, ids.admin),
    /rental._id is required/
  );
  assert.throws(
    () => buildDefaultReturnReminderPlans({ ...rental, expectedReturnAt: 'invalid' }, ids.admin),
    /expectedReturnAt must be a valid date/
  );
});
