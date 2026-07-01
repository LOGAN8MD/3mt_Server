import mongoose from 'mongoose';

const pendingProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    type: { type: String },
    category: { type: String },
    subCategory: { type: String },
    brand: { type: String },
    description: { type: String },
    size: { type: String },
    model: { type: String },
    price: { type: Number, required: true },
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

const PendingProduct = mongoose.model('PendingProduct', pendingProductSchema);
export default PendingProduct;
