import User from '../models/User.js';
import Enquiry from '../models/Enquiry.js';
import AppError from '../utils/AppError.js';
import mongoose from 'mongoose';

const adminCreatableRoles = ['employee', 'admin'];
const adminAssignableRoles = ['customer', 'employee', 'admin'];
const editableProfileFields = ['firstName', 'lastName', 'phone', 'address'];

const buildUserProfileResponse = (user) => ({
  _id: user._id,
  name: user.name,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  phone: user.phone,
  address: user.address,
  authProvider: user.authProvider,
  verificationMethod: user.verificationMethod,
  isVerified: user.isVerified,
  verifiedEmail: user.verifiedEmail,
  verifiedPhone: user.verifiedPhone,
  role: user.role,
  isAdmin: user.isAdmin,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const normalizePhone = (phone) => phone?.replace(/[^\d+]/g, '').trim();

const buildFullName = (firstName, lastName, fallbackName) => {
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  return fullName || fallbackName;
};

const normalizeAdminCreatedRole = (role) => {
  if (!role || role === 'user') {
    return 'employee';
  }

  return role;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseDateFilter = (value, fieldName, useEndOfDay = false) => {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(`${fieldName} must be a valid date`, 400);
  }

  if (useEndOfDay) {
    date.setHours(23, 59, 59, 999);
  }

  return date;
};

export const getMyProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('-password');

    if (!user) {
      return next(new AppError('User not found', 404));
    }

    res.json(buildUserProfileResponse(user));
  } catch (err) {
    next(new AppError('Failed to fetch profile: ' + err.message, 500));
  }
};

export const updateMyProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return next(new AppError('User not found', 404));
    }

    const unknownFields = Object.keys(req.body).filter(
      (field) => !editableProfileFields.includes(field)
    );

    if (unknownFields.length > 0) {
      return next(
        new AppError(
          `Only these profile fields can be updated: ${editableProfileFields.join(', ')}`,
          400
        )
      );
    }

    if (req.body.firstName !== undefined) {
      user.firstName = req.body.firstName.trim();
    }

    if (req.body.lastName !== undefined) {
      user.lastName = req.body.lastName.trim();
    }

    if (req.body.address !== undefined) {
      user.address = req.body.address.trim();
    }

    if (req.body.phone !== undefined) {
      const normalizedPhone = normalizePhone(req.body.phone);

      if (normalizedPhone) {
        const existingPhoneUser = await User.findOne({
          phone: normalizedPhone,
          _id: { $ne: user._id },
        });

        if (existingPhoneUser) {
          return next(new AppError('Phone number is already used by another account', 400));
        }
      }

      if (user.phone !== normalizedPhone) {
        user.phone = normalizedPhone || undefined;
        user.verifiedPhone = false;
      }
    }

    user.name = buildFullName(user.firstName, user.lastName, user.name);

    await user.save();

    res.json(buildUserProfileResponse(user));
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to update profile: ' + err.message, 500));
  }
};

export const createUser = async (req, res, next) => {
  const { name, firstName, lastName, email, password, role, phone } = req.body;
  const normalizedRole = normalizeAdminCreatedRole(role);
  const normalizedEmail = email?.trim().toLowerCase();
  const trimmedFirstName = firstName?.trim() || '';
  const trimmedLastName = lastName?.trim() || '';
  const displayName = buildFullName(trimmedFirstName, trimmedLastName, name?.trim());
  const normalizedPhone = normalizePhone(phone);

  try {
    if (!displayName || !normalizedEmail || !password) {
      return next(new AppError('Name, email, and password are required', 400));
    }

    if (!adminCreatableRoles.includes(normalizedRole)) {
      return next(new AppError('Role must be either employee or admin', 400));
    }

    const userExists = await User.findOne({ email: normalizedEmail }).select('-password');
    if (userExists) {
      return res.status(409).json({
        message: `User already exists as ${userExists.role}`,
        existingUser: buildUserProfileResponse(userExists),
        canUpdateRole: true,
      });
    }

    if (normalizedPhone) {
      const phoneExists = await User.findOne({ phone: normalizedPhone }).select('-password');
      if (phoneExists) {
        return next(new AppError('Phone number is already used by another account', 400));
      }
    }

    const user = await User.create({
      name: displayName,
      firstName: trimmedFirstName,
      lastName: trimmedLastName,
      email: normalizedEmail,
      password,
      phone: normalizedPhone || undefined,
      role: normalizedRole,
      isAdmin: normalizedRole === 'admin',
    });

    res.status(201).json(buildUserProfileResponse(user));
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to create user: ' + err.message, 500));
  }
};

export const updateUserRole = async (req, res, next) => {
  const { role } = req.body;

  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(new AppError('Invalid user id', 400));
    }

    if (!adminAssignableRoles.includes(role)) {
      return next(new AppError('Role must be one of: customer, employee, admin', 400));
    }

    if (req.user._id.toString() === req.params.id) {
      return next(new AppError('You cannot change your own role', 400));
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return next(new AppError('User not found', 404));
    }

    user.role = role;
    user.isAdmin = role === 'admin';
    await user.save();

    res.json(buildUserProfileResponse(user));
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to update user role: ' + err.message, 500));
  }
};

export const getUsers = async (req, res, next) => {
  try {
    const filter = {};
    const requestedRoles = req.query.roles || req.query.role;
    const search = String(req.query.search || '').trim();
    const dateFrom = parseDateFilter(req.query.dateFrom, 'dateFrom');
    const dateTo = parseDateFilter(req.query.dateTo, 'dateTo', true);

    if (requestedRoles) {
      const roles = String(requestedRoles)
        .split(',')
        .map((role) => role.trim())
        .filter(Boolean);

      const invalidRoles = roles.filter((role) => !adminAssignableRoles.includes(role));
      if (invalidRoles.length > 0) {
        return next(new AppError('Role filter must contain only: customer, employee, admin', 400));
      }

      filter.role = { $in: roles };
    }

    if (search) {
      const searchRegex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { name: searchRegex },
        { firstName: searchRegex },
        { lastName: searchRegex },
        { email: searchRegex },
        { phone: searchRegex },
      ];
    }

    if (dateFrom || dateTo) {
      filter.createdAt = {};

      if (dateFrom) {
        filter.createdAt.$gte = dateFrom;
      }

      if (dateTo) {
        filter.createdAt.$lte = dateTo;
      }
    }

    const users = await User.find(filter)
      .select('-password')
      .sort({ createdAt: -1 })
      .lean();

    res.json(users);
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to fetch users: ' + err.message, 500));
  }
};

export const deleteUser = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(new AppError('Invalid user id', 400));
    }

    if (req.user._id.toString() === req.params.id) {
      return next(new AppError('You cannot delete your own account', 400));
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return next(new AppError('User not found', 404));
    }

    const deletedEnquiries = await Enquiry.deleteMany({ customer: user._id });
    await user.deleteOne();

    res.json({
      message: 'User deleted successfully',
      deletedUserId: req.params.id,
      deletedEnquiriesCount: deletedEnquiries.deletedCount || 0,
    });
  } catch (err) {
    next(new AppError('Failed to delete user: ' + err.message, 500));
  }
};
