import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import NotificationDeliveryAttempt from '../models/NotificationDeliveryAttempt.js';
import ReminderDefinition from '../models/ReminderDefinition.js';
import ReminderOccurrence from '../models/ReminderOccurrence.js';

const ids = {
  admin: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
  rental: new mongoose.Types.ObjectId(),
  definition: new mongoose.Types.ObjectId(),
  occurrence: new mongoose.Types.ObjectId(),
};

const recipientSnapshot = {
  name: 'Rahul Customer',
  email: 'rahul@example.com',
  phone: '+919876543210',
};

const buildDefinition = (overrides = {}) =>
  new ReminderDefinition({
    definitionCode: 'rmd-rental-return-001',
    type: 'rental_return',
    rental: ids.rental,
    customer: ids.customer,
    recipientSnapshot,
    scheduleMode: 'offset_before_return',
    offsetMinutes: 720,
    channels: ['email', 'whatsapp'],
    createdBy: ids.admin,
    ...overrides,
  });

const buildOccurrence = (overrides = {}) =>
  new ReminderOccurrence({
    occurrenceKey: 'roc-rental-return-001',
    definition: ids.definition,
    definitionType: 'rental_return',
    rental: ids.rental,
    customer: ids.customer,
    recipientSnapshot,
    scheduledAt: new Date('2026-11-15T11:30:00.000Z'),
    scheduleVersion: 1,
    channels: ['email', 'whatsapp'],
    contentSnapshot: {
      templateKey: 'rental-return-default',
      bodyEnglish: 'Your machine is due for return.',
      bodyHindi: 'Machine return reminder.',
    },
    ...overrides,
  });

test('ReminderDefinition supports default rental return offsets in India time', async () => {
  const definition = buildDefinition();
  await definition.validate();

  assert.equal(definition.definitionCode, 'RMD-RENTAL-RETURN-001');
  assert.equal(definition.offsetMinutes, 720);
  assert.equal(definition.timeZone, 'Asia/Kolkata');
  assert.equal(definition.scheduleVersion, 1);
});

test('ReminderDefinition supports immediate rental activation confirmation', async () => {
  const definition = buildDefinition({
    definitionCode: 'RMD-ACTIVATION-001',
    type: 'rental_activation_confirmation',
    scheduleMode: 'immediate',
    offsetMinutes: undefined,
  });

  await definition.validate();
});

test('ReminderDefinition supports standalone multiple-date and repeating schedules', async () => {
  const multipleDates = buildDefinition({
    definitionCode: 'RMD-CUSTOM-MULTIPLE-001',
    type: 'standalone_custom',
    rental: undefined,
    scheduleMode: 'multiple_dates',
    offsetMinutes: undefined,
    exactDates: [
      new Date('2026-11-15T11:30:00.000Z'),
      new Date('2026-11-16T11:30:00.000Z'),
    ],
  });
  const repeating = buildDefinition({
    definitionCode: 'RMD-CUSTOM-REPEAT-001',
    type: 'standalone_custom',
    rental: undefined,
    scheduleMode: 'repeating',
    offsetMinutes: undefined,
    recurrence: {
      frequency: 'week',
      interval: 1,
      startsAt: new Date('2026-11-15T11:30:00.000Z'),
      occurrenceLimit: 4,
    },
  });

  await multipleDates.validate();
  await repeating.validate();

  assert.equal(multipleDates.exactDates.length, 2);
  assert.equal(repeating.recurrence.occurrenceLimit, 4);
});

test('ReminderDefinition rejects invalid schedule combinations and duplicate channels', async () => {
  const missingRental = buildDefinition({ rental: undefined });
  const invalidStandalone = buildDefinition({
    definitionCode: 'RMD-CUSTOM-INVALID-001',
    type: 'standalone_custom',
    rental: undefined,
  });
  const duplicateChannels = buildDefinition({ channels: ['email', 'email'] });

  await assert.rejects(missingRental.validate(), /rental.*required/);
  await assert.rejects(invalidStandalone.validate(), /standalone reminders cannot use/);
  await assert.rejects(duplicateChannels.validate(), /channels must contain unique/);
});

test('ReminderOccurrence tracks email and WhatsApp independently', async () => {
  const occurrence = buildOccurrence();
  await occurrence.validate();

  assert.equal(occurrence.timeZone, 'Asia/Kolkata');
  assert.equal(occurrence.emailDelivery.status, 'pending');
  assert.equal(occurrence.whatsappDelivery.status, 'pending');

  occurrence.emailDelivery.status = 'delivered';
  occurrence.emailDelivery.deliveredAt = new Date('2026-11-15T11:30:10.000Z');
  occurrence.whatsappDelivery.status = 'failed';
  occurrence.whatsappDelivery.lastError = 'Provider unavailable';
  occurrence.status = 'partially_failed';
  await occurrence.validate();

  assert.equal(occurrence.emailDelivery.status, 'delivered');
  assert.equal(occurrence.whatsappDelivery.status, 'failed');
});

test('ReminderOccurrence keeps unselected channels inactive', async () => {
  const occurrence = buildOccurrence({ channels: ['email'] });
  await occurrence.validate();

  assert.equal(occurrence.emailDelivery.status, 'pending');
  assert.equal(occurrence.whatsappDelivery.status, 'not_selected');
});

test('ReminderOccurrence requires complete expiring locks and cancellation history', async () => {
  const incompleteLock = buildOccurrence({ lockToken: 'claim-1' });
  const invalidLockWindow = buildOccurrence({
    lockToken: 'claim-2',
    lockedAt: new Date('2026-11-15T11:20:00.000Z'),
    lockExpiresAt: new Date('2026-11-15T11:19:00.000Z'),
  });
  const cancelledWithoutAudit = buildOccurrence({ status: 'cancelled' });

  await assert.rejects(incompleteLock.validate(), /must be set together/);
  await assert.rejects(invalidLockWindow.validate(), /must be after lockedAt/);
  await assert.rejects(cancelledWithoutAudit.validate(), /cancelledAt.*required/);
});

test('ReminderOccurrence declares schedule-version deduplication and due-time indexes', () => {
  const indexes = ReminderOccurrence.schema.indexes();
  const dedupe = indexes.find(([, options]) =>
    options.name === 'one_occurrence_per_schedule_version'
  );
  const due = indexes.find(([fields]) => fields.status === 1 && fields.scheduledAt === 1);

  assert.deepEqual(dedupe?.[0], { definition: 1, scheduledAt: 1, scheduleVersion: 1 });
  assert.equal(dedupe?.[1].unique, true);
  assert.ok(due);
});

test('NotificationDeliveryAttempt stores retry history and idempotency data', async () => {
  const attempt = new NotificationDeliveryAttempt({
    occurrence: ids.occurrence,
    definition: ids.definition,
    channel: 'email',
    attemptNumber: 1,
    idempotencyKey: 'occurrence-1:email:1',
    status: 'accepted',
    provider: 'brevo',
    providerMessageId: 'provider-123',
  });

  await attempt.validate();

  assert.equal(attempt.attemptNumber, 1);
  assert.equal(attempt.channel, 'email');
  assert.ok(attempt.startedAt instanceof Date);

  const uniqueAttempt = NotificationDeliveryAttempt.schema.indexes().find(([, options]) =>
    options.name === 'one_channel_attempt_number'
  );
  assert.equal(uniqueAttempt?.[1].unique, true);
});
