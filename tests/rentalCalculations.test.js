import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  calculateFinalRentalCharge,
  calculateRentalQuote,
  calculateRentalSettlement,
  deriveDailyRatePaise,
  validateRentalCustomerEligibility,
  validateRentalMachineEligibility,
} from '../utils/rentalCalculations.js';

const at = (day, hour = 0, minute = 0) =>
  new Date(Date.UTC(2026, 9, day, hour, minute));

test('daily rental quote rounds a started day upward', () => {
  const quote = calculateRentalQuote({
    handoverAt: at(1),
    expectedReturnAt: at(4, 2),
    billingPeriod: 'day',
    agreedRatePaise: 50000,
  });

  assert.equal(quote.fullPeriods, 3);
  assert.equal(quote.extraDays, 1);
  assert.equal(quote.plannedRentalChargePaise, 200000);
});

test('early return charges actual started days and preserves planned quote', () => {
  const result = calculateFinalRentalCharge({
    handoverAt: at(1),
    expectedReturnAt: at(4),
    actualReturnAt: at(3),
    billingPeriod: 'day',
    agreedRatePaise: 50000,
  });

  assert.equal(result.planned.plannedRentalChargePaise, 150000);
  assert.equal(result.actualUsage.chargePaise, 100000);
  assert.equal(result.finalRentalChargePaise, 100000);
  assert.equal(result.lateDays, 0);
});

test('late returns have no grace period and round each started late day upward', () => {
  const base = {
    handoverAt: at(1),
    expectedReturnAt: at(4),
    billingPeriod: 'day',
    agreedRatePaise: 50000,
  };

  assert.equal(calculateFinalRentalCharge({ ...base, actualReturnAt: at(4, 2) }).lateDays, 1);
  assert.equal(calculateFinalRentalCharge({ ...base, actualReturnAt: at(4, 20) }).lateDays, 1);
  assert.equal(calculateFinalRentalCharge({ ...base, actualReturnAt: at(5) }).lateDays, 1);

  const twoLateDays = calculateFinalRentalCharge({
    ...base,
    actualReturnAt: at(5, 0, 1),
  });
  assert.equal(twoLateDays.lateDays, 2);
  assert.equal(twoLateDays.finalRentalChargePaise, 250000);
});

test('weekly rate uses full weeks plus derived-rate started days', () => {
  const result = calculateFinalRentalCharge({
    handoverAt: at(1),
    expectedReturnAt: at(8),
    actualReturnAt: at(8, 2),
    billingPeriod: 'week',
    agreedRatePaise: 300000,
  });

  assert.equal(deriveDailyRatePaise(300000, 'week'), 42858);
  assert.equal(result.planned.plannedRentalChargePaise, 300000);
  assert.equal(result.lateDays, 1);
  assert.equal(result.lateChargePaise, 42858);
  assert.equal(result.finalRentalChargePaise, 342858);
});

test('weekly extension charges each additional started day at the derived rate', () => {
  const quote = calculateRentalQuote({
    handoverAt: at(1),
    expectedReturnAt: at(10),
    billingPeriod: 'week',
    agreedRatePaise: 300000,
  });

  assert.equal(quote.fullPeriods, 1);
  assert.equal(quote.extraDays, 2);
  assert.equal(quote.plannedRentalChargePaise, 385716);
});

test('monthly rate uses fixed 30-day blocks and rate divided by 30', () => {
  const handoverAt = at(1);
  const expectedReturnAt = new Date(handoverAt.getTime() + 31 * 24 * 60 * 60 * 1000);
  const quote = calculateRentalQuote({
    handoverAt,
    expectedReturnAt,
    billingPeriod: 'month',
    agreedRatePaise: 1000000,
  });

  assert.equal(deriveDailyRatePaise(1000000, 'month'), 33334);
  assert.equal(quote.fullPeriods, 1);
  assert.equal(quote.extraDays, 1);
  assert.equal(quote.plannedRentalChargePaise, 1033334);
});

