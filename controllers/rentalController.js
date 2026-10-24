import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Rental from '../models/Rental.js';
import User from '../models/User.js';
import {
  cancelRentalReminders,
  createRentalLifecycleReminders,
  rescheduleRentalReturnReminders,
} from '../services/rentalReminderService.js';
import AppError from '../utils/AppError.js';
import {
  calculateOverdueEstimate,
  calculateRentalSettlement,
  calculateRentalQuote,
  validateRentalCustomerEligibility,
  validateRentalMachineEligibility,
} from '../utils/rentalCalculations.js';
import {
  assertOnlyRentalFields,
  buildCustomerSnapshot,
  buildMachineSnapshot,
  buildRentalPayment,
  buildRentalListFilter,
  parseRentalPagination,
  prepareRentalReturn,
  prepareRentalTerms,
} from '../utils/rentalWorkflow.js';
import { prepareRentalReminderSettings } from '../utils/rentalReminderSettings.js';

const rentalPopulate = [
  { path: 'machine', select: 'name type category subCategory brand model condition availabilityType availabilityStatus images' },
  { path: 'customer', select: 'name firstName lastName email phone address role' },
  { path: 'createdBy', select: 'name email role' },
  { path: 'updatedBy', select: 'name email role' },
];

const generateRentalCode = () => {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `RNT-${date}-${randomBytes(4).toString('hex').toUpperCase()}`;
};

const requireRentalId = (value) => {
  if (!mongoose.isValidObjectId(value)) {
    throw new AppError('Invalid rental id', 400);
  }
};

const findRentalOrThrow = async (id) => {
  requireRentalId(id);
  const rental = await Rental.findById(id);

  if (!rental) throw new AppError('Rental not found', 404);
  return rental;
};

const findRentalPartyRecords = async (machineId, customerId) => {
  const [machine, customer] = await Promise.all([
    Product.findById(machineId),
    User.findById(customerId),
  ]);

  if (!machine) throw new AppError('Machine not found', 404);
  if (!customer) throw new AppError('Customer not found', 404);

  validateRentalMachineEligibility(machine);
  validateRentalCustomerEligibility(customer);
  return { machine, customer };
};

const claimMachine = async (machineId, expectedReturnAt) => {
  const claimedMachine = await Product.findOneAndUpdate(
    {
      _id: machineId,
      condition: 'used',
      availabilityType: { $in: ['rent', 'both'] },
      availabilityStatus: 'available',
      $or: [
        { stock: 1 },
        { stock: null },
        { stock: { $exists: false } },
      ],
    },
    {
      $set: {
        availabilityStatus: 'on_rent',
        availableFrom: expectedReturnAt,
      },
    },
    { new: true, runValidators: true }
  );

  if (!claimedMachine) {
    throw new AppError('Machine is no longer available for rental', 409);
  }

  return claimedMachine;
};

const releaseMachine = (machineId) =>
  Product.findOneAndUpdate(
    { _id: machineId, availabilityStatus: 'on_rent' },
    { $set: { availabilityStatus: 'available', availableFrom: null } },
    { new: true, runValidators: true }
  );

const syncOverdueRecords = (adminId, now = new Date()) =>
  Rental.updateMany(
    {
      status: 'active',
      expectedReturnAt: { $lt: now },
    },
    {
      $set: { status: 'overdue', occupiesMachine: true, updatedBy: adminId },
      $push: {
        auditHistory: {
          action: 'rental_marked_overdue',
          note: 'Expected return time passed without a recorded return',
          performedBy: adminId,
          performedAt: now,
        },
      },
    }
  );

const rentalChargeInput = (rental) => ({
  handoverAt: rental.handoverAt,
  expectedReturnAt: rental.expectedReturnAt,
  billingPeriod: rental.billingPeriod,
  agreedRatePaise: rental.agreedRatePaise,
  dailyLateRatePaise: rental.dailyLateRatePaise,
});

const withOverdueEstimate = (rental, now = new Date()) => {
  if (!rental || rental.status !== 'overdue') return rental;

  const estimate = calculateOverdueEstimate({
    ...rentalChargeInput(rental),
    currentAt: now,
  });

  return {
    ...rental,
    overdueEstimate: {
      calculatedAt: now,
      lateDays: estimate.lateDays,
      lateChargePaise: estimate.lateChargePaise,
      estimatedFinalRentalChargePaise: estimate.finalRentalChargePaise,
    },
  };
};


