import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import ReminderPlan from '../models/ReminderPlan.js';
import ReminderDefinition from '../models/ReminderDefinition.js';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import Rental from '../models/Rental.js';
import User from '../models/User.js';
import { cancelReminderTimers, processReminderEmails } from '../services/reminderProcessor.js';
import {
  buildReminderPlanRecords,
  normalizeSubmissionKey,
  reminderPlanFingerprint,
} from '../services/reminderPlanService.js';
import AppError from '../utils/AppError.js';
import { MANAGEABLE_OCCURRENCE_STATUSES, parseReminderPagination } from '../utils/reminderManagement.js';
import { prepareReminderPlan } from '../utils/reminderPlan.js';

const planPopulate = [
  { path: 'customer', select: 'name firstName lastName email phone role' },
  { path: 'rental', select: 'rentalCode status handoverAt expectedReturnAt machineSnapshot customerSnapshot' },
  { path: 'createdBy', select: 'name email role' },
  { path: 'updatedBy', select: 'name email role' },
];

const requireId = (value, label) => {
  if (!mongoose.isValidObjectId(value)) throw new AppError(`Invalid ${label} id`, 400);
};

const validateCustomer = (customer) => {
  if (!customer || customer.role !== 'customer') {
    throw new AppError('Reminder recipient must be an existing customer', 400);
  }
};

const loadPlanContext = async (body, existingPlan = null) => {
  const rentalId = body.rentalId ?? existingPlan?.rental;
  let rental = null;
  if (rentalId) {
    requireId(rentalId, 'rental');
    rental = await Rental.findById(rentalId);
    if (!rental) throw new AppError('Rental not found', 404);
    if (!['active', 'overdue'].includes(rental.status)) {
      throw new AppError('Rental reminder plans require an active or overdue rental', 409);
    }
  }
  const customerId = rental?.customer ?? body.customerId ?? existingPlan?.customer;
  requireId(customerId, 'customer');
  const customer = await User.findById(customerId);
  validateCustomer(customer);
  return { rental, customer };
};

const generatePlanCode = () =>
  `RPL-${Date.now()}-${randomBytes(5).toString('hex').toUpperCase()}`;

const handlePlanError = (error, next, context) => {
  if (error instanceof AppError) return next(error);
  if (error?.name === 'ValidationError' || error?.name === 'CastError') {
    return next(new AppError(error.message, 400));
  }
  if (error?.code === 11000) {
    return next(new AppError('This reminder plan request was already saved', 409));
  }
  return next(new AppError(`${context}: ${error.message}`, 500));
};

const prepareFromRequest = async (body, existingPlan = null) => {
  const { rental, customer } = await loadPlanContext(body, existingPlan);
  const prepared = prepareReminderPlan(body, { rental, customer });
  if (existingPlan && prepared.planType !== existingPlan.planType) {
    throw new AppError('A reminder plan cannot change between rental and standalone', 409);
  }
  if (
    existingPlan?.rental &&
    prepared.rentalId !== existingPlan.rental.toString()
  ) {
    throw new AppError('A reminder plan cannot be moved to another rental', 409);
  }
  if (existingPlan && prepared.customerId !== existingPlan.customer.toString()) {
    throw new AppError('A reminder plan cannot be moved to another customer', 409);
  }
  return { rental, customer, prepared };
};

export const previewReminderPlan = async (req, res, next) => {
  try {
    const { prepared } = await prepareFromRequest(req.body);
    res.json({ ...prepared, fingerprint: reminderPlanFingerprint(prepared), timeZone: 'Asia/Kolkata' });
  } catch (error) {
    handlePlanError(error, next, 'Failed to preview reminder plan');
  }
};

