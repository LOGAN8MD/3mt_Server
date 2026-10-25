import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import NotificationDeliveryAttempt from '../models/NotificationDeliveryAttempt.js';
import ReminderDefinition from '../models/ReminderDefinition.js';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import ReminderPlan from '../models/ReminderPlan.js';
import Rental from '../models/Rental.js';
import { getReminderLogGroupHistory, getReminderLogGroups } from '../controllers/reminderController.js';
import {
  buildReminderLogGroupsPipeline,
  parseReminderLogGroupIdentity,
  parseReminderLogGroupQuery,
  reminderLogGroupOccurrenceFilter,
} from '../utils/reminderLogGroups.js';

test('group query validates scope, sorting, search length and pagination', () => {
  assert.deepEqual(parseReminderLogGroupQuery({ scope: ' rental ', page: '2', limit: '10' }), {
    scope: 'rental', page: 2, limit: 10, skip: 10,
    sortBy: 'createdAt', sortDirection: 'desc', search: '',
  });
  assert.equal(parseReminderLogGroupQuery({ scope: 'standalone', sortBy: 'scheduledAt', sortDirection: 'ASC' }).sortDirection, 'asc');
  assert.throws(() => parseReminderLogGroupQuery({}), /scope must be rental or standalone/);
  assert.throws(() => parseReminderLogGroupQuery({ scope: 'all' }), /scope must be rental or standalone/);
  assert.throws(() => parseReminderLogGroupQuery({ scope: 'rental', sortBy: 'name' }), /sortBy/);
  assert.throws(() => parseReminderLogGroupQuery({ scope: 'rental', sortDirection: 'sideways' }), /sortDirection/);
  assert.throws(() => parseReminderLogGroupQuery({ scope: 'rental', search: 'x'.repeat(101) }), /100 characters/);
});

test('pipeline applies scope/search before grouping and uses standalone plan precedence', () => {
  const options = parseReminderLogGroupQuery({
    scope: 'standalone', search: 'Deepak.+', sortBy: 'scheduledAt', sortDirection: 'asc', page: 2, limit: 5,
  });
  const pipeline = buildReminderLogGroupsPipeline(options, new Date('2026-10-25T00:00:00.000Z'));
  const match = pipeline[0].$match;
  assert.equal(match.$and[0].$and[0].definitionType, 'standalone_custom');
  assert.equal(match.$and[1].$or[0]['recipientSnapshot.name'].source, 'Deepak\\.\\+');

  const identityStage = pipeline.find((stage) => stage.$addFields?.groupType).$addFields;
  assert.deepEqual(identityStage.groupType.$switch.branches.map(({ then }) => then), ['plan', 'definition', 'rental']);
  assert.equal(identityStage.groupType.$switch.default, 'occurrence');

  const sort = pipeline.find((stage) => stage.$sort?.sortMissing).$sort;
  assert.deepEqual(sort, { sortMissing: 1, sortValue: 1, groupKey: 1 });
  const facet = pipeline.at(-1).$facet;
  assert.deepEqual(facet.groups.slice(0, 2), [{ $skip: 5 }, { $limit: 5 }]);
  assert.deepEqual(facet.total, [{ $count: 'value' }]);
});

test('rental grouping keeps confirmation and plan reminders under one rental entry', () => {
  const pipeline = buildReminderLogGroupsPipeline(parseReminderLogGroupQuery({ scope: 'rental' }));
  const identityStage = pipeline.find((stage) => stage.$addFields?.groupType).$addFields;
  assert.deepEqual(identityStage.groupType.$switch.branches.map(({ then }) => then), ['rental', 'plan', 'definition']);
  const group = pipeline.find((stage) => stage.$group).$group;
  assert.deepEqual(group._id, { type: '$groupType', id: '$groupId' });
  assert.equal(JSON.stringify(group._id).includes('recipientSnapshot'), false);
  assert.deepEqual(group.planId, { $max: '$plan' });
  assert.deepEqual(group.rentalId, { $max: '$rental' });
});

