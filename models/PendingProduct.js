import mongoose from 'mongoose';
import {
  DEFAULT_PRODUCT_RULES,
  PRODUCT_AVAILABILITY_STATUSES,
  PRODUCT_AVAILABILITY_TYPES,
  PRODUCT_CONDITIONS,
  PRODUCT_RENT_PERIODS,
} from '../utils/productRules.js';

const includesSale = function () {
  return ['sale', 'both'].includes(
    this.availabilityType || DEFAULT_PRODUCT_RULES.availabilityType
  );
};

const includesRent = function () {
  return ['rent', 'both'].includes(this.availabilityType);
};

const pendingProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    type: { type: String },
    condition: {
      type: String,
      enum: PRODUCT_CONDITIONS,
      default: DEFAULT_PRODUCT_RULES.condition,
    },
    category: { type: String },
    subCategory: { type: String },
    brand: { type: String },
    description: { type: String },
    size: { type: String },
    model: { type: String },
    availabilityType: {
      type: String,
      enum: PRODUCT_AVAILABILITY_TYPES,
      default: DEFAULT_PRODUCT_RULES.availabilityType,
    },
    availabilityStatus: {
      type: String,
      enum: PRODUCT_AVAILABILITY_STATUSES,
      default: DEFAULT_PRODUCT_RULES.availabilityStatus,
    },
    price: {
      type: Number,
      min: 0,
      required: includesSale,
    },
    rentalPrice: {
      type: Number,
      min: 0,
      required: includesRent,
    },
    rentPeriod: {
      type: String,
      enum: PRODUCT_RENT_PERIODS,
      required: includesRent,
    },
    securityDeposit: {
      type: Number,
      min: 0,
      default: 0,
    },
    availableFrom: {
      type: Date,
      default: null,
    },
    availabilityNote: {
      type: String,
      trim: true,
    },
    stock: { type: Number },
    images: [
      {
        url: { type: String },
        public_id: { type: String },
      },
    ],
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reviewedAt: {
      type: Date,
    },
    approvedProduct: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
    },
    adminNote: {
      type: String,
    },
    rejectionReason: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

pendingProductSchema.index({ status: 1, createdAt: -1 });
pendingProductSchema.index({ submittedBy: 1, createdAt: -1 });
pendingProductSchema.index({ reviewedBy: 1, reviewedAt: -1 });
pendingProductSchema.index({ approvedProduct: 1 });
pendingProductSchema.index({ condition: 1, availabilityType: 1 });
pendingProductSchema.index({ availabilityStatus: 1 });

const PendingProduct = mongoose.model('PendingProduct', pendingProductSchema);
export default PendingProduct;
