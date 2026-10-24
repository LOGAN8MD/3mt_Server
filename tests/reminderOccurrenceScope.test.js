import assert from 'node:assert/strict';
import test from 'node:test';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import { getReminderOccurrences } from '../controllers/reminderController.js';
import { isAdmin } from '../middlewares/authMiddleware.js';
import { reminderOccurrenceScopeFilter } from '../utils/reminderManagement.js';

const queryResult = (rows = []) => ({
  populate() { return this; },
  sort() { return this; },
  skip() { return this; },
  limit() { return this; },
  lean: async () => rows,
});

const callList = async (query, t, { rows = [], total = rows.length } = {}) => {
  let findFilter;
  let countFilter;
  t.mock.method(ReminderOccurrence, 'find', (filter) => {
    findFilter = filter;
    return queryResult(rows);
  });
  t.mock.method(ReminderOccurrence, 'countDocuments', async (filter) => {
    countFilter = filter;
    return total;
  });
  let body;
  let failure;
  await getReminderOccurrences(
    { query },
    { json(value) { body = value; return this; } },
    (error) => { failure = error; }
  );
  return { body, failure, findFilter, countFilter };
};

test('scope filters classify current and legacy rental and standalone occurrences', () => {
  assert.deepEqual(reminderOccurrenceScopeFilter('rental'), {
    $or: [
      { rental: { $type: 'objectId' } },
      { definitionType: { $in: ['rental_activation_confirmation', 'rental_return'] } },
    ],
  });
  assert.deepEqual(reminderOccurrenceScopeFilter('standalone'), {
    $and: [
      { definitionType: 'standalone_custom' },
      { $or: [{ rental: { $exists: false } }, { rental: null }] },
    ],
  });
  assert.equal(reminderOccurrenceScopeFilter(undefined), null);
});

test('rental scope uses the same filter for rows and pagination counts', async (t) => {
  const rows = [{ _id: 'rental-confirmation' }, { _id: 'legacy-rental-return' }];
  const result = await callList(
    { scope: 'rental', status: 'pending', page: '2', limit: '2' },
    t,
    { rows, total: 5 }
  );

  assert.equal(result.failure, undefined);
  assert.deepEqual(result.findFilter, result.countFilter);
  assert.equal(result.findFilter.status, 'pending');
  assert.deepEqual(result.findFilter.$and, [reminderOccurrenceScopeFilter('rental')]);
  assert.deepEqual(result.body.occurrences, rows);
  assert.deepEqual(result.body.pagination, { page: 2, limit: 2, total: 5, pages: 3 });
});

test('standalone scope excludes rental-linked rows before pagination', async (t) => {
  const result = await callList({ scope: ' standalone ' }, t, { total: 1 });

  assert.equal(result.failure, undefined);
  assert.deepEqual(result.findFilter, result.countFilter);
  assert.deepEqual(result.findFilter.$and, [reminderOccurrenceScopeFilter('standalone')]);
  assert.equal(result.body.pagination.total, 1);
});

test('unscoped occurrence listing retains its existing query behavior', async (t) => {
  const result = await callList({ status: 'sent' }, t);

  assert.equal(result.failure, undefined);
  assert.deepEqual(result.findFilter, { status: 'sent' });
  assert.deepEqual(result.countFilter, result.findFilter);
});

test('invalid occurrence scopes are rejected before querying MongoDB', async (t) => {
  let queried = false;
  t.mock.method(ReminderOccurrence, 'find', () => { queried = true; return queryResult(); });
  let failure;
  await getReminderOccurrences(
    { query: { scope: 'everything' } },
    { json() { assert.fail('unexpected response'); } },
    (error) => { failure = error; }
  );

  assert.equal(queried, false);
  assert.equal(failure.statusCode, 400);
  assert.match(failure.message, /scope must be rental or standalone/);
});

test('reminder occurrence routes remain admin-only', () => {
  const response = () => ({
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  });

  for (const role of ['customer', 'employee']) {
    const res = response();
    isAdmin({ user: { role } }, res, () => assert.fail(`${role} should not be allowed`));
    assert.equal(res.statusCode, 403);
  }
  let allowed = false;
  isAdmin({ user: { role: 'admin' } }, response(), () => { allowed = true; });
  assert.equal(allowed, true);
});
