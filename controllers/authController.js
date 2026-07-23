import User from '../models/User.js';
import jwt from 'jsonwebtoken';
import AppError from '../utils/AppError.js';
import { OAuth2Client } from 'google-auth-library';
import {
  createOtpVerification,
  normalizeEmail,
  normalizePhone,
  OTP_PURPOSES,
  verifyOtpCode,
} from '../services/otpService.js';
import { getEmailServiceDebugInfo } from '../services/emailService.js';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

const generatePasswordResetToken = (user) =>
  jwt.sign(
    {
      id: user._id,
      purpose: OTP_PURPOSES.PASSWORD_RESET,
      passwordResetVersion: user.passwordResetVersion || 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );

const buildAuthResponse = (user) => ({
  _id: user._id,
  name: user.name,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  phone: user.phone,
  address: user.address,
  role: user.role,
  isAdmin: user.isAdmin,
  authProvider: user.authProvider,
  isVerified: user.isVerified,
  verifiedEmail: user.verifiedEmail,
  verifiedPhone: user.verifiedPhone,
  token: generateToken(user._id),
});

const buildOtpResponse = (user, otpResult, message) => ({
  message,
  userId: user._id,
  verificationMethod: user.verificationMethod,
  destinationType: otpResult.otpVerification.destinationType,
  destination: otpResult.otpVerification.destination,
  expiresAt: otpResult.otpVerification.expiresAt,
  ...(otpResult.devOtp ? { devOtp: otpResult.devOtp } : {}),
});

const forgotPasswordResponseMessage =
  'If this email is registered, password reset instructions have been sent.';

const isAuthDebugEnabled = () => process.env.AUTH_DEBUG === 'true';

const getSafeErrorDebug = (err) => ({
  name: err?.name,
  code: err?.code,
  command: err?.command,
  responseCode: err?.responseCode,
  response: err?.response,
  statusCode: err?.statusCode,
  message: err?.message,
});

const sendRegisterDebugError = (res, err, debugSteps) => {
  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const message = err instanceof AppError ? err.message : `Server error: ${err.message}`;

  console.error('AUTH_DEBUG register failed', {
    steps: debugSteps,
    error: getSafeErrorDebug(err),
  });

  return res.status(statusCode).json({
    success: false,
    status: `${statusCode}`.startsWith('4') ? 'fail' : 'error',
    message,
    debug: {
      flow: 'customer_registration',
      steps: debugSteps,
      failedAt: debugSteps.at(-1)?.step || 'unknown',
      error: getSafeErrorDebug(err),
      note: 'Temporary production debug is enabled. Remove AUTH_DEBUG after fixing OTP email delivery.',
    },
  });
};

const validateOtpRegistration = ({ name, password, verificationMethod, email }) => {
  if (!name?.trim()) {
    throw new AppError('Name is required', 400);
  }

  if (!password) {
    throw new AppError('Password is required', 400);
  }

  if (verificationMethod !== 'email') {
    throw new AppError('Only email OTP is available right now. Please select email OTP.', 400);
  }

  if (!normalizeEmail(email)) {
    throw new AppError('Email is required when email OTP is selected', 400);
  }
};

const findExistingUserByContact = async ({ email, phone }) => {
  const filters = [];
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);

  if (normalizedEmail) {
    filters.push({ email: normalizedEmail });
  }

  if (normalizedPhone) {
    filters.push({ phone: normalizedPhone });
  }

  if (filters.length === 0) {
    return null;
  }

  return User.findOne({ $or: filters });
};

