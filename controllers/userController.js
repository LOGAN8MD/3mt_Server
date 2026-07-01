import User from '../models/User.js';
import AppError from '../utils/AppError.js';
import mongoose from 'mongoose';

const allowedRoles = ['user', 'admin'];

export const createUser = async (req, res, next) => {
  const { name, email, password, role = 'user' } = req.body;

  try {
    if (!name || !email || !password) {
      return next(new AppError('Name, email, and password are required', 400));
    }

    if (!allowedRoles.includes(role)) {
      return next(new AppError('Role must be either user or admin', 400));
    }

    const userExists = await User.findOne({ email });
    if (userExists) {
      return next(new AppError('User already exists', 400));
    }

    const user = await User.create({
      name,
      email,
      password,
      role,
      isAdmin: role === 'admin',
    });

    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      isAdmin: user.isAdmin,
      createdAt: user.createdAt,
    });
  } catch (err) {
    next(new AppError('Failed to create user: ' + err.message, 500));
  }
};

export const getUsers = async (req, res, next) => {
  try {
    const users = await User.find({})
      .select('-password')
      .sort({ createdAt: -1 })
      .lean();

    res.json(users);
  } catch (err) {
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

    await user.deleteOne();

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    next(new AppError('Failed to delete user: ' + err.message, 500));
  }
};
