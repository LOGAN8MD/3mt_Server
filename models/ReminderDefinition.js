import mongoose from 'mongoose';
import { auditEntrySchema } from './transactionSchemas.js';
import {
  bilingualContentSchema,
  REMINDER_CHANNELS,
  REMINDER_TYPES,
  recipientSnapshotSchema,
  validateChannels,
} from './reminderSchemas.js';
import { BUSINESS_TIME_ZONE } from '../utils/businessTime.js';

export const REMINDER_DEFINITION_STATUSES = Object.freeze([
  'active',
  'paused',
  'completed',
  'cancelled',
]);

export const REMINDER_SCHEDULE_MODES = Object.freeze([
  'immediate',
  'offset_before_return',
  'exact',
  'multiple_dates',
  'repeating',
]);

const requiresRental = function () {
  return this.type !== 'standalone_custom';
};

const recurrenceSchema = new mongoose.Schema(
  {
    frequency: { type: String, enum: ['day', 'week', 'month'] },
    interval: { type: Number, min: 1, default: 1 },
    startsAt: Date,
    endsAt: Date,
    occurrenceLimit: { type: Number, min: 1 },
  },
  { _id: false }
);

const reminderDefinitionSchema = new mongoose.Schema(
  {
    definitionCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      match: /^RMD-[A-Z0-9-]+$/,
    },
    type: { type: String, enum: REMINDER_TYPES, required: true },
    rental: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rental',
      required: requiresRental,
    },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    recipientSnapshot: { type: recipientSnapshotSchema, required: true },
    status: {
      type: String,
      enum: REMINDER_DEFINITION_STATUSES,
      default: 'active',
      required: true,
    },
    scheduleMode: { type: String, enum: REMINDER_SCHEDULE_MODES, required: true },
    offsetMinutes: { type: Number, min: 0 },
    exactAt: Date,
    exactDates: { type: [Date], default: [] },
    recurrence: { type: recurrenceSchema, default: undefined },
    channels: {
      type: [{ type: String, enum: REMINDER_CHANNELS }],
      required: true,
      validate: {
        validator: validateChannels,
        message: 'channels must contain unique email and/or whatsapp values',
      },
    },
    contentMode: {
      type: String,
      enum: ['default_template', 'custom'],
      default: 'default_template',
      required: true,
    },
    content: { type: bilingualContentSchema, default: () => ({}) },
    scheduleVersion: { type: Number, min: 1, default: 1, required: true },
    timeZone: {
      type: String,
      enum: [BUSINESS_TIME_ZONE],
      default: BUSINESS_TIME_ZONE,
      immutable: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancelledAt: Date,
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancellationReason: { type: String, trim: true, default: '' },
    auditHistory: { type: [auditEntrySchema], default: [] },
  },
  { timestamps: true }
);

reminderDefinitionSchema.pre('validate', function validateScheduleConfiguration() {
  if (this.type === 'rental_activation_confirmation' && this.scheduleMode !== 'immediate') {
    this.invalidate('scheduleMode', 'rental activation confirmations must use immediate scheduling');
  }

  if (this.type === 'rental_return' && !['offset_before_return', 'exact'].includes(this.scheduleMode)) {
    this.invalidate('scheduleMode', 'rental return reminders must use offset or exact scheduling');
  }

  if (this.type === 'standalone_custom' && this.scheduleMode === 'offset_before_return') {
    this.invalidate('scheduleMode', 'standalone reminders cannot use a rental return offset');
  }

  if (this.scheduleMode === 'offset_before_return' && !Number.isSafeInteger(this.offsetMinutes)) {
    this.invalidate('offsetMinutes', 'offsetMinutes must be a non-negative integer');
  }

  if (this.scheduleMode === 'exact' && !this.exactAt) {
    this.invalidate('exactAt', 'exactAt is required for exact scheduling');
  }

  if (this.scheduleMode === 'multiple_dates' && this.exactDates.length === 0) {
    this.invalidate('exactDates', 'at least one exact date is required');
  }

  if (this.scheduleMode === 'repeating') {
    if (!this.recurrence?.frequency || !this.recurrence?.startsAt) {
      this.invalidate('recurrence', 'repeating schedules require frequency and startsAt');
    }
    if (!this.recurrence?.endsAt && !this.recurrence?.occurrenceLimit) {
      this.invalidate('recurrence', 'repeating schedules require endsAt or occurrenceLimit');
    }
    if (
      this.recurrence?.startsAt &&
      this.recurrence?.endsAt &&
      this.recurrence.endsAt <= this.recurrence.startsAt
    ) {
      this.invalidate('recurrence.endsAt', 'endsAt must be after startsAt');
    }
  }

  if (this.status === 'cancelled') {
    if (!this.cancelledAt) this.invalidate('cancelledAt', 'cancelledAt is required');
    if (!this.cancelledBy) this.invalidate('cancelledBy', 'cancelledBy is required');
    if (!this.cancellationReason) {
      this.invalidate('cancellationReason', 'cancellationReason is required');
    }
  }
});

reminderDefinitionSchema.index({ rental: 1, status: 1, createdAt: -1 });
reminderDefinitionSchema.index({ customer: 1, status: 1, createdAt: -1 });
reminderDefinitionSchema.index({ type: 1, status: 1, createdAt: -1 });

const ReminderDefinition = mongoose.model('ReminderDefinition', reminderDefinitionSchema);
export default ReminderDefinition;
