import Product from '../models/Product.js';
import cloudinary from '../config/cloudinary.js';
import streamifier from 'streamifier';
import mongoose from 'mongoose';
import AppError from '../utils/AppError.js';
import { customerCatalogFilters } from '../utils/customerCatalog.js';
import {
  DEFAULT_PRODUCT_RULES,
  validateProductRules,
} from '../utils/productRules.js';

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_RELATED_LIMIT = 8;
const MAX_QUERY_LIMIT = 100;
const PRODUCT_CARD_FIELDS = [
  'name',
  'price',
  'rentalPrice',
  'rentPeriod',
  'securityDeposit',
  'brand',
  'category',
  'type',
  'condition',
  'availabilityType',
  'availabilityStatus',
  'availableFrom',
  'availabilityNote',
  'stock',
  'images',
].join(' ');
const SEARCH_PRODUCT_FIELDS = `${PRODUCT_CARD_FIELDS} model`;
const PRODUCT_WRITE_FIELDS = [
  'name',
  'type',
  'condition',
  'category',
  'subCategory',
  'brand',
  'description',
  'size',
  'model',
  'availabilityType',
  'availabilityStatus',
  'price',
  'rentalPrice',
  'rentPeriod',
  'securityDeposit',
  'availableFrom',
  'availabilityNote',
  'stock',
];

const pickProductWriteFields = (body) => {
  const productData = {};

  for (const field of PRODUCT_WRITE_FIELDS) {
    if (body[field] !== undefined) productData[field] = body[field];
  }

  return productData;
};

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

const parseNonNegativeNumber = (value, fieldName) => {
  if (value === undefined) return null;

  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new AppError(`${fieldName} must be a non-negative number`, 400);
  }

  return parsedValue;
};

const parseOptionalBoolean = (value, fieldName) => {
  if (value === undefined) return null;
  if (value === 'true') return true;
  if (value === 'false') return false;

  throw new AppError(`${fieldName} must be true or false`, 400);
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
    rentalPriceAsc: { rentalPrice: 1, name: 1 },
    rentalPriceDesc: { rentalPrice: -1, name: 1 },
    nameAsc: { name: 1 },
    nameDesc: { name: -1 },
  };

  if (!sort) return null;
  if (!sortOptions[sort]) {
    throw new AppError(
      'sort must be one of: newest, oldest, priceAsc, priceDesc, rentalPriceAsc, rentalPriceDesc, nameAsc, nameDesc',
      400
    );
  }

  return sortOptions[sort];
};

export const getProducts = (req, res, next) => listProducts(req, res, next, false);

export const getInventoryProducts = (req, res, next) => listProducts(req, res, next, true);

const listProducts = async (req, res, next, inventory) => {
  try {
    const filters = inventory ? [] : customerCatalogFilters(req.query.condition);
    const searchTerm = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    if (searchTerm) {
      filters.push(buildTextSearchFilter(searchTerm));
    }

    for (const field of [
      'category',
      'type',
      'brand',
      ...(inventory ? ['condition'] : []),
    ]) {
      const value = typeof req.query[field] === 'string' ? req.query[field].trim() : '';
      if (value) {
        filters.push({
          [field]: new RegExp(`^${escapeRegex(value)}$`, 'i'),
        });
      }
    }

    const options = {};
    for (const [field, allowed] of Object.entries({
      availabilityType: ['sale', 'rent', 'both'],
      availabilityStatus: ['available', 'on_rent', 'unavailable', 'sold'],
      rentPeriod: ['day', 'week', 'month'],
    })) {
      const raw = req.query[field];
      if (raw === undefined || raw === '') continue;
      if (typeof raw !== 'string' || !allowed.includes(raw.trim().toLowerCase())) {
        throw new AppError(`${field} must be one of: ${allowed.join(', ')}`, 400);
      }
      const value = raw.trim().toLowerCase();
      options[field] = value;
      filters.push({ [field]: field === 'availabilityType' && !inventory && value !== 'both'
        ? { $in: [value, 'both', ...(value === 'sale' ? [null, ''] : [])] }
        : value });
    }

    const minRental = parseNonNegativeNumber(req.query.minRentalPrice, 'minRentalPrice');
    const maxRental = parseNonNegativeNumber(req.query.maxRentalPrice, 'maxRentalPrice');
    const rentalSort = ['rentalPriceAsc', 'rentalPriceDesc'].includes(req.query.sort);
    if (minRental !== null || maxRental !== null || rentalSort) {
      if (!options.rentPeriod) throw new AppError('rentPeriod is required for rental price filtering or sorting', 400);
      if (minRental !== null && maxRental !== null && minRental > maxRental) {
        throw new AppError('minRentalPrice must be less than or equal to maxRentalPrice', 400);
      }
      const rentalPrice = { $type: 'number' };
      if (minRental !== null) rentalPrice.$gte = minRental;
      if (maxRental !== null) rentalPrice.$lte = maxRental;
      filters.push({ rentalPrice });
    }
    if (options.rentPeriod) filters.push({ availabilityType: { $in: ['rent', 'both'] } });

    const minPrice = parseNonNegativeNumber(req.query.minPrice, 'minPrice');
    const maxPrice = parseNonNegativeNumber(req.query.maxPrice, 'maxPrice');

    if (minPrice !== null || maxPrice !== null) {
      if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
        throw new AppError('minPrice must be less than or equal to maxPrice', 400);
      }

      const priceFilter = {};
      if (minPrice !== null) priceFilter.$gte = minPrice;
      if (maxPrice !== null) priceFilter.$lte = maxPrice;
      filters.push({ price: priceFilter });
    }

    const inStock = parseOptionalBoolean(req.query.inStock, 'inStock');
    if (inStock === true) {
      filters.push({ stock: { $gt: 0 } });
    }

    if (inStock === false) {
      filters.push({
        $or: [
          { stock: { $lte: 0 } },
          { stock: { $exists: false } },
        ],
      });
    }

    const filter = filters.length > 0 ? { $and: filters } : {};
    const sort = getSortOption(req.query.sort);
    const page = parsePositiveInteger(req.query.page, 'page', 1);
    const hasPagination = req.query.page !== undefined || req.query.limit !== undefined;
    const limit = hasPagination ? parseLimit(req.query.limit, 20) : null;

    let query = Product.find(filter).lean();

    if (hasPagination) {
      query = query.select(PRODUCT_CARD_FIELDS).slice('images', 1);
    }

    if (sort) {
      query = query.sort(sort);
    }

    if (limit) {
      query = query.skip((page - 1) * limit).limit(limit);
    }

    const [products, total] = await Promise.all([
      query,
      hasPagination ? Product.countDocuments(filter) : Promise.resolve(null),
    ]);

    if (hasPagination) {
      const totalPages = Math.ceil(total / limit);

      return res.json({
        products,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      });
    }

    res.json(products);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to fetch products: ' + err.message, 500));
  }
};

