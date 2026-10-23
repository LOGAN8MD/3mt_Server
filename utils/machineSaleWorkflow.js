import mongoose from 'mongoose';
import AppError from './AppError.js';
import { buildInitialPayment, parseRentalPagination } from './rentalWorkflow.js';

const EDITABLE_SALE_FIELDS = new Set([
  'machineId',
  'customerId',
  'soldAt',
  'agreedSalePricePaise',
  'initialPayment',
  'notes',
  'status',
]);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalizeText = (value) => String(value || '').trim().toLowerCase();

const requireObjectId = (value, field) => {
  if (!mongoose.isValidObjectId(value)) {
    throw new AppError(`${field} must be a valid id`, 400);
  }
  return value.toString();
};

const requirePositiveMoney = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppError(`${field} must be a positive integer amount in paise`, 400);
  }
  return value;
};

const parseOptionalDate = (value, field) => {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError(`${field} must be a valid date`, 400);
  return date;
};

export const assertOnlyMachineSaleFields = (payload, { allowStatus = true } = {}) => {
  const unknownFields = Object.keys(payload || {}).filter(
    (field) => !EDITABLE_SALE_FIELDS.has(field) || (!allowStatus && field === 'status')
  );
  if (unknownFields.length) {
    throw new AppError(`Unsupported machine sale fields: ${unknownFields.join(', ')}`, 400);
  }
};

export const validateMachineSaleEligibility = (product) => {
  if (!product?._id) throw new AppError('A valid machine is required', 400);
  if (normalizeText(product.condition) !== 'used') {
    throw new AppError('Only second-hand machines can be sold through this workflow', 400);
  }
  if (!['sale', 'both'].includes(normalizeText(product.availabilityType))) {
    throw new AppError('This machine is not offered for sale', 409);
  }
  if (normalizeText(product.availabilityStatus) !== 'available') {
    throw new AppError('This machine is not currently available for sale', 409);
  }
  if (product.stock != null && product.stock !== 1) {
    throw new AppError('Each second-hand Product must represent exactly one physical machine', 400);
  }
  return product;
};

export const prepareMachineSaleTerms = (payload, adminId) => {
  const machineId = requireObjectId(payload.machineId, 'machineId');
  const customerId = requireObjectId(payload.customerId, 'customerId');
  const agreedSalePricePaise = requirePositiveMoney(
    payload.agreedSalePricePaise,
    'agreedSalePricePaise'
  );
  const payment = buildInitialPayment(payload.initialPayment, adminId);

  if (payment.rentalPaymentsReceivedPaise > agreedSalePricePaise) {
    throw new AppError('Initial payment cannot exceed the agreed sale price', 400);
  }

  return {
    machineId,
    customerId,
    soldAt: parseOptionalDate(payload.soldAt, 'soldAt'),
    agreedSalePricePaise,
    paymentsReceivedPaise: payment.rentalPaymentsReceivedPaise,
    remainingBalancePaise: agreedSalePricePaise - payment.rentalPaymentsReceivedPaise,
    payments: payment.payments,
    notes: String(payload.notes || '').trim(),
  };
};

export const buildMachineSaleListFilter = ({ status, customer, machine, search } = {}) => {
  const filter = {};

  if (status) {
    const statuses = String(status).split(',').map((value) => value.trim()).filter(Boolean);
    const allowedStatuses = ['draft', 'completed', 'cancelled'];
    if (!statuses.length || statuses.some((value) => !allowedStatuses.includes(value))) {
      throw new AppError(`status must contain only: ${allowedStatuses.join(', ')}`, 400);
    }
    filter.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
  }

  if (customer) filter.customer = requireObjectId(customer, 'customer');
  if (machine) filter.machine = requireObjectId(machine, 'machine');

  const keyword = String(search || '').trim();
  if (keyword) {
    const regex = new RegExp(escapeRegex(keyword), 'i');
    filter.$or = [
      { saleCode: regex },
      { 'customerSnapshot.name': regex },
      { 'customerSnapshot.email': regex },
      { 'customerSnapshot.phone': regex },
      { 'machineSnapshot.name': regex },
      { 'machineSnapshot.brand': regex },
      { 'machineSnapshot.model': regex },
    ];
  }

  return filter;
};

export const parseMachineSalePagination = (query) => parseRentalPagination(query);
