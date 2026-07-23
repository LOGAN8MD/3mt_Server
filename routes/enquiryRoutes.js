import express from 'express';
import {
  createEnquiry,
  deleteEnquiry,
  getCustomerEnquiries,
  getEnquiries,
  getEnquiryById,
  getProductDemandStats,
  updateEnquiryNotes,
  updateEnquiryStatus,
} from '../controllers/enquiryController.js';
import { isAdmin, protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/', protect, createEnquiry);
router.get('/', protect, isAdmin, getEnquiries);
router.get('/stats/products', protect, isAdmin, getProductDemandStats);
router.get('/customer/:customerId', protect, isAdmin, getCustomerEnquiries);
router.get('/:id', protect, isAdmin, getEnquiryById);
router.patch('/:id/status', protect, isAdmin, updateEnquiryStatus);
router.patch('/:id/notes', protect, isAdmin, updateEnquiryNotes);
router.delete('/:id', protect, isAdmin, deleteEnquiry);

export default router;
