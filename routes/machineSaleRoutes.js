import express from 'express';
import {
  addMachineSalePayment,
  cancelMachineSale,
  completeMachineSale,
  createMachineSale,
  deleteMachineSaleDraft,
  getMachineSaleById,
  getMachineSales,
  updateMachineSaleDraft,
} from '../controllers/machineSaleController.js';
import { isAdmin, protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(protect, isAdmin);

router.route('/')
  .get(getMachineSales)
  .post(createMachineSale);
router.get('/:id', getMachineSaleById);
router.patch('/:id', updateMachineSaleDraft);
router.post('/:id/complete', completeMachineSale);
router.post('/:id/payments', addMachineSalePayment);
router.post('/:id/cancel', cancelMachineSale);
router.delete('/:id', deleteMachineSaleDraft);

export default router;