test('group pipeline exposes status, channel, context and next-or-last schedule summaries', () => {
  const pipeline = buildReminderLogGroupsPipeline(parseReminderLogGroupQuery({ scope: 'rental' }));
  const group = pipeline.find((stage) => stage.$group).$group;
  assert.equal(group.occurrenceCount.$sum, 1);
  assert.ok(group.nextCandidate.$min);
  for (const field of ['pendingCount', 'sentCount', 'partiallyFailedCount', 'failedCount', 'missedCount', 'cancelledCount']) {
    assert.ok(group[field].$sum, `${field} should be counted`);
  }
  assert.ok(group.emailSuccessCount.$sum);
  assert.ok(group.whatsappSuccessCount.$sum);
  const project = pipeline.at(-1).$facet.groups.at(-1).$project;
  for (const field of ['groupKey', 'recipientSnapshot', 'createdAt', 'nextScheduledAt', 'lastScheduledAt', 'statusSummary', 'channelSummary', 'context']) {
    assert.equal(project[field], 1);
  }
});

test('group controller returns aggregate rows with matching pagination and sort metadata', async (t) => {
  let receivedPipeline;
  t.mock.method(ReminderOccurrence, 'aggregate', async (pipeline) => {
    receivedPipeline = pipeline;
    return [{ groups: [{ groupKey: 'plan:1', occurrenceCount: 3 }], total: [{ value: 7 }] }];
  });
  let body;
  let failure;
  await getReminderLogGroups(
    { query: { scope: 'rental', page: '2', limit: '3', sortBy: 'scheduledAt', sortDirection: 'desc' } },
    { json(value) { body = value; return this; } },
    (error) => { failure = error; }
  );
  assert.equal(failure, undefined);
  assert.ok(receivedPipeline.length > 0);
  assert.deepEqual(body.groups, [{ groupKey: 'plan:1', occurrenceCount: 3 }]);
  assert.deepEqual(body.pagination, { page: 2, limit: 3, total: 7, pages: 3 });
  assert.deepEqual(body.sort, { by: 'scheduledAt', direction: 'desc' });
  assert.equal(body.scope, 'rental');
});

test('group controller rejects invalid input before aggregation', async (t) => {
  let queried = false;
  t.mock.method(ReminderOccurrence, 'aggregate', async () => { queried = true; return []; });
  let failure;
  await getReminderLogGroups(
    { query: { scope: 'invalid' } },
    { json() { assert.fail('unexpected response'); } },
    (error) => { failure = error; }
  );
  assert.equal(queried, false);
  assert.equal(failure.statusCode, 400);
});

test('group history identity validates scope, type, and object id', () => {
  const id = new mongoose.Types.ObjectId().toString();
  assert.deepEqual(parseReminderLogGroupIdentity({ scope: ' RENTAL ', groupType: 'Plan', groupId: id }), {
    scope: 'rental', groupType: 'plan', groupId: id,
  });
  assert.throws(() => parseReminderLogGroupIdentity({ scope: 'all', groupType: 'plan', groupId: id }), /scope/);
  assert.throws(() => parseReminderLogGroupIdentity({ scope: 'rental', groupType: 'customer', groupId: id }), /groupType/);
  assert.throws(() => parseReminderLogGroupIdentity({ scope: 'rental', groupType: 'plan', groupId: 'bad' }), /Invalid/);
});

test('group history membership repeats overview precedence exactly', () => {
  const id = new mongoose.Types.ObjectId().toString();
  const rentalPlan = reminderLogGroupOccurrenceFilter({ scope: 'rental', groupType: 'plan', groupId: id });
  assert.deepEqual(rentalPlan.$and[1].rental, null);
  assert.equal(rentalPlan.$and[1].plan.toString(), id);

  const standaloneDefinition = reminderLogGroupOccurrenceFilter({
    scope: 'standalone', groupType: 'definition', groupId: id,
  });
  assert.equal(standaloneDefinition.$and[0].$and[0].definitionType, 'standalone_custom');
  assert.deepEqual(standaloneDefinition.$and[1].plan, null);
  assert.equal(standaloneDefinition.$and[1].definition.toString(), id);

  const orphan = reminderLogGroupOccurrenceFilter({ scope: 'rental', groupType: 'occurrence', groupId: id });
  assert.deepEqual(orphan.$and[1], {
    rental: null, plan: null, definition: null, _id: new mongoose.Types.ObjectId(id),
  });
});

