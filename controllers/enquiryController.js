import mongoose from 'mongoose';
import Enquiry from '../models/Enquiry.js';
import Product from '../models/Product.js';
import AppError from '../utils/AppError.js';

const allowedSources = ['product_detail', 'cart', 'contact'];
const allowedStatuses = ['new', 'contacted', 'converted', 'closed', 'spam'];
const MAX_ENQUIRY_PRODUCTS = 25;

const parseQuantity = (value) => {
  const quantity = Number(value);

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new AppError('Product quantity must be a positive integer', 400);
  }

  return quantity;
};

const normalizeProductInput = (item) => {
  const productId = item?.productId || item?.product || item?._id;

  if (!mongoose.isValidObjectId(productId)) {
    throw new AppError('A valid product id is required for every enquiry item', 400);
  }

  return {
    productId: productId.toString(),
    quantity: parseQuantity(item?.quantity ?? 1),
  };
};

const buildCustomerSnapshot = (customer) => ({
  name: customer?.name || '',
  firstName: customer?.firstName || '',
  lastName: customer?.lastName || '',
  email: customer?.email || '',
  phone: customer?.phone || '',
  address: customer?.address || '',
  authProvider: customer?.authProvider || '',
});

const buildEnquiryProducts = async (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError('At least one enquiry product is required', 400);
  }

  if (items.length > MAX_ENQUIRY_PRODUCTS) {
    throw new AppError(`A maximum of ${MAX_ENQUIRY_PRODUCTS} products can be sent in one enquiry`, 400);
  }

  const normalizedItems = items.map(normalizeProductInput);
  const productIds = [...new Set(normalizedItems.map((item) => item.productId))];
  const products = await Product.find({ _id: { $in: productIds } }).lean();
  const productMap = new Map(products.map((product) => [product._id.toString(), product]));

  return normalizedItems.map((item) => {
    const product = productMap.get(item.productId);

    if (!product) {
      throw new AppError('One or more enquiry products were not found', 404);
    }

    const priceSnapshot = Number(product.price || 0);
    const lineTotal = priceSnapshot * item.quantity;

    return {
      product: product._id,
      nameSnapshot: product.name,
      typeSnapshot: product.type || '',
      categorySnapshot: product.category || '',
      brandSnapshot: product.brand || '',
      modelSnapshot: product.model || '',
      priceSnapshot,
      quantity: item.quantity,
      lineTotal,
    };
  });
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const addKeywordSearchFilter = (filter, search) => {
  const keyword = String(search || '').trim();
  if (!keyword) return filter;

  const searchRegex = new RegExp(escapeRegex(keyword), 'i');
  filter.$or = [
    { 'customerSnapshot.name': searchRegex },
    { 'customerSnapshot.firstName': searchRegex },
    { 'customerSnapshot.lastName': searchRegex },
    { 'customerSnapshot.email': searchRegex },
    { 'customerSnapshot.phone': searchRegex },
    { 'products.nameSnapshot': searchRegex },
    { 'products.brandSnapshot': searchRegex },
    { 'products.categorySnapshot': searchRegex },
    { 'products.typeSnapshot': searchRegex },
    { 'products.modelSnapshot': searchRegex },
    { message: searchRegex },
  ];

  return filter;
};

const buildEnquiryListFilters = ({ status, source, customer, search, dateFrom, dateTo }) => {
  const filter = {};

  if (status) {
    if (!allowedStatuses.includes(status)) {
      throw new AppError(`status must be one of: ${allowedStatuses.join(', ')}`, 400);
    }

    filter.status = status;
  }

  if (source) {
    if (!allowedSources.includes(source)) {
      throw new AppError(`source must be one of: ${allowedSources.join(', ')}`, 400);
    }

    filter.source = source;
  }

  if (customer) {
    if (!mongoose.isValidObjectId(customer)) {
      throw new AppError('Invalid customer id', 400);
    }

    filter.customer = customer;
  }

  addKeywordSearchFilter(filter, search);
  addDateRangeFilter(filter, { dateFrom, dateTo });

  return filter;
};

const parseDateFilter = (value, fieldName) => {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(`${fieldName} must be a valid date`, 400);
  }

  return date;
};

const addDateRangeFilter = (filter, { dateFrom, dateTo }) => {
  const fromDate = parseDateFilter(dateFrom, 'dateFrom');
  const toDate = parseDateFilter(dateTo, 'dateTo');

  if (fromDate || toDate) {
    filter.createdAt = {};

    if (fromDate) {
      filter.createdAt.$gte = fromDate;
    }

    if (toDate) {
      filter.createdAt.$lte = toDate;
    }
  }

  return filter;
};

const parseEnquiryListLimit = (limit) => Math.min(Math.max(Number(limit) || 100, 1), 200);

const fetchEnquiryList = (filter, limit) =>
  Enquiry.find(filter)
    .populate('customer', 'name firstName lastName email phone address authProvider')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

