import mongoose from 'mongoose';
import { REMINDER_CHANNELS } from './reminderSchemas.js';

export const DELIVERY_ATTEMPT_STATUSES = Object.freeze([
  'processing',
  'accepted',
  'delivered',
  'failed',
  'uncertain',
  'cancelled',
]);

const notificationDeliveryAttemptSchema = new mongoose.Schema(
  {
    occurrence: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ReminderOccurrence',
      required: true,
    },
    definition: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ReminderDefinition',
      required: true,
    },
    channel: { type: String, enum: REMINDER_CHANNELS, required: true },
    attemptNumber: { type: Number, min: 1, required: true },
    idempotencyKey: { type: String, required: true, unique: true, trim: true },
    status: { type: String, enum: DELIVERY_ATTEMPT_STATUSES, required: true },
    provider: { type: String, trim: true, default: '' },
    providerMessageId: { type: String, trim: true, default: '' },
    startedAt: { type: Date, default: Date.now, required: true },
    completedAt: Date,
    errorCode: { type: String, trim: true, default: '' },
    errorMessage: { type: String, trim: true, default: '' },
    responseMetadata: { type: mongoose.Schema.Types.Mixed, default: undefined },
    lockToken: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

notificationDeliveryAttemptSchema.index(
  { occurrence: 1, channel: 1, attemptNumber: 1 },
  { unique: true, name: 'one_channel_attempt_number' }
);
notificationDeliveryAttemptSchema.index({ status: 1, startedAt: 1 });
notificationDeliveryAttemptSchema.index({ providerMessageId: 1 }, { sparse: true });

const NotificationDeliveryAttempt = mongoose.model(
  'NotificationDeliveryAttempt',
  notificationDeliveryAttemptSchema
);
export default NotificationDeliveryAttempt;