const queryResult = (value) => {
  const query = {
    select() { return query; },
    populate() { return query; },
    sort() { return query; },
    lean: async () => value,
  };
  return query;
};

test('group history controller returns complete isolated history with attempts and references', async (t) => {
  const ids = {
    group: new mongoose.Types.ObjectId(), occurrence: new mongoose.Types.ObjectId(),
    definition: new mongoose.Types.ObjectId(), plan: new mongoose.Types.ObjectId(),
    attempt: new mongoose.Types.ObjectId(),
  };
  const createdAt = new Date('2026-10-25T05:00:00.000Z');
  const occurrence = {
    _id: ids.occurrence, definition: ids.definition, plan: ids.plan, rental: ids.group,
    recipientSnapshot: { name: 'Deepak Mishra', email: 'deepak@example.com', phone: '8286104286' },
    contentSnapshot: { bodyEnglish: 'Return reminder', bodyHindi: 'Return reminder Hindi' },
    scheduledAt: new Date('2026-10-26T05:00:00.000Z'), scheduleVersion: 2,
    status: 'failed', emailDelivery: { status: 'failed', lastError: 'Provider error' },
    whatsappDelivery: { status: 'pending' }, createdAt,
  };
  let receivedFilter;
  let occurrenceSelect;
  t.mock.method(ReminderOccurrence, 'find', (filter) => {
    receivedFilter = filter;
    const query = queryResult([occurrence]);
    query.select = (value) => { occurrenceSelect = value; return query; };
    return query;
  });
  t.mock.method(ReminderDefinition, 'find', () => queryResult([{ _id: ids.definition, scheduleVersion: 2 }]));
  t.mock.method(ReminderPlan, 'find', () => queryResult([{ _id: ids.plan, planCode: 'RPL-ONE', createdAt }]));
  t.mock.method(Rental, 'find', () => queryResult([{ _id: ids.group, rentalCode: 'RNT-ONE', createdAt }]));
  t.mock.method(NotificationDeliveryAttempt, 'find', () => queryResult([{
    _id: ids.attempt, occurrence: ids.occurrence, channel: 'email', attemptNumber: 1,
    status: 'failed', errorMessage: 'Provider error', startedAt: createdAt,
  }]));

  let body;
  let failure;
  await getReminderLogGroupHistory(
    { params: { groupType: 'rental', groupId: ids.group.toString() }, query: { scope: 'rental' } },
    { json(value) { body = value; return this; } },
    (error) => { failure = error; }
  );
  assert.equal(failure, undefined);
  assert.equal(receivedFilter.$and[1].rental.toString(), ids.group.toString());
  assert.equal(occurrenceSelect, '-lockToken');
  assert.equal(body.group.groupKey, `rental:${ids.group}`);
  assert.equal(body.group.recipientSnapshot.name, 'Deepak Mishra');
  assert.equal(body.occurrences.length, 1);
  assert.equal(body.occurrences[0].deliveryAttempts[0].errorMessage, 'Provider error');
  assert.equal(body.occurrences[0].managementReferences.occurrenceId, ids.occurrence);
  assert.equal(body.definitions[0].scheduleVersion, 2);
  assert.equal(body.plans[0].planCode, 'RPL-ONE');
  assert.equal(body.rentals[0].rentalCode, 'RNT-ONE');
});

test('group history controller returns 404 before loading related records', async (t) => {
  const id = new mongoose.Types.ObjectId().toString();
  t.mock.method(ReminderOccurrence, 'find', () => queryResult([]));
  let relatedQuery = false;
  t.mock.method(ReminderDefinition, 'find', () => { relatedQuery = true; return queryResult([]); });
  let failure;
  await getReminderLogGroupHistory(
    { params: { groupType: 'plan', groupId: id }, query: { scope: 'standalone' } },
    { json() { assert.fail('unexpected response'); } },
    (error) => { failure = error; }
  );
  assert.equal(failure.statusCode, 404);
  assert.equal(relatedQuery, false);
});
