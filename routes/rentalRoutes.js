import express from 'express';
import {
  activateRental,
  cancelRental,
  createRental,
  deleteRentalDraft,
  extendRental,
  getRentalById,
  getRentals,
  addRentalPayment,
  previewRentalReturn,
  quoteRental,
  returnRental,
  syncOverdueRentals,
  updateRentalDraft,
} from '../controllers/rentalController.js';
import { isAdmin, protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(protect, isAdmin);

router.post('/quote', quoteRental);
router.post('/sync-overdue', syncOverdueRentals);
router.route('/')
  .get(getRentals)
  .post(createRental);
router.get('/:id', getRentalById);
router.patch('/:id', updateRentalDraft);
router.post('/:id/activate', activateRental);
router.post('/:id/cancel', cancelRental);
router.post('/:id/extend', extendRental);
router.post('/:id/payments', addRentalPayment);
router.post('/:id/return-preview', previewRentalReturn);
router.post('/:id/return', returnRental);
router.delete('/:id', deleteRentalDraft);

export default router;
