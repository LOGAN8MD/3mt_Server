import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import ReminderDefinition from '../models/ReminderDefinition.js';
import ReminderOccurrence from '../models/ReminderOccurrence.js';
import Rental from '../models/Rental.js';
import User from '../models/User.js';
import { deliverReminderEmail } from '../services/reminderEmailDeliveryService.js';
import { cancelReminderTimers } from '../services/reminderProcessor.js';
import { prepareManualWhatsapp, markManualWhatsappSent } from '../services/reminderWhatsappService.js';
import { restoreDefaultRentalReturnReminders } from '../services/rentalReminderService.js';
import AppError from '../utils/AppError.js';
import {
  MANAGEABLE_OCCURRENCE_STATUSES,
  parseReminderPagination,
  prepareReminderRequest,
} from '../utils/reminderManagement.js';

const definitionPopulate = [
  { path: 'customer', select: 'name firstName lastName email phone role' },
  { path: 'rental', select: 'rentalCode status expectedReturnAt machineSnapshot customerSnapshot' },
  { path: 'createdBy', select: 'name email role' },
  { path: 'updatedBy', select: 'name email role' },
];

const requireId = (value, label) => {
  if (!mongoose.isValidObjectId(value)) throw new AppError(`Invalid ${label} id`, 400);
};

const generateDefinitionCode = () =>
  `RMD-CUSTOM-${Date.now()}-${randomBytes(4).toString('hex').toUpperCase()}`;

const recipientSnapshot = (customer) => ({
  name: String(customer.name || '').trim(),
  email: String(customer.email || '').trim().toLowerCase(),
  phone: String(customer.phone || '').trim(),
});

const validateRecipient = (customer, channels) => {
  if (!customer || customer.role !== 'customer') {
    throw new AppError('Reminder recipient must be an existing customer', 400);
  }
  if (channels.includes('email') && !customer.email) {
    throw new AppError('The selected customer does not have an email address', 400);
  }
  if (channels.includes('whatsapp') && !customer.phone) {
    throw new AppError('The selected customer does not have a phone number', 400);
  }
};

const buildOccurrences = (definition, dates, content, channels) =>
  dates.map((scheduledAt, index) => ({
    occurrenceKey: `ROC-${definition.definitionCode.slice(4)}-${index + 1}-V${definition.scheduleVersion}`,
    definition: definition._id,
    definitionType: definition.type,
    rental: definition.rental,
    customer: definition.customer,
    recipientSnapshot: definition.recipientSnapshot,
    scheduledAt,
    status: 'pending',
    scheduleVersion: definition.scheduleVersion,
    channels,
    contentSnapshot: content,
  }));

const applySchedule = (definition, schedule) => {
  definition.scheduleMode = schedule.scheduleMode;
  definition.offsetMinutes = schedule.offsetMinutes;
  definition.exactAt = schedule.exactAt;
  definition.exactDates = schedule.exactDates || [];
  definition.recurrence = schedule.recurrence;
};

const cancelUnsentOccurrences = async (definitionId, adminId, reason, now = new Date()) => {
  const occurrences = await ReminderOccurrence.find(
    { definition: definitionId, status: { $in: MANAGEABLE_OCCURRENCE_STATUSES } }
  ).select('_id').lean();
  const result = await ReminderOccurrence.updateMany(
    { definition: definitionId, status: { $in: MANAGEABLE_OCCURRENCE_STATUSES } },
    {
      $set: {
        status: 'cancelled',
        cancelledAt: now,
        cancelledBy: adminId,
        cancellationReason: reason,
        lockToken: '',
      },
      $unset: { lockedAt: 1, lockExpiresAt: 1, nextAttemptAt: 1 },
    }
  );
  cancelReminderTimers(occurrences.map(({ _id }) => _id));
  return result;
};

const loadContext = async (body) => {
  let rental = null;
  if (body.rentalId) {
    requireId(body.rentalId, 'rental');
    rental = await Rental.findById(body.rentalId);
    if (!rental) throw new AppError('Rental not found', 404);
    if (!['active', 'overdue'].includes(rental.status)) {
      throw new AppError('Custom rental reminders require an active or overdue rental', 409);
    }
  }
  return rental;
};

