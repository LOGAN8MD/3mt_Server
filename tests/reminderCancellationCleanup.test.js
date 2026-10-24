import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import ReminderDefinition from '../models/ReminderDefinition.js';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import ReminderPlan from '../models/ReminderPlan.js';
import { cancelRentalReminders } from '../services/rentalReminderService.js';

test('rental cancellation durably cancels only unsent reminders and clears retry state', async (t) => {
  const rentalId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();
  const definitionId = new mongoose.Types.ObjectId();
  const occurrenceIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const now = new Date('2026-10-24T05:30:00.000Z');
  let occurrenceFindFilter;
  let definitionUpdate;
  let occurrenceUpdate;
  let planUpdate;

  t.mock.method(mongoose.connection, 'transaction', async (callback) => callback({ id: 'session' }));
  t.mock.method(ReminderDefinition, 'find', () => ({
    select() { return this; },
    session: async () => [{ _id: definitionId }],
  }));
  t.mock.method(ReminderOccurrence, 'find', (filter) => {
    occurrenceFindFilter = filter;
    return {
      select() { return this; },
      session() { return this; },
      lean: async () => occurrenceIds.map((_id) => ({ _id })),
    };
  });
  t.mock.method(ReminderDefinition, 'updateMany', async (filter, update) => {
    definitionUpdate = { filter, update };
    return { modifiedCount: 1 };
  });
  t.mock.method(ReminderOccurrence, 'updateMany', async (filter, update) => {
    occurrenceUpdate = { filter, update };
    return { modifiedCount: 2 };
  });
  t.mock.method(ReminderPlan, 'updateMany', async (filter, update) => {
    planUpdate = { filter, update };
    return { modifiedCount: 1 };
  });

  const result = await cancelRentalReminders(
    rentalId,
    adminId,
    'Rental completed and machine returned',
    { now }
  );

  const unsentStatuses = ['pending', 'scheduled', 'processing', 'failed'];
  assert.deepEqual(occurrenceFindFilter.status.$in, unsentStatuses);
  assert.deepEqual(occurrenceUpdate.filter.status.$in, unsentStatuses);
  assert.equal(occurrenceUpdate.filter.status.$in.includes('sent'), false);
  assert.equal(occurrenceUpdate.filter.status.$in.includes('partially_failed'), false);
  assert.equal(definitionUpdate.update.$set.status, 'cancelled');
  assert.equal(occurrenceUpdate.update.$set.status, 'cancelled');
  assert.equal(occurrenceUpdate.update.$set.cancelledAt, now);
  assert.equal(occurrenceUpdate.update.$set.cancelledBy, adminId);
  assert.equal(occurrenceUpdate.update.$set.cancellationReason, 'Rental completed and machine returned');
  assert.equal(planUpdate.update.$set.status, 'cancelled');
  assert.deepEqual(occurrenceUpdate.update.$unset, {
    lockedAt: 1,
    lockExpiresAt: 1,
    nextAttemptAt: 1,
  });
  assert.deepEqual(result, {
    definitionsCancelled: 1,
    occurrencesCancelled: 2,
    plansCancelled: 1,
  });
});

test('rental cleanup is idempotent when no active reminder definitions remain', async (t) => {
  const occurrenceFind = t.mock.method(ReminderOccurrence, 'find', () => {
    throw new Error('Occurrence lookup should not run');
  });
  t.mock.method(mongoose.connection, 'transaction', async (callback) => callback({ id: 'session' }));
  t.mock.method(ReminderDefinition, 'find', () => ({
    select() { return this; },
    session: async () => [],
  }));
  t.mock.method(ReminderPlan, 'updateMany', async () => ({ modifiedCount: 0 }));

  const result = await cancelRentalReminders(
    new mongoose.Types.ObjectId(),
    new mongoose.Types.ObjectId(),
    'Already cleaned'
  );

  assert.deepEqual(result, {
    definitionsCancelled: 0,
    occurrencesCancelled: 0,
    plansCancelled: 0,
  });
  assert.equal(occurrenceFind.mock.callCount(), 0);
});