export const createReminderPlan = async (req, res, next) => {
  try {
    const { rental, customer, prepared } = await prepareFromRequest(req.body);
    const adminId = req.user._id;
    const now = new Date();
    const planId = new mongoose.Types.ObjectId();
    const planCode = generatePlanCode();
    const fingerprint = reminderPlanFingerprint(prepared);
    const submissionKey = normalizeSubmissionKey(req.body.submissionKey);
    const existingQuery = {
      createdBy: adminId,
      status: { $in: ['active', 'paused'] },
      $or: [{ fingerprint }, ...(submissionKey ? [{ submissionKey }] : [])],
    };
    if (await ReminderPlan.exists(existingQuery)) {
      throw new AppError('An identical active reminder plan already exists', 409);
    }
    if (rental && await ReminderPlan.exists({
      rental: rental._id,
      status: { $in: ['active', 'paused'] },
    })) {
      throw new AppError('This rental already has an active reminder plan; update that plan instead', 409);
    }

    const records = buildReminderPlanRecords({
      planId, planCode, version: 1, prepared, rental, customer, adminId, now,
    });
    let cancelledOccurrenceIds = [];
    await mongoose.connection.transaction(async (session) => {
      if (rental) {
        const legacyDefinitions = await ReminderDefinition.find({
          rental: rental._id,
          type: 'rental_return',
          status: { $in: ['active', 'paused'] },
          plan: { $exists: false },
        }).select('_id').session(session).lean();
        const legacyIds = legacyDefinitions.map(({ _id }) => _id);
        if (legacyIds.length) {
          const occurrences = await ReminderOccurrence.find({
            definition: { $in: legacyIds },
            status: { $in: MANAGEABLE_OCCURRENCE_STATUSES },
          }).select('_id').session(session).lean();
          cancelledOccurrenceIds = occurrences.map(({ _id }) => _id);
          const cancellation = {
            status: 'cancelled', cancelledAt: now, cancelledBy: adminId,
            cancellationReason: 'Replaced by complete reminder plan', updatedBy: adminId,
          };
          await ReminderDefinition.updateMany(
            { _id: { $in: legacyIds } }, { $set: cancellation }, { session }
          );
          await ReminderOccurrence.updateMany(
            { _id: { $in: cancelledOccurrenceIds } },
            { $set: { ...cancellation, lockToken: '' }, $unset: { lockedAt: 1, lockExpiresAt: 1, nextAttemptAt: 1 } },
            { session }
          );
        }
      }
      await ReminderPlan.create([{
        _id: planId,
        planCode,
        planType: prepared.planType,
        reminderMode: prepared.reminderMode,
        ...(rental ? { rental: rental._id } : {}),
        customer: customer._id,
        recipientSnapshot: records.recipientSnapshot,
        startsAt: prepared.startsAt,
        endsAt: prepared.endsAt,
        rows: records.planRows,
        fingerprint,
        ...(submissionKey ? { submissionKey } : {}),
        createdBy: adminId,
        updatedBy: adminId,
        auditHistory: [{ action: 'reminder_plan_created', performedBy: adminId, performedAt: now }],
      }], { session });
      await ReminderDefinition.insertMany(records.definitions, { session });
      await ReminderOccurrence.insertMany(records.occurrences, { session });
    });
    cancelReminderTimers(cancelledOccurrenceIds);
    void processReminderEmails().catch((error) => console.error('Reminder plan scan failed:', error.message));
    const plan = await ReminderPlan.findById(planId).populate(planPopulate).lean();
    res.status(201).json(plan);
  } catch (error) {
    handlePlanError(error, next, 'Failed to create reminder plan');
  }
};

export const getReminderPlans = async (req, res, next) => {
  try {
    const pagination = parseReminderPagination(req.query);
    const filter = {};
    if (req.query.planType) filter.planType = req.query.planType;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.customer) {
      requireId(req.query.customer, 'customer');
      filter.customer = req.query.customer;
    }
    if (req.query.rental) {
      requireId(req.query.rental, 'rental');
      filter.rental = req.query.rental;
    }
    const [plans, total] = await Promise.all([
      ReminderPlan.find(filter).populate(planPopulate).sort({ updatedAt: -1 })
        .skip(pagination.skip).limit(pagination.limit).lean(),
      ReminderPlan.countDocuments(filter),
    ]);
    res.json({
      plans,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        pages: Math.ceil(total / pagination.limit),
      },
    });
  } catch (error) {
    handlePlanError(error, next, 'Failed to fetch reminder plans');
  }
};

