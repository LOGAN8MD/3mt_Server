import AppError from './AppError.js';

export const RENTAL_DAY_MS = 24 * 60 * 60 * 1000;

const PERIOD_DAYS = Object.freeze({
  day: 1,
  week: 7,
  month: 30,
});

const requireMoney = (value, field, { allowZero = false } = {}) => {
  const minimum = allowZero ? 0 : 1;

  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new AppError(`${field} must be a ${allowZero ? 'non-negative' : 'positive'} integer amount in paise`, 400);
  }

  return value;
};

const requireDate = (value, field) => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new AppError(`${field} must be a valid date`, 400);
  }

  return date;
};

const checkedMoneyTotal = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError(`${field} exceeds the supported integer-paise range`, 400);
  }

  return value;
};

const normalizeText = (value) => String(value || '').trim().toLowerCase();

export const deriveDailyRatePaise = (agreedRatePaise, billingPeriod) => {
  requireMoney(agreedRatePaise, 'agreedRatePaise');

  const periodDays = PERIOD_DAYS[billingPeriod];
  if (!periodDays) {
    throw new AppError('billingPeriod must be day, week, or month', 400);
  }

  return Math.ceil(agreedRatePaise / periodDays);
};

export const calculateUsageCharge = ({
  startAt,
  endAt,
  billingPeriod,
  agreedRatePaise,
}) => {
  const start = requireDate(startAt, 'startAt');
  const end = requireDate(endAt, 'endAt');

  if (end <= start) {
    throw new AppError('endAt must be after startAt', 400);
  }

  const periodDays = PERIOD_DAYS[billingPeriod];
  if (!periodDays) {
    throw new AppError('billingPeriod must be day, week, or month', 400);
  }

  requireMoney(agreedRatePaise, 'agreedRatePaise');

  const durationMs = end.getTime() - start.getTime();
  const periodMs = periodDays * RENTAL_DAY_MS;
  const fullPeriods = Math.floor(durationMs / periodMs);
  const remainderMs = durationMs % periodMs;
  const extraDays = Math.ceil(remainderMs / RENTAL_DAY_MS);
  const derivedDailyRatePaise = deriveDailyRatePaise(agreedRatePaise, billingPeriod);
  const chargePaise = checkedMoneyTotal(
    fullPeriods * agreedRatePaise + extraDays * derivedDailyRatePaise,
    'chargePaise'
  );

  return {
    startAt: start,
    endAt: end,
    durationMs,
    billingPeriod,
    agreedRatePaise,
    derivedDailyRatePaise,
    fullPeriods,
    extraDays,
    chargePaise,
  };
};

export const calculateRentalQuote = ({
  handoverAt,
  expectedReturnAt,
  billingPeriod,
  agreedRatePaise,
}) => {
  const usage = calculateUsageCharge({
    startAt: handoverAt,
    endAt: expectedReturnAt,
    billingPeriod,
    agreedRatePaise,
  });

  return {
    ...usage,
    handoverAt: usage.startAt,
    expectedReturnAt: usage.endAt,
    plannedRentalChargePaise: usage.chargePaise,
  };
};

export const calculateFinalRentalCharge = ({
  handoverAt,
  expectedReturnAt,
  actualReturnAt,
  billingPeriod,
  agreedRatePaise,
  dailyLateRatePaise,
}) => {
  const planned = calculateRentalQuote({
    handoverAt,
    expectedReturnAt,
    billingPeriod,
    agreedRatePaise,
  });
  const actualReturn = requireDate(actualReturnAt, 'actualReturnAt');

  if (actualReturn <= planned.handoverAt) {
    throw new AppError('actualReturnAt must be after handoverAt', 400);
  }

  const lateRate = dailyLateRatePaise ?? planned.derivedDailyRatePaise;
  requireMoney(lateRate, 'dailyLateRatePaise');
  const actualUsage = calculateUsageCharge({
    startAt: planned.handoverAt,
    endAt: actualReturn,
    billingPeriod,
    agreedRatePaise,
  });

  if (actualReturn <= planned.expectedReturnAt) {
    return {
      planned,
      actualUsage,
      actualReturnAt: actualReturn,
      dailyLateRatePaise: lateRate,
      lateDays: 0,
      lateChargePaise: 0,
      finalRentalChargePaise: actualUsage.chargePaise,
    };
  }

  const lateDays = Math.ceil(
    (actualReturn.getTime() - planned.expectedReturnAt.getTime()) / RENTAL_DAY_MS
  );
  const lateChargePaise = checkedMoneyTotal(lateDays * lateRate, 'lateChargePaise');

  return {
    planned,
    actualUsage,
    actualReturnAt: actualReturn,
    dailyLateRatePaise: lateRate,
    lateDays,
    lateChargePaise,
    finalRentalChargePaise: checkedMoneyTotal(
      planned.plannedRentalChargePaise + lateChargePaise,
      'finalRentalChargePaise'
    ),
  };
};

