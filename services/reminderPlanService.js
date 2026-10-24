import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { buildDefaultReturnReminderPlans } from '../utils/rentalReminderWorkflow.js';

export const planRecipientSnapshot = (customer) => ({
  name: String(customer.name || '').trim(),
  email: String(customer.email || '').trim().toLowerCase(),
  phone: String(customer.phone || '').trim(),
});

export const normalizeSubmissionKey = (value) => {
  const normalized = String(value || '').trim();
  return normalized || undefined;
};

const canonicalContent = (content = {}) => ({
  subjectEnglish: content.subjectEnglish || '',
  subjectHindi: content.subjectHindi || '',
  bodyEnglish: content.bodyEnglish || '',
  bodyHindi: content.bodyHindi || '',
});

export const reminderPlanFingerprint = (prepared) => createHash('sha256').update(JSON.stringify({
  planType: prepared.planType,
  reminderMode: prepared.reminderMode,
  rentalId: prepared.rentalId || '',
  productId: prepared.productId || '',
  customerId: prepared.customerId,
  startsAt: prepared.startsAt.toISOString(),
  endsAt: prepared.endsAt.toISOString(),
  reminders: prepared.reminders.map((row) => ({
    offsetMinutes: row.offsetMinutes,
    scheduledAt: row.scheduledAt.toISOString(),
    channels: [...row.channels].sort(),
    contentMode: row.contentMode,
    content: canonicalContent(row.content),
  })),
})).digest('hex');

const deliveryState = (channels, channel) => ({
  status: channels.includes(channel) ? 'pending' : 'not_selected',
});

export const buildReminderPlanRecords = ({
  planId,
  planCode,
  version,
  prepared,
  rental,
  customer,
  adminId,
  now = new Date(),
  excludedChannelsByRowKey = new Map(),
}) => {
  const recipientSnapshot = planRecipientSnapshot(customer);
  const defaultContentByOffset = new Map(
    rental && prepared.reminderMode === 'default'
      ? buildDefaultReturnReminderPlans(rental, adminId, { now, scheduleVersion: version })
        .map(({ definition }) => [definition.offsetMinutes, definition.content])
      : []
  );

  const definitions = [];
  const occurrences = [];
  const planRows = prepared.reminders.map((row, index) => {
    const content = row.contentMode === 'default_template'
      ? defaultContentByOffset.get(row.offsetMinutes)
      : row.content;
    const excludedChannels = new Set(excludedChannelsByRowKey.get(row.rowKey) || []);
    const pendingChannels = row.channels.filter((channel) => !excludedChannels.has(channel));
    const definitionId = new mongoose.Types.ObjectId();
    const suffix = `${planId.toString()}-${index + 1}-V${version}`.toUpperCase();
    const definition = {
      _id: definitionId,
      definitionCode: `RMD-PLAN-${suffix}`,
      type: prepared.planType === 'rental' ? 'rental_return' : 'standalone_custom',
      plan: planId,
      planRowKey: row.rowKey,
      ...(rental ? { rental: rental._id } : {}),
      customer: customer._id,
      recipientSnapshot,
      status: 'active',
      scheduleMode: row.scheduleMode,
      ...(row.scheduleMode === 'offset_before_return'
        ? { offsetMinutes: row.offsetMinutes }
        : { exactAt: row.scheduledAt }),
      channels: pendingChannels,
      contentMode: row.contentMode,
      content,
      scheduleVersion: version,
      createdBy: adminId,
      updatedBy: adminId,
    };
    if (pendingChannels.length > 0) definitions.push(definition);
    if (pendingChannels.length > 0) occurrences.push({
      occurrenceKey: `ROC-PLAN-${suffix}`,
      definition: definitionId,
      definitionType: definition.type,
      plan: planId,
      planRowKey: row.rowKey,
      ...(rental ? { rental: rental._id } : {}),
      customer: customer._id,
      recipientSnapshot,
      scheduledAt: row.scheduledAt,
      status: row.status,
      scheduleVersion: version,
      channels: pendingChannels,
      contentSnapshot: content,
      emailDelivery: deliveryState(pendingChannels, 'email'),
      whatsappDelivery: deliveryState(pendingChannels, 'whatsapp'),
      ...(row.status === 'missed' ? { missedAt: row.missedAt || now } : {}),
    });
    return {
      rowKey: row.rowKey,
      offsetMinutes: row.offsetMinutes,
      scheduledAt: row.scheduledAt,
      scheduleMode: row.scheduleMode,
      channels: row.channels,
      contentMode: row.contentMode,
      content,
      initialStatus: row.status,
      ...(row.status === 'missed' ? { missedAt: row.missedAt || now } : {}),
    };
  });

  return { planCode, recipientSnapshot, planRows, definitions, occurrences };
};
