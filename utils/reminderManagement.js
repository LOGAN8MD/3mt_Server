import mongoose from 'mongoose';
import AppError from './AppError.js';
import { indiaLocalDateTimeToUtc } from './businessTime.js';
import { prepareCustomBilingualContent } from './reminderMessageTemplates.js';

export const MAX_GENERATED_OCCURRENCES = 100;
export const MANAGEABLE_OCCURRENCE_STATUSES = Object.freeze([
  'pending',
  'scheduled',
  'processing',
  'failed',
]);

const requireObjectId = (value, field) => {
  if (!mongoose.isValidObjectId(value)) throw new AppError(`${field} must be a valid id`, 400);
  return value.toString();
};

export const parseReminderDate = (value, field) => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new AppError(`${field} must be a valid date`, 400);
    return new Date(value.getTime());
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} must be a valid date`, 400);
  }

  try {
    const date = /(Z|[+-]\d{2}:\d{2})$/i.test(value.trim())
      ? new Date(value.trim())
      : indiaLocalDateTimeToUtc(value.trim());
    if (Number.isNaN(date.getTime())) throw new TypeError('Invalid date');
    return date;
  } catch {
    throw new AppError(`${field} must be a valid date/time`, 400);
  }
};

export const normalizeReminderChannels = (channels) => {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new AppError('At least one reminder channel is required', 400);
  }
  const normalized = channels.map((channel) => String(channel).trim().toLowerCase());
  if (
    new Set(normalized).size !== normalized.length ||
    normalized.some((channel) => !['email', 'whatsapp'].includes(channel))
  ) {
    throw new AppError('channels must contain unique email and/or whatsapp values', 400);
  }
  return normalized;
};

const addRecurrence = (date, frequency, interval) => {
  const next = new Date(date.getTime());
  if (frequency === 'day') next.setUTCDate(next.getUTCDate() + interval);
  if (frequency === 'week') next.setUTCDate(next.getUTCDate() + interval * 7);
  if (frequency === 'month') next.setUTCMonth(next.getUTCMonth() + interval);
  return next;
};

export const buildReminderSchedule = (
  payload,
  { rental = null, now = new Date() } = {}
) => {
  const scheduleMode = String(payload.scheduleMode || '').trim();
  const allowed = rental
    ? ['offset_before_return', 'exact']
    : ['exact', 'multiple_dates', 'repeating'];
  if (!allowed.includes(scheduleMode)) {
    throw new AppError(`scheduleMode must be one of: ${allowed.join(', ')}`, 400);
  }

  let dates = [];
  let definitionSchedule = { scheduleMode };
  if (scheduleMode === 'offset_before_return') {
    if (!Number.isSafeInteger(payload.offsetMinutes) || payload.offsetMinutes < 0) {
      throw new AppError('offsetMinutes must be a non-negative integer', 400);
    }
    const expectedReturnAt = parseReminderDate(rental.expectedReturnAt, 'rental.expectedReturnAt');
    dates = [new Date(expectedReturnAt.getTime() - payload.offsetMinutes * 60000)];
    definitionSchedule.offsetMinutes = payload.offsetMinutes;
  } else if (scheduleMode === 'exact') {
    const exactAt = parseReminderDate(payload.exactAt, 'exactAt');
    dates = [exactAt];
    definitionSchedule.exactAt = exactAt;
  } else if (scheduleMode === 'multiple_dates') {
    if (!Array.isArray(payload.exactDates) || payload.exactDates.length === 0) {
      throw new AppError('exactDates must contain at least one date', 400);
    }
    if (payload.exactDates.length > MAX_GENERATED_OCCURRENCES) {
      throw new AppError(`A reminder can contain at most ${MAX_GENERATED_OCCURRENCES} dates`, 400);
    }
    dates = payload.exactDates.map((date, index) =>
      parseReminderDate(date, `exactDates[${index}]`)
    );
    definitionSchedule.exactDates = dates;
  } else {
    const recurrence = payload.recurrence || {};
    if (!['day', 'week', 'month'].includes(recurrence.frequency)) {
      throw new AppError('recurrence.frequency must be day, week, or month', 400);
    }
    const interval = recurrence.interval ?? 1;
    if (!Number.isSafeInteger(interval) || interval < 1) {
      throw new AppError('recurrence.interval must be a positive integer', 400);
    }
    const startsAt = parseReminderDate(recurrence.startsAt, 'recurrence.startsAt');
    const endsAt = recurrence.endsAt
      ? parseReminderDate(recurrence.endsAt, 'recurrence.endsAt')
      : null;
    const occurrenceLimit = recurrence.occurrenceLimit;
    if (!endsAt && (!Number.isSafeInteger(occurrenceLimit) || occurrenceLimit < 1)) {
      throw new AppError('Repeating reminders require endsAt or occurrenceLimit', 400);
    }
    if (occurrenceLimit && occurrenceLimit > MAX_GENERATED_OCCURRENCES) {
      throw new AppError(`occurrenceLimit cannot exceed ${MAX_GENERATED_OCCURRENCES}`, 400);
    }
    if (endsAt && endsAt <= startsAt) {
      throw new AppError('recurrence.endsAt must be after startsAt', 400);
    }

    let cursor = startsAt;
    while (
      dates.length < (occurrenceLimit || MAX_GENERATED_OCCURRENCES) &&
      (!endsAt || cursor <= endsAt)
    ) {
      dates.push(cursor);
      cursor = addRecurrence(cursor, recurrence.frequency, interval);
    }
    if (endsAt && cursor <= endsAt) {
      throw new AppError(
        `Repeating schedule exceeds the ${MAX_GENERATED_OCCURRENCES}-occurrence limit`,
        400
      );
    }
    definitionSchedule.recurrence = {
      frequency: recurrence.frequency,
      interval,
      startsAt,
      ...(endsAt ? { endsAt } : {}),
      ...(occurrenceLimit ? { occurrenceLimit } : {}),
    };
  }

  const uniqueTimes = new Set(dates.map((date) => date.getTime()));
  if (uniqueTimes.size !== dates.length) throw new AppError('Reminder dates must be unique', 400);
  if (dates.some((date) => date <= now)) {
    throw new AppError('Custom reminder dates must be in the future', 400);
  }

  return { ...definitionSchedule, dates: dates.sort((a, b) => a - b) };
};

export const prepareReminderRequest = (payload, context = {}) => ({
  customerId: context.rental
    ? context.rental.customer.toString()
    : requireObjectId(payload.customerId, 'customerId'),
  channels: normalizeReminderChannels(payload.channels),
  content: prepareCustomBilingualContent(payload.content),
  schedule: buildReminderSchedule(payload, context),
});

export const parseReminderPagination = ({ page = 1, limit = 25 } = {}) => {
  const parsedPage = Number(page);
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedPage) || parsedPage < 1) {
    throw new AppError('page must be a positive integer', 400);
  }
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    throw new AppError('limit must be an integer between 1 and 100', 400);
  }
  return { page: parsedPage, limit: parsedLimit, skip: (parsedPage - 1) * parsedLimit };
};
