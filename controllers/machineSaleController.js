import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import MachineSale from '../models/MachineSale.js';
import Product from '../models/Product.js';
import Rental from '../models/Rental.js';
import User from '../models/User.js';
import AppError from '../utils/AppError.js';
import { validateRentalCustomerEligibility } from '../utils/rentalCalculations.js';
import {
  assertOnlyMachineSaleFields,
  buildMachineSaleListFilter,
  parseMachineSalePagination,
  prepareMachineSaleTerms,
  validateMachineSaleEligibility,
} from '../utils/machineSaleWorkflow.js';
import {
  buildCustomerSnapshot,
  buildMachineSnapshot,
  buildRentalPayment,
} from '../utils/rentalWorkflow.js';

const salePopulate = [
  { path: 'machine', select: 'name type category subCategory brand model condition availabilityType availabilityStatus images' },
  { path: 'customer', select: 'name firstName lastName email phone address role' },
  { path: 'createdBy', select: 'name email role' },
  { path: 'updatedBy', select: 'name email role' },
];

const generateSaleCode = () => {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `SAL-${date}-${randomBytes(4).toString('hex').toUpperCase()}`;
};

const requireSaleId = (value) => {
  if (!mongoose.isValidObjectId(value)) throw new AppError('Invalid machine sale id', 400);
};

const findSaleOrThrow = async (id) => {
  requireSaleId(id);
  const sale = await MachineSale.findById(id);
  if (!sale) throw new AppError('Machine sale not found', 404);
  return sale;
};

const findSalePartyRecords = async (machineId, customerId) => {
  const [machine, customer, occupyingRental] = await Promise.all([
    Product.findById(machineId),
    User.findById(customerId),
    Rental.exists({ machine: machineId, status: { $in: ['active', 'overdue'] } }),
  ]);
  if (!machine) throw new AppError('Machine not found', 404);
  if (!customer) throw new AppError('Customer not found', 404);
  if (occupyingRental) throw new AppError('A machine with an active rental cannot be sold', 409);
  validateMachineSaleEligibility(machine);
  validateRentalCustomerEligibility(customer);
  return { machine, customer };
};

const claimMachineForSale = async (machineId) => {
  const machine = await Product.findOneAndUpdate(
    {
      _id: machineId,
      condition: 'used',
      availabilityType: { $in: ['sale', 'both'] },
      availabilityStatus: 'available',
      $or: [{ stock: 1 }, { stock: null }, { stock: { $exists: false } }],
    },
    { $set: { availabilityStatus: 'sold', availableFrom: null } },
    { new: true, runValidators: true }
  );
  if (!machine) throw new AppError('Machine is no longer available for sale', 409);
  return machine;
};

const releaseFailedSaleClaim = (machineId) =>
  Product.findOneAndUpdate(
    { _id: machineId, availabilityStatus: 'sold' },
    { $set: { availabilityStatus: 'available', availableFrom: null } },
    { new: true, runValidators: true }
  );

const existingDraftInput = (sale) => ({
  machineId: sale.machine.toString(),
  customerId: sale.customer.toString(),
  soldAt: sale.soldAt,
  agreedSalePricePaise: sale.agreedSalePricePaise,
  initialPayment: sale.payments[0]
    ? {
        amountPaise: sale.payments[0].amountPaise,
        method: sale.payments[0].method,
        paidAt: sale.payments[0].paidAt,
        reference: sale.payments[0].reference,
        note: sale.payments[0].note,
      }
    : undefined,
  notes: sale.notes,
});

const applyPreparedTerms = (sale, terms, machine, customer, adminId) => {
  sale.machine = machine._id;
  sale.customer = customer._id;
  sale.machineSnapshot = buildMachineSnapshot(machine);
  sale.customerSnapshot = buildCustomerSnapshot(customer);
  sale.soldAt = terms.soldAt;
  sale.agreedSalePricePaise = terms.agreedSalePricePaise;
  sale.paymentsReceivedPaise = terms.paymentsReceivedPaise;
  sale.remainingBalancePaise = terms.remainingBalancePaise;
  sale.payments = terms.payments;
  sale.notes = terms.notes;
  sale.updatedBy = adminId;
};

const preserveExistingPayments = (terms, sale) => {
  if (sale.paymentsReceivedPaise > terms.agreedSalePricePaise) {
    throw new AppError('Agreed sale price cannot be lower than payments already received', 400);
  }

  return {
    ...terms,
    payments: sale.payments.map((payment) => payment.toObject()),
    paymentsReceivedPaise: sale.paymentsReceivedPaise,
    remainingBalancePaise: terms.agreedSalePricePaise - sale.paymentsReceivedPaise,
  };
};

