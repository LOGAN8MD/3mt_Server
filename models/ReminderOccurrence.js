import mongoose from 'mongoose';
import {
  bilingualContentSchema,
  channelDeliverySchema,
  REMINDER_CHANNELS,
  REMINDER_OCCURRENCE_STATUSES,
  REMINDER_TYPES,
  recipientSnapshotSchema,
  validateChannels,
} from './reminderSchemas.js';
import { BUSINESS_TIME_ZONE } from '../utils/businessTime.js';

const requiresRental = function () {
  return this.definitionType !== 'standalone_custom';
};

const reminderOccurrenceSchema = new mongoose.Schema(
  {
    occurrenceKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      match: /^ROC-[A-Z0-9-]+$/,
    },
    definition: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ReminderDefinition',
      required: true,
    },
    definitionType: { type: String, enum: REMINDER_TYPES, required: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: 'ReminderPlan' },
    planRowKey: { type: String, trim: true, uppercase: true },
    rental: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rental',
      required: requiresRental,
    },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    recipientSnapshot: { type: recipientSnapshotSchema, required: true },
    scheduledAt: { type: Date, required: true },
    timeZone: {
      type: String,
      enum: [BUSINESS_TIME_ZONE],
      default: BUSINESS_TIME_ZONE,
      immutable: true,
    },
    status: {
      type: String,
      enum: REMINDER_OCCURRENCE_STATUSES,
      default: 'pending',
      required: true,
    },
    scheduleVersion: { type: Number, min: 1, required: true },
    channels: {
      type: [{ type: String, enum: REMINDER_CHANNELS }],
      required: true,
      validate: {
        validator: validateChannels,
        message: 'channels must contain unique email and/or whatsapp values',
      },
    },
    contentSnapshot: { type: bilingualContentSchema, required: true },
    emailDelivery: { type: channelDeliverySchema, default: () => ({}) },
    whatsappDelivery: { type: channelDeliverySchema, default: () => ({}) },
    nextAttemptAt: Date,
    maxAttemptsPerChannel: { type: Number, min: 1, default: 3, required: true },
    lockToken: { type: String, trim: true, default: '' },
    lockedAt: Date,
    lockExpiresAt: Date,
    processingStartedAt: Date,
    completedAt: Date,
    sentAt: Date,
    missedAt: Date,
    cancelledAt: Date,
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancellationReason: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

reminderOccurrenceSchema.pre('validate', function validateOccurrenceState() {
  this.emailDelivery.status = this.channels.includes('email')
    ? this.emailDelivery.status === 'not_selected'
      ? 'pending'
      : this.emailDelivery.status
    : 'not_selected';
  this.whatsappDelivery.status = this.channels.includes('whatsapp')
    ? this.whatsappDelivery.status === 'not_selected'
      ? 'pending'
      : this.whatsappDelivery.status
    : 'not_selected';

  const hasAnyLockField = Boolean(this.lockToken || this.lockedAt || this.lockExpiresAt);
  const hasEveryLockField = Boolean(this.lockToken && this.lockedAt && this.lockExpiresAt);
  if (hasAnyLockField && !hasEveryLockField) {
    this.invalidate('lockToken', 'lockToken, lockedAt, and lockExpiresAt must be set together');
  }
  if (this.lockedAt && this.lockExpiresAt && this.lockExpiresAt <= this.lockedAt) {
    this.invalidate('lockExpiresAt', 'lockExpiresAt must be after lockedAt');
  }

  if (this.status === 'missed' && !this.missedAt) {
    this.invalidate('missedAt', 'missedAt is required for a missed occurrence');
  }
  if (this.status === 'cancelled') {
    if (!this.cancelledAt) this.invalidate('cancelledAt', 'cancelledAt is required');
    if (!this.cancelledBy) this.invalidate('cancelledBy', 'cancelledBy is required');
    if (!this.cancellationReason) {
      this.invalidate('cancellationReason', 'cancellationReason is required');
    }
  }
});

reminderOccurrenceSchema.index(
  { definition: 1, scheduledAt: 1, scheduleVersion: 1 },
  { unique: true, name: 'one_occurrence_per_schedule_version' }
);
reminderOccurrenceSchema.index({ status: 1, scheduledAt: 1 });
reminderOccurrenceSchema.index({ 'emailDelivery.status': 1, scheduledAt: 1, nextAttemptAt: 1 });
reminderOccurrenceSchema.index({ status: 1, nextAttemptAt: 1 });
reminderOccurrenceSchema.index({ lockExpiresAt: 1 });
reminderOccurrenceSchema.index({ rental: 1, status: 1, scheduledAt: 1 });
reminderOccurrenceSchema.index({ customer: 1, scheduledAt: -1 });
reminderOccurrenceSchema.index({ plan: 1, scheduleVersion: 1, scheduledAt: 1 });

const ReminderOccurrence = mongoose.model('ReminderOccurrence', reminderOccurrenceSchema);
export default ReminderOccurrence;
