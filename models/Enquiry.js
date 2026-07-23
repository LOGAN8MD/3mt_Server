import mongoose from 'mongoose';

const enquiryProductSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    nameSnapshot: {
      type: String,
      required: true,
      trim: true,
    },
    typeSnapshot: {
      type: String,
      trim: true,
      default: '',
    },
    categorySnapshot: {
      type: String,
      trim: true,
      default: '',
    },
    brandSnapshot: {
      type: String,
      trim: true,
      default: '',
    },
    modelSnapshot: {
      type: String,
      trim: true,
      default: '',
    },
    priceSnapshot: {
      type: Number,
      required: true,
      min: 0,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    lineTotal: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  {
    _id: false,
  }
);

const customerSnapshotSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      default: '',
    },
    firstName: {
      type: String,
      trim: true,
      default: '',
    },
    lastName: {
      type: String,
      trim: true,
      default: '',
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    address: {
      type: String,
      trim: true,
      default: '',
    },
    authProvider: {
      type: String,
      trim: true,
      default: '',
    },
  },
  {
    _id: false,
  }
);

const enquirySchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    customerSnapshot: {
      type: customerSnapshotSchema,
      default: () => ({}),
    },
    products: {
      type: [enquiryProductSchema],
      validate: {
        validator(products) {
          return Array.isArray(products) && products.length > 0;
        },
        message: 'At least one enquiry product is required',
      },
    },
    source: {
      type: String,
      enum: ['product_detail', 'cart', 'contact'],
      required: true,
      index: true,
    },
    message: {
      type: String,
      trim: true,
      default: '',
    },
    totalEstimatedPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ['new', 'contacted', 'converted', 'closed', 'spam'],
      default: 'new',
      index: true,
    },
    notes: {
      type: String,
      trim: true,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

enquirySchema.index({ createdAt: -1 });
enquirySchema.index({ customer: 1, createdAt: -1 });
enquirySchema.index({ 'products.product': 1, createdAt: -1 });

const Enquiry = mongoose.model('Enquiry', enquirySchema);
export default Enquiry;
