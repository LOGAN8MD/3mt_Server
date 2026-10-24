import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { deliveredChannelsFromOccurrences } from '../controllers/reminderPlanController.js';
import ReminderPlan from '../models/ReminderPlan.js';

test('plan edits exclude only channels that already succeeded for each row', () => {
  const delivered = deliveredChannelsFromOccurrences([
    {
      planRowKey: 'OFFSET-60M',
      emailDelivery: { status: 'accepted' },
      whatsappDelivery: { status: 'pending' },
    },
    {
      planRowKey: 'OFFSET-720M',
      emailDelivery: { status: 'failed' },
      whatsappDelivery: { status: 'manual_sent' },
    },
    {
      planRowKey: 'OFFSET-60M',
      emailDelivery: { status: 'delivered' },
      whatsappDelivery: { status: 'failed' },
    },
  ]);

  assert.deepEqual(delivered.get('OFFSET-60M'), ['email']);
  assert.deepEqual(delivered.get('OFFSET-720M'), ['whatsapp']);
});

test('cancelled plans require complete cancellation history while paused plans remain valid', async () => {
  const base = {
    planCode: 'RPL-LIFECYCLE-1',
    planType: 'standalone',
    reminderMode: 'custom',
    customer: new mongoose.Types.ObjectId(),
    recipientSnapshot: { name: 'Deepak', email: 'deepak@example.com' },
    startsAt: new Date('2099-11-15T04:30:00.000Z'),
    endsAt: new Date('2099-11-16T04:30:00.000Z'),
    rows: [{
      rowKey: 'OFFSET-60M', offsetMinutes: 60,
      scheduledAt: new Date('2099-11-16T03:30:00.000Z'),
      scheduleMode: 'exact', channels: ['email'], contentMode: 'custom',
      content: { bodyEnglish: 'English', bodyHindi: 'Hindi' }, initialStatus: 'pending',
    }],
    fingerprint: 'a'.repeat(64),
    createdBy: new mongoose.Types.ObjectId(),
  };
  await new ReminderPlan({ ...base, status: 'paused' }).validate();
  await assert.rejects(
    new ReminderPlan({ ...base, status: 'cancelled' }).validate(),
    /cancelledAt is required|cancelledBy is required|cancellationReason is required/
  );
});
