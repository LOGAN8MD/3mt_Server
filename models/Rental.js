import mongoose from 'mongoose';
import {
  auditEntrySchema,
  customerSnapshotSchema,
  machineSnapshotSchema,
  moneyField,
  paymentSchema,
} from './transactionSchemas.js';

export const RENTAL_STATUSES = Object.freeze([
  'draft',
  'active',
  'overdue',
  'returned',
  'cancelled',
]);

const occupiesMachineStatuses = new Set(['active', 'overdue']);
const requiresRentalDates = function () {
  return ['active', 'overdue', 'returned'].includes(this.status);
};
const requiresReturnDates = function () {
  return this.status === 'returned';
};
const requiresCancellationDetails = function () {
  return this.status === 'cancelled';
};

const rentalSchema = new mongoose.Schema(
  {
    rentalCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      match: /^RNT-[A-Z0-9-]+$/,
    },
    machine: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    machineSnapshot: { type: machineSnapshotSchema, required: true },
    customerSnapshot: { type: customerSnapshotSchema, required: true },
    status: {
      type: String,
      enum: RENTAL_STATUSES,
      default: 'draft',
      required: true,
    },
    occupiesMachine: {
      type: Boolean,
      default: false,
      required: true,
    },
    handoverAt: {
      type: Date,
      required: requiresRentalDates,
    },
    expectedReturnAt: {
      type: Date,
      required: requiresRentalDates,
    },
    actualReturnAt: {
      type: Date,
      required: requiresReturnDates,
    },
    returnRecordedAt: {
      type: Date,
      required: requiresReturnDates,
    },
    billingPeriod: {
      type: String,
      enum: ['day', 'week', 'month'],
      required: true,
    },
    agreedRatePaise: moneyField({ required: true, minValue: 1 }),
    plannedBillablePeriods: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'plannedBillablePeriods must be an integer',
      },
    },
    plannedExtraDays: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'plannedExtraDays must be an integer',
      },
    },
    derivedDailyRatePaise: moneyField({ required: true, minValue: 1 }),
    plannedRentalChargePaise: moneyField({ required: true, minValue: 1 }),
    dailyLateRatePaise: moneyField({ required: true, minValue: 1 }),
    actualBillablePeriods: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'actualBillablePeriods must be an integer',
      },
    },
    actualExtraDays: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'actualExtraDays must be an integer',
      },
    },
    lateDays: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'lateDays must be an integer',
      },
    },
    lateChargePaise: moneyField({ defaultValue: 0 }),
    finalRentalChargePaise: moneyField({ defaultValue: 0 }),
    otherApprovedChargesPaise: moneyField({ defaultValue: 0 }),
    rentalPaymentsReceivedPaise: moneyField({ defaultValue: 0 }),
    rentalPaymentRefundPaise: moneyField({ defaultValue: 0 }),
    securityDepositReceivedPaise: moneyField({ defaultValue: 0 }),
    approvedDepositDeductionsPaise: moneyField({ defaultValue: 0 }),
    depositAppliedPaise: moneyField({ defaultValue: 0 }),
    depositRefundPaise: moneyField({ defaultValue: 0 }),
    remainingBalancePaise: moneyField({ defaultValue: 0 }),
    payments: { type: [paymentSchema], default: [] },
    returnMachineStatus: {
      type: String,
      enum: ['available', 'unavailable'],
      required: requiresReturnDates,
    },
    returnConditionNote: { type: String, trim: true, default: '' },
    settlementNote: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, default: '' },
    cancellationReason: {
      type: String,
      trim: true,
      required: requiresCancellationDetails,
      default: '',
    },
    cancelledAt: { type: Date, required: requiresCancellationDetails },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: requiresCancellationDetails,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    auditHistory: { type: [auditEntrySchema], default: [] },
    currency: {
      type: String,
      enum: ['INR'],
      default: 'INR',
      immutable: true,
    },
  },
  { timestamps: true }
);

rentalSchema.pre('validate', function syncMachineOccupancy() {
  this.occupiesMachine = occupiesMachineStatuses.has(this.status);
});

rentalSchema.pre('validate', function validateRentalDates() {
  if (this.handoverAt && this.expectedReturnAt && this.expectedReturnAt <= this.handoverAt) {
    this.invalidate('expectedReturnAt', 'expectedReturnAt must be after handoverAt');
  }

  if (this.handoverAt && this.actualReturnAt && this.actualReturnAt < this.handoverAt) {
    this.invalidate('actualReturnAt', 'actualReturnAt cannot be before handoverAt');
  }
});

rentalSchema.index(
  { machine: 1 },
  {
    unique: true,
    partialFilterExpression: { occupiesMachine: true },
    name: 'one_occupying_rental_per_machine',
  }
);
rentalSchema.index({ status: 1, expectedReturnAt: 1 });
rentalSchema.index({ customer: 1, createdAt: -1 });
rentalSchema.index({ machine: 1, createdAt: -1 });
rentalSchema.index({ createdAt: -1 });

const Rental = mongoose.model('Rental', rentalSchema);
export default Rental;
