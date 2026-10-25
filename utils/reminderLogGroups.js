import AppError from './AppError.js';
import mongoose from 'mongoose';
import { parseReminderPagination, reminderOccurrenceScopeFilter } from './reminderManagement.js';

const GROUP_SORT_FIELDS = new Set(['createdAt', 'scheduledAt']);
const GROUP_SORT_DIRECTIONS = new Set(['asc', 'desc']);
const FUTURE_UNSENT_STATUSES = ['pending', 'scheduled', 'processing', 'failed', 'partially_failed'];
const EMAIL_SUCCESS = ['accepted', 'delivered'];
const WHATSAPP_SUCCESS = ['manual_sent', 'accepted', 'delivered'];
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const parseReminderLogGroupQuery = (query = {}) => {
  const pagination = parseReminderPagination(query);
  const scope = String(query.scope || '').trim().toLowerCase();
  if (!['rental', 'standalone'].includes(scope)) {
    throw new AppError('scope must be rental or standalone', 400);
  }
  const sortBy = String(query.sortBy || 'createdAt').trim();
  if (!GROUP_SORT_FIELDS.has(sortBy)) {
    throw new AppError('sortBy must be createdAt or scheduledAt', 400);
  }
  const sortDirection = String(query.sortDirection || 'desc').trim().toLowerCase();
  if (!GROUP_SORT_DIRECTIONS.has(sortDirection)) {
    throw new AppError('sortDirection must be asc or desc', 400);
  }
  const search = String(query.search || '').trim();
  if (search.length > 100) throw new AppError('search cannot exceed 100 characters', 400);
  return { ...pagination, scope, sortBy, sortDirection, search };
};

const GROUP_TYPES = new Set(['rental', 'plan', 'definition', 'occurrence']);

export const parseReminderLogGroupIdentity = ({ scope, groupType, groupId } = {}) => {
  const normalizedScope = String(scope || '').trim().toLowerCase();
  if (!['rental', 'standalone'].includes(normalizedScope)) {
    throw new AppError('scope must be rental or standalone', 400);
  }
  const normalizedType = String(groupType || '').trim().toLowerCase();
  if (!GROUP_TYPES.has(normalizedType)) {
    throw new AppError('groupType must be rental, plan, definition, or occurrence', 400);
  }
  if (!mongoose.isValidObjectId(groupId)) throw new AppError('Invalid reminder log group id', 400);
  return { scope: normalizedScope, groupType: normalizedType, groupId: String(groupId) };
};

export const reminderLogGroupOccurrenceFilter = ({ scope, groupType, groupId }) => {
  const scopeFilter = reminderOccurrenceScopeFilter(scope);
  const objectId = new mongoose.Types.ObjectId(groupId);
  const priority = scope === 'rental'
    ? ['rental', 'plan', 'definition', 'occurrence']
    : ['plan', 'definition', 'rental', 'occurrence'];
  const groupIndex = priority.indexOf(groupType);
  const filter = { $and: [scopeFilter] };
  const membership = {};
  for (const higherPriorityType of priority.slice(0, groupIndex)) {
    if (higherPriorityType !== 'occurrence') membership[higherPriorityType] = null;
  }
  if (groupType === 'occurrence') membership._id = objectId;
  else membership[groupType] = objectId;
  filter.$and.push(membership);
  return filter;
};

const selectedChannel = (channel) => ({ $in: [channel, '$channels'] });
const statusIs = (path, statuses) => ({ $in: [path, statuses] });
const sumWhen = (condition) => ({ $sum: { $cond: [condition, 1, 0] } });

