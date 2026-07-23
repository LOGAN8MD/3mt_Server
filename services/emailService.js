import nodemailer from 'nodemailer';
import AppError from '../utils/AppError.js';

const requiredSmtpFields = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];

const hasSmtpConfig = () =>
  requiredSmtpFields.every((field) => Boolean(process.env[field]?.trim()));

const getSmtpTransporter = () => {
  if (!hasSmtpConfig()) {
    throw new AppError('Email OTP is not configured. Please contact support.', 500);
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

export const sendOtpEmail = async ({ to, otp, expiresInMinutes }) => {
  const transporter = getSmtpTransporter();
  const from = process.env.OTP_EMAIL_FROM || process.env.SMTP_USER;
  const safeOtp = escapeHtml(otp);
  const safeMinutes = escapeHtml(expiresInMinutes);

  await transporter.sendMail({
    from,
    to,
    subject: 'Your 3MT verification OTP',
    text: [
      `Your 3MT verification OTP is ${otp}.`,
      `This OTP expires in ${expiresInMinutes} minutes.`,
      'If you did not request this, please ignore this email.',
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; color: #1f2937;">
        <h2 style="margin-bottom: 12px;">3MT Machine Tools Verification</h2>
        <p>Your one-time password is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px; margin: 20px 0;">${safeOtp}</p>
        <p>This OTP expires in ${safeMinutes} minutes.</p>
        <p style="color: #6b7280; font-size: 13px;">If you did not request this, please ignore this email.</p>
      </div>
    `,
  });
};
