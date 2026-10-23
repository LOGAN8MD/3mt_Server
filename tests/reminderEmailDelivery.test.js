import assert from 'node:assert/strict';
import test from 'node:test';
import AppError from '../utils/AppError.js';
import { sendReminderEmail } from '../services/emailService.js';
import { deriveOccurrenceDeliveryStatus } from '../services/reminderEmailDeliveryService.js';

const content = {
  subjectEnglish: 'Return reminder',
  subjectHindi: 'वापसी रिमाइंडर',
  bodyEnglish: 'Please return the Bosch drill by 5:00 pm.',
  bodyHindi: 'कृपया बॉश ड्रिल शाम 5:00 बजे तक वापस करें।',
};

const withBrevoEnvironment = async (callback) => {
  const previous = {
    key: process.env.BREVO_API_KEY,
    email: process.env.OTP_EMAIL_FROM_EMAIL,
    name: process.env.OTP_EMAIL_FROM_NAME,
    fetch: global.fetch,
  };
  process.env.BREVO_API_KEY = 'test-key';
  process.env.OTP_EMAIL_FROM_EMAIL = 'reminders@3mt.example';
  process.env.OTP_EMAIL_FROM_NAME = '3MT Machine Tools';
  try {
    return await callback();
  } finally {
    if (previous.key === undefined) delete process.env.BREVO_API_KEY;
    else process.env.BREVO_API_KEY = previous.key;
    if (previous.email === undefined) delete process.env.OTP_EMAIL_FROM_EMAIL;
    else process.env.OTP_EMAIL_FROM_EMAIL = previous.email;
    if (previous.name === undefined) delete process.env.OTP_EMAIL_FROM_NAME;
    else process.env.OTP_EMAIL_FROM_NAME = previous.name;
    global.fetch = previous.fetch;
  }
};

test('Brevo reminder email sends bilingual content and returns provider message id', async () => {
  await withBrevoEnvironment(async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ messageId: '<message-123@brevo>' }),
      };
    };

    const result = await sendReminderEmail({
      to: 'CUSTOMER@EXAMPLE.COM',
      recipientName: 'Rahul Customer',
      content,
      idempotencyKey: 'ROC-123:EMAIL:1',
    });
    const body = JSON.parse(request.options.body);

    assert.equal(request.url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(body.to[0].email, 'customer@example.com');
    assert.equal(body.headers['Idempotency-Key'], 'ROC-123:EMAIL:1');
    assert.match(body.subject, /Return reminder.*वापसी रिमाइंडर/);
    assert.match(body.textContent, /Please return.*कृपया बॉश ड्रिल/s);
    assert.match(body.htmlContent, /English/);
    assert.match(body.htmlContent, /हिन्दी/);
    assert.equal(result.provider, 'brevo');
    assert.equal(result.providerMessageId, '<message-123@brevo>');
  });
});

test('Brevo reminder email exposes a safe provider failure for delivery history', async () => {
  await withBrevoEnvironment(async () => {
    global.fetch = async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ code: 'too_many_requests', message: 'Slow down' }),
    });

    await assert.rejects(
      sendReminderEmail({
        to: 'customer@example.com',
        recipientName: 'Rahul Customer',
        content,
        idempotencyKey: 'ROC-123:EMAIL:2',
      }),
      (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'BREVO_REMINDER_EMAIL_FAILED');
        assert.equal(error.responseCode, 429);
        return true;
      }
    );
  });
});

test('Brevo reminder email requires existing shared sender configuration', async () => {
  const previousKey = process.env.BREVO_API_KEY;
  const previousEmail = process.env.OTP_EMAIL_FROM_EMAIL;
  delete process.env.BREVO_API_KEY;
  delete process.env.OTP_EMAIL_FROM_EMAIL;
  try {
    await assert.rejects(
      sendReminderEmail({
        to: 'customer@example.com',
        content,
        idempotencyKey: 'ROC-123:EMAIL:1',
      }),
      /Reminder email is not configured/
    );
  } finally {
    if (previousKey !== undefined) process.env.BREVO_API_KEY = previousKey;
    if (previousEmail !== undefined) process.env.OTP_EMAIL_FROM_EMAIL = previousEmail;
  }
});

test('occurrence status keeps email and WhatsApp channel results independent', () => {
  assert.equal(deriveOccurrenceDeliveryStatus('accepted', 'not_selected'), 'sent');
  assert.equal(deriveOccurrenceDeliveryStatus('accepted', 'pending'), 'pending');
  assert.equal(deriveOccurrenceDeliveryStatus('accepted', 'failed'), 'partially_failed');
  assert.equal(deriveOccurrenceDeliveryStatus('failed', 'failed'), 'failed');
  assert.equal(deriveOccurrenceDeliveryStatus('failed', 'pending'), 'pending');
  assert.equal(deriveOccurrenceDeliveryStatus('processing', 'pending'), 'processing');
});