const existingDraftInput = (rental) => ({
  machineId: rental.machine.toString(),
  customerId: rental.customer.toString(),
  handoverAt: rental.handoverAt,
  expectedReturnAt: rental.expectedReturnAt,
  billingPeriod: rental.billingPeriod,
  agreedRatePaise: rental.agreedRatePaise,
  dailyLateRatePaise: rental.dailyLateRatePaise,
  securityDepositReceivedPaise: rental.securityDepositReceivedPaise,
  initialPayment: rental.payments[0]
    ? {
        amountPaise: rental.payments[0].amountPaise,
        method: rental.payments[0].method,
        paidAt: rental.payments[0].paidAt,
        reference: rental.payments[0].reference,
        note: rental.payments[0].note,
      }
    : undefined,
  notes: rental.notes,
  reminderSettings: rental.reminderSettings?.toObject
    ? rental.reminderSettings.toObject()
    : rental.reminderSettings,
});

const applyPreparedTerms = (rental, terms, machine, customer, adminId) => {
  rental.machine = machine._id;
  rental.customer = customer._id;
  rental.machineSnapshot = buildMachineSnapshot(machine);
  rental.customerSnapshot = buildCustomerSnapshot(customer);
  rental.handoverAt = terms.handoverAt;
  rental.expectedReturnAt = terms.expectedReturnAt;
  rental.billingPeriod = terms.billingPeriod;
  rental.agreedRatePaise = terms.agreedRatePaise;
  rental.plannedBillablePeriods = terms.plannedBillablePeriods;
  rental.plannedExtraDays = terms.plannedExtraDays;
  rental.derivedDailyRatePaise = terms.derivedDailyRatePaise;
  rental.plannedRentalChargePaise = terms.plannedRentalChargePaise;
  rental.dailyLateRatePaise = terms.dailyLateRatePaise;
  rental.securityDepositReceivedPaise = terms.securityDepositReceivedPaise;
  rental.rentalPaymentsReceivedPaise = terms.rentalPaymentsReceivedPaise;
  rental.payments = terms.payments;
  rental.notes = terms.notes;
  rental.updatedBy = adminId;
};

const applyReminderSettings = (rental, value, customer, now = new Date()) => {
  const { settings } = prepareRentalReminderSettings(value, { rental, customer, now });
  rental.reminderSettings = settings;
  return settings;
};

const populatedRental = (id) => Rental.findById(id).populate(rentalPopulate).lean();

const handleRentalError = (error, next, context) => {
  if (error instanceof AppError) return next(error);
  if (error?.name === 'ValidationError' || error?.name === 'CastError') {
    return next(new AppError(error.message, 400));
  }
  if (error?.code === 11000) {
    const duplicateField = Object.keys(error.keyPattern || {})[0];
    const message = duplicateField === 'rentalCode'
      ? 'Rental code conflict; please retry the request'
      : 'This machine already has an active rental';
    return next(new AppError(message, 409));
  }
  return next(new AppError(`${context}: ${error.message}`, 500));
};

export const quoteRental = async (req, res, next) => {
  try {
    const quote = calculateRentalQuote({
      handoverAt: req.body.handoverAt,
      expectedReturnAt: req.body.expectedReturnAt,
      billingPeriod: req.body.billingPeriod,
      agreedRatePaise: req.body.agreedRatePaise,
    });

    res.json({
      billingPeriod: quote.billingPeriod,
      agreedRatePaise: quote.agreedRatePaise,
      derivedDailyRatePaise: quote.derivedDailyRatePaise,
      plannedBillablePeriods: quote.fullPeriods,
      plannedExtraDays: quote.extraDays,
      plannedRentalChargePaise: quote.plannedRentalChargePaise,
      handoverAt: quote.handoverAt,
      expectedReturnAt: quote.expectedReturnAt,
    });
  } catch (error) {
    handleRentalError(error, next, 'Failed to calculate rental quote');
  }
};