export const registerUser = async (req, res, next) => {
  const debugSteps = [];
  const addDebugStep = (step, details = {}) => {
    if (!isAuthDebugEnabled()) {
      return;
    }

    debugSteps.push({
      step,
      details,
      at: new Date().toISOString(),
    });
  };

  const {
    name,
    firstName = '',
    lastName = '',
    email,
    phone,
    password,
    address = '',
    verificationMethod,
  } = req.body;

  try {
    addDebugStep('register_request_received', {
      hasName: Boolean(name?.trim()),
      hasFirstName: Boolean(firstName?.trim()),
      hasLastName: Boolean(lastName?.trim()),
      hasEmail: Boolean(email?.trim()),
      hasPhone: Boolean(phone?.trim()),
      hasPassword: Boolean(password),
      verificationMethod: verificationMethod || null,
    });

    if (!verificationMethod) {
      const normalizedEmail = normalizeEmail(email);

      if (!name?.trim() || !normalizedEmail || !password) {
        return next(new AppError('Name, email, and password are required', 400));
      }

      const userExists = await User.findOne({ email: normalizedEmail });
      addDebugStep('legacy_duplicate_email_checked', {
        email: normalizedEmail,
        exists: Boolean(userExists),
      });
      if (userExists) return next(new AppError('User already exists', 400));

      const user = await User.create({
        name,
        firstName,
        lastName,
        email: normalizedEmail,
        password,
        role: 'customer',
        isVerified: true,
        verifiedEmail: true,
      });
      addDebugStep('legacy_user_created', {
        userId: user._id,
        email: normalizedEmail,
      });

      return res.status(201).json(buildAuthResponse(user));
    }

    validateOtpRegistration({ name, password, verificationMethod, email });
    addDebugStep('otp_registration_input_validated', {
      verificationMethod,
    });

    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhone(phone);
    const userExists = await findExistingUserByContact({
      email: normalizedEmail,
      phone: normalizedPhone,
    });
    addDebugStep('duplicate_contact_checked', {
      email: normalizedEmail,
      hasPhone: Boolean(normalizedPhone),
      exists: Boolean(userExists),
      existingUserId: userExists?._id,
      existingUserVerified: userExists?.isVerified,
      existingUserRole: userExists?.role,
    });

    if (userExists) {
      return next(new AppError('User already exists with this email or phone', 400));
    }

    const user = await User.create({
      name,
      firstName,
      lastName,
      email: normalizedEmail || undefined,
      phone: normalizedPhone || undefined,
      password,
      address,
      role: 'customer',
      verificationMethod,
      isVerified: false,
      verifiedEmail: false,
      verifiedPhone: false,
    });
    addDebugStep('pending_user_created_before_otp', {
      userId: user._id,
      email: normalizedEmail,
      hasPhone: Boolean(normalizedPhone),
      isVerified: user.isVerified,
    });

    addDebugStep('smtp_configuration_checked', getEmailServiceDebugInfo());
    addDebugStep('otp_create_and_email_send_started', {
      userId: user._id,
      purpose: OTP_PURPOSES.REGISTRATION,
    });

    const otpResult = await createOtpVerification(user);
    addDebugStep('otp_created_and_email_send_finished', {
      userId: user._id,
      destinationType: otpResult.otpVerification.destinationType,
      destination: otpResult.otpVerification.destination,
      expiresAt: otpResult.otpVerification.expiresAt,
      devOtpReturned: Boolean(otpResult.devOtp),
    });

    res.status(201).json({
      ...buildOtpResponse(
        user,
        otpResult,
        'Registration started. Please verify the OTP to activate your account.'
      ),
    });
  } catch (err) {
    addDebugStep('register_failed', getSafeErrorDebug(err));

    if (isAuthDebugEnabled()) {
      return sendRegisterDebugError(res, err, debugSteps);
    }

    if (err instanceof AppError) return next(err);
    next(new AppError('Server error: ' + err.message, 500));
  }
};

export const verifyRegistrationOtp = async (req, res, next) => {
  const { userId, otp } = req.body;

  try {
    if (!userId || !otp) {
      return next(new AppError('userId and otp are required', 400));
    }

    const user = await User.findById(userId);

    if (!user) {
      return next(new AppError('User not found', 404));
    }

    if (user.isVerified) {
      return res.json(buildAuthResponse(user));
    }

    const otpVerification = await verifyOtpCode({ userId, otp });

    user.isVerified = true;

    if (otpVerification.destinationType === 'email') {
      user.verifiedEmail = true;
    }

    if (otpVerification.destinationType === 'mobile') {
      user.verifiedPhone = true;
    }

    await user.save();

    res.json(buildAuthResponse(user));
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to verify OTP: ' + err.message, 500));
  }
};

export const resendRegistrationOtp = async (req, res, next) => {
  const { userId } = req.body;

  try {
    if (!userId) {
      return next(new AppError('userId is required', 400));
    }

    const user = await User.findById(userId);

    if (!user) {
      return next(new AppError('User not found', 404));
    }

    if (user.isVerified) {
      return next(new AppError('User is already verified', 400));
    }

    const otpResult = await createOtpVerification(user, { incrementResend: true });

    res.json(
      buildOtpResponse(user, otpResult, 'OTP resent successfully.')
    );
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to resend OTP: ' + err.message, 500));
  }
};

export const forgotPassword = async (req, res, next) => {
  const { email } = req.body;

  try {
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail) {
      return next(new AppError('Email is required', 400));
    }

    const user = await User.findOne({ email: normalizedEmail }).select(
      '+password +passwordResetVersion'
    );

    if (!user || user.authProvider === 'google' || !user.password) {
      return res.json({ message: forgotPasswordResponseMessage });
    }

    const otpResult = await createOtpVerification(user, {
      purpose: OTP_PURPOSES.PASSWORD_RESET,
    });

    res.json({
      message: forgotPasswordResponseMessage,
      destinationType: otpResult.otpVerification.destinationType,
      destination: otpResult.otpVerification.destination,
      expiresAt: otpResult.otpVerification.expiresAt,
      ...(otpResult.devOtp ? { devOtp: otpResult.devOtp } : {}),
    });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to request password reset: ' + err.message, 500));
  }
};

