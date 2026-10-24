import mongoose from 'mongoose';
import ReminderDefinition from '../models/ReminderDefinition.js';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import ReminderPlan from '../models/ReminderPlan.js';
import { cancelReminderTimers, processReminderEmails } from './reminderProcessor.js';
import { buildReminderPlanRecords, reminderPlanFingerprint } from './reminderPlanService.js';
import {
  buildDefaultReturnReminderPlans,
  buildRentalActivationReminderPlan,
} from '../utils/rentalReminderWorkflow.js';
import {
  prepareRentalReminderSettings,
} from '../utils/rentalReminderSettings.js';

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

const SUCCESSFUL_CHANNEL_STATUSES = new Set(['accepted', 'delivered', 'manual_sent']);

const customerFromRental = (rental) => ({
  _id: rental.customer,
  name: rental.customerSnapshot?.name || '',
  email: rental.customerSnapshot?.email || '',
  phone: rental.customerSnapshot?.phone || '',
});

const planCodeForRental = (rental) => `RPL-${rental._id}-RETURN`.toUpperCase();

export const upsertPlan = async ({ definition, occurrence }, { session } = {}) => {
  const savedDefinition = await ReminderDefinition.findOneAndUpdate(
    { definitionCode: definition.definitionCode },
    { $setOnInsert: definition },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true, session }
  );

  return ReminderOccurrence.findOneAndUpdate(
    { occurrenceKey: occurrence.occurrenceKey },
    {
      $setOnInsert: buildOccurrenceUpsertDocument(occurrence, savedDefinition._id),
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true, session }
  );
};

const createCompleteRentalReturnPlan = async (
  rental,
  adminId,
  { now, customer, session }
) => {
  const { prepared, settings } = prepareRentalReminderSettings(rental.reminderSettings, {
    rental,
    customer,
    now,
  });
  const existing = await ReminderPlan.findOne({
    rental: rental._id,
    status: { $in: ['active', 'paused'] },
  }).session(session);
  if (existing) return existing;

  const planId = new mongoose.Types.ObjectId();
  const planCode = planCodeForRental(rental);
  const records = buildReminderPlanRecords({
    planId,
    planCode,
    version: 1,
    prepared,
    rental,
    customer,
    adminId,
    now,
  });
  const [plan] = await ReminderPlan.create([{
    _id: planId,
    planCode,
    planType: 'rental',
    reminderMode: prepared.reminderMode,
    rental: rental._id,
    customer: rental.customer,
    recipientSnapshot: records.recipientSnapshot,
    startsAt: prepared.startsAt,
    endsAt: prepared.endsAt,
    rows: records.planRows,
    fingerprint: reminderPlanFingerprint(prepared),
    submissionKey: `rental-${rental._id}-activation`,
    createdBy: adminId,
    updatedBy: adminId,
    auditHistory: [{
      action: 'rental_reminder_plan_activated',
      note: `${settings.mode} rental reminder settings activated`,
      performedBy: adminId,
      performedAt: now,
    }],
  }], { session });
  if (records.definitions.length) {
    await ReminderDefinition.insertMany(records.definitions, { session });
    await ReminderOccurrence.insertMany(records.occurrences, { session });
  }
  return plan;
};