export const getProductFilterOptions = async (req, res, next) => {
  try {
    const cleanOptions = (values) =>
      Array.from(
        new Set(
          values
            .filter((value) => typeof value === 'string' && value.trim())
            .map((value) => value.trim())
        )
      ).sort((a, b) => a.localeCompare(b));

    const [
      brands,
      types,
      categories,
      conditions,
      availabilityTypes,
      availabilityStatuses,
      priceStats,
      rentalPriceStats,
    ] = await Promise.all([
      Product.distinct('brand'),
      Product.distinct('type'),
      Product.distinct('category'),
      Product.distinct('condition'),
      Product.distinct('availabilityType'),
      Product.distinct('availabilityStatus'),
      Product.aggregate([
        {
          $group: {
            _id: null,
            min: { $min: '$price' },
            max: { $max: '$price' },
          },
        },
      ]),
      Product.aggregate([
        {
          $group: {
            _id: null,
            min: { $min: '$rentalPrice' },
            max: { $max: '$rentalPrice' },
          },
        },
      ]),
    ]);

    const priceRange = priceStats[0]
      ? {
          min: priceStats[0].min ?? 0,
          max: priceStats[0].max ?? 0,
        }
      : {
          min: 0,
          max: 0,
        };
    const rentalPriceRange = rentalPriceStats[0]
      ? {
          min: rentalPriceStats[0].min ?? 0,
          max: rentalPriceStats[0].max ?? 0,
        }
      : {
          min: 0,
          max: 0,
        };

    res.json({
      brands: cleanOptions(brands),
      types: cleanOptions(types),
      categories: cleanOptions(categories),
      conditions: cleanOptions([...conditions, DEFAULT_PRODUCT_RULES.condition]),
      availabilityTypes: cleanOptions([
        ...availabilityTypes,
        DEFAULT_PRODUCT_RULES.availabilityType,
      ]),
      availabilityStatuses: cleanOptions([
        ...availabilityStatuses,
        DEFAULT_PRODUCT_RULES.availabilityStatus,
      ]),
      priceRange,
      rentalPriceRange,
    });
  } catch (err) {
    next(new AppError('Failed to fetch product filter options: ' + err.message, 500));
  }
};

export const searchProducts = async (req, res, next) => {
  try {
    const searchTerm = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!searchTerm) {
      return next(new AppError('q query parameter is required', 400));
    }

    const limit = parseLimit(req.query.limit, DEFAULT_SEARCH_LIMIT);
    const products = await Product.find({
      $and: [...customerCatalogFilters(), buildTextSearchFilter(searchTerm)],
    })
      .select(SEARCH_PRODUCT_FIELDS)
      .slice('images', 1)
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
      .select('category subCategory type condition')
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
      $and: customerCatalogFilters(product.condition === 'used' ? 'used' : 'new'),
    })
      .select(PRODUCT_CARD_FIELDS)
      .slice('images', 1)
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
  try {
    const productData = validateProductRules(pickProductWriteFields(req.body));

    if (!req.files || req.files.length === 0) {
      throw new AppError('At least one product image is required', 400);
    }

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
      ...productData,
      images: uploadedImages,
    });

    await newProduct.save();
    res.status(201).json(newProduct);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to create product: ' + err.message, 500));
  }
};

export const updateProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return next(new AppError('Product not found', 404));
    }

    const requestedUpdates = pickProductWriteFields(req.body);
    const validatedProductData = validateProductRules({
      ...product.toObject(),
      ...requestedUpdates,
    });

    for (const field of Object.keys(requestedUpdates)) {
      product[field] = validatedProductData[field];
    }

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
    if (err instanceof AppError) return next(err);
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