export const createRental = async (req, res, next) => {
  let claimedMachine = null;
  let createdRental = null;

  try {
    assertOnlyRentalFields(req.body);
    const status = req.body.status || 'draft';
    if (!['draft', 'active'].includes(status)) {
      throw new AppError('status must be draft or active when creating a rental', 400);
    }

    const terms = prepareRentalTerms(req.body, req.user._id);
    const records = await findRentalPartyRecords(terms.machineId, terms.customerId);
    const rental = new Rental({
      rentalCode: generateRentalCode(),
      status,
      createdBy: req.user._id,
    });
    applyPreparedTerms(rental, terms, records.machine, records.customer, req.user._id);
    applyReminderSettings(rental, req.body.reminderSettings, records.customer);
    if (status === 'active') {
      claimedMachine = await claimMachine(records.machine._id, terms.expectedReturnAt);
      records.machine = claimedMachine;
      applyPreparedTerms(rental, terms, records.machine, records.customer, req.user._id);
    }
    rental.auditHistory.push({
      action: status === 'active' ? 'rental_created_and_activated' : 'rental_draft_created',
      note: status === 'active' ? 'Rental confirmed at creation' : 'Editable rental draft saved',
      performedBy: req.user._id,
    });
    await rental.save();
    createdRental = rental;
    if (status === 'active') {
      await createRentalLifecycleReminders(rental, req.user._id, { customer: records.customer });
      claimedMachine = null;
    }

    res.status(201).json(await populatedRental(rental._id));
  } catch (error) {
    if (createdRental?.status === 'active' && claimedMachine) {
      await Rental.deleteOne({ _id: createdRental._id, status: 'active' }).catch(() => {});
    }
    if (claimedMachine) await releaseMachine(claimedMachine._id).catch(() => {});
    handleRentalError(error, next, 'Failed to create rental');
  }
};

export const getRentals = async (req, res, next) => {
  try {
    const now = new Date();
    await syncOverdueRecords(req.user._id, now);
    const filter = buildRentalListFilter(req.query);
    const pagination = parseRentalPagination(req.query);
    const [rentals, total] = await Promise.all([
      Rental.find(filter)
        .populate(rentalPopulate)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      Rental.countDocuments(filter),
    ]);

    res.json({
      rentals: rentals.map((rental) => withOverdueEstimate(rental, now)),
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        pages: Math.ceil(total / pagination.limit),
      },
    });
  } catch (error) {
    handleRentalError(error, next, 'Failed to fetch rentals');
  }
};

export const getRentalById = async (req, res, next) => {
  try {
    const now = new Date();
    await syncOverdueRecords(req.user._id, now);
    requireRentalId(req.params.id);
    const rental = await populatedRental(req.params.id);
    if (!rental) throw new AppError('Rental not found', 404);
    res.json(withOverdueEstimate(rental, now));
  } catch (error) {
    handleRentalError(error, next, 'Failed to fetch rental');
  }
};

export const updateRentalDraft = async (req, res, next) => {
  try {
    assertOnlyRentalFields(req.body, { allowStatus: false });
    const rental = await findRentalOrThrow(req.params.id);
    if (rental.status !== 'draft') {
      throw new AppError('Only draft rentals can be edited with this endpoint', 409);
    }

    const input = { ...existingDraftInput(rental), ...req.body };
    const terms = prepareRentalTerms(input, req.user._id);
    const { machine, customer } = await findRentalPartyRecords(terms.machineId, terms.customerId);
    applyPreparedTerms(rental, terms, machine, customer, req.user._id);
    applyReminderSettings(rental, input.reminderSettings, customer);
    rental.auditHistory.push({
      action: 'rental_draft_updated',
      note: 'Draft details and calculated quote updated',
      changes: { fields: Object.keys(req.body) },
      performedBy: req.user._id,
    });
    await rental.save();

    res.json(await populatedRental(rental._id));
  } catch (error) {
    handleRentalError(error, next, 'Failed to update rental draft');
  }
};

