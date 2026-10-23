import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  assertOnlyMachineSaleFields,
  buildMachineSaleListFilter,
  parseMachineSalePagination,
  prepareMachineSaleTerms,
  validateMachineSaleEligibility,
} from '../utils/machineSaleWorkflow.js';

const ids = {
  admin: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
  machine: new mongoose.Types.ObjectId(),
};

const validInput = {
  machineId: ids.machine.toString(),
  customerId: ids.customer.toString(),
  agreedSalePricePaise: 2500000,
  notes: 'Customer will complete the remaining payment next month.',
};

test('machine sale terms support a draft without payment', () => {
  const terms = prepareMachineSaleTerms(validInput, ids.admin);

  assert.equal(terms.agreedSalePricePaise, 2500000);
  assert.equal(terms.paymentsReceivedPaise, 0);
  assert.equal(terms.remainingBalancePaise, 2500000);
  assert.deepEqual(terms.payments, []);
});

test('machine sale terms preserve a partial initial payment and remaining balance', () => {
  const terms = prepareMachineSaleTerms({
    ...validInput,
    initialPayment: {
      amountPaise: 1000000,
      method: 'bank_transfer',
      reference: 'BANK-100',
    },
  }, ids.admin);

  assert.equal(terms.paymentsReceivedPaise, 1000000);
  assert.equal(terms.remainingBalancePaise, 1500000);
  assert.equal(terms.payments[0].method, 'bank_transfer');
  assert.equal(terms.payments[0].recordedBy, ids.admin);
});

test('machine sale terms reject overpayment and invalid money', () => {
  assert.throws(
    () => prepareMachineSaleTerms({ ...validInput, agreedSalePricePaise: 10.5 }, ids.admin),
    /integer amount in paise/
  );
  assert.throws(
    () => prepareMachineSaleTerms({
      ...validInput,
      initialPayment: { amountPaise: 2500001, method: 'cash' },
    }, ids.admin),
    /cannot exceed the agreed sale price/
  );
});

test('machine sale eligibility accepts one available second-hand sale machine', () => {
  const machine = {
    _id: ids.machine,
    condition: 'used',
    availabilityType: 'both',
    availabilityStatus: 'available',
    stock: 1,
  };

  assert.equal(validateMachineSaleEligibility(machine), machine);
});

test('machine sale eligibility rejects rented, non-sale, and multi-unit products', () => {
  assert.throws(
    () => validateMachineSaleEligibility({
      _id: ids.machine,
      condition: 'used',
      availabilityType: 'both',
      availabilityStatus: 'on_rent',
      stock: 1,
    }),
    /not currently available for sale/
  );
  assert.throws(
    () => validateMachineSaleEligibility({
      _id: ids.machine,
      condition: 'used',
      availabilityType: 'rent',
      availabilityStatus: 'available',
      stock: 1,
    }),
    /not offered for sale/
  );
  assert.throws(
    () => validateMachineSaleEligibility({
      _id: ids.machine,
      condition: 'used',
      availabilityType: 'sale',
      availabilityStatus: 'available',
      stock: 2,
    }),
    /exactly one physical machine/
  );
});

test('machine sale request allowlist protects calculated and lifecycle fields', () => {
  assert.doesNotThrow(() => assertOnlyMachineSaleFields(validInput));
  assert.throws(
    () => assertOnlyMachineSaleFields({ ...validInput, remainingBalancePaise: 0 }),
    /Unsupported machine sale fields/
  );
  assert.throws(
    () => assertOnlyMachineSaleFields({ status: 'completed' }, { allowStatus: false }),
    /Unsupported machine sale fields/
  );
});

test('machine sale list filters support statuses, ids, escaped search, and pagination', () => {
  const filter = buildMachineSaleListFilter({
    status: 'draft,completed',
    customer: ids.customer.toString(),
    machine: ids.machine.toString(),
    search: 'Bosch (1)',
  });

  assert.deepEqual(filter.status, { $in: ['draft', 'completed'] });
  assert.equal(filter.customer, ids.customer.toString());
  assert.equal(filter.machine, ids.machine.toString());
  assert.equal(filter.$or[0].saleCode.test('Bosch (1)'), true);
  assert.equal(filter.$or[0].saleCode.test('Bosch 1'), false);
  assert.deepEqual(parseMachineSalePagination({ page: '2', limit: '10' }), {
    page: 2,
    limit: 10,
    skip: 10,
  });
});

test('machine sale list validation rejects invalid status and pagination', () => {
  assert.throws(
    () => buildMachineSaleListFilter({ status: 'refunded' }),
    /status must contain only/
  );
  assert.throws(() => parseMachineSalePagination({ limit: 101 }), /between 1 and 100/);
});
