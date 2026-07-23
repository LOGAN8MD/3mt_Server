import mongoose from 'mongoose';

const otpVerificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    purpose: {
      type: String,
      enum: ['registration', 'password_reset'],
      default: 'registration',
    },
    destinationType: {
      type: String,
      enum: ['email', 'mobile'],
      required: true,
    },
    destination: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    otpHash: {
      type: String,
      required: true,
      select: false,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },
    attempts: {
      type: Number,
      default: 0,
    },
    resendCount: {
      type: Number,
      default: 0,
    },
    usedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

otpVerificationSchema.index({ user: 1, purpose: 1, usedAt: 1, createdAt: -1 });
otpVerificationSchema.index({ destinationType: 1, destination: 1, createdAt: -1 });

const OtpVerification = mongoose.model('OtpVerification', otpVerificationSchema);
export default OtpVerification;
