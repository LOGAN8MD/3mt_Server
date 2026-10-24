import mongoose from 'mongoose';
import AppError from './AppError.js';
import {
  calculateFinalRentalCharge,
  calculateRentalSettlement,
  calculateRentalQuote,
  deriveDailyRatePaise,
} from './rentalCalculations.js';

export const RENTAL_PAYMENT_METHODS = Object.freeze([
  'cash',
  'upi',
  'bank_transfer',
  'card',
  'other',
]);

const EDITABLE_RENTAL_FIELDS = new Set([
  'machineId',
  'customerId',
  'handoverAt',
  'expectedReturnAt',
  'billingPeriod',
  'agreedRatePaise',
  'dailyLateRatePaise',
  'securityDepositReceivedPaise',
  'initialPayment',
  'notes',
  'reminderSettings',
  'status',
]);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const requireObjectId = (value, field) => {
  if (!mongoose.isValidObjectId(value)) {
    throw new AppError(`${field} must be a valid id`, 400);
  }

  return value.toString();
};

const parseNonNegativeMoney = (value, field, defaultValue = 0) => {
  const parsed = value ?? defaultValue;

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AppError(`${field} must be a non-negative integer amount in paise`, 400);
  }

  return parsed;
};

const parseOptionalPositiveMoney = (value, field) => {
  if (value === undefined || value === null || value === '') return undefined;

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppError(`${field} must be a positive integer amount in paise`, 400);
  }

  return value;
};

const parseDate = (value, field) => {
  const date = new Date(value);

  if (value === undefined || value === null || value === '' || Number.isNaN(date.getTime())) {
    throw new AppError(`${field} must be a valid date`, 400);
  }

  return date;
};

export const assertOnlyRentalFields = (payload, { allowStatus = true } = {}) => {
  const unknownFields = Object.keys(payload || {}).filter(
    (field) => !EDITABLE_RENTAL_FIELDS.has(field) || (!allowStatus && field === 'status')
  );

  if (unknownFields.length > 0) {
    throw new AppError(`Unsupported rental fields: ${unknownFields.join(', ')}`, 400);
  }
};

export const buildCustomerSnapshot = (customer) => ({
  name: String(customer.name || '').trim(),
  firstName: String(customer.firstName || '').trim(),
  lastName: String(customer.lastName || '').trim(),
  email: String(customer.email || '').trim().toLowerCase(),
  phone: String(customer.phone || '').trim(),
  address: String(customer.address || '').trim(),
});

export const buildMachineSnapshot = (machine) => ({
  name: String(machine.name || '').trim(),
  type: String(machine.type || '').trim(),
  category: String(machine.category || '').trim(),
  subCategory: String(machine.subCategory || '').trim(),
  brand: String(machine.brand || '').trim(),
  model: String(machine.model || '').trim(),
  condition: machine.condition,
  availabilityType: machine.availabilityType,
  imageUrl: machine.images?.[0]?.url || '',
});

export const buildInitialPayment = (initialPayment, adminId) => {
  if (!initialPayment || initialPayment.amountPaise === undefined) {
    return { payments: [], rentalPaymentsReceivedPaise: 0 };
  }

  const amountPaise = parseNonNegativeMoney(
    initialPayment.amountPaise,
    'initialPayment.amountPaise'
  );
  if (amountPaise === 0) {
    return { payments: [], rentalPaymentsReceivedPaise: 0 };
  }
  if (!RENTAL_PAYMENT_METHODS.includes(initialPayment.method)) {
    throw new AppError(
      `initialPayment.method must be one of: ${RENTAL_PAYMENT_METHODS.join(', ')}`,
      400
    );
  }

  const paidAt = initialPayment.paidAt
    ? parseDate(initialPayment.paidAt, 'initialPayment.paidAt')
    : new Date();

  return {
    rentalPaymentsReceivedPaise: amountPaise,
    payments: [{
      amountPaise,
      method: initialPayment.method,
      paidAt,
      reference: String(initialPayment.reference || '').trim(),
      note: String(initialPayment.note || '').trim(),
      recordedBy: adminId,
    }],
  };
};

export const buildRentalPayment = (payment, adminId, field = 'payment') => {
  if (!payment || typeof payment !== 'object') {
    throw new AppError(`${field} is required`, 400);
  }

  const amountPaise = parseOptionalPositiveMoney(payment.amountPaise, `${field}.amountPaise`);
  if (amountPaise === undefined) {
    throw new AppError(`${field}.amountPaise is required`, 400);
  }
  if (!RENTAL_PAYMENT_METHODS.includes(payment.method)) {
    throw new AppError(
      `${field}.method must be one of: ${RENTAL_PAYMENT_METHODS.join(', ')}`,
      400
    );
  }

  return {
    amountPaise,
    method: payment.method,
    paidAt: payment.paidAt ? parseDate(payment.paidAt, `${field}.paidAt`) : new Date(),
    reference: String(payment.reference || '').trim(),
    note: String(payment.note || '').trim(),
    recordedBy: adminId,
  };
};

export const parseReturnAt = (value, { now = new Date() } = {}) => {
  const actualReturnAt = parseDate(value, 'actualReturnAt');

  if (actualReturnAt > now) {
    throw new AppError('actualReturnAt cannot be in the future', 400);
  }

  return actualReturnAt;
};

