import mongoose from 'mongoose';

export const REMINDER_TYPES = Object.freeze([
  'rental_activation_confirmation',
  'rental_return',
  'standalone_custom',
]);

export const REMINDER_CHANNELS = Object.freeze(['email', 'whatsapp']);

export const REMINDER_OCCURRENCE_STATUSES = Object.freeze([
  'pending',
  'scheduled',
  'processing',
  'sent',
  'partially_failed',
  'failed',
  'missed',
  'cancelled',
]);

export const CHANNEL_DELIVERY_STATUSES = Object.freeze([
  'not_selected',
  'pending',
  'processing',
  'accepted',
  'delivered',
  'failed',
  'cancelled',
  'skipped',
  'manual_sent',
  'uncertain',
]);

export const recipientSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

export const bilingualContentSchema = new mongoose.Schema(
  {
    subjectEnglish: { type: String, trim: true, default: '' },
    subjectHindi: { type: String, trim: true, default: '' },
    bodyEnglish: { type: String, trim: true, default: '' },
    bodyHindi: { type: String, trim: true, default: '' },
    templateKey: { type: String, trim: true, default: '' },
    variables: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { _id: false }
);

export const channelDeliverySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: CHANNEL_DELIVERY_STATUSES,
      default: 'not_selected',
      required: true,
    },
    provider: { type: String, trim: true, default: '' },
    providerMessageId: { type: String, trim: true, default: '' },
    attemptsCount: { type: Number, min: 0, default: 0 },
    lastAttemptAt: Date,
    acceptedAt: Date,
    deliveredAt: Date,
    failedAt: Date,
    lastError: { type: String, trim: true, default: '' },
    manuallySentAt: Date,
    manuallySentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false }
);

export const validateChannels = (channels) =>
  Array.isArray(channels) &&
  channels.length > 0 &&
  new Set(channels).size === channels.length &&
  channels.every((channel) => REMINDER_CHANNELS.includes(channel));
