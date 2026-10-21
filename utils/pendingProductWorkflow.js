import AppError from './AppError.js';
import { validateProductRules } from './productRules.js';

export const PENDING_PRODUCT_EDITABLE_FIELDS = Object.freeze([
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
]);

const parseNonNegativeNumber = (value, fieldName) => {
  if (value === undefined || value === null || value === '') return undefined;

  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new AppError(`${fieldName} must be a non-negative number`, 400);
  }

  return parsedValue;
};

export const pickPendingProductFields = (source = {}) => {
  const productData = {};

  for (const field of PENDING_PRODUCT_EDITABLE_FIELDS) {
    if (source[field] !== undefined) productData[field] = source[field];
  }

  return productData;
};

export const validatePendingProductData = (productData, requireCoreFields = false) => {
  const normalizedProductData = validateProductRules(productData);

  if (requireCoreFields && !normalizedProductData.name) {
    throw new AppError('Product name is required', 400);
  }

  if (normalizedProductData.stock !== undefined) {
    normalizedProductData.stock = parseNonNegativeNumber(normalizedProductData.stock, 'stock');
  }

  return normalizedProductData;
};

export const preparePendingProductSubmission = (body = {}) =>
  validatePendingProductData(
    {
      ...pickPendingProductFields(body),
      availabilityStatus: 'available',
    },
    true
  );

export const buildApprovedProductPayload = (pendingProduct) => {
  const source = typeof pendingProduct?.toObject === 'function'
    ? pendingProduct.toObject()
    : pendingProduct;
  const productData = validatePendingProductData(pickPendingProductFields(source), true);

  return {
    ...productData,
    images: (source?.images || []).map((image) => ({
      url: image.url,
      public_id: image.public_id,
    })),
  };
};