const handleReminderError = (error, next, context) => {
  if (error instanceof AppError) return next(error);
  if (error?.name === 'ValidationError' || error?.name === 'CastError') {
    return next(new AppError(error.message, 400));
  }
  if (error?.code === 11000) return next(new AppError('Reminder conflict; retry the request', 409));
  return next(new AppError(`${context}: ${error.message}`, 500));
};

export const previewReminder = async (req, res, next) => {
  try {
    const rental = await loadContext(req.body);
    const prepared = prepareReminderRequest(req.body, { rental });
    res.json({
      type: rental ? 'rental_return' : 'standalone_custom',
      timeZone: 'Asia/Kolkata',
      channels: prepared.channels,
      content: prepared.content,
      scheduledDates: prepared.schedule.dates,
    });
  } catch (error) {
    handleReminderError(error, next, 'Failed to preview reminder');
  }
};

export const createReminder = async (req, res, next) => {
  try {
    const rental = await loadContext(req.body);
    const prepared = prepareReminderRequest(req.body, { rental });
    const customer = await User.findById(prepared.customerId);
    validateRecipient(customer, prepared.channels);

    let replacedDefinitionIds = [];
    if (rental) {
      const existingDefinitions = await ReminderDefinition.find({
        rental: rental._id,
        type: 'rental_return',
        status: { $in: ['active', 'paused'] },
      }).select('_id');
      replacedDefinitionIds = existingDefinitions.map((item) => item._id);
    }

    const definition = new ReminderDefinition({
      definitionCode: generateDefinitionCode(),
      type: rental ? 'rental_return' : 'standalone_custom',
      rental: rental?._id,
      customer: customer._id,
      recipientSnapshot: recipientSnapshot(customer),
      channels: prepared.channels,
      contentMode: 'custom',
      content: prepared.content,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    applySchedule(definition, prepared.schedule);
    await definition.save();
    await ReminderOccurrence.insertMany(
      buildOccurrences(definition, prepared.schedule.dates, prepared.content, prepared.channels)
    );

    if (replacedDefinitionIds.length) {
        await ReminderDefinition.updateMany(
          { _id: { $in: replacedDefinitionIds } },
          {
            $set: {
              status: 'cancelled',
              cancelledAt: new Date(),
              cancelledBy: req.user._id,
              cancellationReason: 'Replaced by customized rental reminders',
              updatedBy: req.user._id,
            },
          }
        );
        await ReminderOccurrence.updateMany(
          {
            definition: { $in: replacedDefinitionIds },
            status: { $in: MANAGEABLE_OCCURRENCE_STATUSES },
          },
          {
            $set: {
              status: 'cancelled',
              cancelledAt: new Date(),
              cancelledBy: req.user._id,
              cancellationReason: 'Replaced by customized rental reminders',
            },
          }
        );
    }

    res.status(201).json(await ReminderDefinition.findById(definition._id).populate(definitionPopulate).lean());
  } catch (error) {
    handleReminderError(error, next, 'Failed to create reminder');
  }
};

export const getReminders = async (req, res, next) => {
  try {
    const pagination = parseReminderPagination(req.query);
    const filter = {};
    if (req.query.type) filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.customer) {
      requireId(req.query.customer, 'customer');
      filter.customer = req.query.customer;
    }
    if (req.query.rental) {
      requireId(req.query.rental, 'rental');
      filter.rental = req.query.rental;
    }
    const [reminders, total] = await Promise.all([
      ReminderDefinition.find(filter)
        .populate(definitionPopulate)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      ReminderDefinition.countDocuments(filter),
    ]);
    res.json({ reminders, pagination: { ...pagination, skip: undefined, total, pages: Math.ceil(total / pagination.limit) } });
  } catch (error) {
    handleReminderError(error, next, 'Failed to fetch reminders');
  }
};

export const getReminderById = async (req, res, next) => {
  try {
    requireId(req.params.id, 'reminder');
    const reminder = await ReminderDefinition.findById(req.params.id).populate(definitionPopulate).lean();
    if (!reminder) throw new AppError('Reminder not found', 404);
    const occurrences = await ReminderOccurrence.find({ definition: reminder._id })
      .sort({ scheduledAt: 1 })
      .lean();
    res.json({ ...reminder, occurrences });
  } catch (error) {
    handleReminderError(error, next, 'Failed to fetch reminder');
  }
};

export const updateReminder = async (req, res, next) => {
  try {
    requireId(req.params.id, 'reminder');
    const definition = await ReminderDefinition.findById(req.params.id);
    if (!definition) throw new AppError('Reminder not found', 404);
    if (!['active', 'paused'].includes(definition.status)) {
      throw new AppError('Only active or paused reminders can be edited', 409);
    }
    const sentExists = await ReminderOccurrence.exists({
      definition: definition._id,
      $or: [
        { status: { $in: ['sent', 'partially_failed'] } },
        { 'emailDelivery.status': { $in: ['processing', 'accepted', 'delivered', 'uncertain'] } },
        { 'whatsappDelivery.status': { $in: ['manual_sent', 'accepted', 'delivered'] } },
      ],
    });
    if (sentExists) throw new AppError('A reminder with delivery history cannot be edited', 409);

    const rental = definition.rental ? await Rental.findById(definition.rental) : null;
    if (definition.rental && (!rental || !['active', 'overdue'].includes(rental.status))) {
      throw new AppError('Rental reminder can be edited only while its rental is active', 409);
    }
    const prepared = prepareReminderRequest(
      { ...req.body, customerId: definition.customer.toString() },
      { rental }
    );
    const customer = await User.findById(definition.customer);
    validateRecipient(customer, prepared.channels);
    await cancelUnsentOccurrences(
      definition._id,
      req.user._id,
      'Superseded by reminder schedule edit'
    );

    definition.scheduleVersion += 1;
    definition.channels = prepared.channels;
    definition.contentMode = 'custom';
    definition.content = prepared.content;
    definition.recipientSnapshot = recipientSnapshot(customer);
    definition.updatedBy = req.user._id;
    applySchedule(definition, prepared.schedule);
    definition.auditHistory.push({
      action: 'reminder_updated',
      note: 'Unsent reminder schedule and content updated',
      performedBy: req.user._id,
    });
    await definition.save();
    await ReminderOccurrence.insertMany(
      buildOccurrences(definition, prepared.schedule.dates, prepared.content, prepared.channels)
    );
    res.json(await ReminderDefinition.findById(definition._id).populate(definitionPopulate).lean());
  } catch (error) {
    handleReminderError(error, next, 'Failed to update reminder');
  }
};

const setReminderStatus = (status) => async (req, res, next) => {
  try {
    requireId(req.params.id, 'reminder');
    const definition = await ReminderDefinition.findById(req.params.id);
    if (!definition) throw new AppError('Reminder not found', 404);
    if (status === 'paused' && definition.status !== 'active') {
      throw new AppError('Only active reminders can be paused', 409);
    }
    if (status === 'active' && definition.status !== 'paused') {
      throw new AppError('Only paused reminders can be resumed', 409);
    }
    definition.status = status;
    definition.updatedBy = req.user._id;
    definition.auditHistory.push({
      action: status === 'paused' ? 'reminder_paused' : 'reminder_resumed',
      performedBy: req.user._id,
    });
    await definition.save();
    if (status === 'paused') {
      const occurrences = await ReminderOccurrence.find({
        definition: definition._id,
        status: { $in: MANAGEABLE_OCCURRENCE_STATUSES },
      }).select('_id').lean();
      cancelReminderTimers(occurrences.map(({ _id }) => _id));
    }
    res.json(definition);
  } catch (error) {
    handleReminderError(error, next, `Failed to ${status === 'paused' ? 'pause' : 'resume'} reminder`);
  }
};

export const pauseReminder = setReminderStatus('paused');
export const resumeReminder = setReminderStatus('active');

export const cancelReminder = async (req, res, next) => {
  try {
    requireId(req.params.id, 'reminder');
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw new AppError('Cancellation reason is required', 400);
    const definition = await ReminderDefinition.findById(req.params.id);
    if (!definition) throw new AppError('Reminder not found', 404);
    if (!['active', 'paused'].includes(definition.status)) {
      throw new AppError('Only active or paused reminders can be cancelled', 409);
    }
    const now = new Date();
    definition.status = 'cancelled';
    definition.cancelledAt = now;
    definition.cancelledBy = req.user._id;
    definition.cancellationReason = reason;
    definition.updatedBy = req.user._id;
    await definition.save();
    await cancelUnsentOccurrences(definition._id, req.user._id, reason, now);
    res.json(definition);
  } catch (error) {
    handleReminderError(error, next, 'Failed to cancel reminder');
  }
};

export const getReminderOccurrences = async (req, res, next) => {
  try {
    const pagination = parseReminderPagination(req.query);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.definition) {
      requireId(req.query.definition, 'definition');
      filter.definition = req.query.definition;
    }
    if (req.query.rental) {
      requireId(req.query.rental, 'rental');
      filter.rental = req.query.rental;
    }
    const [occurrences, total] = await Promise.all([
      ReminderOccurrence.find(filter)
        .populate('definition', 'status scheduleVersion')
        .sort({ scheduledAt: 1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      ReminderOccurrence.countDocuments(filter),
    ]);
    res.json({ occurrences, pagination: { page: pagination.page, limit: pagination.limit, total, pages: Math.ceil(total / pagination.limit) } });
  } catch (error) {
    handleReminderError(error, next, 'Failed to fetch reminder occurrences');
  }
};

export const cancelReminderOccurrence = async (req, res, next) => {
  try {
    requireId(req.params.id, 'occurrence');
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw new AppError('Cancellation reason is required', 400);
    const occurrence = await ReminderOccurrence.findOneAndUpdate(
      { _id: req.params.id, status: { $in: MANAGEABLE_OCCURRENCE_STATUSES } },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: req.user._id,
          cancellationReason: reason,
          lockToken: '',
        },
        $unset: { lockedAt: 1, lockExpiresAt: 1, nextAttemptAt: 1 },
      },
      { new: true }
    );
    if (!occurrence) throw new AppError('Only an unsent occurrence can be cancelled', 409);
    cancelReminderTimers([occurrence._id]);
    res.json(occurrence);
  } catch (error) {
    handleReminderError(error, next, 'Failed to cancel reminder occurrence');
  }
};

