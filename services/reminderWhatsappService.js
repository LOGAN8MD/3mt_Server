import ReminderOccurrence from '../models/ReminderOccurrence.js';
import AppError from '../utils/AppError.js';
import { combineBilingualMessage } from '../utils/reminderMessageTemplates.js';
import { requireEligibleReminder } from './reminderEligibilityService.js';
import { refreshOccurrenceDeliveryStatus } from './reminderEmailDeliveryService.js';

export const buildManualWhatsappLink = (phone, content) => {
  let digits = String(phone || '').replace(/[\s()+-]/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) digits = `91${digits}`;
  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    throw new AppError('Customer WhatsApp number must include a valid country code', 400);
  }
  const message = combineBilingualMessage(content);
  return { url: `https://wa.me/${digits}?text=${encodeURIComponent(message)}`, message };
};

export const prepareManualWhatsapp = async (id) => {
  const occurrence = await requireEligibleReminder(id);
  if (!occurrence.channels.includes('whatsapp')) throw new AppError('WhatsApp is not selected', 409);
  return buildManualWhatsappLink(occurrence.recipientSnapshot.phone, occurrence.contentSnapshot);
};

export const markManualWhatsappSent = async (id, adminId) => {
  const occurrence = await requireEligibleReminder(id);
  if (!occurrence.channels.includes('whatsapp')) throw new AppError('WhatsApp is not selected', 409);
  if (occurrence.whatsappDelivery.status === 'manual_sent') return occurrence;
  const updated = await ReminderOccurrence.findOneAndUpdate({
    _id: id,
    status: { $nin: ['cancelled', 'missed'] },
    'whatsappDelivery.status': { $in: ['pending', 'failed'] },
  }, {
    $set: {
      'whatsappDelivery.status': 'manual_sent',
      'whatsappDelivery.provider': 'manual_whatsapp',
      'whatsappDelivery.manuallySentAt': new Date(),
      'whatsappDelivery.manuallySentBy': adminId,
    },
  }, { new: true }).lean();
  if (!updated) throw new AppError('WhatsApp status changed; refresh and try again', 409);
  return refreshOccurrenceDeliveryStatus(id);
};
