import Order from '../models/Order.js';
import AppError from '../utils/AppError.js';

export const createOrder = async (req, res, next) => {
  const { orderItems, totalAmount } = req.body;
  try {
    const order = new Order({
      user: req.user._id,
      orderItems,
      totalAmount,
    });
    const savedOrder = await order.save();
    res.status(201).json(savedOrder);
  } catch (err) {
    next(new AppError('Failed to create order: ' + err.message, 500));
  }
};

export const getMyOrders = async (req, res, next) => {
  try {
    const orders = await Order.find({ user: req.user._id }).populate('orderItems.product');
    res.json(orders);
  } catch (err) {
    next(new AppError('Failed to fetch orders: ' + err.message, 500));
  }
};

export const getAllOrders = async (req, res, next) => {
  try {
    const orders = await Order.find({}).populate('user').populate('orderItems.product');
    res.json(orders);
  } catch (err) {
    next(new AppError('Failed to fetch all orders: ' + err.message, 500));
  }
};
