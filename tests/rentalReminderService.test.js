import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import ReminderDefinition from '../models/ReminderDefinition.js';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import { upsertPlan } from '../services/rentalReminderService.js';

const buildPlan = (channels) => ({
  definition: { definitionCode: 'RMD-CHANNEL-STATUS-TEST' },
  occurrence: {
    occurrenceKey: 'ROC-CHANNEL-STATUS-TEST',
    channels,
  },
});

test('reminder upsert initializes selected delivery channels in the database payload', async (t) => {
  const definitionId = new mongoose.Types.ObjectId();
  let occurrenceUpdate;

  t.mock.method(ReminderDefinition, 'findOneAndUpdate', async () => ({ _id: definitionId }));
  t.mock.method(ReminderOccurrence, 'findOneAndUpdate', async (filter, update) => {
    occurrenceUpdate = update;
    return { ...update.$setOnInsert };
  });

  const result = await upsertPlan(buildPlan(['email', 'whatsapp']));

  assert.equal(occurrenceUpdate.$setOnInsert.emailDelivery.status, 'pending');
  assert.equal(occurrenceUpdate.$setOnInsert.whatsappDelivery.status, 'pending');
  assert.equal(result.emailDelivery.status, 'pending');
  assert.equal(result.whatsappDelivery.status, 'pending');
});

test('reminder upsert keeps channels that were not selected inactive', async (t) => {
  const definitionId = new mongoose.Types.ObjectId();
  let occurrenceUpdate;

  t.mock.method(ReminderDefinition, 'findOneAndUpdate', async () => ({ _id: definitionId }));
  t.mock.method(ReminderOccurrence, 'findOneAndUpdate', async (filter, update) => {
    occurrenceUpdate = update;
    return { ...update.$setOnInsert };
  });

  await upsertPlan(buildPlan(['email']));

  assert.equal(occurrenceUpdate.$setOnInsert.emailDelivery.status, 'pending');
  assert.equal(occurrenceUpdate.$setOnInsert.whatsappDelivery.status, 'not_selected');
});

test('reminder upsert preserves an explicitly supplied delivery state', async (t) => {
  const definitionId = new mongoose.Types.ObjectId();
  let occurrenceUpdate;
  const plan = buildPlan(['email', 'whatsapp']);
  plan.occurrence.emailDelivery = { status: 'failed', attemptsCount: 1 };

  t.mock.method(ReminderDefinition, 'findOneAndUpdate', async () => ({ _id: definitionId }));
  t.mock.method(ReminderOccurrence, 'findOneAndUpdate', async (filter, update) => {
    occurrenceUpdate = update;
    return { ...update.$setOnInsert };
  });

  await upsertPlan(plan);

  assert.deepEqual(occurrenceUpdate.$setOnInsert.emailDelivery, {
    status: 'failed',
    attemptsCount: 1,
  });
  assert.equal(occurrenceUpdate.$setOnInsert.whatsappDelivery.status, 'pending');
});
