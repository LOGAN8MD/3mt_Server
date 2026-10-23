import ReminderDefinition from '../models/ReminderDefinition.js';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import Rental from '../models/Rental.js';
import AppError from '../utils/AppError.js';
import { renderRentalReminderContent } from '../utils/reminderMessageTemplates.js';

export const requireEligibleReminder = async (id, { now = new Date() } = {}) => {
  const occurrence = await ReminderOccurrence.findById(id).lean();
  if (!occurrence) throw new AppError('Reminder occurrence not found', 404);
  if (['cancelled', 'missed'].includes(occurrence.status)) {
    throw new AppError('This reminder is no longer available for sending', 409);
  }
  if (new Date(occurrence.scheduledAt) > now) {
    throw new AppError('This reminder is not due yet', 409);
  }
  const definition = await ReminderDefinition.findById(occurrence.definition).lean();
  if (!definition || definition.status !== 'active' || definition.scheduleVersion !== occurrence.scheduleVersion) {
    throw new AppError('Reminder is paused, cancelled, or superseded', 409);
  }
  if (occurrence.rental) {
    const rental = await Rental.findById(occurrence.rental).lean();
    if (!rental || !['active', 'overdue'].includes(rental.status)) {
      throw new AppError('Rental is no longer active', 409);
    }
    if (definition.contentMode === 'default_template') {
      occurrence.contentSnapshot = renderRentalReminderContent(occurrence.contentSnapshot.templateKey, {
        ...occurrence.contentSnapshot.variables,
        expectedReturnAt: rental.expectedReturnAt,
        plannedRentalChargePaise: rental.plannedRentalChargePaise,
        rentalPaymentsReceivedPaise: rental.rentalPaymentsReceivedPaise,
        remainingPlannedBalancePaise: Math.max(0, rental.plannedRentalChargePaise - rental.rentalPaymentsReceivedPaise),
        securityDepositReceivedPaise: rental.securityDepositReceivedPaise,
      });
    }
  }
  return occurrence;
};
