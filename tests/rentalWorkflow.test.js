import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  assertOnlyRentalFields,
  buildCustomerSnapshot,
  buildInitialPayment,
  buildMachineSnapshot,
  buildRentalListFilter,
  buildRentalPayment,
  parseRentalPagination,
  prepareRentalReturn,
  prepareRentalTerms,
} from '../utils/rentalWorkflow.js';

const ids = {
  admin: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
  machine: new mongoose.Types.ObjectId(),
};

const validInput = {
  machineId: ids.machine.toString(),
  customerId: ids.customer.toString(),
  handoverAt: '2026-11-10T10:00:00.000Z',
  expectedReturnAt: '2026-11-13T10:00:00.000Z',
  billingPeriod: 'day',
  agreedRatePaise: 50000,
  securityDepositReceivedPaise: 200000,
  notes: 'Customer will collect the machine from the shop.',
};

test('rental workflow prepares calculated draft terms and a derived late rate', () => {
  const terms = prepareRentalTerms(validInput, ids.admin);

  assert.equal(terms.machineId, ids.machine.toString());
  assert.equal(terms.customerId, ids.customer.toString());
  assert.equal(terms.plannedBillablePeriods, 3);
  assert.equal(terms.plannedExtraDays, 0);
  assert.equal(terms.plannedRentalChargePaise, 150000);
  assert.equal(terms.derivedDailyRatePaise, 50000);
  assert.equal(terms.dailyLateRatePaise, 50000);
  assert.equal(terms.securityDepositReceivedPaise, 200000);
  assert.deepEqual(terms.payments, []);
});

test('rental workflow preserves a valid initial payment as a ledger entry', () => {
  const terms = prepareRentalTerms({
    ...validInput,
    initialPayment: {
      amountPaise: 100000,
      method: 'upi',
      paidAt: '2026-11-09T10:00:00.000Z',
      reference: 'UPI-123',
      note: 'Advance payment',
    },
  }, ids.admin);

  assert.equal(terms.rentalPaymentsReceivedPaise, 100000);
  assert.equal(terms.payments.length, 1);
  assert.equal(terms.payments[0].method, 'upi');
  assert.equal(terms.payments[0].recordedBy, ids.admin);
});

test('zero initial payment creates no misleading payment history', () => {
  const payment = buildInitialPayment({ amountPaise: 0 }, ids.admin);

  assert.equal(payment.rentalPaymentsReceivedPaise, 0);
  assert.deepEqual(payment.payments, []);
});

test('invalid ids, money and payment methods are rejected before persistence', () => {
  assert.throws(
    () => prepareRentalTerms({ ...validInput, machineId: 'invalid' }, ids.admin),
    /machineId must be a valid id/
  );
  assert.throws(
    () => prepareRentalTerms({ ...validInput, securityDepositReceivedPaise: 10.5 }, ids.admin),
    /integer amount in paise/
  );
  assert.throws(
    () => prepareRentalTerms({
      ...validInput,
      initialPayment: { amountPaise: 1000, method: 'cheque' },
    }, ids.admin),
    /must be one of/
  );
});

test('rental request field allowlist blocks lifecycle and calculated-field injection', () => {
  assert.doesNotThrow(() => assertOnlyRentalFields(validInput));
  assert.throws(
    () => assertOnlyRentalFields({ ...validInput, finalRentalChargePaise: 1 }),
    /Unsupported rental fields/
  );
  assert.throws(
    () => assertOnlyRentalFields({ status: 'active' }, { allowStatus: false }),
    /Unsupported rental fields/
  );
});

test('customer and machine snapshots copy stable transaction details', () => {
  const customer = buildCustomerSnapshot({
    name: ' Rahul Customer ',
    firstName: 'Rahul',
    email: 'RAHUL@EXAMPLE.COM ',
    phone: '+919876543210',
  });
  const machine = buildMachineSnapshot({
    name: ' Bosch Drill 1 ',
    type: 'Machine',
    category: 'DRILL',
    brand: 'BOSCH',
    model: 'BD-1',
    condition: 'used',
    availabilityType: 'both',
    images: [{ url: 'https://example.com/drill.jpg' }],
  });

  assert.equal(customer.name, 'Rahul Customer');
  assert.equal(customer.email, 'rahul@example.com');
  assert.equal(machine.name, 'Bosch Drill 1');
  assert.equal(machine.imageUrl, 'https://example.com/drill.jpg');
});

test('rental list filters support multiple statuses, ids and escaped search', () => {
  const filter = buildRentalListFilter({
    status: 'draft,active',
    customer: ids.customer.toString(),
    machine: ids.machine.toString(),
    search: 'Bosch (1)',
  });

  assert.deepEqual(filter.status, { $in: ['draft', 'active'] });
  assert.equal(filter.customer, ids.customer.toString());
  assert.equal(filter.machine, ids.machine.toString());
  assert.equal(filter.$or.length, 7);
  assert.equal(filter.$or[0].rentalCode.test('Bosch (1)'), true);
  assert.equal(filter.$or[0].rentalCode.test('Bosch 1'), false);
});

