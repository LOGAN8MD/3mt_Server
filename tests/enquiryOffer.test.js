import test from 'node:test';
import assert from 'node:assert/strict';
import { enquiryOfferSnapshot } from '../utils/enquiryOffer.js';
import { validateEnquiry, createEnquiry } from '../controllers/enquiryController.js';
import Product from '../models/Product.js';
import Enquiry from '../models/Enquiry.js';

const product = { name: 'Mixer', condition: 'used', availabilityType: 'both', stock: 1, price: 50000, rentalPrice: 500, rentPeriod: 'day', securityDeposit: 2000 };
test('rental snapshots retain rate/deposit but never contribute to sale totals', () => {
  const rental = enquiryOfferSnapshot(product, 1, 'rent');
  assert.equal(rental.lineTotal, 0);
  assert.equal(rental.priceSnapshot, 0);
  assert.equal(rental.rentalPriceSnapshot, 500);
  assert.equal(rental.securityDepositSnapshot, 2000);
  assert.equal(enquiryOfferSnapshot(product, 1, 'sale').lineTotal, 50000);
});
test('live availability, offer and quantity restrictions reject invalid enquiries', () => {
  for (const status of ['sold', 'unavailable']) for (const intent of ['sale', 'rent']) {
    assert.throws(() => enquiryOfferSnapshot({ ...product, availabilityStatus: status }, 1, intent));
  }
  assert.throws(() => enquiryOfferSnapshot(product, 2, 'sale'));
  assert.throws(() => enquiryOfferSnapshot(product, 2, 'rent'));
  assert.throws(() => enquiryOfferSnapshot({ ...product, availabilityType: 'sale' }, 1, 'rent'));
  assert.throws(() => enquiryOfferSnapshot({ ...product, availabilityStatus: 'on_rent' }, 1, 'sale'));
  assert.equal(enquiryOfferSnapshot({ ...product, availabilityStatus: 'on_rent' }, 1, 'rent').intent, 'rent');
});
test('validation and creation both reject sold records, duplicate products and rental carts', async (t) => {
  const id = '507f1f77bcf86cd799439011';
  t.mock.method(Product, 'find', () => ({ lean: async () => [{ ...product, _id: id, availabilityStatus: 'sold' }] }));
  for (const handler of [validateEnquiry, createEnquiry]) {
    for (const products of [[{ productId: id, quantity: 1 }], [{ productId: id }, { productId: id }], [{ productId: id, intent: 'rent' }]]) {
      let error;
      await handler({ body: { source: 'cart', products }, user: { _id: id } }, {}, (value) => { error = value; });
      assert.ok(error);
    }
  }
});

test('successful rental creation saves rental snapshots with zero purchase total', async (t) => {
  const id = '507f1f77bcf86cd799439011';
  const liveProduct = { ...product, _id: id, availabilityStatus: 'available' };
  let savedPayload;
  t.mock.method(Product, 'find', () => ({ lean: async () => [liveProduct] }));
  t.mock.method(Enquiry, 'create', async (payload) => {
    savedPayload = payload;
    return { _id: id };
  });
  t.mock.method(Enquiry, 'findById', () => ({
    populate() { return this; },
    async lean() { return savedPayload; },
  }));
  let responseStatus;
  let responseBody;
  const response = {
    status(value) { responseStatus = value; return this; },
    json(value) { responseBody = value; },
  };
  await createEnquiry({
    body: {
      source: 'product_detail',
      products: [{ productId: id, quantity: 1, intent: 'rent' }],
      message: 'Rental enquiry',
    },
    user: { _id: id, name: 'Rahul', email: 'rahul@example.com' },
  }, response, (error) => { throw error; });
  assert.equal(responseStatus, 201);
  assert.equal(savedPayload.totalEstimatedPrice, 0);
  assert.deepEqual(savedPayload.products[0], {
    product: id,
    nameSnapshot: 'Mixer',
    typeSnapshot: '',
    categorySnapshot: '',
    brandSnapshot: '',
    modelSnapshot: '',
    intent: 'rent',
    conditionSnapshot: 'used',
    availabilityStatusSnapshot: 'available',
    priceSnapshot: 0,
    lineTotal: 0,
    rentalPriceSnapshot: 500,
    rentPeriodSnapshot: 'day',
    securityDepositSnapshot: 2000,
    quantity: 1,
  });
  assert.equal(responseBody.totalEstimatedPrice, 0);
});