export const buildReminderLogGroupsPipeline = (options, now = new Date()) => {
  const scopeFilter = reminderOccurrenceScopeFilter(options.scope);
  const match = { $and: [scopeFilter] };
  if (options.search) {
    const pattern = new RegExp(escapeRegex(options.search), 'i');
    match.$and.push({
      $or: [
        { 'recipientSnapshot.name': pattern },
        { 'recipientSnapshot.email': pattern },
        { 'recipientSnapshot.phone': pattern },
      ],
    });
  }

  const neverDue = new Date('9999-12-31T23:59:59.999Z');
  const direction = options.sortDirection === 'asc' ? 1 : -1;
  const groupBranches = options.scope === 'rental'
    ? [
      { field: '$rental', type: 'rental' },
      { field: '$plan', type: 'plan' },
      { field: '$definition', type: 'definition' },
    ]
    : [
      { field: '$plan', type: 'plan' },
      { field: '$definition', type: 'definition' },
      { field: '$rental', type: 'rental' },
    ];
  const fallbackGroupId = groupBranches.reduceRight(
    (fallback, { field }) => ({ $ifNull: [field, fallback] }),
    '$_id'
  );
  return [
    { $match: match },
    { $sort: { createdAt: 1, _id: 1 } },
    { $addFields: {
      groupType: {
        $switch: {
          branches: [
            ...groupBranches.map(({ field, type }) => ({
              case: { $ne: [{ $ifNull: [field, null] }, null] },
              then: type,
            })),
          ],
          default: 'occurrence',
        },
      },
      groupId: fallbackGroupId,
    } },
    { $group: {
      _id: { type: '$groupType', id: '$groupId' },
      planId: { $max: '$plan' },
      rentalId: { $max: '$rental' },
      definitionId: { $first: '$definition' },
      recipientSnapshot: { $first: '$recipientSnapshot' },
      definitionType: { $first: '$definitionType' },
      occurrenceCreatedAt: { $min: '$createdAt' },
      nextCandidate: { $min: { $cond: [
        { $and: [{ $gte: ['$scheduledAt', now] }, { $in: ['$status', FUTURE_UNSENT_STATUSES] }] },
        '$scheduledAt',
        neverDue,
      ] } },
      lastScheduledAt: { $max: '$scheduledAt' },
      occurrenceCount: { $sum: 1 },
      pendingCount: sumWhen(statusIs('$status', ['pending', 'scheduled', 'processing'])),
      sentCount: sumWhen(statusIs('$status', ['sent'])),
      partiallyFailedCount: sumWhen(statusIs('$status', ['partially_failed'])),
      failedCount: sumWhen(statusIs('$status', ['failed'])),
      missedCount: sumWhen(statusIs('$status', ['missed'])),
      cancelledCount: sumWhen(statusIs('$status', ['cancelled'])),
      emailSelectedCount: sumWhen(selectedChannel('email')),
      emailPendingCount: sumWhen({ $and: [selectedChannel('email'), statusIs('$emailDelivery.status', ['pending', 'processing'])] }),
      emailSuccessCount: sumWhen({ $and: [selectedChannel('email'), statusIs('$emailDelivery.status', EMAIL_SUCCESS)] }),
      emailFailedCount: sumWhen({ $and: [selectedChannel('email'), statusIs('$emailDelivery.status', ['failed', 'uncertain'])] }),
      emailInactiveCount: sumWhen({ $and: [selectedChannel('email'), statusIs('$emailDelivery.status', ['cancelled', 'skipped'])] }),
      whatsappSelectedCount: sumWhen(selectedChannel('whatsapp')),
      whatsappPendingCount: sumWhen({ $and: [selectedChannel('whatsapp'), statusIs('$whatsappDelivery.status', ['pending', 'processing'])] }),
      whatsappSuccessCount: sumWhen({ $and: [selectedChannel('whatsapp'), statusIs('$whatsappDelivery.status', WHATSAPP_SUCCESS)] }),
      whatsappFailedCount: sumWhen({ $and: [selectedChannel('whatsapp'), statusIs('$whatsappDelivery.status', ['failed', 'uncertain'])] }),
      whatsappInactiveCount: sumWhen({ $and: [selectedChannel('whatsapp'), statusIs('$whatsappDelivery.status', ['cancelled', 'skipped'])] }),
    } },
    { $lookup: { from: 'reminderplans', localField: 'planId', foreignField: '_id', as: 'plan' } },
    { $lookup: { from: 'rentals', localField: 'rentalId', foreignField: '_id', as: 'rental' } },
    { $set: {
      plan: { $first: '$plan' },
      rental: { $first: '$rental' },
      nextScheduledAt: { $cond: [{ $eq: ['$nextCandidate', neverDue] }, null, '$nextCandidate'] },
    } },
    { $set: {
      groupType: '$_id.type',
      groupId: '$_id.id',
      groupKey: { $concat: ['$_id.type', ':', { $toString: '$_id.id' }] },
      createdAt: { $ifNull: ['$plan.createdAt', { $ifNull: ['$rental.createdAt', '$occurrenceCreatedAt'] }] },
      scheduledAt: { $ifNull: ['$nextScheduledAt', '$lastScheduledAt'] },
      context: {
        planCode: '$plan.planCode',
        planType: '$plan.planType',
        product: '$plan.productContextSnapshot',
        rentalCode: '$rental.rentalCode',
        rentalStatus: '$rental.status',
        machine: '$rental.machineSnapshot',
      },
      statusSummary: {
        pending: '$pendingCount', sent: '$sentCount', partiallyFailed: '$partiallyFailedCount',
        failed: '$failedCount', missed: '$missedCount', cancelled: '$cancelledCount',
      },
      channelSummary: {
        email: {
          selected: '$emailSelectedCount', pending: '$emailPendingCount', successful: '$emailSuccessCount',
          failed: '$emailFailedCount', inactive: '$emailInactiveCount',
        },
        whatsapp: {
          selected: '$whatsappSelectedCount', pending: '$whatsappPendingCount', successful: '$whatsappSuccessCount',
          failed: '$whatsappFailedCount', inactive: '$whatsappInactiveCount',
        },
      },
    } },
    { $set: {
      sortValue: options.sortBy === 'scheduledAt' ? '$scheduledAt' : '$createdAt',
      sortMissing: { $cond: [{ $eq: [options.sortBy === 'scheduledAt' ? '$scheduledAt' : '$createdAt', null] }, 1, 0] },
    } },
    { $sort: { sortMissing: 1, sortValue: direction, groupKey: 1 } },
    { $facet: {
      groups: [
        { $skip: options.skip },
        { $limit: options.limit },
        { $project: {
          _id: 0, groupType: 1, groupId: 1, groupKey: 1, planId: 1, rentalId: 1,
          definitionId: 1, recipientSnapshot: 1, definitionType: 1, createdAt: 1,
          nextScheduledAt: 1, lastScheduledAt: 1, scheduledAt: 1, occurrenceCount: 1,
          statusSummary: 1, channelSummary: 1, context: 1,
        } },
      ],
      total: [{ $count: 'value' }],
    } },
  ];
};
