import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import PendingProduct from '../models/PendingProduct.js';
import Product from '../models/Product.js';

test('Product model validates legacy products with new listing defaults', async () => {
  const product = new Product({ name: 'Legacy Product', price: 5000 });

  await product.validate();

  assert.equal(product.condition, 'new');
  assert.equal(product.availabilityType, 'sale');
  assert.equal(product.availabilityStatus, 'available');
});

test('Product model validates a complete second-hand rental product', async () => {
  const product = new Product({
    name: 'Used Compactor',
    condition: 'used',
    availabilityType: 'rent',
    availabilityStatus: 'on_rent',
    rentalPrice: 1800,
    rentPeriod: 'day',
  });

  await product.validate();
  assert.equal(product.rentalPrice, 1800);
});

test('PendingProduct keeps employee review state separate from listing availability', async () => {
  const pendingProduct = new PendingProduct({
    name: 'Used Mixer',
    condition: 'used',
    availabilityType: 'both',
    availabilityStatus: 'available',
    price: 90000,
    rentalPrice: 4500,
    rentPeriod: 'week',
    submittedBy: new mongoose.Types.ObjectId(),
  });

  await pendingProduct.validate();

  assert.equal(pendingProduct.status, 'pending');
  assert.equal(pendingProduct.availabilityStatus, 'available');
});

test('Product model rejects incomplete rental products', async () => {
  const product = new Product({
    name: 'Incomplete Rental',
    condition: 'used',
    availabilityType: 'rent',
  });

  await assert.rejects(product.validate(), /rentalPrice.*required|rentPeriod.*required/);
});
