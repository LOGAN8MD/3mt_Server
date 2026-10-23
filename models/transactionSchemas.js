import mongoose from 'mongoose';

const integerMoneyValidator = {
  validator(value) {
    return Number.isSafeInteger(value);
  },
  message: '{PATH} must be an integer amount in paise',
};

export const moneyField = ({ required = false, defaultValue, minValue = 0 } = {}) => ({
  type: Number,
  required,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
  min: minValue,
  validate: integerMoneyValidator,
});

export const customerSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    firstName: { type: String, trim: true, default: '' },
    lastName: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

export const machineSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, trim: true, default: '' },
    category: { type: String, trim: true, default: '' },
    subCategory: { type: String, trim: true, default: '' },
    brand: { type: String, trim: true, default: '' },
    model: { type: String, trim: true, default: '' },
    condition: { type: String, enum: ['used'], required: true },
    availabilityType: { type: String, enum: ['sale', 'rent', 'both'], required: true },
    imageUrl: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

export const paymentSchema = new mongoose.Schema(
  {
    amountPaise: moneyField({ required: true, minValue: 1 }),
    method: {
      type: String,
      enum: ['cash', 'upi', 'bank_transfer', 'card', 'other'],
      required: true,
    },
    paidAt: { type: Date, required: true, default: Date.now },
    reference: { type: String, trim: true, default: '' },
    note: { type: String, trim: true, default: '' },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

export const auditEntrySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true },
    note: { type: String, trim: true, default: '' },
    changes: { type: mongoose.Schema.Types.Mixed, default: undefined },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    performedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: true }
);