export const activateRental = async (req, res, next) => {
  let claimedMachine = null;
  let activatedRental = null;

  try {
    const rental = await findRentalOrThrow(req.params.id);
    if (rental.status !== 'draft') {
      throw new AppError('Only a draft rental can be activated', 409);
    }

    const terms = prepareRentalTerms(existingDraftInput(rental), req.user._id);
    const records = await findRentalPartyRecords(terms.machineId, terms.customerId);
    applyReminderSettings(rental, rental.reminderSettings, records.customer);
    claimedMachine = await claimMachine(records.machine._id, terms.expectedReturnAt);
    applyPreparedTerms(rental, terms, claimedMachine, records.customer, req.user._id);
    rental.status = 'active';
    rental.auditHistory.push({
      action: 'rental_activated',
      note: 'Machine handover confirmed and rental activated',
      performedBy: req.user._id,
    });
    await rental.save();
    activatedRental = rental;
    await createRentalLifecycleReminders(rental, req.user._id, { customer: records.customer });
    claimedMachine = null;

    res.json(await populatedRental(rental._id));
  } catch (error) {
    if (activatedRental && claimedMachine) {
      activatedRental.status = 'draft';
      activatedRental.auditHistory.pop();
      await activatedRental.save().catch(() => {});
    }
    if (claimedMachine) await releaseMachine(claimedMachine._id).catch(() => {});
    handleRentalError(error, next, 'Failed to activate rental');
  }
};

export const cancelRental = async (req, res, next) => {
  let previousStatus;

  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw new AppError('Cancellation reason is required', 400);

    const rental = await findRentalOrThrow(req.params.id);
    if (!['draft', 'active', 'overdue'].includes(rental.status)) {
      throw new AppError('Only draft, active, or overdue rentals can be cancelled', 409);
    }

    previousStatus = rental.status;
    rental.status = 'cancelled';
    rental.cancellationReason = reason;
    rental.cancelledAt = new Date();
    rental.cancelledBy = req.user._id;
    rental.updatedBy = req.user._id;
    rental.auditHistory.push({
      action: 'rental_cancelled',
      note: reason,
      changes: { previousStatus },
      performedBy: req.user._id,
    });
    await rental.save();

    if (['active', 'overdue'].includes(previousStatus)) {
      const released = await releaseMachine(rental.machine);
      if (!released) {
        rental.status = previousStatus;
        rental.cancellationReason = '';
        rental.cancelledAt = undefined;
        rental.cancelledBy = undefined;
        rental.auditHistory.pop();
        await rental.save();
        throw new AppError('Machine could not be released; rental cancellation was rolled back', 409);
      }
    }

    await cancelRentalReminders(
      rental._id,
      req.user._id,
      `Rental cancelled: ${reason}`
    );

    res.json(await populatedRental(rental._id));
  } catch (error) {
    handleRentalError(error, next, 'Failed to cancel rental');
  }
};

export const syncOverdueRentals = async (req, res, next) => {
  try {
    const now = new Date();
    const result = await syncOverdueRecords(req.user._id, now);

    res.json({
      checkedAt: now,
      rentalsMarkedOverdue: result.modifiedCount,
    });
  } catch (error) {
    handleRentalError(error, next, 'Failed to synchronize overdue rentals');
  }
};

