import { renderRentalReminderContent } from './reminderMessageTemplates.js';

export const DEFAULT_RETURN_REMINDER_OFFSETS_MINUTES = Object.freeze([720, 60]);
export const RENTAL_REMINDER_CHANNELS = Object.freeze(['email', 'whatsapp']);

const requireDate = (value, field) => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a valid date`);
  return date;
};

const requireRentalIdentity = (rental) => {
  const rentalId = String(rental?._id || '').trim();
  const customerId = String(rental?.customer || '').trim();
  if (!rentalId) throw new TypeError('rental._id is required');
  if (!customerId) throw new TypeError('rental.customer is required');
  return { rentalId, customerId };
};

const recipientSnapshot = (rental) => ({
  name: String(rental.customerSnapshot?.name || '').trim(),
  email: String(rental.customerSnapshot?.email || '').trim().toLowerCase(),
  phone: String(rental.customerSnapshot?.phone || '').trim(),
});

const messageVariables = (rental) => ({
  rentalCode: rental.rentalCode,
  customerName: rental.customerSnapshot?.name || '',
  machineName: rental.machineSnapshot?.name || '',
  handoverAt: rental.handoverAt,
  expectedReturnAt: rental.expectedReturnAt,
  billingPeriod: rental.billingPeriod,
  agreedRatePaise: rental.agreedRatePaise,
  plannedRentalChargePaise: rental.plannedRentalChargePaise,
  rentalPaymentsReceivedPaise: rental.rentalPaymentsReceivedPaise,
  remainingPlannedBalancePaise: Math.max(
    0,
    Number(rental.plannedRentalChargePaise || 0) - Number(rental.rentalPaymentsReceivedPaise || 0)
  ),
  securityDepositReceivedPaise: rental.securityDepositReceivedPaise,
  currency: rental.currency || 'INR',
});

const definitionCode = (rentalId, suffix) => `RMD-${rentalId}-${suffix}`.toUpperCase();
const occurrenceKey = (rentalId, suffix, version) =>
  `ROC-${rentalId}-${suffix}-V${version}`.toUpperCase();

const occurrenceStatus = (scheduledAt, now, { immediate = false } = {}) =>
  !immediate && scheduledAt <= now ? 'missed' : 'pending';

const defaultContent = (templateKey, variables) =>
  renderRentalReminderContent(templateKey, variables);

export const buildRentalActivationReminderPlan = (rental, adminId, { now = new Date() } = {}) => {
  const { rentalId, customerId } = requireRentalIdentity(rental);
  const scheduledAt = requireDate(now, 'now');
  const suffix = 'ACTIVATION';
  const variables = messageVariables(rental);
  const content = defaultContent('rental_activation_confirmation', variables);

  return {
    definition: {
      definitionCode: definitionCode(rentalId, suffix),
      type: 'rental_activation_confirmation',
      rental: rentalId,
      customer: customerId,
      recipientSnapshot: recipientSnapshot(rental),
      scheduleMode: 'immediate',
      channels: [...RENTAL_REMINDER_CHANNELS],
      contentMode: 'default_template',
      content,
      scheduleVersion: 1,
      createdBy: adminId,
      updatedBy: adminId,
    },
    occurrence: {
      occurrenceKey: occurrenceKey(rentalId, suffix, 1),
      definitionType: 'rental_activation_confirmation',
      rental: rentalId,
      customer: customerId,
      recipientSnapshot: recipientSnapshot(rental),
      scheduledAt,
      status: occurrenceStatus(scheduledAt, scheduledAt, { immediate: true }),
      scheduleVersion: 1,
      channels: [...RENTAL_REMINDER_CHANNELS],
      contentSnapshot: content,
    },
  };
};

export const buildDefaultReturnReminderPlans = (
  rental,
  adminId,
  { now = new Date(), scheduleVersion = 1 } = {}
) => {
  const { rentalId, customerId } = requireRentalIdentity(rental);
  const currentAt = requireDate(now, 'now');
  const expectedReturnAt = requireDate(rental.expectedReturnAt, 'rental.expectedReturnAt');

  return DEFAULT_RETURN_REMINDER_OFFSETS_MINUTES.map((offsetMinutes) => {
    const scheduledAt = new Date(expectedReturnAt.getTime() - offsetMinutes * 60 * 1000);
    const suffix = `RETURN-${offsetMinutes}M`;
    const status = occurrenceStatus(scheduledAt, currentAt);
    const variables = { ...messageVariables(rental), reminderOffsetMinutes: offsetMinutes };
    const content = defaultContent('rental_return_default', variables);

    return {
      definition: {
        definitionCode: definitionCode(rentalId, suffix),
        type: 'rental_return',
        rental: rentalId,
        customer: customerId,
        recipientSnapshot: recipientSnapshot(rental),
        scheduleMode: 'offset_before_return',
        offsetMinutes,
        channels: [...RENTAL_REMINDER_CHANNELS],
        contentMode: 'default_template',
        content,
        scheduleVersion,
        createdBy: adminId,
        updatedBy: adminId,
      },
      occurrence: {
        occurrenceKey: occurrenceKey(rentalId, suffix, scheduleVersion),
        definitionType: 'rental_return',
        rental: rentalId,
        customer: customerId,
        recipientSnapshot: recipientSnapshot(rental),
        scheduledAt,
        status,
        ...(status === 'missed' ? { missedAt: currentAt } : {}),
        scheduleVersion,
        channels: [...RENTAL_REMINDER_CHANNELS],
        contentSnapshot: content,
      },
    };
  });
};