export const sendOccurrenceEmail = async (req, res, next) => {
  try {
    requireId(req.params.id, 'occurrence');
    const result = await deliverReminderEmail(req.params.id);
    res.status(result.skipped ? 200 : 202).json(result);
  } catch (error) {
    handleReminderError(error, next, 'Failed to deliver reminder email');
  }
};

export const getOccurrenceWhatsapp = async (req, res, next) => {
  try {
    requireId(req.params.id, 'occurrence');
    res.json(await prepareManualWhatsapp(req.params.id));
  } catch (error) {
    handleReminderError(error, next, 'Failed to prepare WhatsApp message');
  }
};

export const confirmOccurrenceWhatsapp = async (req, res, next) => {
  try {
    requireId(req.params.id, 'occurrence');
    if (req.body.confirmed !== true) throw new AppError('Confirm that you sent the WhatsApp message', 400);
    res.json(await markManualWhatsappSent(req.params.id, req.user._id));
  } catch (error) {
    handleReminderError(error, next, 'Failed to record manual WhatsApp send');
  }
};

export const restoreRentalDefaults = async (req, res, next) => {
  try {
    requireId(req.params.rentalId, 'rental');
    const rental = await Rental.findById(req.params.rentalId);
    if (!rental) throw new AppError('Rental not found', 404);
    if (!['active', 'overdue'].includes(rental.status)) {
      throw new AppError('Defaults can be restored only for an active or overdue rental', 409);
    }
    const occurrences = await restoreDefaultRentalReturnReminders(rental, req.user._id);
    res.json({ message: 'Default rental reminders restored', occurrences });
  } catch (error) {
    handleReminderError(error, next, 'Failed to restore default rental reminders');
  }
};