export const verifyResetOtp = async (req, res, next) => {
  const { email, otp } = req.body;

  try {
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !otp) {
      return next(new AppError('Email and OTP are required', 400));
    }

    const user = await User.findOne({ email: normalizedEmail }).select(
      '+password +passwordResetVersion'
    );

    if (!user || user.authProvider === 'google' || !user.password) {
      return next(new AppError('Invalid or expired password reset OTP', 400));
    }

    await verifyOtpCode({
      userId: user._id,
      otp,
      purpose: OTP_PURPOSES.PASSWORD_RESET,
    });

    res.json({
      message: 'Password reset OTP verified successfully.',
      resetToken: generatePasswordResetToken(user),
      expiresInMinutes: 10,
    });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to verify password reset OTP: ' + err.message, 500));
  }
};

export const resetPassword = async (req, res, next) => {
  const { resetToken, password } = req.body;

  try {
    if (!resetToken || !password) {
      return next(new AppError('Reset token and new password are required', 400));
    }

    if (password.length < 6) {
      return next(new AppError('Password must be at least 6 characters', 400));
    }

    let decoded;
    try {
      decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    } catch (error) {
      return next(new AppError('Invalid or expired password reset token', 400));
    }

    if (decoded.purpose !== OTP_PURPOSES.PASSWORD_RESET) {
      return next(new AppError('Invalid password reset token', 400));
    }

    const user = await User.findById(decoded.id).select('+password +passwordResetVersion');

    if (!user || user.authProvider === 'google' || !user.password) {
      return next(new AppError('Invalid password reset token', 400));
    }

    if ((user.passwordResetVersion || 0) !== decoded.passwordResetVersion) {
      return next(new AppError('Invalid or already used password reset token', 400));
    }

    user.password = password;
    user.passwordResetVersion = (user.passwordResetVersion || 0) + 1;
    await user.save();

    res.json({ message: 'Password reset successfully. Please log in with your new password.' });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to reset password: ' + err.message, 500));
  }
};

export const loginUser = async (req, res, next) => {
  const { email, phone, identifier, password } = req.body;

  try {
    const loginIdentifier = normalizeEmail(identifier || email) || normalizePhone(phone);

    if (!loginIdentifier || !password) {
      return next(new AppError('Email/phone and password are required', 400));
    }

    const user = await User.findOne({
      $or: [
        { email: normalizeEmail(loginIdentifier) },
        { phone: normalizePhone(loginIdentifier) },
      ],
    }).select('+password');

    if (!user || !(await user.matchPassword(password))) {
      return next(new AppError('Invalid credentials', 401));
    }

    if (user.verificationMethod && !user.isVerified) {
      return next(new AppError('Please verify your account before logging in', 403));
    }

    res.json(buildAuthResponse(user));
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Server error: ' + err.message, 500));
  }
};

export const googleLogin = async (req, res, next) => {
  const { credential, idToken } = req.body;
  const googleCredential = credential || idToken;

  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return next(new AppError('Google login is not configured', 500));
    }

    if (!googleCredential) {
      return next(new AppError('Google credential is required', 400));
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: googleCredential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const googleId = payload?.sub;
    const email = normalizeEmail(payload?.email);
    const emailVerified = Boolean(payload?.email_verified);

    if (!googleId || !email) {
      return next(new AppError('Invalid Google account details', 400));
    }

    if (!emailVerified) {
      return next(new AppError('Google email is not verified', 403));
    }

    const firstName = payload?.given_name?.trim() || '';
    const lastName = payload?.family_name?.trim() || '';
    const name = payload?.name?.trim() || [firstName, lastName].filter(Boolean).join(' ') || email;

    let user = await User.findOne({
      $or: [{ googleId }, { email }],
    });

    if (!user) {
      user = await User.create({
        name,
        firstName,
        lastName,
        email,
        authProvider: 'google',
        googleId,
        role: 'customer',
        isVerified: true,
        verifiedEmail: true,
      });
    } else {
      user.googleId = user.googleId || googleId;
      user.name = user.name || name;
      user.firstName = user.firstName || firstName;
      user.lastName = user.lastName || lastName;
      user.email = user.email || email;
      user.isVerified = true;
      user.verifiedEmail = true;

      if (!user.authProvider) {
        user.authProvider = 'google';
      }

      await user.save();
    }

    res.json(buildAuthResponse(user));
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Google login failed', 401));
  }
};
