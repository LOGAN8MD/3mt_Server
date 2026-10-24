import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import User from '../models/User.js';
import ReminderPlan from '../models/ReminderPlan.js';
import ReminderDefinition from '../models/ReminderDefinition.js';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import { createReminderPlan } from '../controllers/reminderPlanController.js';

test('creation saves initial and scheduled occurrences atomically and rejects duplicate submissions', async (t) => {
  const previous = process.env.REMINDER_EMAIL_AUTOMATION_ENABLED;
  process.env.REMINDER_EMAIL_AUTOMATION_ENABLED = 'false';
  t.after(() => {
    if (previous === undefined) delete process.env.REMINDER_EMAIL_AUTOMATION_ENABLED;
    else process.env.REMINDER_EMAIL_AUTOMATION_ENABLED = previous;
  });
  const customer = { _id: new mongoose.Types.ObjectId(), role: 'customer', name: 'Test', email: 'test@example.com', phone: '9876543210' };
  const content = { bodyEnglish: 'Welcome', bodyHindi: 'नमस्ते' };
  const req = { user: { _id: new mongoose.Types.ObjectId() }, body: {
    customerId: customer._id.toString(), startAt: '2099-10-25T00:00', endAt: '2099-10-27T00:00',
    reminders: [{ offsetMinutes: 60, channels: ['email'], content }],
    startingMessage: { channels: ['email', 'whatsapp'], content }, submissionKey: 'test-starting-message',
  } };
  let saved;
  let definitions;
  let occurrences;
  let duplicate = false;
  const session = { transaction: true };
  t.mock.method(User, 'findById', async () => customer);
  t.mock.method(ReminderPlan, 'exists', async () => duplicate);
  t.mock.method(mongoose.connection, 'transaction', async (callback) => callback(session));
  t.mock.method(ReminderPlan, 'create', async ([plan], options) => { assert.equal(options.session, session); saved = plan; });
  t.mock.method(ReminderDefinition, 'insertMany', async (rows, options) => { assert.equal(options.session, session); definitions = rows; });
  t.mock.method(ReminderOccurrence, 'insertMany', async (rows, options) => { assert.equal(options.session, session); occurrences = rows; });
  t.mock.method(ReminderPlan, 'findById', () => ({ populate() { return this; }, lean: async () => saved }));
  const res = { status(code) { this.code = code; return this; }, json(value) { this.payload = value; } };
  await createReminderPlan(req, res, assert.fail);
  assert.equal(res.code, 201);
  assert.ok(saved.startingMessage);
  assert.equal(saved.rows.length, 1);
  assert.equal(definitions.length, 2);
  assert.equal(occurrences.length, 2);
  assert.equal(occurrences.filter((row) => row.planRowKey === 'STARTING_MESSAGE').length, 1);
  duplicate = true;
  let error;
  await createReminderPlan(req, res, (value) => { error = value; });
  assert.equal(error.statusCode, 409);
  assert.equal(ReminderOccurrence.insertMany.mock.callCount(), 1);
});