export const calculateOverdueEstimate = ({ currentAt = new Date(), ...rentalTerms }) =>
  calculateFinalRentalCharge({ ...rentalTerms, actualReturnAt: currentAt });

export const calculateRentalSettlement = ({
  finalRentalChargePaise,
  otherApprovedChargesPaise = 0,
  rentalPaymentsReceivedPaise = 0,
  securityDepositReceivedPaise = 0,
  depositAppliedPaise = 0,
}) => {
  requireMoney(finalRentalChargePaise, 'finalRentalChargePaise', { allowZero: true });
  requireMoney(otherApprovedChargesPaise, 'otherApprovedChargesPaise', { allowZero: true });
  requireMoney(rentalPaymentsReceivedPaise, 'rentalPaymentsReceivedPaise', { allowZero: true });
  requireMoney(securityDepositReceivedPaise, 'securityDepositReceivedPaise', { allowZero: true });
  requireMoney(depositAppliedPaise, 'depositAppliedPaise', { allowZero: true });

  const grossAmountDuePaise = checkedMoneyTotal(
    finalRentalChargePaise + otherApprovedChargesPaise,
    'grossAmountDuePaise'
  );
  const balanceBeforeDepositPaise = Math.max(
    0,
    grossAmountDuePaise - rentalPaymentsReceivedPaise
  );
  const rentalPaymentRefundPaise = Math.max(
    0,
    rentalPaymentsReceivedPaise - grossAmountDuePaise
  );

  if (depositAppliedPaise > securityDepositReceivedPaise) {
    throw new AppError('depositAppliedPaise cannot exceed the received security deposit', 400);
  }
  if (depositAppliedPaise > balanceBeforeDepositPaise) {
    throw new AppError('depositAppliedPaise cannot exceed the outstanding balance', 400);
  }

  return {
    grossAmountDuePaise,
    balanceBeforeDepositPaise,
    rentalPaymentRefundPaise,
    depositAppliedPaise,
    depositRefundPaise: securityDepositReceivedPaise - depositAppliedPaise,
    remainingBalancePaise: balanceBeforeDepositPaise - depositAppliedPaise,
  };
};

export const validateRentalMachineEligibility = (product) => {
  if (!product?._id) {
    throw new AppError('A valid machine is required', 400);
  }
  if (normalizeText(product.condition) !== 'used') {
    throw new AppError('Only second-hand machines can be assigned to a rental', 400);
  }
  if (!['rent', 'both'].includes(normalizeText(product.availabilityType))) {
    throw new AppError('This machine is not offered for rent', 409);
  }
  if (normalizeText(product.availabilityStatus) !== 'available') {
    throw new AppError('This machine is not currently available', 409);
  }
  if (product.stock != null && product.stock !== 1) {
    throw new AppError('Each second-hand Product must represent exactly one physical machine', 400);
  }

  return product;
};

export const validateRentalCustomerEligibility = (customer) => {
  if (!customer?._id) {
    throw new AppError('A valid customer is required', 400);
  }
  if (normalizeText(customer.role) !== 'customer') {
    throw new AppError('The selected account must have the customer role', 400);
  }
  if (!String(customer.name || '').trim()) {
    throw new AppError('The selected customer must have a name', 400);
  }
  if (!String(customer.email || '').trim()) {
    throw new AppError('The selected customer must have an email address', 400);
  }
  if (!String(customer.phone || '').trim()) {
    throw new AppError('The selected customer must have a phone number', 400);
  }

  return customer;
};
