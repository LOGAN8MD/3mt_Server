import mongoose from 'mongoose';
import streamifier from 'streamifier';
import cloudinary from '../config/cloudinary.js';
import PendingProduct from '../models/PendingProduct.js';
import Product from '../models/Product.js';
import AppError from '../utils/AppError.js';
import {
  buildApprovedProductPayload,
  pickPendingProductFields,
  preparePendingProductSubmission,
  validatePendingProductData,
} from '../utils/pendingProductWorkflow.js';

const pendingProductStatuses = ['pending', 'approved', 'rejected'];

const uploadImage = (fileBuffer) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'pending-products' },
      (error, result) => {
        if (result) {
          resolve({
            url: result.secure_url,
            public_id: result.public_id,
          });
        } else {
          reject(error);
        }
      }
    );

    streamifier.createReadStream(fileBuffer).pipe(stream);
  });

const uploadImages = async (files = []) => {
  const uploadedImages = [];

  for (const file of files) {
    uploadedImages.push(await uploadImage(file.buffer));
  }

  return uploadedImages;
};

const deleteImages = async (images = []) => {
  for (const image of images) {
    if (image.public_id) {
      await cloudinary.uploader.destroy(image.public_id);
    }
  }
};

const validateObjectId = (id, fieldName = 'id') => {
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(`Invalid ${fieldName}`, 400);
  }
};

const ensurePendingStatus = (pendingProduct) => {
  if (pendingProduct.status !== 'pending') {
    throw new AppError('Only pending product requests can be changed', 400);
  }
};

export const submitPendingProduct = async (req, res, next) => {
  try {
    const productData = preparePendingProductSubmission(req.body);

    if (!req.files || req.files.length === 0) {
      return next(new AppError('At least one product image is required', 400));
    }

    const images = await uploadImages(req.files);
    const pendingProduct = await PendingProduct.create({
      ...productData,
      images,
      submittedBy: req.user._id,
      status: 'pending',
    });

    const populatedProduct = await PendingProduct.findById(pendingProduct._id)
      .populate('submittedBy', 'name email role')
      .lean();

    res.status(201).json(populatedProduct);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to submit product for review: ' + err.message, 500));
  }
};

export const getMyPendingProducts = async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const filter = { submittedBy: req.user._id };

    if (status) {
      if (!pendingProductStatuses.includes(status)) {
        throw new AppError('status must be one of: pending, approved, rejected', 400);
      }

      filter.status = status;
    }

    const products = await PendingProduct.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    res.json(products);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to fetch your product requests: ' + err.message, 500));
  }
};

export const getPendingProductsForAdmin = async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const filter = {};

    if (status) {
      if (!pendingProductStatuses.includes(status)) {
        throw new AppError('status must be one of: pending, approved, rejected', 400);
      }

      filter.status = status;
    }

    const products = await PendingProduct.find(filter)
      .populate('submittedBy', 'name email role')
      .populate('reviewedBy', 'name email role')
      .sort({ createdAt: -1 })
      .lean();

    res.json(products);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to fetch pending products: ' + err.message, 500));
  }
};

export const getPendingProductByIdForAdmin = async (req, res, next) => {
  try {
    validateObjectId(req.params.id);

    const pendingProduct = await PendingProduct.findById(req.params.id)
      .populate('submittedBy', 'name email role')
      .populate('reviewedBy', 'name email role')
      .lean();

    if (!pendingProduct) {
      return next(new AppError('Pending product not found', 404));
    }

    res.json(pendingProduct);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to fetch pending product: ' + err.message, 500));
  }
};

export const updatePendingProductForAdmin = async (req, res, next) => {
  try {
    validateObjectId(req.params.id);

    const pendingProduct = await PendingProduct.findById(req.params.id);
    if (!pendingProduct) {
      return next(new AppError('Pending product not found', 404));
    }

    ensurePendingStatus(pendingProduct);

    const requestedUpdates = pickPendingProductFields(req.body);
    const validatedProductData = validatePendingProductData(
      {
        ...pickPendingProductFields(pendingProduct.toObject()),
        ...requestedUpdates,
      },
      true
    );

    for (const field of Object.keys(requestedUpdates)) {
      pendingProduct[field] = validatedProductData[field];
    }

    if (req.body.adminNote !== undefined) {
      pendingProduct.adminNote = req.body.adminNote.trim();
    }

    if (req.files && req.files.length > 0) {
      await deleteImages(pendingProduct.images);
      pendingProduct.images = await uploadImages(req.files);
    }

    const updatedProduct = await pendingProduct.save();
    const populatedProduct = await PendingProduct.findById(updatedProduct._id)
      .populate('submittedBy', 'name email role')
      .populate('reviewedBy', 'name email role')
      .lean();

    res.json(populatedProduct);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to update pending product: ' + err.message, 500));
  }
};

export const rejectPendingProductForAdmin = async (req, res, next) => {
  try {
    validateObjectId(req.params.id);

    const pendingProduct = await PendingProduct.findById(req.params.id);
    if (!pendingProduct) {
      return next(new AppError('Pending product not found', 404));
    }

    ensurePendingStatus(pendingProduct);

    pendingProduct.status = 'rejected';
    pendingProduct.reviewedBy = req.user._id;
    pendingProduct.reviewedAt = new Date();
    pendingProduct.rejectionReason = req.body.rejectionReason?.trim() || '';
    pendingProduct.adminNote = req.body.adminNote?.trim() || pendingProduct.adminNote;

    const rejectedProduct = await pendingProduct.save();
    const populatedProduct = await PendingProduct.findById(rejectedProduct._id)
      .populate('submittedBy', 'name email role')
      .populate('reviewedBy', 'name email role')
      .lean();

    res.json(populatedProduct);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to reject pending product: ' + err.message, 500));
  }
};

export const approvePendingProductForAdmin = async (req, res, next) => {
  try {
    validateObjectId(req.params.id);

    const pendingProduct = await PendingProduct.findById(req.params.id);
    if (!pendingProduct) {
      return next(new AppError('Pending product not found', 404));
    }

    ensurePendingStatus(pendingProduct);

    if (!pendingProduct.images || pendingProduct.images.length === 0) {
      return next(new AppError('Pending product must have at least one image before approval', 400));
    }

    const createdProduct = await Product.create(buildApprovedProductPayload(pendingProduct));

    pendingProduct.status = 'approved';
    pendingProduct.reviewedBy = req.user._id;
    pendingProduct.reviewedAt = new Date();
    pendingProduct.approvedProduct = createdProduct._id;
    pendingProduct.adminNote = req.body.adminNote?.trim() || pendingProduct.adminNote;

    const approvedPendingProduct = await pendingProduct.save();

    const populatedPendingProduct = await PendingProduct.findById(approvedPendingProduct._id)
      .populate('submittedBy', 'name email role')
      .populate('reviewedBy', 'name email role')
      .populate('approvedProduct')
      .lean();

    res.status(201).json({
      pendingProduct: populatedPendingProduct,
      product: createdProduct,
    });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to approve pending product: ' + err.message, 500));
  }
};

export const deletePendingProductForAdmin = async (req, res, next) => {
  try {
    validateObjectId(req.params.id);

    const pendingProduct = await PendingProduct.findById(req.params.id);
    if (!pendingProduct) {
      return next(new AppError('Pending product not found', 404));
    }

    if (pendingProduct.status !== 'approved') {
      await deleteImages(pendingProduct.images);
    }

    await pendingProduct.deleteOne();

    res.json({ message: 'Pending product deleted successfully' });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to delete pending product: ' + err.message, 500));
  }
};
