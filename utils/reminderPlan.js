import mongoose from 'mongoose';
import AppError from './AppError.js';
import { parseReminderDate, normalizeReminderChannels } from './reminderManagement.js';
import { prepareCustomBilingualContent } from './reminderMessageTemplates.js';

export const MAX_REMINDER_PLAN_ROWS = 20;
export const DEFAULT_RENTAL_PLAN_OFFSETS_MINUTES = Object.freeze([720, 60]);

const idString = (value, field) => {
  const id = value?._id ?? value;
  if (!mongoose.isValidObjectId(id)) throw new AppError(`${field} must be a valid id`, 400);
  return id.toString();
};

const validateCustomerContacts = (customer, channels) => {
  if (!customer) throw new AppError('Reminder customer is required', 400);
  if (channels.includes('email') && !String(customer.email || '').trim()) {
    throw new AppError('The selected customer does not have an email address', 400);
  }
  if (channels.includes('whatsapp') && !String(customer.phone || '').trim()) {
    throw new AppError('The selected customer does not have a phone number', 400);
  }
};

const prepareCustomContent = (content, index) => {
  try {
    return prepareCustomBilingualContent(content);
  } catch (error) {
    throw new AppError(`reminders[${index}].content: ${error.message}`, 400);
  }
};

const prepareCustomRows = ({ reminders, fallbackChannels, fallbackContent }, context) => {
  if (!Array.isArray(reminders) || reminders.length === 0) {
    throw new AppError('A custom reminder plan requires at least one reminder', 400);
  }
  if (reminders.length > MAX_REMINDER_PLAN_ROWS) {
    throw new AppError(
      `A reminder plan can contain at most ${MAX_REMINDER_PLAN_ROWS} reminders`,
      400
    );
  }

  const rows = reminders.map((reminder, index) => {
    if (!Number.isSafeInteger(reminder?.offsetMinutes) || reminder.offsetMinutes <= 0) {
      throw new AppError(`reminders[${index}].offsetMinutes must be a positive integer`, 400);
    }
    const channels = normalizeReminderChannels(reminder.channels ?? fallbackChannels);
    validateCustomerContacts(context.customer, channels);
    const scheduledAt = new Date(context.endsAt.getTime() - reminder.offsetMinutes * 60_000);
    if (scheduledAt <= context.now) {
      throw new AppError(`reminders[${index}] must be scheduled in the future`, 400);
    }
    if (scheduledAt < context.startsAt || scheduledAt >= context.endsAt) {
      throw new AppError(
        `reminders[${index}] must be scheduled within the selected period before its end`,
        400
      );
    }

    return {
      rowKey: `OFFSET-${reminder.offsetMinutes}M`,
      offsetMinutes: reminder.offsetMinutes,
      scheduledAt,
      scheduleMode: context.planType === 'rental' ? 'offset_before_return' : 'exact',
      channels,
      contentMode: 'custom',
      content: prepareCustomContent(reminder.content ?? fallbackContent, index),
      status: 'pending',
    };
  });

  const offsets = new Set(rows.map(({ offsetMinutes }) => offsetMinutes));
  const scheduledTimes = new Set(rows.map(({ scheduledAt }) => scheduledAt.getTime()));
  if (offsets.size !== rows.length || scheduledTimes.size !== rows.length) {
    throw new AppError('Reminder timings must be unique within a plan', 400);
  }
  return rows.sort((first, second) => first.scheduledAt - second.scheduledAt);
};

const prepareDefaultRentalRows = (context) => {
  const channels = ['email', 'whatsapp'];
  validateCustomerContacts(context.customer, channels);
  return DEFAULT_RENTAL_PLAN_OFFSETS_MINUTES.map((offsetMinutes) => {
    const scheduledAt = new Date(context.endsAt.getTime() - offsetMinutes * 60_000);
    const missed = scheduledAt <= context.now;
    return {
      rowKey: `OFFSET-${offsetMinutes}M`,
      offsetMinutes,
      scheduledAt,
      scheduleMode: 'offset_before_return',
      channels: [...channels],
      contentMode: 'default_template',
      status: missed ? 'missed' : 'pending',
      ...(missed ? { missedAt: new Date(context.now) } : {}),
    };
  }).sort((first, second) => first.scheduledAt - second.scheduledAt);
};

export const prepareReminderPlan = (payload, {
  rental = null,
  customer,
  now = new Date(),
} = {}) => {
  const planType = rental ? 'rental' : 'standalone';
  const customerId = idString(customer, 'customerId');
  const rentalCustomerId = rental ? idString(rental.customer, 'rental.customer') : null;
  if (rentalCustomerId && rentalCustomerId !== customerId) {
    throw new AppError('The selected customer does not match the rental customer', 400);
  }

  const startsAt = rental
    ? parseReminderDate(rental.handoverAt, 'rental.handoverAt')
    : parseReminderDate(payload.startAt, 'startAt');
  const endsAt = rental
    ? parseReminderDate(rental.expectedReturnAt, 'rental.expectedReturnAt')
    : parseReminderDate(payload.endAt, 'endAt');
  if (endsAt <= startsAt) throw new AppError('Reminder plan end time must be after start time', 400);
  if (endsAt <= now) throw new AppError('Reminder plan end time must be in the future', 400);

  const reminderMode = planType === 'rental'
    ? String(payload.reminderMode || 'default').trim().toLowerCase()
    : 'custom';
  if (planType === 'rental' && !['default', 'custom'].includes(reminderMode)) {
    throw new AppError('reminderMode must be default or custom', 400);
  }

  const context = { planType, customer, startsAt, endsAt, now };
  const reminders = reminderMode === 'default'
    ? prepareDefaultRentalRows(context)
    : prepareCustomRows({
      reminders: payload.reminders,
      fallbackChannels: payload.channels,
      fallbackContent: payload.content,
    }, context);

  return {
    planType,
    reminderMode,
    customerId,
    ...(rental ? { rentalId: idString(rental, 'rentalId') } : {}),
    startsAt,
    endsAt,
    reminders,
  };
};
