import mongoose from 'mongoose';
import { auditEntrySchema } from './transactionSchemas.js';
import {
  bilingualContentSchema,
  REMINDER_CHANNELS,
  recipientSnapshotSchema,
  validateChannels,
} from './reminderSchemas.js';
import { BUSINESS_TIME_ZONE } from '../utils/businessTime.js';

export const REMINDER_PLAN_STATUSES = Object.freeze([
  'active',
  'paused',
  'completed',
  'cancelled',
]);

const planRowSchema = new mongoose.Schema(
  {
    rowKey: { type: String, required: true, trim: true, uppercase: true },
    offsetMinutes: { type: Number, required: true, min: 1 },
    scheduledAt: { type: Date, required: true },
    scheduleMode: {
      type: String,
      enum: ['offset_before_return', 'exact'],
      required: true,
    },
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
      required: true,
    },
    content: { type: bilingualContentSchema, required: true },
    initialStatus: {
      type: String,
      enum: ['pending', 'missed'],
      default: 'pending',
      required: true,
    },
    missedAt: Date,
  },
  { _id: false }
);

const reminderPlanSchema = new mongoose.Schema(
  {
    planCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      match: /^RPL-[A-Z0-9-]+$/,
    },
    planType: { type: String, enum: ['rental', 'standalone'], required: true },
    reminderMode: { type: String, enum: ['default', 'custom'], required: true },
    rental: { type: mongoose.Schema.Types.ObjectId, ref: 'Rental' },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    recipientSnapshot: { type: recipientSnapshotSchema, required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    rows: {
      type: [planRowSchema],
      validate: {
        validator: (rows) => Array.isArray(rows) && rows.length > 0 && rows.length <= 20,
        message: 'rows must contain between 1 and 20 reminders',
      },
    },
    status: {
      type: String,
      enum: REMINDER_PLAN_STATUSES,
      default: 'active',
      required: true,
    },
    version: { type: Number, min: 1, default: 1, required: true },
    fingerprint: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
      index: true,
    },
    submissionKey: { type: String, trim: true, maxlength: 100 },
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

reminderPlanSchema.pre('validate', function validatePlan() {
  if (this.planType === 'rental' && !this.rental) {
    this.invalidate('rental', 'rental is required for rental reminder plans');
  }
  if (this.planType === 'standalone' && this.rental) {
    this.invalidate('rental', 'standalone reminder plans cannot reference a rental');
  }
  if (this.planType === 'standalone' && this.reminderMode !== 'custom') {
    this.invalidate('reminderMode', 'standalone reminder plans must be custom');
  }
  if (this.endsAt <= this.startsAt) {
    this.invalidate('endsAt', 'endsAt must be after startsAt');
  }
  const rows = Array.isArray(this.rows) ? this.rows : [];
  const rowKeys = new Set(rows.map(({ rowKey }) => rowKey));
  const scheduledTimes = new Set(
    rows.filter(({ scheduledAt }) => scheduledAt instanceof Date)
      .map(({ scheduledAt }) => scheduledAt.getTime())
  );
  if (rowKeys.size !== rows.length || scheduledTimes.size !== rows.length) {
    this.invalidate('rows', 'plan reminder rows and scheduled times must be unique');
  }
  for (const row of rows) {
    if (!row.scheduledAt) continue;
    if (
      (row.initialStatus !== 'missed' && row.scheduledAt < this.startsAt) ||
      row.scheduledAt >= this.endsAt
    ) {
      this.invalidate('rows', 'each reminder must be within the plan period before its end');
    }
    if (row.initialStatus === 'missed' && !row.missedAt) {
      this.invalidate('rows', 'missed reminder rows require missedAt');
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

reminderPlanSchema.index(
  { createdBy: 1, submissionKey: 1 },
  {
    unique: true,
    partialFilterExpression: { submissionKey: { $type: 'string' } },
    name: 'one_plan_per_submission_key',
  }
);
reminderPlanSchema.index({ rental: 1, status: 1, updatedAt: -1 });
reminderPlanSchema.index({ customer: 1, status: 1, updatedAt: -1 });
reminderPlanSchema.index({ planType: 1, status: 1, updatedAt: -1 });

const ReminderPlan = mongoose.model('ReminderPlan', reminderPlanSchema);
export default ReminderPlan;