test('settlement supports separate payment, deposit deduction, and mixed payment', () => {
  const paidSeparately = calculateRentalSettlement({
    finalRentalChargePaise: 250000,
    rentalPaymentsReceivedPaise: 250000,
    securityDepositReceivedPaise: 200000,
  });
  assert.equal(paidSeparately.depositRefundPaise, 200000);
  assert.equal(paidSeparately.remainingBalancePaise, 0);

  const deductedFromDeposit = calculateRentalSettlement({
    finalRentalChargePaise: 250000,
    rentalPaymentsReceivedPaise: 100000,
    securityDepositReceivedPaise: 200000,
    depositAppliedPaise: 150000,
  });
  assert.equal(deductedFromDeposit.depositRefundPaise, 50000);
  assert.equal(deductedFromDeposit.remainingBalancePaise, 0);

  const mixed = calculateRentalSettlement({
    finalRentalChargePaise: 250000,
    rentalPaymentsReceivedPaise: 120000,
    securityDepositReceivedPaise: 100000,
    depositAppliedPaise: 100000,
  });
  assert.equal(mixed.remainingBalancePaise, 30000);
});

test('early-return overpayment is tracked separately from the deposit refund', () => {
  const settlement = calculateRentalSettlement({
    finalRentalChargePaise: 100000,
    rentalPaymentsReceivedPaise: 150000,
    securityDepositReceivedPaise: 200000,
  });

  assert.equal(settlement.rentalPaymentRefundPaise, 50000);
  assert.equal(settlement.depositRefundPaise, 200000);
  assert.equal(settlement.remainingBalancePaise, 0);
});

test('settlement rejects a deposit deduction larger than deposit or balance', () => {
  assert.throws(
    () => calculateRentalSettlement({
      finalRentalChargePaise: 100000,
      securityDepositReceivedPaise: 50000,
      depositAppliedPaise: 50001,
    }),
    /cannot exceed the received security deposit/
  );

  assert.throws(
    () => calculateRentalSettlement({
      finalRentalChargePaise: 100000,
      rentalPaymentsReceivedPaise: 90000,
      securityDepositReceivedPaise: 50000,
      depositAppliedPaise: 10001,
    }),
    /cannot exceed the outstanding balance/
  );
});

test('rental eligibility accepts one available second-hand rental machine and customer', () => {
  const machine = {
    _id: new mongoose.Types.ObjectId(),
    condition: 'used',
    availabilityType: 'both',
    availabilityStatus: 'available',
    stock: 1,
  };
  const customer = {
    _id: new mongoose.Types.ObjectId(),
    role: 'customer',
    name: 'Test Customer',
    email: 'customer@example.com',
    phone: '+919876543210',
  };

  assert.equal(validateRentalMachineEligibility(machine), machine);
  assert.equal(validateRentalCustomerEligibility(customer), customer);
});

test('rental eligibility rejects unavailable, multi-unit, and incomplete records', () => {
  const id = new mongoose.Types.ObjectId();

  assert.throws(
    () => validateRentalMachineEligibility({
      _id: id,
      condition: 'used',
      availabilityType: 'rent',
      availabilityStatus: 'on_rent',
      stock: 1,
    }),
    /not currently available/
  );
  assert.throws(
    () => validateRentalMachineEligibility({
      _id: id,
      condition: 'used',
      availabilityType: 'rent',
      availabilityStatus: 'available',
      stock: 3,
    }),
    /exactly one physical machine/
  );
  assert.throws(
    () => validateRentalCustomerEligibility({
      _id: id,
      role: 'customer',
      name: 'Missing Contacts',
    }),
    /email address/
  );
});

test('rental calculations reject invalid dates, periods, and fractional paise', () => {
  assert.throws(
    () => calculateRentalQuote({
      handoverAt: at(2),
      expectedReturnAt: at(1),
      billingPeriod: 'day',
      agreedRatePaise: 50000,
    }),
    /must be after/
  );
  assert.throws(() => deriveDailyRatePaise(50000, 'year'), /day, week, or month/);
  assert.throws(() => deriveDailyRatePaise(50000.5, 'day'), /integer amount in paise/);
});
