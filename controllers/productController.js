import Product from '../models/Product.js';
import cloudinary from '../config/cloudinary.js';
import streamifier from 'streamifier';

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

// export const createProduct = async (req, res) => {
//   const { name, description, price } = req.body;
//   const image = req.file?.path; // Image path from multer

//   console.log(req.body)
//   console.log(image)
//   // Check if image is uploaded
//   if (!image) {
//     return res.status(400).json({ message: 'Product image is required' });
//   }

//   try {
//     const newProduct = new Product({ name, description, price, image });

//     // Save the new product to the database
//     await newProduct.save();
//     res.status(201).json(newProduct);  // Respond with the created product
//   } catch (err) {
//     res.status(500).json({ message: 'Failed to create product', error: err.message });
//   }
// };

export const createProduct = async (req, res) => {
  const { name, type, category, subCategory, brand, description, size, model, price, stock } = req.body;

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ message: 'At least one product image is required' });
  }

  try {
    // Upload to Cloudinary
    console.log("-----------------------------------------");
    console.log("📦 Starting product creation process...");
    console.log("BODY received:", req.body);
    console.log(`FILES received: ${req.files.length} image(s)`);
    
    const uploadedImages = [];
    const streamUpload = (fileBuffer) => {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'products' },
          (error, result) => {
            if (result) {
              console.log("✅ Successfully uploaded an image to Cloudinary:", result.secure_url);
              resolve(result);
            } else {
              console.error("❌ Cloudinary upload error:", error);
              reject(error);
            }
          }
        );
        streamifier.createReadStream(fileBuffer).pipe(stream);
      });
    };

    console.log("⏳ Uploading images to Cloudinary...");
    for (const file of req.files) {
      const result = await streamUpload(file.buffer);
      uploadedImages.push({
        url: result.secure_url,
        public_id: result.public_id,
      });
    }
    console.log("✅ All images uploaded successfully!");

    const newProduct = new Product({
      name,
      type,
      category,
      subCategory,
      brand,
      description,
      size,
      model,
      price,
      stock,
      images: uploadedImages,
    });

    await newProduct.save();
    console.log("✅ Product saved to Database successfully!");
    console.log("-----------------------------------------");
    res.status(201).json(newProduct);
  } catch (err) {
    console.error("❌ Error in createProduct function:", err);
    res.status(500).json({ message: 'Failed to create product', error: err.message });
  }
};

// export const updateProduct = async (req, res) => {
//   const { name, description, price } = req.body;
//   const image = req.file?.path;  // Get the image path if new image uploaded

//   try {
//     const product = await Product.findById(req.params.id);

//     // If the product doesn't exist, return an error
//     if (!product) {
//       return res.status(404).json({ message: 'Product not found' });
//     }

//     // Update product fields
//     product.name = name || product.name;
//     product.description = description || product.description;
//     product.price = price || product.price;

//     // Update the image only if a new one is provided
//     if (image) product.image = image;

//     // Save the updated product to the database
//     const updatedProduct = await product.save();
//     res.status(200).json(updatedProduct);  // Return the updated product
//   } catch (err) {
//     res.status(500).json({ message: 'Failed to update product', error: err.message });
//   }
// };

export const updateProduct = async (req, res) => {
  const { name, type, category, subCategory, brand, description, size, model, price, stock } = req.body;

  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    product.name = name || product.name;
    product.type = type || product.type;
    product.category = category || product.category;
    product.subCategory = subCategory || product.subCategory;
    product.brand = brand || product.brand;
    product.description = description || product.description;
    product.size = size || product.size;
    product.model = model || product.model;
    product.price = price || product.price;
    product.stock = stock || product.stock;

    // If new images uploaded, replace old ones
    if (req.files && req.files.length > 0) {
      // Delete old images
      if (product.images && product.images.length > 0) {
        for (const img of product.images) {
          if (img.public_id) {
            await cloudinary.uploader.destroy(img.public_id);
          }
        }
      }

      // Upload new images
      const uploadedImages = [];
      const streamUpload = (fileBuffer) => {
        return new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: 'products' },
            (error, result) => {
              if (result) resolve(result);
              else reject(error);
            }
          );
          streamifier.createReadStream(fileBuffer).pipe(stream);
        });
      };

      for (const file of req.files) {
        const result = await streamUpload(file.buffer);
        uploadedImages.push({
          url: result.secure_url,
          public_id: result.public_id,
        });
      }

      product.images = uploadedImages;
    }

    const updatedProduct = await product.save();
    res.json(updatedProduct);

  } catch (err) {
    res.status(500).json({ message: 'Failed to update product', error: err.message });
  }
};

// export const deleteProduct = async (req, res) => {
//   try {
//     const product = await Product.findByIdAndDelete(req.params.id);

//     // If product not found, return an error
//     if (!product) {
//       return res.status(404).json({ message: 'Product not found' });
//     }

//     res.status(200).json({ message: 'Product deleted successfully' });  // Return success message
//   } catch (err) {
//     res.status(500).json({ message: 'Failed to delete product', error: err.message });
//   }
// };

export const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // Delete images from Cloudinary
    if (product.images && product.images.length > 0) {
      for (const img of product.images) {
        if (img.public_id) {
          await cloudinary.uploader.destroy(img.public_id);
        }
      }
    }

    await product.deleteOne();

    res.json({ message: 'Product deleted successfully' });

  } catch (err) {
    res.status(500).json({ message: 'Failed to delete product', error: err.message });
  }
};