test('rental list validation rejects invalid statuses and pagination', () => {
  assert.throws(() => buildRentalListFilter({ status: 'unknown' }), /status must contain only/);
  assert.deepEqual(parseRentalPagination({ page: '2', limit: '20' }), {
    page: 2,
    limit: 20,
    skip: 20,
  });
  assert.throws(() => parseRentalPagination({ page: 0 }), /positive integer/);
  assert.throws(() => parseRentalPagination({ limit: 101 }), /between 1 and 100/);
});

test('additional rental payment requires a positive amount and supported method', () => {
  const payment = buildRentalPayment({ amountPaise: 25000, method: 'cash' }, ids.admin);

  assert.equal(payment.amountPaise, 25000);
  assert.equal(payment.method, 'cash');
  assert.equal(payment.recordedBy, ids.admin);
  assert.throws(
    () => buildRentalPayment({ amountPaise: 0, method: 'cash' }, ids.admin),
    /positive integer amount/
  );
});

test('return preparation bills an early return and keeps entry time separate', () => {
  const now = new Date('2026-11-14T19:00:00.000Z');
  const result = prepareRentalReturn({
    handoverAt: new Date('2026-11-10T10:00:00.000Z'),
    expectedReturnAt: new Date('2026-11-13T10:00:00.000Z'),
    billingPeriod: 'day',
    agreedRatePaise: 50000,
    dailyLateRatePaise: 50000,
    rentalPaymentsReceivedPaise: 150000,
    securityDepositReceivedPaise: 200000,
  }, {
    actualReturnAt: '2026-11-12T10:00:00.000Z',
    settlementNote: 'Returned after two days; charge adjusted to actual usage.',
  }, ids.admin, { now });

  assert.equal(result.actualReturnAt.toISOString(), '2026-11-12T10:00:00.000Z');
  assert.equal(result.returnRecordedAt, now);
  assert.equal(result.charge.finalRentalChargePaise, 100000);
  assert.equal(result.settlement.rentalPaymentRefundPaise, 50000);
  assert.equal(result.settlement.depositRefundPaise, 200000);
});

test('return preparation calculates no-grace late charge and mixed settlement', () => {
  const result = prepareRentalReturn({
    handoverAt: new Date('2026-11-10T10:00:00.000Z'),
    expectedReturnAt: new Date('2026-11-13T10:00:00.000Z'),
    billingPeriod: 'day',
    agreedRatePaise: 50000,
    dailyLateRatePaise: 50000,
    rentalPaymentsReceivedPaise: 100000,
    securityDepositReceivedPaise: 200000,
  }, {
    actualReturnAt: '2026-11-13T12:00:00.000Z',
    depositAppliedPaise: 100000,
    returnNote: 'Machine received in working condition.',
  }, ids.admin, { now: new Date('2026-11-13T19:00:00.000Z') });

  assert.equal(result.charge.lateDays, 1);
  assert.equal(result.charge.lateChargePaise, 50000);
  assert.equal(result.charge.finalRentalChargePaise, 200000);
  assert.equal(result.settlement.depositAppliedPaise, 100000);
  assert.equal(result.settlement.depositRefundPaise, 100000);
  assert.equal(result.settlement.remainingBalancePaise, 0);
});

test('return preparation rejects future times, unknown fields, and excess final payment', () => {
  const rental = {
    handoverAt: new Date('2026-11-10T10:00:00.000Z'),
    expectedReturnAt: new Date('2026-11-13T10:00:00.000Z'),
    billingPeriod: 'day',
    agreedRatePaise: 50000,
    dailyLateRatePaise: 50000,
    rentalPaymentsReceivedPaise: 150000,
    securityDepositReceivedPaise: 200000,
  };
  const now = new Date('2026-11-13T19:00:00.000Z');

  assert.throws(
    () => prepareRentalReturn(rental, {
      actualReturnAt: '2026-11-14T10:00:00.000Z',
    }, ids.admin, { now }),
    /cannot be in the future/
  );
  assert.throws(
    () => prepareRentalReturn(rental, {
      actualReturnAt: '2026-11-13T10:00:00.000Z',
      machineStatus: 'unavailable',
    }, ids.admin, { now }),
    /Unsupported return fields/
  );
  assert.throws(
    () => prepareRentalReturn(rental, {
      actualReturnAt: '2026-11-13T10:00:00.000Z',
      payment: { amountPaise: 1, method: 'cash' },
    }, ids.admin, { now }),
    /cannot exceed the current unpaid charge/
  );
});
