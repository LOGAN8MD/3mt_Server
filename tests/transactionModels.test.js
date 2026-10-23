import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import MachineSale from '../models/MachineSale.js';
import Rental from '../models/Rental.js';

const ids = {
  admin: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
  machine: new mongoose.Types.ObjectId(),
};

const customerSnapshot = {
  name: 'Rahul Customer',
  email: 'rahul@example.com',
  phone: '+919876543210',
  address: 'Mumbai',
};

const machineSnapshot = {
  name: 'Second-Hand Bosch Drill 1',
  type: 'machine',
  category: 'DRILL',
  brand: 'BOSCH',
  model: 'BD-100',
  condition: 'used',
  availabilityType: 'both',
  imageUrl: 'https://example.com/drill.jpg',
};

const buildRental = (overrides = {}) =>
  new Rental({
    rentalCode: 'rnt-20261023-001',
    machine: ids.machine,
    customer: ids.customer,
    machineSnapshot,
    customerSnapshot,
    status: 'active',
    handoverAt: new Date('2026-10-23T04:30:00.000Z'),
    expectedReturnAt: new Date('2026-10-26T04:30:00.000Z'),
    billingPeriod: 'day',
    agreedRatePaise: 50000,
    plannedBillablePeriods: 3,
    derivedDailyRatePaise: 50000,
    plannedRentalChargePaise: 150000,
    dailyLateRatePaise: 50000,
    securityDepositReceivedPaise: 300000,
    rentalPaymentsReceivedPaise: 150000,
    createdBy: ids.admin,
    ...overrides,
  });

test('Rental validates one physical machine assignment and preserves snapshots', async () => {
  const rental = buildRental();

  await rental.validate();

  assert.equal(rental.rentalCode, 'RNT-20261023-001');
  assert.equal(rental.occupiesMachine, true);
  assert.equal(rental.machineSnapshot.name, 'Second-Hand Bosch Drill 1');
  assert.equal(rental.customerSnapshot.email, 'rahul@example.com');
  assert.equal(rental.currency, 'INR');
  assert.equal(rental.agreedRatePaise, 50000);
});

test('Rental releases its machine marker for returned and cancelled history', async () => {
  const returnedRental = buildRental({
    status: 'returned',
    actualReturnAt: new Date('2026-10-26T06:30:00.000Z'),
    returnRecordedAt: new Date('2026-10-26T06:45:00.000Z'),
    returnMachineStatus: 'available',
  });
  const cancelledRental = buildRental({
    status: 'cancelled',
    cancellationReason: 'Customer cancelled before handover',
    cancelledAt: new Date('2026-10-22T04:30:00.000Z'),
    cancelledBy: ids.admin,
  });

  await returnedRental.validate();
  await cancelledRental.validate();

  assert.equal(returnedRental.occupiesMachine, false);
  assert.equal(cancelledRental.occupiesMachine, false);
});

test('Rental rejects invalid lifecycle dates and fractional paise', async () => {
  const invalidDates = buildRental({
    expectedReturnAt: new Date('2026-10-23T04:00:00.000Z'),
  });
  const fractionalMoney = buildRental({ agreedRatePaise: 50000.5 });

  await assert.rejects(invalidDates.validate(), /expectedReturnAt must be after handoverAt/);
  await assert.rejects(fractionalMoney.validate(), /integer amount in paise/);
});

test('Rental requires actual and recorded return times when returned', async () => {
  const rental = buildRental({ status: 'returned' });

  await assert.rejects(rental.validate(), /actualReturnAt.*required|returnRecordedAt.*required/);
});

test('Rental requires complete cancellation details when cancelled', async () => {
  const rental = buildRental({ status: 'cancelled' });

  await assert.rejects(
    rental.validate(),
    /cancellationReason.*required|cancelledAt.*required|cancelledBy.*required/
  );
});

test('Rental schema declares a unique occupying-machine index', () => {
  const index = Rental.schema.indexes().find(([, options]) =>
    options.name === 'one_occupying_rental_per_machine'
  );

  assert.deepEqual(index?.[0], { machine: 1 });
  assert.equal(index?.[1].unique, true);
  assert.deepEqual(index?.[1].partialFilterExpression, { occupiesMachine: true });
});

test('MachineSale validates completed customer-linked sales and snapshots', async () => {
  const sale = new MachineSale({
    saleCode: 'sal-20261023-001',
    machine: ids.machine,
    customer: ids.customer,
    machineSnapshot: { ...machineSnapshot, availabilityType: 'sale' },
    customerSnapshot,
    status: 'completed',
    soldAt: new Date('2026-10-23T08:00:00.000Z'),
    agreedSalePricePaise: 2500000,
    paymentsReceivedPaise: 1000000,
    remainingBalancePaise: 1500000,
    createdBy: ids.admin,
  });

  await sale.validate();

  assert.equal(sale.saleCode, 'SAL-20261023-001');
  assert.equal(sale.isCompletedSale, true);
  assert.equal(sale.machineSnapshot.condition, 'used');
  assert.equal(sale.remainingBalancePaise, 1500000);
  assert.equal(sale.paymentsRefundedPaise, 0);
});

test('MachineSale requires a sale date only when completed', async () => {
  const completedSale = new MachineSale({
    saleCode: 'SAL-20261023-002',
    machine: ids.machine,
    customer: ids.customer,
    machineSnapshot,
    customerSnapshot,
    status: 'completed',
    agreedSalePricePaise: 2500000,
    createdBy: ids.admin,
  });
  const draftSale = new MachineSale({
    saleCode: 'SAL-20261023-003',
    machine: ids.machine,
    customer: ids.customer,
    machineSnapshot,
    customerSnapshot,
    status: 'draft',
    agreedSalePricePaise: 2500000,
    createdBy: ids.admin,
  });

  await assert.rejects(completedSale.validate(), /soldAt.*required/);
  await draftSale.validate();
  assert.equal(draftSale.isCompletedSale, false);
});

test('MachineSale rejects zero-price and incomplete cancellation records', async () => {
  const sale = new MachineSale({
    saleCode: 'SAL-20261023-004',
    machine: ids.machine,
    customer: ids.customer,
    machineSnapshot,
    customerSnapshot,
    status: 'cancelled',
    agreedSalePricePaise: 0,
    createdBy: ids.admin,
  });

  await assert.rejects(
    sale.validate(),
    /agreedSalePricePaise|cancellationReason.*required|cancelledAt.*required|cancelledBy.*required/
  );
});

test('MachineSale schema declares a unique completed-sale index', () => {
  const index = MachineSale.schema.indexes().find(([, options]) =>
    options.name === 'one_completed_sale_per_machine'
  );

  assert.deepEqual(index?.[0], { machine: 1 });
  assert.equal(index?.[1].unique, true);
  assert.deepEqual(index?.[1].partialFilterExpression, { isCompletedSale: true });
});
