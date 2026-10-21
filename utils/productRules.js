import AppError from './AppError.js';
import { normalizeProductFields, normalizeTextValue } from './normalizeProductFields.js';

export const PRODUCT_CONDITIONS = Object.freeze(['new', 'used']);
export const PRODUCT_AVAILABILITY_TYPES = Object.freeze(['sale', 'rent', 'both']);
export const PRODUCT_AVAILABILITY_STATUSES = Object.freeze([
  'available',
  'on_rent',
  'unavailable',
  'sold',
]);
export const PRODUCT_RENT_PERIODS = Object.freeze(['day', 'week', 'month']);

export const DEFAULT_PRODUCT_RULES = Object.freeze({
  condition: 'new',
  availabilityType: 'sale',
  availabilityStatus: 'available',
});

const enumFields = {
  condition: PRODUCT_CONDITIONS,
  availabilityType: PRODUCT_AVAILABILITY_TYPES,
  availabilityStatus: PRODUCT_AVAILABILITY_STATUSES,
  rentPeriod: PRODUCT_RENT_PERIODS,
};

const normalizeEnumValue = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const parseOptionalNonNegativeNumber = (value, fieldName) => {
  if (value === undefined || value === null || value === '') return undefined;

  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new AppError(`${fieldName} must be a non-negative number`, 400);
  }

  return parsedValue;
};

const requirePositiveNumber = (value, fieldName) => {
  if (value === undefined || value === null || value === '' || Number(value) <= 0) {
    throw new AppError(`${fieldName} must be greater than zero`, 400);
  }
};

const validateEnumField = (fieldName, value) => {
  if (value === undefined || value === null || value === '') return;

  const allowedValues = enumFields[fieldName];
  if (!allowedValues.includes(value)) {
    throw new AppError(`${fieldName} must be one of: ${allowedValues.join(', ')}`, 400);
  }
};

export const normalizeProductRuleFields = (productData, { applyDefaults = true } = {}) => {
  const normalizedData = normalizeProductFields(productData);

  for (const fieldName of Object.keys(enumFields)) {
    if (normalizedData[fieldName] !== undefined) {
      const normalizedValue = normalizeEnumValue(normalizedData[fieldName]);
      if (normalizedValue === '') {
        delete normalizedData[fieldName];
      } else {
        normalizedData[fieldName] = normalizedValue;
      }
    }
  }

  if (normalizedData.availabilityNote !== undefined) {
    normalizedData.availabilityNote = normalizeTextValue(normalizedData.availabilityNote);
  }

  if (typeof normalizedData.availableFrom === 'string') {
    normalizedData.availableFrom = normalizedData.availableFrom.trim() || null;
  }

  for (const fieldName of ['price', 'rentalPrice', 'securityDeposit']) {
    const parsedValue = parseOptionalNonNegativeNumber(normalizedData[fieldName], fieldName);
    if (parsedValue === undefined) {
      delete normalizedData[fieldName];
    } else {
      normalizedData[fieldName] = parsedValue;
    }
  }

  return applyDefaults
    ? { ...DEFAULT_PRODUCT_RULES, ...normalizedData }
    : normalizedData;
};

export const validateProductRules = (productData, options = {}) => {
  const normalizedData = normalizeProductRuleFields(productData, options);

  for (const [fieldName, allowedValues] of Object.entries(enumFields)) {
    if (fieldName === 'rentPeriod' && normalizedData[fieldName] === undefined) continue;
    if (!allowedValues.includes(normalizedData[fieldName])) {
      validateEnumField(fieldName, normalizedData[fieldName]);
    }
  }

  const includesSale = ['sale', 'both'].includes(normalizedData.availabilityType);
  const includesRent = ['rent', 'both'].includes(normalizedData.availabilityType);

  if (includesSale) {
    requirePositiveNumber(normalizedData.price, 'price');
  }

  if (includesRent) {
    requirePositiveNumber(normalizedData.rentalPrice, 'rentalPrice');

    if (!normalizedData.rentPeriod) {
      throw new AppError('rentPeriod is required for rent listings', 400);
    }
  }

  if (normalizedData.availabilityStatus === 'on_rent' && !includesRent) {
    throw new AppError('Only rent or both listings can have on_rent status', 400);
  }

  if (normalizedData.availabilityStatus === 'sold' && !includesSale) {
    throw new AppError('Only sale or both listings can have sold status', 400);
  }

  if (
    normalizedData.availableFrom &&
    Number.isNaN(new Date(normalizedData.availableFrom).getTime())
  ) {
    throw new AppError('availableFrom must be a valid date', 400);
  }

  return normalizedData;
};
