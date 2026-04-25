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

const Product = mongoose.model('Product', productSchema);
export default Product;