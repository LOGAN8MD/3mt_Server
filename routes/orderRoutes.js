import express from 'express';
import { createOrder, getMyOrders, getAllOrders } from '../controllers/orderController.js';
import { protect, isAdmin } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/', protect, createOrder);
router.get('/my-orders', protect, getMyOrders);
router.get('/', protect, isAdmin, getAllOrders);

export default router;