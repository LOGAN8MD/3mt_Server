import assert from 'node:assert/strict';
import test from 'node:test';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import ReminderDefinition from '../models/ReminderDefinition.js';
import Rental from '../models/Rental.js';
import NotificationDeliveryAttempt from '../models/NotificationDeliveryAttempt.js';
import { buildManualWhatsappLink, prepareManualWhatsapp, markManualWhatsappSent } from '../services/reminderWhatsappService.js';
import { requireEligibleReminder } from '../services/reminderEligibilityService.js';
import { deriveOccurrenceDeliveryStatus, deliverReminderEmail } from '../services/reminderEmailDeliveryService.js';
import { cancelReminderTimers, createReminderTimerQueue, validCronSecret } from '../services/reminderProcessor.js';

const content = { bodyEnglish: 'Return Drill & pay Rs 500', bodyHindi: '\u0928\u092e\u0938\u094d\u0924\u0947' };
const record = () => ({
  _id: 'occurrence', definition: 'definition', scheduleVersion: 1,
  scheduledAt: new Date(Date.now() - 1000), status: 'pending', channels: ['email', 'whatsapp'],
  contentSnapshot: content, recipientSnapshot: { phone: '9876543210' },
  emailDelivery: { status: 'accepted' }, whatsappDelivery: { status: 'pending' },
});
const mockRecords = (t, occurrence, definition = { status: 'active', scheduleVersion: 1 }) => {
  t.mock.method(ReminderOccurrence, 'findById', () => ({ lean: async () => occurrence }));
  t.mock.method(ReminderDefinition, 'findById', () => ({ lean: async () => definition }));
};

test('manual WhatsApp encodes bilingual text and adds India country code for local mobile numbers', () => {
  const result = buildManualWhatsappLink('98765 43210', content);
  const url = new URL(result.url);
  assert.equal(url.origin, 'https://wa.me');
  assert.equal(url.pathname, '/919876543210');
  assert.equal(url.searchParams.get('text'), result.message);
  assert.match(result.message, /Return Drill & pay Rs 500/);
  assert.ok(result.message.includes(content.bodyHindi));
  assert.equal(new URL(buildManualWhatsappLink('+91 98765-43210', content).url).pathname, url.pathname);
  assert.throws(() => buildManualWhatsappLink('123<script>', content), /valid country code/);
});

