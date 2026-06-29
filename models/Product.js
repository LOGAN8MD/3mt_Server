import mongoose from 'mongoose';


const productSchema = new mongoose.Schema({
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
  images: [{
    url: { type: String },
    public_id: { type: String }
  }]
}, { timestamps: true });

productSchema.index({ category: 1, type: 1 });
productSchema.index({ brand: 1 });
productSchema.index({ price: 1 });
productSchema.index({ stock: 1 });
productSchema.index({ type: 1, price: 1 });
productSchema.index({ createdAt: -1 });

const Product = mongoose.model('Product', productSchema);
export default Product;
