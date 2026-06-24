import Product from '../models/Product.js';
import cloudinary from '../config/cloudinary.js';
import streamifier from 'streamifier';
import mongoose from 'mongoose';
import AppError from '../utils/AppError.js';

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_RELATED_LIMIT = 8;
const MAX_QUERY_LIMIT = 100;

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parsePositiveInteger = (value, fieldName, defaultValue) => {
  if (value === undefined) return defaultValue;

  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new AppError(`${fieldName} must be a positive integer`, 400);
  }

  return parsedValue;
};

const parseLimit = (value, defaultValue) => {
  const limit = parsePositiveInteger(value, 'limit', defaultValue);
  return Math.min(limit, MAX_QUERY_LIMIT);
};

const buildTextSearchFilter = (searchTerm) => {
  const searchRegex = new RegExp(escapeRegex(searchTerm.trim()), 'i');

  return {
    $or: [
      { name: searchRegex },
      { brand: searchRegex },
      { model: searchRegex },
      { category: searchRegex },
      { subCategory: searchRegex },
      { type: searchRegex },
    ],
  };
};

const getSortOption = (sort) => {
  const sortOptions = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    priceAsc: { price: 1, name: 1 },
    priceDesc: { price: -1, name: 1 },
    nameAsc: { name: 1 },
    nameDesc: { name: -1 },
  };

  if (!sort) return null;
  if (!sortOptions[sort]) {
    throw new AppError(
      'sort must be one of: newest, oldest, priceAsc, priceDesc, nameAsc, nameDesc',
      400
    );
  }

  return sortOptions[sort];
};

export const getProducts = async (req, res, next) => {
  try {
    const filters = [];
    const searchTerm = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    if (searchTerm) {
      filters.push(buildTextSearchFilter(searchTerm));
    }

    for (const field of ['category', 'type', 'brand']) {
      const value = typeof req.query[field] === 'string' ? req.query[field].trim() : '';
      if (value) {
        filters.push({
          [field]: new RegExp(`^${escapeRegex(value)}$`, 'i'),
        });
      }
    }

    const filter = filters.length > 0 ? { $and: filters } : {};
    const sort = getSortOption(req.query.sort);
    const page = parsePositiveInteger(req.query.page, 'page', 1);
    const hasPagination = req.query.page !== undefined || req.query.limit !== undefined;
    const limit = hasPagination ? parseLimit(req.query.limit, 20) : null;

    let query = Product.find(filter).lean();

    if (sort) {
      query = query.sort(sort);
    }

    if (limit) {
      query = query.skip((page - 1) * limit).limit(limit);
    }

    const products = await query;
    res.json(products);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to fetch products: ' + err.message, 500));
  }
};

export const searchProducts = async (req, res, next) => {
  try {
    const searchTerm = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!searchTerm) {
      return next(new AppError('q query parameter is required', 400));
    }

    const limit = parseLimit(req.query.limit, DEFAULT_SEARCH_LIMIT);
    const products = await Product.find(buildTextSearchFilter(searchTerm))
      .select('name category type brand model price stock images')
      .sort({ name: 1 })
      .limit(limit)
      .lean();

    res.json(products);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to search products: ' + err.message, 500));
  }
};

export const getRelatedProducts = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(new AppError('Invalid product id', 400));
    }

    const product = await Product.findById(req.params.id)
      .select('category subCategory type')
      .lean();

    if (!product) {
      return next(new AppError('Product not found', 404));
    }

    const categoryValues = [
      product.category,
      ...(product.subCategory || '').split(','),
    ]
      .map((value) => value?.trim())
      .filter(Boolean);

    const relatedFilters = categoryValues.flatMap((value) => {
      const exactValue = new RegExp(`^${escapeRegex(value)}$`, 'i');
      const containedValue = new RegExp(`(^|,)\\s*${escapeRegex(value)}\\s*(,|$)`, 'i');

      return [
        { category: exactValue },
        { subCategory: containedValue },
      ];
    });

    if (relatedFilters.length === 0 && product.type) {
      relatedFilters.push({
        type: new RegExp(`^${escapeRegex(product.type.trim())}$`, 'i'),
      });
    }

    if (relatedFilters.length === 0) {
      return res.json([]);
    }

    const limit = parseLimit(req.query.limit, DEFAULT_RELATED_LIMIT);
    const products = await Product.find({
      _id: { $ne: product._id },
      $or: relatedFilters,
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json(products);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to fetch related products: ' + err.message, 500));
  }
};

export const getProductById = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(new AppError('Invalid product id', 400));
    }

    const product = await Product.findById(req.params.id).lean();
    if (!product) return next(new AppError('Product not found', 404));
    res.json(product);
  } catch (err) {
    next(new AppError('Failed to fetch product: ' + err.message, 500));
  }
};

export const createProduct = async (req, res, next) => {
  const { name, type, category, subCategory, brand, description, size, model, price, stock } = req.body;

  if (!req.files || req.files.length === 0) {
    return next(new AppError('At least one product image is required', 400));
  }

  try {
    const uploadedImages = [];
    const streamUpload = (fileBuffer) => {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'products' },
          (error, result) => {
            if (result) {
              resolve(result);
            } else {
              reject(error);
            }
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
    res.status(201).json(newProduct);
  } catch (err) {
    next(new AppError('Failed to create product: ' + err.message, 500));
  }
};

export const updateProduct = async (req, res, next) => {
  const { name, type, category, subCategory, brand, description, size, model, price, stock } = req.body;

  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return next(new AppError('Product not found', 404));
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
    next(new AppError('Failed to update product: ' + err.message, 500));
  }
};

export const deleteProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return next(new AppError('Product not found', 404));
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
    next(new AppError('Failed to delete product: ' + err.message, 500));
  }
};
