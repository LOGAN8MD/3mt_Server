import test from 'node:test';
import assert from 'node:assert/strict';
import Product from '../models/Product.js';
import { getProductById, getProducts, getInventoryProducts } from '../controllers/productController.js';
import { customerCatalogFilters } from '../utils/customerCatalog.js';
import { allowRoles, protect } from '../middlewares/authMiddleware.js';

test('default catalog includes legacy conditions and excludes sold/unavailable', () => {
  assert.deepEqual(customerCatalogFilters(), [
    { $or: [{ condition: 'new' }, { condition: null }, { condition: '' }] },
    { availabilityStatus: { $nin: ['sold', 'unavailable'] } },
  ]);
  assert.deepEqual(customerCatalogFilters('new'), customerCatalogFilters());
});

test('second-hand mode selects machines without restricting status', () => {
  assert.deepEqual(customerCatalogFilters(' USED '), [
    { condition: 'used' }, { type: /^machine$/i },
  ]);
  for (const value of ['all', ['used'], { $ne: 'new' }]) {
    assert.throws(() => customerCatalogFilters(value), /condition must/);
  }
});

test('public list and count use the same catalog scope; inventory stays unfiltered', async (t) => {
  let findFilter;
  let countFilter;
  const query = {
    lean() { return this; }, select() { return this; }, slice() { return this; },
    sort() { return this; }, skip() { return this; }, limit() { return this; },
    then(resolve) { return Promise.resolve([]).then(resolve); },
  };
  t.mock.method(Product, 'find', (filter) => { findFilter = filter; return query; });
  t.mock.method(Product, 'countDocuments', async (filter) => { countFilter = filter; return 0; });
  let body;
  const res = { json(value) { body = value; } };
  const next = (err) => { throw err; };
  await getProducts({ query: { page: '1', limit: '24', inventory: 'true' } }, res, next);
  assert.deepEqual(findFilter, { $and: customerCatalogFilters() });
  assert.deepEqual(countFilter, findFilter);
  assert.equal(body.pagination.total, 0);
  await getProducts({ query: { condition: 'used', availabilityStatus: 'sold' } }, res, next);
  assert.deepEqual(findFilter.$and.slice(0, 2), customerCatalogFilters('used'));
  assert.equal(findFilter.$and[2].availabilityStatus, 'sold');
  for (const offer of ['sale', 'rent', 'both']) {
    await getProducts({ query: { condition: 'used', availabilityType: offer } }, res, next);
    const expected = offer === 'both' ? 'both' : { $in: [offer, 'both', ...(offer === 'sale' ? [null, ''] : [])] };
    assert.deepEqual(findFilter.$and[2].availabilityType, expected);
  }
  await getProducts({ query: { condition: 'used', availabilityType: 'rent', rentPeriod: 'month', minRentalPrice: '100', maxRentalPrice: '500', sort: 'rentalPriceAsc' } }, res, next);
  assert.ok(findFilter.$and.some((entry) => entry.rentPeriod === 'month'));
  assert.ok(findFilter.$and.some((entry) => entry.rentalPrice?.$gte === 100 && entry.rentalPrice?.$lte === 500));
  for (const invalid of [{ minRentalPrice: '100' }, { rentPeriod: 'year' }, { availabilityType: 'bad' }, { rentPeriod: 'day', minRentalPrice: '500', maxRentalPrice: '100' }]) {
    let failure;
    await getProducts({ query: invalid }, res, (err) => { failure = err; });
    assert.ok(failure);
  }
  await getInventoryProducts({ query: {} }, res, next);
  assert.deepEqual(findFilter, {});
  assert.deepEqual(body, []);
});

test('inventory guards reject anonymous and customer access and allow staff', async () => {
  let status;
  const res = { status(value) { status = value; return this; }, json() {} };
  await protect({ headers: {} }, res, () => assert.fail('anonymous access'));
  assert.equal(status, 401);
  const guard = allowRoles('admin', 'employee');
  guard({ user: { role: 'customer' } }, res, () => assert.fail('customer access'));
  assert.equal(status, 403);
  for (const role of ['admin', 'employee']) {
    let allowed = false;
    guard({ user: { role } }, res, () => { allowed = true; });
    assert.equal(allowed, true);
  }
});

for (const status of ['sold', 'unavailable']) {
  test(`direct product lookup keeps ${status} machines viewable`, async (t) => {
    const id = '507f1f77bcf86cd799439011';
    const product = {
      _id: id,
      name: `Second-Hand ${status} machine`,
      condition: 'used',
      type: 'machine',
      availabilityStatus: status,
    };
    t.mock.method(Product, 'findById', (value) => {
      assert.equal(value, id);
      return { lean: async () => product };
    });

    let body;
    await getProductById(
      { params: { id } },
      { json(value) { body = value; } },
      (error) => { throw error; }
    );

    assert.equal(body, product);
    assert.equal(body.availabilityStatus, status);
  });
}
