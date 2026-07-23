import bcrypt from 'bcryptjs';
import OtpVerification from '../models/OtpVerification.js';
import AppError from '../utils/AppError.js';
import { sendOtpEmail } from './emailService.js';

export const OTP_EXPIRY_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_RESENDS = 3;
export const OTP_PURPOSES = {
  REGISTRATION: 'registration',
  PASSWORD_RESET: 'password_reset',
};

const allowedOtpPurposes = Object.values(OTP_PURPOSES);

export const normalizeEmail = (email) => email?.trim().toLowerCase();

export const normalizePhone = (phone) => phone?.replace(/[^\d+]/g, '').trim();

export const normalizeOtpDestination = (destinationType, destination) => {
  if (destinationType === 'email') {
    return normalizeEmail(destination);
  }

  return normalizePhone(destination);
};

export const getOtpDestinationForUser = (user) => {
  if (user.verificationMethod === 'email') {
    return {
      destinationType: 'email',
      destination: normalizeEmail(user.email),
    };
  }

  if (user.verificationMethod === 'mobile') {
    return {
      destinationType: 'mobile',
      destination: normalizePhone(user.phone),
    };
  }

  throw new AppError('Verification method is required', 400);
};

export const generateOtpCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const normalizeOtpPurpose = (purpose = OTP_PURPOSES.REGISTRATION) => {
  if (!allowedOtpPurposes.includes(purpose)) {
    throw new AppError(`OTP purpose must be one of: ${allowedOtpPurposes.join(', ')}`, 400);
  }

  return purpose;
};

export const createOtpVerification = async (
  user,
  { incrementResend = false, purpose = OTP_PURPOSES.REGISTRATION } = {}
) => {
  const otpPurpose = normalizeOtpPurpose(purpose);
  const { destinationType, destination } = getOtpDestinationForUser(user);

  if (!destination) {
    throw new AppError(
      destinationType === 'email'
        ? 'Email is required for email OTP verification'
        : 'Phone number is required for mobile OTP verification',
      400
    );
  }

  const latestOtp = await OtpVerification.findOne({
    user: user._id,
    purpose: otpPurpose,
    usedAt: null,
  }).sort({ createdAt: -1 });

  const nextResendCount = incrementResend ? (latestOtp?.resendCount || 0) + 1 : 0;

  if (nextResendCount > OTP_MAX_RESENDS) {
    throw new AppError('OTP resend limit reached. Please try again later.', 429);
  }

  await OtpVerification.updateMany(
    {
      user: user._id,
      purpose: otpPurpose,
      usedAt: null,
    },
    {
      usedAt: new Date(),
    }
  );

  const otp = generateOtpCode();
  const otpHash = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  const otpVerification = await OtpVerification.create({
    user: user._id,
    purpose: otpPurpose,
    destinationType,
    destination,
    otpHash,
    expiresAt,
    resendCount: nextResendCount,
  });

  await sendOtp({
    destinationType,
    destination,
    otp,
  });

  return {
    otpVerification,
    devOtp: process.env.NODE_ENV === 'production' ? undefined : otp,
  };
};

export const sendOtp = async ({ destinationType, destination, otp }) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`3MT OTP for ${destinationType} ${destination}: ${otp}`);
  }

  if (destinationType === 'email') {
    await sendOtpEmail({
      to: destination,
      otp,
      expiresInMinutes: OTP_EXPIRY_MINUTES,
    });
    return;
  }

  throw new AppError('Mobile OTP delivery is not configured yet. Please select email OTP.', 501);
};

export const verifyOtpCode = async ({ userId, otp, purpose = OTP_PURPOSES.REGISTRATION }) => {
  const otpPurpose = normalizeOtpPurpose(purpose);
  const otpVerification = await OtpVerification.findOne({
    user: userId,
    purpose: otpPurpose,
    usedAt: null,
  })
    .select('+otpHash')
    .sort({ createdAt: -1 });

  if (!otpVerification) {
    throw new AppError('OTP not found. Please request a new OTP.', 400);
  }

  if (otpVerification.expiresAt <= new Date()) {
    otpVerification.usedAt = new Date();
    await otpVerification.save();
    throw new AppError('OTP has expired. Please request a new OTP.', 400);
  }

  if (otpVerification.attempts >= OTP_MAX_ATTEMPTS) {
    otpVerification.usedAt = new Date();
    await otpVerification.save();
    throw new AppError('OTP attempt limit reached. Please request a new OTP.', 429);
  }

  const isOtpValid = await bcrypt.compare(String(otp), otpVerification.otpHash);

  if (!isOtpValid) {
    otpVerification.attempts += 1;
    await otpVerification.save();
    throw new AppError('Invalid OTP', 400);
  }

  otpVerification.usedAt = new Date();
  await otpVerification.save();

  return otpVerification;
};
