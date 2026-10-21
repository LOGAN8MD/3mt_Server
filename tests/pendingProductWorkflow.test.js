import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildApprovedProductPayload,
  preparePendingProductSubmission,
} from '../utils/pendingProductWorkflow.js';

test('employee submission normalizes second-hand details and always starts available', () => {
  const submission = preparePendingProductSubmission({
    name: ' Used Grinder ',
    type: 'machine',
    condition: 'USED',
    category: ' grinder ',
    brand: ' makita ',
    availabilityType: 'rent',
    availabilityStatus: 'on_rent',
    rentalPrice: '1200',
    rentPeriod: 'week',
    securityDeposit: '4000',
    stock: '1',
    status: 'approved',
    submittedBy: 'not-accepted-from-request-body',
  });

  assert.equal(submission.name, 'Used Grinder');
  assert.equal(submission.category, 'GRINDER');
  assert.equal(submission.brand, 'MAKITA');
  assert.equal(submission.availabilityStatus, 'available');
  assert.equal(submission.rentalPrice, 1200);
  assert.equal(submission.stock, 1);
  assert.equal('status' in submission, false);
  assert.equal('submittedBy' in submission, false);
});

test('employee submission enforces second-hand rental validation', () => {
  assert.throws(
    () => preparePendingProductSubmission({
      name: 'Used Saw',
      condition: 'used',
      availabilityType: 'rent',
      rentPeriod: 'month',
    }),
    /rentalPrice must be greater than zero/
  );
});

test('admin approval builds a validated Product payload and preserves images', () => {
  const payload = buildApprovedProductPayload({
    name: 'Used Lathe',
    type: 'machine',
    condition: 'used',
    category: ' machine ',
    availabilityType: 'both',
    availabilityStatus: 'available',
    price: 175000,
    rentalPrice: 12000,
    rentPeriod: 'month',
    securityDeposit: 30000,
    stock: 1,
    images: [
      { url: 'https://example.com/lathe.jpg', public_id: 'pending-products/lathe', _id: 'ignored' },
    ],
    status: 'pending',
    reviewedBy: 'ignored',
  });

  assert.equal(payload.category, 'MACHINE');
  assert.equal(payload.availabilityType, 'both');
  assert.equal(payload.price, 175000);
  assert.equal(payload.rentalPrice, 12000);
  assert.deepEqual(payload.images, [
    { url: 'https://example.com/lathe.jpg', public_id: 'pending-products/lathe' },
  ]);
  assert.equal('status' in payload, false);
  assert.equal('reviewedBy' in payload, false);
});

test('admin approval also supports legacy pending products', () => {
  const payload = buildApprovedProductPayload({
    name: 'Legacy Drill',
    price: 8500,
    images: [{ url: 'https://example.com/drill.jpg', public_id: 'pending-products/drill' }],
  });

  assert.equal(payload.condition, 'new');
  assert.equal(payload.availabilityType, 'sale');
  assert.equal(payload.availabilityStatus, 'available');
  assert.equal(payload.price, 8500);
});
