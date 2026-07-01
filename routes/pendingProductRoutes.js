import express from 'express';
import {
  approvePendingProductForAdmin,
  deletePendingProductForAdmin,
  getMyPendingProducts,
  getPendingProductByIdForAdmin,
  getPendingProductsForAdmin,
  rejectPendingProductForAdmin,
  submitPendingProduct,
  updatePendingProductForAdmin,
} from '../controllers/pendingProductController.js';
import { protect, isAdmin } from '../middlewares/authMiddleware.js';
import { upload } from '../middlewares/uploadMiddleware.js';

const router = express.Router();

router.post('/', protect, upload.array('images', 5), submitPendingProduct);
router.get('/mine', protect, getMyPendingProducts);

router.get('/admin', protect, isAdmin, getPendingProductsForAdmin);
router.get('/admin/:id', protect, isAdmin, getPendingProductByIdForAdmin);
router.put('/admin/:id', protect, isAdmin, upload.array('images', 5), updatePendingProductForAdmin);
router.patch('/admin/:id/approve', protect, isAdmin, approvePendingProductForAdmin);
router.patch('/admin/:id/reject', protect, isAdmin, rejectPendingProductForAdmin);
router.delete('/admin/:id', protect, isAdmin, deletePendingProductForAdmin);

export default router;
