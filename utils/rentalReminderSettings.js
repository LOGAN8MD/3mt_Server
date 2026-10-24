import AppError from './AppError.js';
import { prepareReminderPlan } from './reminderPlan.js';

const rawSettings = (value) => {
  const settings = value ?? { mode: 'default', reminders: [] };
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new AppError('reminderSettings must be an object', 400);
  }
  const mode = String(settings.mode || 'default').trim().toLowerCase();
  if (!['default', 'custom'].includes(mode)) {
    throw new AppError('reminderSettings.mode must be default or custom', 400);
  }
  if (mode === 'default' && Array.isArray(settings.reminders) && settings.reminders.length) {
    throw new AppError('Default reminder settings cannot contain custom rows', 400);
  }
  return { mode, reminders: mode === 'custom' ? settings.reminders : [] };
};

export const prepareRentalReminderSettings = (
  value,
  { rental, customer, now = new Date() }
) => {
  const settings = rawSettings(value);
  const prepared = prepareReminderPlan({
    reminderMode: settings.mode,
    reminders: settings.reminders,
  }, { rental, customer, now });

  return {
    prepared,
    settings: {
      mode: prepared.reminderMode,
      reminders: prepared.reminderMode === 'custom'
        ? prepared.reminders.map((row) => ({
          offsetMinutes: row.offsetMinutes,
          channels: [...row.channels],
          content: row.content,
        }))
        : [],
    },
  };
};

export const reminderSettingsPayload = (settings) => ({
  reminderMode: settings?.mode || 'default',
  reminders: settings?.mode === 'custom'
    ? (settings.reminders || []).map((row) => ({
      offsetMinutes: row.offsetMinutes,
      channels: [...row.channels],
      content: row.content,
    }))
    : [],
});