export const getReminderPlanById = async (req, res, next) => {
  try {
    requireId(req.params.id, 'reminder plan');
    const plan = await ReminderPlan.findById(req.params.id).populate(planPopulate).lean();
    if (!plan) throw new AppError('Reminder plan not found', 404);
    const [definitions, occurrences] = await Promise.all([
      ReminderDefinition.find({ plan: plan._id }).sort({ scheduleVersion: 1, exactAt: 1 }).lean(),
      ReminderOccurrence.find({ plan: plan._id }).sort({ scheduleVersion: 1, scheduledAt: 1 }).lean(),
    ]);
    res.json({ ...plan, definitions, occurrences });
  } catch (error) {
    handlePlanError(error, next, 'Failed to fetch reminder plan');
  }
};

export const updateReminderPlan = async (req, res, next) => {
  try {
    requireId(req.params.id, 'reminder plan');
    const existingPlan = await ReminderPlan.findById(req.params.id);
    if (!existingPlan) throw new AppError('Reminder plan not found', 404);
    if (!['active', 'paused'].includes(existingPlan.status)) {
      throw new AppError('Only active or paused reminder plans can be updated', 409);
    }
    const { rental, customer, prepared } = await prepareFromRequest(req.body, existingPlan);
    const adminId = req.user._id;
    const now = new Date();
    const nextVersion = existingPlan.version + 1;
    const fingerprint = reminderPlanFingerprint(prepared);
    if (await ReminderPlan.exists({
      _id: { $ne: existingPlan._id },
      createdBy: adminId,
      fingerprint,
      status: { $in: ['active', 'paused'] },
    })) {
      throw new AppError('An identical active reminder plan already exists', 409);
    }
    const records = buildReminderPlanRecords({
      planId: existingPlan._id,
      planCode: existingPlan.planCode,
      version: nextVersion,
      prepared,
      rental,
      customer,
      adminId,
      now,
    });
    let cancelledOccurrenceIds = [];
    await mongoose.connection.transaction(async (session) => {
      const occurrences = await ReminderOccurrence.find({
        plan: existingPlan._id,
        status: { $in: MANAGEABLE_OCCURRENCE_STATUSES },
      }).select('_id').session(session).lean();
      cancelledOccurrenceIds = occurrences.map(({ _id }) => _id);
      const cancellation = {
        status: 'cancelled', cancelledAt: now, cancelledBy: adminId,
        cancellationReason: 'Superseded by reminder plan update', updatedBy: adminId,
      };
      await ReminderDefinition.updateMany(
        { plan: existingPlan._id, status: { $in: ['active', 'paused'] } },
        { $set: cancellation },
        { session }
      );
      await ReminderOccurrence.updateMany(
        { _id: { $in: cancelledOccurrenceIds } },
        { $set: { ...cancellation, lockToken: '' }, $unset: { lockedAt: 1, lockExpiresAt: 1, nextAttemptAt: 1 } },
        { session }
      );
      existingPlan.reminderMode = prepared.reminderMode;
      existingPlan.recipientSnapshot = records.recipientSnapshot;
      existingPlan.startsAt = prepared.startsAt;
      existingPlan.endsAt = prepared.endsAt;
      existingPlan.rows = records.planRows;
      existingPlan.version = nextVersion;
      existingPlan.fingerprint = fingerprint;
      existingPlan.updatedBy = adminId;
      existingPlan.auditHistory.push({
        action: 'reminder_plan_updated',
        note: `Created schedule version ${nextVersion}`,
        changes: { scheduleVersion: nextVersion },
        performedBy: adminId,
        performedAt: now,
      });
      await existingPlan.save({ session });
      await ReminderDefinition.insertMany(records.definitions, { session });
      await ReminderOccurrence.insertMany(records.occurrences, { session });
    });
    cancelReminderTimers(cancelledOccurrenceIds);
    void processReminderEmails().catch((error) => console.error('Reminder plan scan failed:', error.message));
    res.json(await ReminderPlan.findById(existingPlan._id).populate(planPopulate).lean());
  } catch (error) {
    handlePlanError(error, next, 'Failed to update reminder plan');
  }
};