const populatedSale = (id) => MachineSale.findById(id).populate(salePopulate).lean();

const handleSaleError = (error, next, context) => {
  if (error instanceof AppError) return next(error);
  if (error?.name === 'ValidationError' || error?.name === 'CastError') {
    return next(new AppError(error.message, 400));
  }
  if (error?.code === 11000) {
    const duplicateField = Object.keys(error.keyPattern || {})[0];
    return next(new AppError(
      duplicateField === 'saleCode'
        ? 'Sale code conflict; please retry the request'
        : 'This machine already has a completed sale',
      409
    ));
  }
  return next(new AppError(`${context}: ${error.message}`, 500));
};

export const createMachineSale = async (req, res, next) => {
  let claimedMachine = null;

  try {
    assertOnlyMachineSaleFields(req.body);
    const status = req.body.status || 'draft';
    if (!['draft', 'completed'].includes(status)) {
      throw new AppError('status must be draft or completed when creating a sale', 400);
    }

    const terms = prepareMachineSaleTerms(req.body, req.user._id);
    const records = await findSalePartyRecords(terms.machineId, terms.customerId);
    if (status === 'completed') {
      claimedMachine = await claimMachineForSale(records.machine._id);
      records.machine = claimedMachine;
      terms.soldAt = terms.soldAt || new Date();
      if (terms.soldAt > new Date()) throw new AppError('soldAt cannot be in the future', 400);
    }

    const sale = new MachineSale({
      saleCode: generateSaleCode(),
      status,
      createdBy: req.user._id,
    });
    applyPreparedTerms(sale, terms, records.machine, records.customer, req.user._id);
    sale.auditHistory.push({
      action: status === 'completed' ? 'machine_sale_created_and_completed' : 'machine_sale_draft_created',
      note: status === 'completed' ? 'Machine sale completed at creation' : 'Editable machine sale draft saved',
      performedBy: req.user._id,
    });
    await sale.save();
    claimedMachine = null;

    res.status(201).json(await populatedSale(sale._id));
  } catch (error) {
    if (claimedMachine) await releaseFailedSaleClaim(claimedMachine._id).catch(() => {});
    handleSaleError(error, next, 'Failed to create machine sale');
  }
};

export const getMachineSales = async (req, res, next) => {
  try {
    const filter = buildMachineSaleListFilter(req.query);
    const pagination = parseMachineSalePagination(req.query);
    const [sales, total] = await Promise.all([
      MachineSale.find(filter)
        .populate(salePopulate)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      MachineSale.countDocuments(filter),
    ]);
    res.json({
      sales,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        pages: Math.ceil(total / pagination.limit),
      },
    });
  } catch (error) {
    handleSaleError(error, next, 'Failed to fetch machine sales');
  }
};

export const getMachineSaleById = async (req, res, next) => {
  try {
    requireSaleId(req.params.id);
    const sale = await populatedSale(req.params.id);
    if (!sale) throw new AppError('Machine sale not found', 404);
    res.json(sale);
  } catch (error) {
    handleSaleError(error, next, 'Failed to fetch machine sale');
  }
};

export const updateMachineSaleDraft = async (req, res, next) => {
  try {
    assertOnlyMachineSaleFields(req.body, { allowStatus: false });
    const sale = await findSaleOrThrow(req.params.id);
    if (sale.status !== 'draft') throw new AppError('Only draft machine sales can be edited', 409);

    let terms = prepareMachineSaleTerms(
      { ...existingDraftInput(sale), ...req.body },
      req.user._id
    );
    if (req.body.initialPayment === undefined) {
      terms = preserveExistingPayments(terms, sale);
    } else if (sale.payments.length > 1) {
      throw new AppError('Initial payment cannot be replaced after additional payments exist', 409);
    }
    const { machine, customer } = await findSalePartyRecords(terms.machineId, terms.customerId);
    applyPreparedTerms(sale, terms, machine, customer, req.user._id);
    sale.auditHistory.push({
      action: 'machine_sale_draft_updated',
      note: 'Draft sale details updated',
      changes: { fields: Object.keys(req.body) },
      performedBy: req.user._id,
    });
    await sale.save();
    res.json(await populatedSale(sale._id));
  } catch (error) {
    handleSaleError(error, next, 'Failed to update machine sale draft');
  }
};

