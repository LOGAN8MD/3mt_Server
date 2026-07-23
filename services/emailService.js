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

export const sendOtpEmail = async ({ to, otp, expiresInMinutes }) => {
  if (!hasBrevoConfig()) {
    throw new AppError('Email OTP is not configured. Please contact support.', 500);
  }

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