export const createEnquiry = async (req, res, next) => {
  try {
    const { products, source, message = '' } = req.body;

    if (!allowedSources.includes(source)) {
      return next(new AppError(`source must be one of: ${allowedSources.join(', ')}`, 400));
    }

    const enquiryProducts = await buildEnquiryProducts(products);
    const totalEstimatedPrice = enquiryProducts.reduce(
      (total, item) => total + item.lineTotal,
      0
    );

    const enquiry = await Enquiry.create({
      customer: req.user._id,
      customerSnapshot: buildCustomerSnapshot(req.user),
      products: enquiryProducts,
      source,
      message,
      totalEstimatedPrice,
      status: 'new',
    });

    const populatedEnquiry = await Enquiry.findById(enquiry._id)
      .populate('customer', 'name firstName lastName email phone address authProvider')
      .lean();

    res.status(201).json(populatedEnquiry);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to create enquiry: ' + err.message, 500));
  }
};

export const getEnquiries = async (req, res, next) => {
  try {
    const {
      status,
      source,
      customer,
      search,
      dateFrom,
      dateTo,
      limit = 100,
    } = req.query;
    const filter = buildEnquiryListFilters({
      status,
      source,
      customer,
      search,
      dateFrom,
      dateTo,
    });
    const enquiries = await fetchEnquiryList(filter, parseEnquiryListLimit(limit));

    res.json(enquiries);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to fetch enquiries: ' + err.message, 500));
  }
};

export const getCustomerEnquiries = async (req, res, next) => {
  try {
    const {
      status,
      source,
      search,
      dateFrom,
      dateTo,
      limit = 100,
    } = req.query;
    const { customerId } = req.params;
    const filter = buildEnquiryListFilters({
      status,
      source,
      customer: customerId,
      search,
      dateFrom,
      dateTo,
    });
    const enquiries = await fetchEnquiryList(filter, parseEnquiryListLimit(limit));

    res.json(enquiries);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to fetch customer enquiries: ' + err.message, 500));
  }
};

export const getEnquiryById = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(new AppError('Invalid enquiry id', 400));
    }

    const enquiry = await Enquiry.findById(req.params.id)
      .populate('customer', 'name firstName lastName email phone address authProvider')
      .lean();

    if (!enquiry) {
      return next(new AppError('Enquiry not found', 404));
    }

    res.json(enquiry);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to fetch enquiry: ' + err.message, 500));
  }
};

export const updateEnquiryStatus = async (req, res, next) => {
  try {
    const { status } = req.body;

    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(new AppError('Invalid enquiry id', 400));
    }

    if (!allowedStatuses.includes(status)) {
      return next(new AppError(`status must be one of: ${allowedStatuses.join(', ')}`, 400));
    }

    const enquiry = await Enquiry.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true, runValidators: true }
    ).populate('customer', 'name firstName lastName email phone address authProvider');

    if (!enquiry) {
      return next(new AppError('Enquiry not found', 404));
    }

    res.json(enquiry);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to update enquiry status: ' + err.message, 500));
  }
};

export const updateEnquiryNotes = async (req, res, next) => {
  try {
    const { notes = '' } = req.body;

    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(new AppError('Invalid enquiry id', 400));
    }

    const enquiry = await Enquiry.findByIdAndUpdate(
      req.params.id,
      { notes: String(notes).trim() },
      { new: true, runValidators: true }
    ).populate('customer', 'name firstName lastName email phone address authProvider');

    if (!enquiry) {
      return next(new AppError('Enquiry not found', 404));
    }

    res.json(enquiry);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to update enquiry notes: ' + err.message, 500));
  }
};

export const deleteEnquiry = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(new AppError('Invalid enquiry id', 400));
    }

    const enquiry = await Enquiry.findById(req.params.id);
    if (!enquiry) {
      return next(new AppError('Enquiry not found', 404));
    }

    await enquiry.deleteOne();

    res.json({ message: 'Enquiry deleted successfully', deletedEnquiryId: req.params.id });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to delete enquiry: ' + err.message, 500));
  }
};

export const getProductDemandStats = async (req, res, next) => {
  try {
    const {
      status,
      source,
      customer,
      dateFrom,
      dateTo,
      limit,
    } = req.query;
    const queryLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const matchFilter = addDateRangeFilter(
      buildEnquiryListFilters({ status, source, customer }),
      { dateFrom, dateTo }
    );
    const pipeline = [];

    if (Object.keys(matchFilter).length > 0) {
      pipeline.push({ $match: matchFilter });
    }

    pipeline.push(
      { $unwind: '$products' },
      {
        $group: {
          _id: '$products.product',
          productId: { $first: '$products.product' },
          productName: { $first: '$products.nameSnapshot' },
          category: { $first: '$products.categorySnapshot' },
          type: { $first: '$products.typeSnapshot' },
          brand: { $first: '$products.brandSnapshot' },
          totalEnquiries: { $sum: 1 },
          totalQuantityRequested: { $sum: '$products.quantity' },
          totalEstimatedValue: { $sum: '$products.lineTotal' },
          latestEnquiryDate: { $max: '$createdAt' },
          customerIds: { $addToSet: '$customer' },
        },
      },
      {
        $addFields: {
          uniqueCustomerCount: { $size: '$customerIds' },
        },
      },
      {
        $project: {
          customerIds: 0,
        },
      },
      { $sort: { totalEnquiries: -1, totalQuantityRequested: -1, latestEnquiryDate: -1 } },
      { $limit: queryLimit },
    );

    const stats = await Enquiry.aggregate(pipeline);

    res.json(stats);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to fetch product demand stats: ' + err.message, 500));
  }
};
