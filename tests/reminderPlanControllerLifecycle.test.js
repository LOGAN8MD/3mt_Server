import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import ReminderDefinition from '../models/ReminderDefinition.js';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import ReminderPlan from '../models/ReminderPlan.js';
import {
  pauseReminderPlan,
  resumeReminderPlan,
} from '../controllers/reminderPlanController.js';

const request = (id, adminId) => ({ params: { id: id.toString() }, user: { _id: adminId } });
const response = () => ({
  payload: null,
  json(value) { this.payload = value; return this; },
});

const mockPlanQuery = (t, plan) => {
  t.mock.method(ReminderPlan, 'findById', () => ({
    populate() { return this; },
    lean: async () => ({ _id: plan._id, status: plan.status }),
  }));
  t.mock.method(ReminderOccurrence, 'find', () => ({
    select() { return this; },
    lean: async () => [{ _id: new mongoose.Types.ObjectId() }],
  }));
};

test('pause and resume update a plan and its definitions in one transaction', async (t) => {
  const planId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();
  const updates = [];
  let currentPlan = {
    _id: planId,
    status: 'active',
    auditHistory: [],
    async save({ session }) { assert.ok(session); },
  };

  t.mock.method(ReminderPlan, 'findOne', async ({ status }) => {
    if (currentPlan.status !== status) return null;
    return currentPlan;
  });
  mockPlanQuery(t, currentPlan);
  t.mock.method(mongoose.connection, 'transaction', async (callback) => callback({ transaction: true }));
  t.mock.method(ReminderDefinition, 'updateMany', async (filter, update, options) => {
    updates.push({ filter, update, options });
    return { modifiedCount: 1 };
  });

  const paused = response();
  await pauseReminderPlan(request(planId, adminId), paused, assert.fail);
  assert.equal(currentPlan.status, 'paused');
  assert.equal(updates[0].update.$set.status, 'paused');
  assert.equal(updates[0].options.session.transaction, true);

  const resumed = response();
  await resumeReminderPlan(request(planId, adminId), resumed, assert.fail);
  assert.equal(currentPlan.status, 'active');
  assert.equal(updates[1].update.$set.status, 'active');
  assert.deepEqual(
    currentPlan.auditHistory.map(({ action }) => action),
    ['reminder_plan_paused', 'reminder_plan_resumed']
  );
});

test('lifecycle transaction failure is returned as an error and sends no success response', async (t) => {
  const planId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();
  const plan = {
    _id: planId,
    status: 'active',
    auditHistory: [],
    async save() {},
  };
  t.mock.method(ReminderPlan, 'findOne', async () => plan);
  t.mock.method(ReminderOccurrence, 'find', () => ({
    select() { return this; },
    lean: async () => [],
  }));
  t.mock.method(mongoose.connection, 'transaction', async () => {
    throw new Error('transaction aborted');
  });

  const res = response();
  let received;
  await pauseReminderPlan(request(planId, adminId), res, (error) => { received = error; });

  assert.equal(res.payload, null);
  assert.equal(received.statusCode, 500);
  assert.match(received.message, /transaction aborted/);
});

test('reminder plans retain a unique submission-key index for duplicate requests', () => {
  const index = ReminderPlan.schema.indexes().find(([, options]) =>
    options.name === 'one_plan_per_submission_key');

  assert.ok(index);
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression, { submissionKey: { $type: 'string' } });
});
