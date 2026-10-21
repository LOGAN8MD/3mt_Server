import test from 'node:test';
import assert from 'node:assert/strict';
import Product from '../models/Product.js';
import { searchProducts, getRelatedProducts } from '../controllers/productController.js';
import { customerCatalogFilters } from '../utils/customerCatalog.js';

const sourceId = '507f1f77bcf86cd799439011';
const chain = (result) => ({
  select() { return this; }, slice() { return this; }, sort() { return this; },
  limit() { return this; }, lean() { return Promise.resolve(result); },
});
const next = (error) => { throw error; };

test('navbar search always applies new catalog scope even with a used query flag', async (t) => {
  let filter;
  t.mock.method(Product, 'find', (value) => { filter = value; return chain([]); });
  await searchProducts({ query: { q: 'mixer', condition: 'used' } }, { json() {} }, next);
  assert.deepEqual(filter.$and.slice(0, 2), customerCatalogFilters());
  assert.ok(filter.$and[2].$or[0].name.test('Concrete Mixer'));
});

for (const condition of [undefined, 'new', 'used']) {
  test(`related products follow ${condition || 'legacy'} source condition`, async (t) => {
    let filter;
    let projection;
    const source = { _id: sourceId, condition, category: 'Mixer', type: 'machine' };
    const sourceQuery = chain(source);
    sourceQuery.select = function (fields) { projection = fields; return this; };
    t.mock.method(Product, 'findById', () => sourceQuery);
    t.mock.method(Product, 'find', (value) => { filter = value; return chain([]); });
    await getRelatedProducts({ params: { id: sourceId }, query: {} }, { json() {} }, next);
    assert.ok(projection.includes('condition'));
    assert.deepEqual(filter.$and, customerCatalogFilters(condition === 'used' ? 'used' : 'new'));
    assert.deepEqual(filter._id, { $ne: sourceId });
    assert.ok(filter.$or[0].category.test('Mixer'));
  });
}

test('related products retain type fallback and empty-result behaviour', async (t) => {
  let source = { _id: sourceId, type: 'machine', condition: 'used' };
  let filter;
  let calls = 0;
  t.mock.method(Product, 'findById', () => chain(source));
  t.mock.method(Product, 'find', (value) => { filter = value; calls++; return chain([]); });
  await getRelatedProducts({ params: { id: sourceId }, query: {} }, { json() {} }, next);
  assert.ok(filter.$or[0].type.test('machine'));
  source = { _id: sourceId };
  let response;
  await getRelatedProducts({ params: { id: sourceId }, query: {} }, { json(value) { response = value; } }, next);
  assert.deepEqual(response, []);
  assert.equal(calls, 1);
});
