import User from '../models/User.js';
import jwt from 'jsonwebtoken';
import AppError from '../utils/AppError.js';

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

export const registerUser = async (req, res, next) => {
  const { name, email, password } = req.body;
  try {
    const userExists = await User.findOne({ email });
    if (userExists) return next(new AppError('User already exists', 400));

    const user = await User.create({ name, email, password, role:'user' });
    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role:user.role,
      token: generateToken(user._id),
    });
  } catch (err) {
    next(new AppError('Server error: ' + err.message, 500));
  }
};

export const loginUser = async (req, res, next) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user || !(await user.matchPassword(password))) {
      return next(new AppError('Invalid credentials', 401));
    }
    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      token: generateToken(user._id),
    });
  } catch (err) {
    next(new AppError('Server error: ' + err.message, 500));
  }
};
