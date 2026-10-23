import mongoose from 'mongoose';
import {
  auditEntrySchema,
  customerSnapshotSchema,
  machineSnapshotSchema,
  moneyField,
  paymentSchema,
} from './transactionSchemas.js';

export const MACHINE_SALE_STATUSES = Object.freeze(['draft', 'completed', 'cancelled']);

const requiresCompletedSaleDate = function () {
  return this.status === 'completed';
};
const requiresCancellationDetails = function () {
  return this.status === 'cancelled';
};

const machineSaleSchema = new mongoose.Schema(
  {
    saleCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      match: /^SAL-[A-Z0-9-]+$/,
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
      enum: MACHINE_SALE_STATUSES,
      default: 'draft',
      required: true,
    },
    isCompletedSale: {
      type: Boolean,
      default: false,
      required: true,
    },
    soldAt: {
      type: Date,
      required: requiresCompletedSaleDate,
    },
    agreedSalePricePaise: moneyField({ required: true, minValue: 1 }),
    paymentsReceivedPaise: moneyField({ defaultValue: 0 }),
    paymentsRefundedPaise: moneyField({ defaultValue: 0 }),
    remainingBalancePaise: moneyField({ defaultValue: 0 }),
    payments: { type: [paymentSchema], default: [] },
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

machineSaleSchema.pre('validate', function syncCompletedSale() {
  this.isCompletedSale = this.status === 'completed';
});

machineSaleSchema.index(
  { machine: 1 },
  {
    unique: true,
    partialFilterExpression: { isCompletedSale: true },
    name: 'one_completed_sale_per_machine',
  }
);
machineSaleSchema.index({ status: 1, soldAt: -1 });
machineSaleSchema.index({ customer: 1, createdAt: -1 });
machineSaleSchema.index({ createdAt: -1 });

const MachineSale = mongoose.model('MachineSale', machineSaleSchema);
export default MachineSale;
