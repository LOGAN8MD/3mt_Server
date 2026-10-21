import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProductRules } from '../utils/productRules.js';

test('legacy sale products receive backward-compatible defaults and normalized labels', () => {
  const product = validateProductRules({
    name: ' Legacy Drill ',
    category: ' Drill ',
    brand: ' Bosch ',
    price: '12500',
  });

  assert.equal(product.name, 'Legacy Drill');
  assert.equal(product.category, 'DRILL');
  assert.equal(product.brand, 'BOSCH');
  assert.equal(product.price, 12500);
  assert.equal(product.condition, 'new');
  assert.equal(product.availabilityType, 'sale');
  assert.equal(product.availabilityStatus, 'available');
});

test('rent and combined second-hand listings accept their required pricing fields', () => {
  const rentProduct = validateProductRules({
    name: 'Used Cutter',
    condition: 'USED',
    availabilityType: ' RENT ',
    availabilityStatus: 'ON_RENT',
    rentalPrice: '900',
    rentPeriod: 'DAY',
    securityDeposit: '2500',
  });
  const combinedProduct = validateProductRules({
    name: 'Used Lathe',
    condition: 'used',
    availabilityType: 'both',
    price: 80000,
    rentalPrice: 5000,
    rentPeriod: 'month',
  });

  assert.equal(rentProduct.condition, 'used');
  assert.equal(rentProduct.availabilityType, 'rent');
  assert.equal(rentProduct.availabilityStatus, 'on_rent');
  assert.equal(rentProduct.rentalPrice, 900);
  assert.equal(rentProduct.securityDeposit, 2500);
  assert.equal(combinedProduct.price, 80000);
  assert.equal(combinedProduct.rentalPrice, 5000);
});

test('second-hand listing validation rejects missing prices and invalid status combinations', () => {
  assert.throws(
    () => validateProductRules({ availabilityType: 'rent', rentPeriod: 'month' }),
    /rentalPrice must be greater than zero/
  );
  assert.throws(
    () => validateProductRules({ availabilityType: 'both', rentalPrice: 500, rentPeriod: 'day' }),
    /price must be greater than zero/
  );
  assert.throws(
    () => validateProductRules({ availabilityType: 'sale', price: 500, availabilityStatus: 'on_rent' }),
    /Only rent or both listings can have on_rent status/
  );
  assert.throws(
    () => validateProductRules({ availabilityType: 'rent', rentalPrice: 500, rentPeriod: 'day', availabilityStatus: 'sold' }),
    /Only sale or both listings can have sold status/
  );
  assert.throws(
    () => validateProductRules({ price: 500, availableFrom: 'not-a-date' }),
    /availableFrom must be a valid date/
  );
});