export const extendRental = async (req, res, next) => {
  let productUpdated = false;
  let previousExpectedReturnAt;
  let rentalMachineId;
  let originalRental;
  let extensionSaved = false;

  try {
    const rental = await findRentalOrThrow(req.params.id);
    rentalMachineId = rental.machine;
    if (!['active', 'overdue'].includes(rental.status)) {
      throw new AppError('Only active or overdue rentals can be extended', 409);
    }

    const expectedReturnAt = new Date(req.body.expectedReturnAt);
    if (!req.body.expectedReturnAt || Number.isNaN(expectedReturnAt.getTime())) {
      throw new AppError('expectedReturnAt must be a valid date', 400);
    }
    if (expectedReturnAt <= rental.expectedReturnAt) {
      throw new AppError('Extended return time must be after the current expected return time', 400);
    }

    const note = String(req.body.note || '').trim();
    if (!note) throw new AppError('Extension note is required', 400);
    const unknownFields = Object.keys(req.body).filter(
      (field) => !['expectedReturnAt', 'note'].includes(field)
    );
    if (unknownFields.length) {
      throw new AppError(`Unsupported extension fields: ${unknownFields.join(', ')}`, 400);
    }

    previousExpectedReturnAt = rental.expectedReturnAt;
    originalRental = rental.toObject({ depopulate: true });
    const quote = calculateRentalQuote({
      handoverAt: rental.handoverAt,
      expectedReturnAt,
      billingPeriod: rental.billingPeriod,
      agreedRatePaise: rental.agreedRatePaise,
    });
    const product = await Product.findOneAndUpdate(
      { _id: rental.machine, availabilityStatus: 'on_rent' },
      { $set: { availableFrom: expectedReturnAt } },
      { new: true, runValidators: true }
    );
    if (!product) throw new AppError('Rental machine is not currently marked on rent', 409);
    productUpdated = true;

    const previousStatus = rental.status;
    rental.expectedReturnAt = expectedReturnAt;
    rental.plannedBillablePeriods = quote.fullPeriods;
    rental.plannedExtraDays = quote.extraDays;
    rental.plannedRentalChargePaise = quote.plannedRentalChargePaise;
    rental.status = expectedReturnAt > new Date() ? 'active' : 'overdue';
    rental.updatedBy = req.user._id;
    rental.auditHistory.push({
      action: 'rental_extended',
      note,
      changes: {
        previousExpectedReturnAt,
        expectedReturnAt,
        previousStatus,
        status: rental.status,
        plannedRentalChargePaise: quote.plannedRentalChargePaise,
      },
      performedBy: req.user._id,
    });
    await rental.save();
    extensionSaved = true;
    await rescheduleRentalReturnReminders(rental, req.user._id);
    extensionSaved = false;
    productUpdated = false;

    res.json(await populatedRental(rental._id));
  } catch (error) {
    if (extensionSaved && originalRental) {
      await Rental.collection.replaceOne({ _id: originalRental._id }, originalRental).catch(() => {});
    }
    if (productUpdated) {
      await Product.findByIdAndUpdate(
        rentalMachineId,
        { $set: { availableFrom: previousExpectedReturnAt } },
        { runValidators: true }
      ).catch(() => {});
    }
    handleRentalError(error, next, 'Failed to extend rental');
  }
};

export const addRentalPayment = async (req, res, next) => {
  try {
    const rental = await findRentalOrThrow(req.params.id);
    if (!['active', 'overdue', 'returned'].includes(rental.status)) {
      throw new AppError('Payments can be added only to active, overdue, or returned rentals', 409);
    }

    const payment = buildRentalPayment(req.body, req.user._id);
    if (rental.status === 'returned' && payment.amountPaise > rental.remainingBalancePaise) {
      throw new AppError('Payment cannot exceed the remaining rental balance', 400);
    }

    rental.payments.push(payment);
    rental.rentalPaymentsReceivedPaise += payment.amountPaise;
    rental.updatedBy = req.user._id;

    if (rental.status === 'returned') {
      const settlement = calculateRentalSettlement({
        finalRentalChargePaise: rental.finalRentalChargePaise,
        otherApprovedChargesPaise: rental.otherApprovedChargesPaise,
        rentalPaymentsReceivedPaise: rental.rentalPaymentsReceivedPaise,
        securityDepositReceivedPaise: rental.securityDepositReceivedPaise,
        depositAppliedPaise: rental.depositAppliedPaise,
      });
      rental.rentalPaymentRefundPaise = settlement.rentalPaymentRefundPaise;
      rental.depositRefundPaise = settlement.depositRefundPaise;
      rental.remainingBalancePaise = settlement.remainingBalancePaise;
    }

    rental.auditHistory.push({
      action: 'rental_payment_recorded',
      note: payment.note,
      changes: {
        amountPaise: payment.amountPaise,
        method: payment.method,
        rentalPaymentsReceivedPaise: rental.rentalPaymentsReceivedPaise,
      },
      performedBy: req.user._id,
    });
    await rental.save();

    res.status(201).json(await populatedRental(rental._id));
  } catch (error) {
    handleRentalError(error, next, 'Failed to record rental payment');
  }
};

export const previewRentalReturn = async (req, res, next) => {
  try {
    const rental = await findRentalOrThrow(req.params.id);
    if (!['active', 'overdue'].includes(rental.status)) {
      throw new AppError('Only active or overdue rentals can be returned', 409);
    }

    const prepared = prepareRentalReturn(rental, req.body, req.user._id);
    res.json({
      actualReturnAt: prepared.actualReturnAt,
      previewedAt: prepared.returnRecordedAt,
      plannedRentalChargePaise: prepared.charge.planned.plannedRentalChargePaise,
      actualBillablePeriods: prepared.charge.actualUsage.fullPeriods,
      actualExtraDays: prepared.charge.actualUsage.extraDays,
      lateDays: prepared.charge.lateDays,
      lateChargePaise: prepared.charge.lateChargePaise,
      finalRentalChargePaise: prepared.charge.finalRentalChargePaise,
      otherApprovedChargesPaise: prepared.otherApprovedChargesPaise,
      rentalPaymentsReceivedPaise: prepared.rentalPaymentsReceivedPaise,
      securityDepositReceivedPaise: rental.securityDepositReceivedPaise,
      ...prepared.settlement,
      machineStatusAfterReturn: 'available',
    });
  } catch (error) {
    handleRentalError(error, next, 'Failed to preview rental return');
  }
};

