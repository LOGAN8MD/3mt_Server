import ReminderDefinition from '../models/ReminderDefinition.js';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import { processReminderEmails } from './reminderProcessor.js';
import {
  buildDefaultReturnReminderPlans,
  buildRentalActivationReminderPlan,
} from '../utils/rentalReminderWorkflow.js';

const UNSENT_OCCURRENCE_STATUSES = ['pending', 'scheduled', 'processing', 'failed'];

export const buildOccurrenceUpsertDocument = (occurrence, definitionId) => {
  const selectedChannels = new Set(occurrence.channels || []);

  return {
    ...occurrence,
    definition: definitionId,
    emailDelivery: {
      ...occurrence.emailDelivery,
      status: occurrence.emailDelivery?.status
        || (selectedChannels.has('email') ? 'pending' : 'not_selected'),
    },
    whatsappDelivery: {
      ...occurrence.whatsappDelivery,
      status: occurrence.whatsappDelivery?.status
        || (selectedChannels.has('whatsapp') ? 'pending' : 'not_selected'),
    },
  };
};

export const upsertPlan = async ({ definition, occurrence }) => {
  const savedDefinition = await ReminderDefinition.findOneAndUpdate(
    { definitionCode: definition.definitionCode },
    { $setOnInsert: definition },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );

  return ReminderOccurrence.findOneAndUpdate(
    { occurrenceKey: occurrence.occurrenceKey },
    {
      $setOnInsert: buildOccurrenceUpsertDocument(occurrence, savedDefinition._id),
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );
};

export const createRentalLifecycleReminders = async (
  rental,
  adminId,
  { now = new Date() } = {}
) => {
  const plans = [
    buildRentalActivationReminderPlan(rental, adminId, { now }),
    ...buildDefaultReturnReminderPlans(rental, adminId, { now }),
  ];

  const occurrences = [];
  for (const plan of plans) occurrences.push(await upsertPlan(plan));
  void processReminderEmails().catch((error) => console.error('Rental reminder scan failed:', error.message));
  return occurrences;
};

export const rescheduleRentalReturnReminders = async (
  rental,
  adminId,
  { now = new Date() } = {}
) => {
  const definitions = await ReminderDefinition.find({
    rental: rental._id,
    type: 'rental_return',
    status: { $in: ['active', 'paused'] },
    scheduleMode: 'offset_before_return',
  });

  const occurrences = [];
  for (const definition of definitions) {
    const nextVersion = definition.scheduleVersion + 1;
    await ReminderOccurrence.updateMany(
      {
        definition: definition._id,
        status: { $in: UNSENT_OCCURRENCE_STATUSES },
      },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: now,
          cancelledBy: adminId,
          cancellationReason: 'Superseded by rental return deadline extension',
          lockToken: '',
        },
        $unset: { lockedAt: 1, lockExpiresAt: 1, nextAttemptAt: 1 },
      }
    );

    definition.scheduleVersion = nextVersion;
    definition.status = 'active';
    definition.updatedBy = adminId;
    const [plan] = buildDefaultReturnReminderPlans(rental, adminId, {
      now,
      scheduleVersion: nextVersion,
    }).filter((item) => item.definition.offsetMinutes === definition.offsetMinutes);
    definition.content = plan.definition.content;
    definition.auditHistory.push({
      action: 'reminder_rescheduled',
      note: 'Rental return deadline was extended',
      changes: { scheduleVersion: nextVersion, expectedReturnAt: rental.expectedReturnAt },
      performedBy: adminId,
      performedAt: now,
    });
    await definition.save();

    plan.definition = definition;
    occurrences.push(await upsertPlan(plan));
  }

  return occurrences;
};

export const cancelRentalReminders = async (
  rentalId,
  adminId,
  reason,
  { now = new Date() } = {}
) => {
  const definitions = await ReminderDefinition.find({
    rental: rentalId,
    status: { $in: ['active', 'paused'] },
  }).select('_id');
  const definitionIds = definitions.map((definition) => definition._id);

  if (definitionIds.length === 0) return { definitionsCancelled: 0, occurrencesCancelled: 0 };

  const [definitionResult, occurrenceResult] = await Promise.all([
    ReminderDefinition.updateMany(
      { _id: { $in: definitionIds } },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: now,
          cancelledBy: adminId,
          cancellationReason: reason,
          updatedBy: adminId,
        },
      }
    ),
    ReminderOccurrence.updateMany(
      {
        definition: { $in: definitionIds },
        status: { $in: UNSENT_OCCURRENCE_STATUSES },
      },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: now,
          cancelledBy: adminId,
          cancellationReason: reason,
          lockToken: '',
        },
        $unset: { lockedAt: 1, lockExpiresAt: 1, nextAttemptAt: 1 },
      }
    ),
  ]);

  return {
    definitionsCancelled: definitionResult.modifiedCount,
    occurrencesCancelled: occurrenceResult.modifiedCount,
  };
};

export const restoreDefaultRentalReturnReminders = async (
  rental,
  adminId,
  { now = new Date() } = {}
) => {
  const activeDefinitions = await ReminderDefinition.find({
    rental: rental._id,
    type: 'rental_return',
    status: { $in: ['active', 'paused'] },
  }).select('_id');
  const activeIds = activeDefinitions.map((definition) => definition._id);
  if (activeIds.length) {
    await ReminderDefinition.updateMany(
      { _id: { $in: activeIds } },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: now,
          cancelledBy: adminId,
          cancellationReason: 'Replaced by default rental reminders',
          updatedBy: adminId,
        },
      }
    );
    await ReminderOccurrence.updateMany(
      { definition: { $in: activeIds }, status: { $in: UNSENT_OCCURRENCE_STATUSES } },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: now,
          cancelledBy: adminId,
          cancellationReason: 'Replaced by default rental reminders',
          lockToken: '',
        },
        $unset: { lockedAt: 1, lockExpiresAt: 1, nextAttemptAt: 1 },
      }
    );
  }

  const initialPlans = buildDefaultReturnReminderPlans(rental, adminId, { now });
  const occurrences = [];
  for (const initialPlan of initialPlans) {
    const existing = await ReminderDefinition.findOne({
      definitionCode: initialPlan.definition.definitionCode,
    });
    const version = existing ? existing.scheduleVersion + 1 : 1;
    const [plan] = buildDefaultReturnReminderPlans(rental, adminId, {
      now,
      scheduleVersion: version,
    }).filter((item) => item.definition.offsetMinutes === initialPlan.definition.offsetMinutes);

    if (existing) {
      existing.status = 'active';
      existing.scheduleVersion = version;
      existing.channels = plan.definition.channels;
      existing.contentMode = 'default_template';
      existing.content = plan.definition.content;
      existing.recipientSnapshot = plan.definition.recipientSnapshot;
      existing.updatedBy = adminId;
      existing.cancelledAt = undefined;
      existing.cancelledBy = undefined;
      existing.cancellationReason = '';
      existing.auditHistory.push({
        action: 'default_reminder_restored',
        note: 'Admin restored the default rental reminder schedule',
        performedBy: adminId,
        performedAt: now,
      });
      await existing.save();
      plan.definition = existing;
    }
    occurrences.push(await upsertPlan(plan));
  }
  return occurrences;
};