export const completeMachineSale = async (req, res, next) => {
  let claimedMachine = null;

  try {
    const unknownFields = Object.keys(req.body || {}).filter((field) => field !== 'soldAt');
    if (unknownFields.length) {
      throw new AppError(`Unsupported completion fields: ${unknownFields.join(', ')}`, 400);
    }

    const sale = await findSaleOrThrow(req.params.id);
    if (sale.status !== 'draft') throw new AppError('Only a draft machine sale can be completed', 409);
    let terms = prepareMachineSaleTerms(existingDraftInput(sale), req.user._id);
    terms = preserveExistingPayments(terms, sale);
    const records = await findSalePartyRecords(terms.machineId, terms.customerId);
    const requestedSoldAt = req.body.soldAt ? new Date(req.body.soldAt) : terms.soldAt || new Date();
    if (Number.isNaN(requestedSoldAt.getTime())) throw new AppError('soldAt must be a valid date', 400);
    if (requestedSoldAt > new Date()) throw new AppError('soldAt cannot be in the future', 400);

    claimedMachine = await claimMachineForSale(records.machine._id);
    applyPreparedTerms(sale, { ...terms, soldAt: requestedSoldAt }, claimedMachine, records.customer, req.user._id);
    sale.status = 'completed';
    sale.auditHistory.push({
      action: 'machine_sale_completed',
      note: 'Machine marked sold and sale completed',
      performedBy: req.user._id,
    });
    await sale.save();
    claimedMachine = null;

    res.json(await populatedSale(sale._id));
  } catch (error) {
    if (claimedMachine) await releaseFailedSaleClaim(claimedMachine._id).catch(() => {});
    handleSaleError(error, next, 'Failed to complete machine sale');
  }
};

export const addMachineSalePayment = async (req, res, next) => {
  try {
    const sale = await findSaleOrThrow(req.params.id);
    if (!['draft', 'completed'].includes(sale.status)) {
      throw new AppError('Payments can be added only to draft or completed sales', 409);
    }

    const payment = buildRentalPayment(req.body, req.user._id, 'payment');
    if (payment.amountPaise > sale.remainingBalancePaise) {
      throw new AppError('Payment cannot exceed the remaining sale balance', 400);
    }
    sale.payments.push(payment);
    sale.paymentsReceivedPaise += payment.amountPaise;
    sale.remainingBalancePaise = sale.agreedSalePricePaise - sale.paymentsReceivedPaise;
    sale.updatedBy = req.user._id;
    sale.auditHistory.push({
      action: 'machine_sale_payment_recorded',
      note: payment.note,
      changes: {
        amountPaise: payment.amountPaise,
        method: payment.method,
        paymentsReceivedPaise: sale.paymentsReceivedPaise,
        remainingBalancePaise: sale.remainingBalancePaise,
      },
      performedBy: req.user._id,
    });
    await sale.save();
    res.status(201).json(await populatedSale(sale._id));
  } catch (error) {
    handleSaleError(error, next, 'Failed to record machine sale payment');
  }
};

export const cancelMachineSale = async (req, res, next) => {
  try {
    const unknownFields = Object.keys(req.body || {}).filter(
      (field) => !['reason', 'refundConfirmed'].includes(field)
    );
    if (unknownFields.length) {
      throw new AppError(`Unsupported cancellation fields: ${unknownFields.join(', ')}`, 400);
    }
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw new AppError('Cancellation reason is required', 400);
    const sale = await findSaleOrThrow(req.params.id);
    if (sale.status !== 'draft') throw new AppError('Only draft machine sales can be cancelled', 409);
    if (sale.paymentsReceivedPaise > 0 && req.body.refundConfirmed !== true) {
      throw new AppError('refundConfirmed must be true when cancelling a paid sale draft', 400);
    }

    sale.status = 'cancelled';
    sale.paymentsRefundedPaise = sale.paymentsReceivedPaise;
    sale.cancellationReason = reason;
    sale.cancelledAt = new Date();
    sale.cancelledBy = req.user._id;
    sale.updatedBy = req.user._id;
    sale.auditHistory.push({
      action: 'machine_sale_cancelled',
      note: reason,
      changes: { paymentsRefundedPaise: sale.paymentsRefundedPaise },
      performedBy: req.user._id,
    });
    await sale.save();
    res.json(await populatedSale(sale._id));
  } catch (error) {
    handleSaleError(error, next, 'Failed to cancel machine sale');
  }
};

export const deleteMachineSaleDraft = async (req, res, next) => {
  try {
    const sale = await findSaleOrThrow(req.params.id);
    if (sale.status !== 'draft') {
      throw new AppError('Only draft machine sales can be permanently deleted', 409);
    }
    if (sale.paymentsReceivedPaise > 0) {
      throw new AppError('Paid sale drafts must be cancelled to preserve refund history', 409);
    }
    await sale.deleteOne();
    res.json({ message: 'Machine sale draft deleted successfully' });
  } catch (error) {
    handleSaleError(error, next, 'Failed to delete machine sale draft');
  }
};
