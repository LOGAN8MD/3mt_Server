import NotificationDeliveryAttempt from '../models/NotificationDeliveryAttempt.js';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import AppError from '../utils/AppError.js';
import { sendReminderEmail } from './emailService.js';
import { requireEligibleReminder } from './reminderEligibilityService.js';

const ELIGIBLE_OCCURRENCE_STATUSES = [
  'pending',
  'scheduled',
  'processing',
  'failed',
  'partially_failed',
];
const SUCCESS_CHANNEL_STATUSES = new Set(['accepted', 'delivered', 'manual_sent']);

export const deriveOccurrenceDeliveryStatus = (emailStatus, whatsappStatus) => {
  const selected = [emailStatus, whatsappStatus].filter((status) => status !== 'not_selected');
  if (selected.length === 0) return 'failed';
  if (selected.every((status) => SUCCESS_CHANNEL_STATUSES.has(status))) return 'sent';
  if (selected.some((status) => status === 'processing')) return 'processing';

  const hasSuccess = selected.some((status) => SUCCESS_CHANNEL_STATUSES.has(status));
  const hasFailure = selected.some((status) => ['failed', 'uncertain'].includes(status));
  if (hasSuccess && hasFailure) return 'partially_failed';
  if (selected.every((status) => ['failed', 'uncertain'].includes(status))) return 'failed';
  return 'pending';
};

const retryAt = (attemptNumber, now) =>
  new Date(now.getTime() + Math.min(60, 5 * 2 ** (attemptNumber - 1)) * 60 * 1000);

export const refreshOccurrenceDeliveryStatus = async (id) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await ReminderOccurrence.findById(id).lean();
    if (!current || ['cancelled', 'missed'].includes(current.status)) return current;
    const status = deriveOccurrenceDeliveryStatus(current.emailDelivery.status, current.whatsappDelivery.status);
    const updated = await ReminderOccurrence.findOneAndUpdate({
      _id: id,
      status: current.status,
      'emailDelivery.status': current.emailDelivery.status,
      'whatsappDelivery.status': current.whatsappDelivery.status,
    }, { $set: { status, ...(status === 'sent' ? { sentAt: new Date(), completedAt: new Date() } : {}) } }, { new: true }).lean();
    if (updated) return updated;
  }
  return ReminderOccurrence.findById(id).lean();
};

const claimEmailDelivery = (occurrenceId, now) =>
  ReminderOccurrence.findOneAndUpdate(
    {
      _id: occurrenceId,
      status: { $in: ELIGIBLE_OCCURRENCE_STATUSES },
      channels: 'email',
      scheduledAt: { $lte: now },
      $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }],
      'emailDelivery.status': { $in: ['pending', 'failed'] },
      $expr: { $lt: ['$emailDelivery.attemptsCount', '$maxAttemptsPerChannel'] },
    },
    {
      $set: {
        status: 'processing',
        'emailDelivery.status': 'processing',
        'emailDelivery.lastAttemptAt': now,
        processingStartedAt: now,
      },
      $inc: { 'emailDelivery.attemptsCount': 1 },
      $unset: { nextAttemptAt: 1 },
    },
    { new: true }
  );

export const deliverReminderEmail = async (
  occurrenceId,
  { now = new Date(), sendEmail = sendReminderEmail } = {}
) => {
  const eligible = await requireEligibleReminder(occurrenceId, { now });
  const claimed = await claimEmailDelivery(occurrenceId, now);
  if (!claimed) {
    const existing = await ReminderOccurrence.findById(occurrenceId).lean();
    if (!existing) throw new AppError('Reminder occurrence not found', 404);
    if (SUCCESS_CHANNEL_STATUSES.has(existing.emailDelivery?.status)) {
      return { occurrence: existing, skipped: true, reason: 'email_already_accepted' };
    }
    throw new AppError('Reminder email is not eligible for delivery or retries are exhausted', 409);
  }

  const attemptNumber = claimed.emailDelivery.attemptsCount;
  const idempotencyKey = `${claimed.occurrenceKey}:EMAIL:${attemptNumber}`;
  let attempt;
  let providerAccepted = false;
  try {
    attempt = await NotificationDeliveryAttempt.create({
      occurrence: claimed._id,
      definition: claimed.definition,
      channel: 'email',
      attemptNumber,
      idempotencyKey,
      status: 'processing',
      provider: 'brevo',
      startedAt: now,
    });
  } catch (error) {
    await ReminderOccurrence.findByIdAndUpdate(claimed._id, {
      $set: {
        'emailDelivery.status': 'failed',
        'emailDelivery.failedAt': new Date(),
        'emailDelivery.lastError': 'Could not create email delivery attempt',
      },
    });
    await refreshOccurrenceDeliveryStatus(claimed._id);
    throw error;
  }

  try {
    const providerResult = await sendEmail({
      to: claimed.recipientSnapshot.email,
      recipientName: claimed.recipientSnapshot.name,
      content: eligible.contentSnapshot,
      idempotencyKey,
    });
    const acceptedAt = new Date();
    providerAccepted = true;
    attempt.status = 'accepted';
    attempt.provider = providerResult.provider;
    attempt.providerMessageId = providerResult.providerMessageId;
    attempt.responseMetadata = providerResult.responseMetadata;
    attempt.completedAt = acceptedAt;
    await attempt.save();

    await ReminderOccurrence.findByIdAndUpdate(
      claimed._id,
      {
        $set: {
          'emailDelivery.status': 'accepted',
          'emailDelivery.provider': providerResult.provider,
          'emailDelivery.providerMessageId': providerResult.providerMessageId,
          'emailDelivery.acceptedAt': acceptedAt,
          'emailDelivery.lastError': '',
        },
        $unset: { nextAttemptAt: 1 },
      },
      { new: true }
    ).lean();
    const occurrence = await refreshOccurrenceDeliveryStatus(claimed._id);
    return { occurrence, attempt: attempt.toObject(), skipped: false };
  } catch (error) {
    const failedAt = new Date();
    const uncertain = providerAccepted || !error?.responseCode;
    attempt.status = uncertain ? 'uncertain' : 'failed';
    attempt.errorCode = error.code || error.name || 'EMAIL_DELIVERY_FAILED';
    attempt.errorMessage = error.message;
    attempt.responseMetadata = {
      responseCode: error.responseCode,
      response: error.response,
    };
    attempt.completedAt = failedAt;
    await attempt.save();

    await ReminderOccurrence.findByIdAndUpdate(claimed._id, {
      $set: {
        'emailDelivery.status': uncertain ? 'uncertain' : 'failed',
        'emailDelivery.failedAt': failedAt,
        'emailDelivery.lastError': error.message,
        nextAttemptAt: retryAt(attemptNumber, failedAt),
      },
    });
    await refreshOccurrenceDeliveryStatus(claimed._id);
    throw error;
  }
};