export const createRentalLifecycleReminders = async (
  rental,
  adminId,
  { now = new Date(), customer = customerFromRental(rental) } = {}
) => {
  const activationPlan = buildRentalActivationReminderPlan(rental, adminId, { now });
  let activationOccurrence;
  try {
    await mongoose.connection.transaction(async (session) => {
      await createCompleteRentalReturnPlan(rental, adminId, { now, customer, session });
      activationOccurrence = await upsertPlan(activationPlan, { session });
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existingPlan = await ReminderPlan.exists({
      rental: rental._id,
      status: { $in: ['active', 'paused'] },
    });
    if (!existingPlan) throw error;
    activationOccurrence = await upsertPlan(activationPlan);
  }
  void processReminderEmails().catch((error) => console.error('Rental reminder scan failed:', error.message));
  return activationOccurrence;
};

const deliveredChannelsByRow = async (planId, session) => {
  const occurrences = await ReminderOccurrence.find({ plan: planId })
    .select('planRowKey emailDelivery.status whatsappDelivery.status')
    .session(session)
    .lean();
  const result = new Map();
  for (const occurrence of occurrences) {
    const delivered = result.get(occurrence.planRowKey) || new Set();
    if (SUCCESSFUL_CHANNEL_STATUSES.has(occurrence.emailDelivery?.status)) delivered.add('email');
    if (SUCCESSFUL_CHANNEL_STATUSES.has(occurrence.whatsappDelivery?.status)) delivered.add('whatsapp');
    result.set(occurrence.planRowKey, delivered);
  }
  return new Map([...result].map(([key, channels]) => [key, [...channels]]));
};

const rescheduleCompleteRentalPlan = async (rental, plan, adminId, now) => {
  const customer = customerFromRental(rental);
  const { prepared } = prepareRentalReminderSettings(
    { mode: plan.reminderMode, reminders: plan.reminderMode === 'custom' ? plan.rows : [] },
    { rental, customer, now }
  );
  const nextVersion = plan.version + 1;
  let cancelledIds = [];
  await mongoose.connection.transaction(async (session) => {
    const excludedChannelsByRowKey = await deliveredChannelsByRow(plan._id, session);
    const records = buildReminderPlanRecords({
      planId: plan._id,
      planCode: plan.planCode,
      version: nextVersion,
      prepared,
      rental,
      customer,
      adminId,
      now,
      excludedChannelsByRowKey,
    });
    for (const definition of records.definitions) definition.status = plan.status;
    const unsent = await ReminderOccurrence.find({
      plan: plan._id,
      status: { $in: UNSENT_OCCURRENCE_STATUSES },
    }).select('_id').session(session).lean();
    cancelledIds = unsent.map(({ _id }) => _id);
    const cancellation = {
      status: 'cancelled',
      cancelledAt: now,
      cancelledBy: adminId,
      cancellationReason: 'Superseded by rental return deadline extension',
    };
    await ReminderOccurrence.updateMany(
      { _id: { $in: cancelledIds } },
      { $set: { ...cancellation, lockToken: '' }, $unset: { lockedAt: 1, lockExpiresAt: 1, nextAttemptAt: 1 } },
      { session }
    );
    await ReminderDefinition.updateMany(
      { plan: plan._id, status: { $in: ['active', 'paused'] } },
      { $set: { ...cancellation, updatedBy: adminId } },
      { session }
    );
    plan.startsAt = prepared.startsAt;
    plan.endsAt = prepared.endsAt;
    plan.rows = records.planRows;
    plan.version = nextVersion;
    plan.fingerprint = reminderPlanFingerprint(prepared);
    plan.updatedBy = adminId;
    plan.auditHistory.push({
      action: 'rental_reminder_plan_rescheduled',
      note: 'Rental return deadline was extended',
      changes: { scheduleVersion: nextVersion, expectedReturnAt: rental.expectedReturnAt },
      performedBy: adminId,
      performedAt: now,
    });
    await plan.save({ session });
    if (records.definitions.length) {
      await ReminderDefinition.insertMany(records.definitions, { session });
      await ReminderOccurrence.insertMany(records.occurrences, { session });
    }
  });
  cancelReminderTimers(cancelledIds);
  void processReminderEmails().catch((error) => console.error('Rental reminder scan failed:', error.message));
  return plan;
};

export const rescheduleRentalReturnReminders = async (
  rental,
  adminId,
  { now = new Date() } = {}
) => {
  const completePlan = await ReminderPlan.findOne({
    rental: rental._id,
    status: { $in: ['active', 'paused'] },
  });
  if (completePlan) {
    return rescheduleCompleteRentalPlan(rental, completePlan, adminId, now);
  }

  const definitions = await ReminderDefinition.find({
    rental: rental._id,
    type: 'rental_return',
    status: { $in: ['active', 'paused'] },
    scheduleMode: 'offset_before_return',
  });

  const occurrences = [];
  for (const definition of definitions) {
    const nextVersion = definition.scheduleVersion + 1;
    const supersededOccurrences = await ReminderOccurrence.find({
      definition: definition._id,
      status: { $in: UNSENT_OCCURRENCE_STATUSES },
    }).select('_id').lean();
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
    cancelReminderTimers(supersededOccurrences.map(({ _id }) => _id));

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
  let unsentOccurrences = [];
  let definitionResult = { modifiedCount: 0 };
  let occurrenceResult = { modifiedCount: 0 };
  let planResult = { modifiedCount: 0 };
  await mongoose.connection.transaction(async (session) => {
    const definitions = await ReminderDefinition.find({
      rental: rentalId,
      status: { $in: ['active', 'paused'] },
    }).select('_id').session(session);
    const definitionIds = definitions.map((definition) => definition._id);

    if (definitionIds.length) {
      unsentOccurrences = await ReminderOccurrence.find({
        definition: { $in: definitionIds },
        status: { $in: UNSENT_OCCURRENCE_STATUSES },
      }).select('_id').session(session).lean();
      [definitionResult, occurrenceResult] = await Promise.all([
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
          },
          { session }
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
          },
          { session }
        ),
      ]);
    }
    planResult = await ReminderPlan.updateMany(
      { rental: rentalId, status: { $in: ['active', 'paused'] } },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: now,
          cancelledBy: adminId,
          cancellationReason: reason,
          updatedBy: adminId,
        },
        $push: {
          auditHistory: {
            action: 'rental_reminder_plan_cancelled',
            note: reason,
            performedBy: adminId,
            performedAt: now,
          },
        },
      },
      { session }
    );
  });
  cancelReminderTimers(unsentOccurrences.map(({ _id }) => _id));

  return {
    definitionsCancelled: definitionResult.modifiedCount,
    occurrencesCancelled: occurrenceResult.modifiedCount,
    plansCancelled: planResult.modifiedCount,
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
    const replacedOccurrences = await ReminderOccurrence.find({
      definition: { $in: activeIds },
      status: { $in: UNSENT_OCCURRENCE_STATUSES },
    }).select('_id').lean();
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
    cancelReminderTimers(replacedOccurrences.map(({ _id }) => _id));
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