export const parseOptionalMoney = (value, field, defaultValue = 0) =>
  parseNonNegativeMoney(value, field, defaultValue);

const allowedReturnFields = new Set([
  'actualReturnAt',
  'otherApprovedChargesPaise',
  'depositAppliedPaise',
  'payment',
  'settlementNote',
  'returnNote',
]);

export const prepareRentalReturn = (
  rental,
  body,
  adminId,
  { now = new Date() } = {}
) => {
  const unknownFields = Object.keys(body || {}).filter((field) => !allowedReturnFields.has(field));
  if (unknownFields.length) {
    throw new AppError(`Unsupported return fields: ${unknownFields.join(', ')}`, 400);
  }

  const actualReturnAt = parseReturnAt(body.actualReturnAt, { now });
  const charge = calculateFinalRentalCharge({
    handoverAt: rental.handoverAt,
    expectedReturnAt: rental.expectedReturnAt,
    billingPeriod: rental.billingPeriod,
    agreedRatePaise: rental.agreedRatePaise,
    dailyLateRatePaise: rental.dailyLateRatePaise,
    actualReturnAt,
  });
  const otherApprovedChargesPaise = parseOptionalMoney(
    body.otherApprovedChargesPaise,
    'otherApprovedChargesPaise'
  );
  const payment = body.payment ? buildRentalPayment(body.payment, adminId, 'payment') : null;
  const existingPaymentsPaise = rental.rentalPaymentsReceivedPaise;
  const grossBeforePaymentPaise = charge.finalRentalChargePaise + otherApprovedChargesPaise;

  if (payment && payment.amountPaise > Math.max(0, grossBeforePaymentPaise - existingPaymentsPaise)) {
    throw new AppError('Return payment cannot exceed the current unpaid charge', 400);
  }

  const rentalPaymentsReceivedPaise = existingPaymentsPaise + (payment?.amountPaise || 0);
  const settlement = calculateRentalSettlement({
    finalRentalChargePaise: charge.finalRentalChargePaise,
    otherApprovedChargesPaise,
    rentalPaymentsReceivedPaise,
    securityDepositReceivedPaise: rental.securityDepositReceivedPaise,
    depositAppliedPaise: parseOptionalMoney(body.depositAppliedPaise, 'depositAppliedPaise'),
  });

  return {
    actualReturnAt,
    returnRecordedAt: now,
    charge,
    settlement,
    payment,
    rentalPaymentsReceivedPaise,
    otherApprovedChargesPaise,
    settlementNote: String(body.settlementNote || '').trim(),
    returnNote: String(body.returnNote || '').trim(),
  };
};

export const prepareRentalTerms = (payload, adminId) => {
  const machineId = requireObjectId(payload.machineId, 'machineId');
  const customerId = requireObjectId(payload.customerId, 'customerId');
  const handoverAt = parseDate(payload.handoverAt, 'handoverAt');
  const expectedReturnAt = parseDate(payload.expectedReturnAt, 'expectedReturnAt');
  const agreedRatePaise = parseOptionalPositiveMoney(
    payload.agreedRatePaise,
    'agreedRatePaise'
  );
  const quote = calculateRentalQuote({
    handoverAt,
    expectedReturnAt,
    billingPeriod: payload.billingPeriod,
    agreedRatePaise,
  });
  const dailyLateRatePaise = parseOptionalPositiveMoney(
    payload.dailyLateRatePaise,
    'dailyLateRatePaise'
  ) ?? deriveDailyRatePaise(agreedRatePaise, payload.billingPeriod);
  const payment = buildInitialPayment(payload.initialPayment, adminId);

  return {
    machineId,
    customerId,
    handoverAt,
    expectedReturnAt,
    billingPeriod: payload.billingPeriod,
    agreedRatePaise,
    plannedBillablePeriods: quote.fullPeriods,
    plannedExtraDays: quote.extraDays,
    derivedDailyRatePaise: quote.derivedDailyRatePaise,
    plannedRentalChargePaise: quote.plannedRentalChargePaise,
    dailyLateRatePaise,
    securityDepositReceivedPaise: parseNonNegativeMoney(
      payload.securityDepositReceivedPaise,
      'securityDepositReceivedPaise'
    ),
    notes: String(payload.notes || '').trim(),
    ...payment,
  };
};

export const buildRentalListFilter = ({ status, customer, machine, search } = {}) => {
  const filter = {};

  if (status) {
    const statuses = String(status).split(',').map((value) => value.trim()).filter(Boolean);
    const allowedStatuses = ['draft', 'active', 'overdue', 'returned', 'cancelled'];
    const invalidStatuses = statuses.filter((value) => !allowedStatuses.includes(value));
    if (invalidStatuses.length || statuses.length === 0) {
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
      { rentalCode: regex },
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

export const parseRentalPagination = ({ page = 1, limit = 25 } = {}) => {
  const parsedPage = Number(page);
  const parsedLimit = Number(limit);

  if (!Number.isInteger(parsedPage) || parsedPage < 1) {
    throw new AppError('page must be a positive integer', 400);
  }
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    throw new AppError('limit must be an integer between 1 and 100', 400);
  }

  return { page: parsedPage, limit: parsedLimit, skip: (parsedPage - 1) * parsedLimit };
};
