import Product from '../models/Product.js';

export const getProducts = async (req, res) => {
  try {
    const products = await Product.find({});
    res.json(products);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch products', error: err.message });
  }
};

export const getProductById = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch product', error: err.message });
  }
};

export const createProduct = async (req, res) => {
  const { name, description, price } = req.body;
  const image = req.file?.path; // Image path from multer

  console.log(req.body)
  console.log(image)
  // Check if image is uploaded
  if (!image) {
    return res.status(400).json({ message: 'Product image is required' });
  }

  try {
    const newProduct = new Product({ name, description, price, image });

    // Save the new product to the database
    await newProduct.save();
    res.status(201).json(newProduct);  // Respond with the created product
  } catch (err) {
    res.status(500).json({ message: 'Failed to create product', error: err.message });
  }
};

export const updateProduct = async (req, res) => {
  const { name, description, price } = req.body;
  const image = req.file?.path;  // Get the image path if new image uploaded

  try {
    const product = await Product.findById(req.params.id);

    // If the product doesn't exist, return an error
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // Update product fields
    product.name = name || product.name;
    product.description = description || product.description;
    product.price = price || product.price;

    // Update the image only if a new one is provided
    if (image) product.image = image;

    // Save the updated product to the database
    const updatedProduct = await product.save();
    res.status(200).json(updatedProduct);  // Return the updated product
  } catch (err) {
    res.status(500).json({ message: 'Failed to update product', error: err.message });
  }
};

export const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);

    // If product not found, return an error
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.status(200).json({ message: 'Product deleted successfully' });  // Return success message
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete product', error: err.message });
  }
};