export const returnRental = async (req, res, next) => {
  let savedAsReturned = false;
  let originalRental;

  try {
    const rental = await findRentalOrThrow(req.params.id);
    if (!['active', 'overdue'].includes(rental.status)) {
      throw new AppError('Only active or overdue rentals can be returned', 409);
    }

    originalRental = rental.toObject({ depopulate: true });
    const prepared = prepareRentalReturn(rental, req.body, req.user._id);
    rental.status = 'returned';
    rental.actualReturnAt = prepared.actualReturnAt;
    rental.returnRecordedAt = prepared.returnRecordedAt;
    rental.actualBillablePeriods = prepared.charge.actualUsage.fullPeriods;
    rental.actualExtraDays = prepared.charge.actualUsage.extraDays;
    rental.lateDays = prepared.charge.lateDays;
    rental.lateChargePaise = prepared.charge.lateChargePaise;
    rental.finalRentalChargePaise = prepared.charge.finalRentalChargePaise;
    rental.otherApprovedChargesPaise = prepared.otherApprovedChargesPaise;
    rental.rentalPaymentsReceivedPaise = prepared.rentalPaymentsReceivedPaise;
    rental.rentalPaymentRefundPaise = prepared.settlement.rentalPaymentRefundPaise;
    rental.approvedDepositDeductionsPaise = prepared.settlement.depositAppliedPaise;
    rental.depositAppliedPaise = prepared.settlement.depositAppliedPaise;
    rental.depositRefundPaise = prepared.settlement.depositRefundPaise;
    rental.remainingBalancePaise = prepared.settlement.remainingBalancePaise;
    rental.returnMachineStatus = 'available';
    rental.returnConditionNote = prepared.returnNote;
    rental.settlementNote = prepared.settlementNote;
    rental.updatedBy = req.user._id;
    if (prepared.payment) rental.payments.push(prepared.payment);
    rental.auditHistory.push({
      action: 'rental_return_recorded',
      note: prepared.settlementNote,
      changes: {
        actualReturnAt: prepared.actualReturnAt,
        returnRecordedAt: prepared.returnRecordedAt,
        lateDays: prepared.charge.lateDays,
        finalRentalChargePaise: prepared.charge.finalRentalChargePaise,
        depositAppliedPaise: prepared.settlement.depositAppliedPaise,
        depositRefundPaise: prepared.settlement.depositRefundPaise,
        remainingBalancePaise: prepared.settlement.remainingBalancePaise,
        machineStatus: 'available',
      },
      performedBy: req.user._id,
    });
    await rental.save();
    savedAsReturned = true;

    const released = await releaseMachine(rental.machine);
    if (!released) {
      await Rental.collection.replaceOne({ _id: rental._id }, originalRental);
      savedAsReturned = false;
      throw new AppError('Machine could not be released; return recording was rolled back', 409);
    }
    savedAsReturned = false;
    await cancelRentalReminders(
      rental._id,
      req.user._id,
      'Rental completed and machine returned'
    );

    res.json(await populatedRental(rental._id));
  } catch (error) {
    if (savedAsReturned && originalRental) {
      await Rental.collection.replaceOne({ _id: originalRental._id }, originalRental).catch(() => {});
    }
    handleRentalError(error, next, 'Failed to record rental return');
  }
};

export const deleteRentalDraft = async (req, res, next) => {
  try {
    const rental = await findRentalOrThrow(req.params.id);
    if (rental.status !== 'draft') {
      throw new AppError('Only draft rentals can be permanently deleted', 409);
    }

    await rental.deleteOne();
    res.json({ message: 'Rental draft deleted successfully' });
  } catch (error) {
    handleRentalError(error, next, 'Failed to delete rental draft');
  }
};
