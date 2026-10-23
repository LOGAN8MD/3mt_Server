import { timingSafeEqual } from 'node:crypto';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import ReminderDefinition from '../models/ReminderDefinition.js';
import { deliverReminderEmail } from './reminderEmailDeliveryService.js';
import { requireEligibleReminder } from './reminderEligibilityService.js';

const MINUTE = 60_000;
let stopping = false;
let activeDeliveries = 0;
const waitingDeliveries = [];
export const automaticEmailEnabled = () => process.env.REMINDER_EMAIL_AUTOMATION_ENABLED === 'true';

export const validCronSecret = (authorization, secret) => {
  if (!secret || secret.length < 32) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(authorization || '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

// Timer handles are transient. MongoDB channel claims prevent concurrent sends.
export const createReminderTimerQueue = ({ execute, setTimer = setTimeout, clearTimer = clearTimeout }) => {
  const timers = new Map();
  return {
    schedule(id, dueAt, now = new Date()) {
      if (timers.has(id)) return false;
      const timer = setTimer(async () => {
        try { await execute(id); } finally { timers.delete(id); }
      }, Math.max(0, new Date(dueAt).getTime() - now.getTime()));
      timer?.unref?.();
      timers.set(id, timer);
      return true;
    },
    ids: () => [...timers.keys()],
    cancel(id) {
      if (timers.has(id)) clearTimer(timers.get(id));
      timers.delete(id);
    },
    clear() {
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
    },
  };
};

const deliverDue = async (id) => {
  if (activeDeliveries >= 3) await new Promise((resolve) => waitingDeliveries.push(resolve));
  activeDeliveries += 1;
  try {
    if (stopping || !automaticEmailEnabled()) return;
    const occurrence = await requireEligibleReminder(id);
    const dueAt = occurrence.nextAttemptAt || occurrence.scheduledAt;
    if (Date.now() - new Date(dueAt).getTime() > 10 * MINUTE) {
      await ReminderOccurrence.updateOne({ _id: id, 'emailDelivery.status': { $in: ['pending', 'failed'] } }, {
        $set: { 'emailDelivery.status': 'skipped', 'emailDelivery.lastError': 'Automatic email missed its ten-minute delivery window' },
      });
      return;
    }
    await deliverReminderEmail(id);
  } catch (error) {
    if (error.statusCode !== 409) console.error('Reminder email processing failed:', id, error.message);
  } finally {
    activeDeliveries -= 1;
    waitingDeliveries.shift()?.();
  }
};

const queue = createReminderTimerQueue({ execute: deliverDue });
let scanning = false;
let interval;

export const processReminderEmails = async () => {
  if (!automaticEmailEnabled()) return { enabled: false, scheduled: 0 };
  if (scanning) return { enabled: true, busy: true, scheduled: 0 };
  scanning = true;
  try {
    const now = new Date();
    const horizon = new Date(now.getTime() + 10 * MINUTE);
    // An interrupted provider request has an unknown result: never blindly resend it.
    await ReminderOccurrence.updateMany({
      'emailDelivery.status': 'processing',
      'emailDelivery.lastAttemptAt': { $lt: new Date(now.getTime() - 5 * MINUTE) },
    }, { $set: { 'emailDelivery.status': 'uncertain', 'emailDelivery.lastError': 'Interrupted delivery; check Brevo before any further send' } });

    for (const id of queue.ids()) {
      try {
        await requireEligibleReminder(id, { now: horizon });
      } catch { queue.cancel(id); }
    }
    const activeDefinitions = await ReminderDefinition.find({ status: 'active' }).distinct('_id');
    const occurrences = await ReminderOccurrence.find({
      definition: { $in: activeDefinitions },
      status: { $nin: ['cancelled', 'missed', 'sent'] },
      channels: 'email',
      'emailDelivery.status': { $in: ['pending', 'failed'] },
      scheduledAt: { $lte: horizon },
      $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: horizon } }],
      $expr: { $lt: ['$emailDelivery.attemptsCount', '$maxAttemptsPerChannel'] },
    }).sort({ scheduledAt: 1 }).limit(500).lean();
    let scheduled = 0;
    for (const occurrence of occurrences) {
      try {
        await requireEligibleReminder(occurrence._id, { now: horizon });
      } catch { continue; }
      if (queue.schedule(String(occurrence._id), occurrence.nextAttemptAt || occurrence.scheduledAt, now)) scheduled += 1;
    }
    return { enabled: true, scheduled, timers: queue.ids().length };
  } finally { scanning = false; }
};

export const stopReminderProcessor = () => {
  stopping = true;
  clearInterval(interval);
  queue.clear();
};

export const startReminderProcessor = () => {
  if (!automaticEmailEnabled()) return;
  stopping = false;
  const tick = () => processReminderEmails().catch((error) => console.error('Reminder scan failed:', error.message));
  tick();
  interval = setInterval(tick, 30_000);
  interval.unref();
};
