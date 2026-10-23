export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

const INDIA_OFFSET_MINUTES = 5 * 60 + 30;
const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

export const indiaLocalDateTimeToUtc = (value) => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError('A valid date is required');
    }
    return new Date(value.getTime());
  }

  if (typeof value !== 'string') {
    throw new TypeError('India local date/time must be a string');
  }

  const match = value.trim().match(LOCAL_DATE_TIME_PATTERN);
  if (!match) {
    throw new TypeError('India local date/time must use YYYY-MM-DDTHH:mm[:ss]');
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', msText = '0'] =
    match;
  const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = parts;
  const millisecond = Number(msText.padEnd(3, '0'));

  const localAsUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  if (
    localAsUtc.getUTCFullYear() !== year ||
    localAsUtc.getUTCMonth() !== month - 1 ||
    localAsUtc.getUTCDate() !== day ||
    localAsUtc.getUTCHours() !== hour ||
    localAsUtc.getUTCMinutes() !== minute ||
    localAsUtc.getUTCSeconds() !== second
  ) {
    throw new TypeError('India local date/time contains an invalid calendar value');
  }

  return new Date(localAsUtc.getTime() - INDIA_OFFSET_MINUTES * 60 * 1000);
};

export const formatInBusinessTimeZone = (value, options = {}) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('A valid date is required');
  }

  return new Intl.DateTimeFormat('en-IN', {
    timeZone: BUSINESS_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
  }).format(date);
};
