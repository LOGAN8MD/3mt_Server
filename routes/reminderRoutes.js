import express from 'express';
import {
  cancelReminder,
  cancelReminderOccurrence,
  createReminder,
  getReminderById,
  getReminderOccurrences,
  getReminders,
  pauseReminder,
  previewReminder,
  restoreRentalDefaults,
  resumeReminder,
  sendOccurrenceEmail,
  getOccurrenceWhatsapp,
  confirmOccurrenceWhatsapp,
  updateReminder,
} from '../controllers/reminderController.js';
import {
  createReminderPlan,
  getReminderPlanById,
  getReminderPlans,
  previewReminderPlan,
  updateReminderPlan,
} from '../controllers/reminderPlanController.js';
import { isAdmin, protect } from '../middlewares/authMiddleware.js';

const router = express.Router();
router.use(protect, isAdmin);

router.post('/plans/preview', previewReminderPlan);
router.route('/plans').get(getReminderPlans).post(createReminderPlan);
router.route('/plans/:id').get(getReminderPlanById).patch(updateReminderPlan);
router.post('/preview', previewReminder);
router.get('/occurrences', getReminderOccurrences);
router.post('/occurrences/:id/cancel', cancelReminderOccurrence);
router.post('/occurrences/:id/send-email', sendOccurrenceEmail);
router.get('/occurrences/:id/whatsapp', getOccurrenceWhatsapp);
router.post('/occurrences/:id/whatsapp-sent', confirmOccurrenceWhatsapp);
router.post('/rentals/:rentalId/restore-defaults', restoreRentalDefaults);
router.route('/').get(getReminders).post(createReminder);
router.get('/:id', getReminderById);
router.patch('/:id', updateReminder);
router.post('/:id/pause', pauseReminder);
router.post('/:id/resume', resumeReminder);
router.post('/:id/cancel', cancelReminder);

export default router;
