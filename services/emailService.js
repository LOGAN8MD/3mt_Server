import AppError from '../utils/AppError.js';

const BREVO_EMAIL_API_URL = 'https://api.brevo.com/v3/smtp/email';

const requiredBrevoFields = ['BREVO_API_KEY', 'OTP_EMAIL_FROM_EMAIL'];

const hasBrevoConfig = () =>
  requiredBrevoFields.every((field) => Boolean(process.env[field]?.trim()));

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const reminderHtml = ({ bodyEnglish, bodyHindi }) => {
  const section = (title, body) => `
    <section style="margin-bottom: 24px;">
      <h2 style="font-size: 18px; margin: 0 0 12px;">${escapeHtml(title)}</h2>
      <div style="white-space: pre-line; line-height: 1.6;">${escapeHtml(body)}</div>
    </section>
  `;

  return `
    <div style="font-family: Arial, sans-serif; max-width: 640px; color: #1f2937;">
      ${section('English', bodyEnglish)}
      <hr style="border: 0; border-top: 1px solid #d1d5db; margin: 24px 0;" />
      ${section('हिन्दी', bodyHindi)}
    </div>
  `;
};

const requireBrevoConfig = (purpose) => {
  if (!hasBrevoConfig()) {
    throw new AppError(`${purpose} is not configured. Please contact support.`, 500);
  }
};

export const sendOtpEmail = async ({ to, otp, expiresInMinutes }) => {
  requireBrevoConfig('Email OTP');

  const fromEmail = process.env.OTP_EMAIL_FROM_EMAIL.trim();
  const fromName = process.env.OTP_EMAIL_FROM_NAME?.trim() || '3MT Machine Tools';
  const safeOtp = escapeHtml(otp);
  const safeMinutes = escapeHtml(expiresInMinutes);
  const textContent = [
    `Your 3MT verification OTP is ${otp}.`,
    `This OTP expires in ${expiresInMinutes} minutes.`,
    'If you did not request this, please ignore this email.',
  ].join('\n');
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; color: #1f2937;">
      <h2 style="margin-bottom: 12px;">3MT Machine Tools Verification</h2>
      <p>Your one-time password is:</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px; margin: 20px 0;">${safeOtp}</p>
      <p>This OTP expires in ${safeMinutes} minutes.</p>
      <p style="color: #6b7280; font-size: 13px;">If you did not request this, please ignore this email.</p>
    </div>
  `;

  const response = await fetch(BREVO_EMAIL_API_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: {
        name: fromName,
        email: fromEmail,
      },
      to: [{ email: to }],
      subject: 'Your 3MT verification OTP',
      textContent,
      htmlContent,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const error = new AppError('Failed to send OTP email through Brevo.', 500);
    error.code = 'BREVO_EMAIL_FAILED';
    error.responseCode = response.status;
    error.command = 'BREVO_API_SEND_EMAIL';
    error.response = errorBody.slice(0, 500);
    throw error;
  }
};

export const sendReminderEmail = async ({
  to,
  recipientName,
  content,
  idempotencyKey,
}) => {
  requireBrevoConfig('Reminder email');
  if (!to?.trim()) throw new AppError('Reminder recipient email is required.', 400);
  if (!content?.bodyEnglish?.trim() || !content?.bodyHindi?.trim()) {
    throw new AppError('Complete bilingual reminder content is required.', 400);
  }
  if (!idempotencyKey?.trim()) throw new AppError('Email idempotency key is required.', 500);

  const subjectEnglish = content.subjectEnglish?.trim() || '3MT Machine Tools reminder';
  const subjectHindi = content.subjectHindi?.trim() || '3MT Machine Tools रिमाइंडर';
  const textContent = `${content.bodyEnglish.trim()}\n\n--------------------\n\n${content.bodyHindi.trim()}`;
  const response = await fetch(BREVO_EMAIL_API_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: {
        name: process.env.OTP_EMAIL_FROM_NAME?.trim() || '3MT Machine Tools',
        email: process.env.OTP_EMAIL_FROM_EMAIL.trim(),
      },
      to: [{ email: to.trim().toLowerCase(), name: recipientName?.trim() || undefined }],
      subject: `${subjectEnglish} | ${subjectHindi}`,
      textContent,
      htmlContent: reminderHtml(content),
      headers: { 'Idempotency-Key': idempotencyKey },
      tags: ['3mt-reminder'],
    }),
  });

  const rawBody = await response.text();
  let responseBody = {};
  try {
    responseBody = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    responseBody = { raw: rawBody.slice(0, 500) };
  }

  if (!response.ok) {
    const error = new AppError('Failed to send reminder email through Brevo.', 502);
    error.code = 'BREVO_REMINDER_EMAIL_FAILED';
    error.responseCode = response.status;
    error.response = responseBody;
    throw error;
  }

  if (!responseBody.messageId) {
    const error = new AppError('Brevo accepted the request without a message ID.', 502);
    error.code = 'BREVO_MESSAGE_ID_MISSING';
    error.response = responseBody;
    throw error;
  }

  return {
    provider: 'brevo',
    providerMessageId: responseBody.messageId,
    responseMetadata: { statusCode: response.status },
  };
};