test('preparing a WhatsApp link never records a send or changes email state', async (t) => {
  const occurrence = record();
  mockRecords(t, occurrence);
  const mutation = t.mock.method(ReminderOccurrence, 'findOneAndUpdate', () => { throw new Error('Unexpected mutation'); });
  const result = await prepareManualWhatsapp('occurrence');
  assert.match(result.url, /^https:\/\/wa.me\//);
  assert.equal(mutation.mock.callCount(), 0);
  assert.equal(occurrence.whatsappDelivery.status, 'pending');
  assert.equal(occurrence.emailDelivery.status, 'accepted');
});

test('future, paused, cancelled, superseded and returned rentals cannot be shared', async (t) => {
  const occurrence = record();
  const definition = { status: 'active', scheduleVersion: 1 };
  mockRecords(t, occurrence, definition);
  occurrence.scheduledAt = new Date(Date.now() + 60_000);
  await assert.rejects(requireEligibleReminder('occurrence'), /not due/);
  occurrence.scheduledAt = new Date(0);
  definition.status = 'paused';
  await assert.rejects(prepareManualWhatsapp('occurrence'), /paused/);
  definition.status = 'active'; definition.scheduleVersion = 2;
  await assert.rejects(prepareManualWhatsapp('occurrence'), /superseded/);
  definition.scheduleVersion = 1; occurrence.status = 'cancelled';
  await assert.rejects(prepareManualWhatsapp('occurrence'), /no longer/);
  occurrence.status = 'pending'; occurrence.rental = 'rental';
  t.mock.method(Rental, 'findById', () => ({ lean: async () => ({ status: 'returned' }) }));
  await assert.rejects(prepareManualWhatsapp('occurrence'), /no longer active/);
});

test('manual confirmation is audited without claiming provider delivery and is idempotent', async (t) => {
  const occurrence = record();
  mockRecords(t, occurrence);
  const writes = [];
  t.mock.method(ReminderOccurrence, 'findOneAndUpdate', (filter, update) => {
    writes.push(update);
    for (const [key, value] of Object.entries(update.$set)) {
      const [root, field] = key.split('.');
      if (field) occurrence[root][field] = value;
      else occurrence[root] = value;
    }
    return { lean: async () => occurrence };
  });
  const result = await markManualWhatsappSent('occurrence', 'admin');
  assert.equal(result.whatsappDelivery.status, 'manual_sent');
  assert.equal(result.whatsappDelivery.manuallySentBy, 'admin');
  assert.ok(result.whatsappDelivery.manuallySentAt instanceof Date);
  assert.equal(result.whatsappDelivery.deliveredAt, undefined);
  assert.equal(result.status, 'sent');
  const writeCount = writes.length;
  await markManualWhatsappSent('occurrence', 'admin');
  assert.equal(writes.length, writeCount);
});

test('email and manual WhatsApp outcomes remain independent', () => {
  assert.equal(deriveOccurrenceDeliveryStatus('accepted', 'pending'), 'pending');
  assert.equal(deriveOccurrenceDeliveryStatus('accepted', 'manual_sent'), 'sent');
  assert.equal(deriveOccurrenceDeliveryStatus('failed', 'manual_sent'), 'partially_failed');
  assert.equal(deriveOccurrenceDeliveryStatus('uncertain', 'manual_sent'), 'partially_failed');
});

test('timer queue deduplicates same reminder, supports simultaneous customers and cleans up', async () => {
  const callbacks = [];
  const sent = [];
  const cleared = [];
  const queue = createReminderTimerQueue({
    execute: async (id) => sent.push(id),
    setTimer: (callback, delay) => { callbacks.push({ callback, delay }); return callbacks.length; },
    clearTimer: (id) => cleared.push(id),
  });
  const now = new Date();
  assert.equal(queue.schedule('a', now, now), true);
  assert.equal(queue.schedule('a', now, now), false);
  assert.equal(queue.schedule('b', now, now), true);
  await Promise.all(callbacks.map(({ callback }) => callback()));
  assert.deepEqual(sent.sort(), ['a', 'b']);
  assert.deepEqual(queue.ids(), []);
  queue.schedule('c', now, now); queue.clear();
  assert.equal(cleared.length, 1);
  assert.deepEqual(queue.ids(), []);
});

test('timer cleanup also runs when delivery fails', async () => {
  let callback;
  const queue = createReminderTimerQueue({ execute: async () => { throw new Error('failure'); }, setTimer: (fn) => { callback = fn; return 1; } });
  queue.schedule('a', new Date());
  await assert.rejects(callback(), /failure/);
  assert.deepEqual(queue.ids(), []);
});

test('lifecycle cleanup immediately cancels unique scheduled occurrence timers', () => {
  const cancelled = [];
  const timerQueue = { cancel: (id) => cancelled.push(id) };

  cancelReminderTimers(['occurrence-a', 'occurrence-b', 'occurrence-a'], { timerQueue });

  assert.deepEqual(cancelled, ['occurrence-a', 'occurrence-b']);
});

test('cron endpoint authentication rejects missing, short and mismatched secrets', () => {
  const secret = 'x'.repeat(40);
  assert.equal(validCronSecret(`Bearer ${secret}`, secret), true);
  assert.equal(validCronSecret(`Bearer ${'y'.repeat(40)}`, secret), false);
  assert.equal(validCronSecret('', secret), false);
  assert.equal(validCronSecret('Bearer short', 'short'), false);
  assert.equal(validCronSecret('', undefined), false);
});

const mockEmailStorage = (t) => {
  const occurrence = record();
  occurrence.emailDelivery = { status: 'pending', attemptsCount: 0 };
  occurrence.occurrenceKey = 'ROC-TEST';
  occurrence.maxAttemptsPerChannel = 3;
  occurrence.recipientSnapshot.email = 'customer@example.com';
  mockRecords(t, occurrence);
  const apply = (update) => {
    for (const [key, value] of Object.entries(update.$set || {})) {
      const [root, field] = key.split('.');
      if (field) occurrence[root][field] = value;
      else occurrence[root] = value;
    }
    for (const key of Object.keys(update.$unset || {})) delete occurrence[key];
    return occurrence;
  };
  t.mock.method(ReminderOccurrence, 'findOneAndUpdate', (filter, update) => {
    if (update.$inc) {
      if (!['pending', 'failed'].includes(occurrence.emailDelivery.status)) return Promise.resolve(null);
      occurrence.emailDelivery.attemptsCount += 1;
      return Promise.resolve(structuredClone(apply(update)));
    }
    return { lean: async () => apply(update) };
  });
  t.mock.method(ReminderOccurrence, 'findByIdAndUpdate', (id, update) => {
    const result = apply(update);
    return { lean: async () => result };
  });
  t.mock.method(NotificationDeliveryAttempt, 'create', async (fields) => ({
    ...fields, save: async () => {}, toObject() { return { status: this.status }; },
  }));
  return occurrence;
};

test('concurrent email attempts send once and leave WhatsApp ready', async (t) => {
  const occurrence = mockEmailStorage(t);
  let sends = 0;
  const sendEmail = async () => { sends += 1; return { provider: 'brevo', providerMessageId: 'test-123' }; };
  await Promise.allSettled([
    deliverReminderEmail('occurrence', { sendEmail }),
    deliverReminderEmail('occurrence', { sendEmail }),
  ]);
  assert.equal(sends, 1);
  assert.equal(occurrence.emailDelivery.status, 'accepted');
  assert.equal(occurrence.whatsappDelivery.status, 'pending');
  assert.equal(occurrence.status, 'pending');
  const again = await deliverReminderEmail('occurrence', { sendEmail });
  assert.equal(again.skipped, true);
  assert.equal(sends, 1);
});

test('ambiguous provider error is held for review rather than resent', async (t) => {
  const occurrence = mockEmailStorage(t);
  let sends = 0;
  const sendEmail = async () => { sends += 1; throw new Error('Connection lost after request'); };
  await assert.rejects(deliverReminderEmail('occurrence', { sendEmail }), /Connection lost/);
  assert.equal(occurrence.emailDelivery.status, 'uncertain');
  await assert.rejects(deliverReminderEmail('occurrence', { sendEmail }), /not eligible/);
  assert.equal(sends, 1);
});
