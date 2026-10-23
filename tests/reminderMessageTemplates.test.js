import assert from 'node:assert/strict';
import test from 'node:test';
import {
  combineBilingualMessage,
  formatReminderMoney,
  prepareCustomBilingualContent,
  renderRentalReminderContent,
} from '../utils/reminderMessageTemplates.js';

const variables = {
  rentalCode: 'RNT-20261023-ABC123',
  customerName: 'Rahul Customer',
  machineName: 'Second-Hand Bosch Drill 1',
  handoverAt: new Date('2026-11-15T04:30:00.000Z'),
  expectedReturnAt: new Date('2026-11-18T11:30:00.000Z'),
  plannedRentalChargePaise: 150000,
  rentalPaymentsReceivedPaise: 50000,
  remainingPlannedBalancePaise: 100000,
  securityDepositReceivedPaise: 200000,
};

test('activation template renders complete English and Hindi rental details', () => {
  const content = renderRentalReminderContent('rental_activation_confirmation', variables);

  assert.match(content.subjectEnglish, /Rental confirmed/);
  assert.match(content.subjectHindi, /किराया पुष्टि/);
  assert.match(content.bodyEnglish, /Thank you for choosing 3MT Machine Tools/);
  assert.match(content.bodyEnglish, /18 November 2026 at 5:00 pm/);
  assert.match(content.bodyEnglish, /Rental amount: ₹1,500/);
  assert.match(content.bodyEnglish, /Amount paid: ₹500/);
  assert.match(content.bodyEnglish, /Remaining balance: ₹1,000/);
  assert.match(content.bodyEnglish, /Security deposit: ₹2,000/);
  assert.match(content.bodyHindi, /3MT Machine Tools की सेवा/);
  assert.match(content.bodyHindi, /सुरक्षा जमा: ₹2,000/);
});

test('return templates distinguish the 12-hour and 1-hour reminders', () => {
  const twelveHour = renderRentalReminderContent('rental_return_default', {
    ...variables,
    reminderOffsetMinutes: 720,
  });
  const oneHour = renderRentalReminderContent('rental_return_default', {
    ...variables,
    reminderOffsetMinutes: 60,
  });

  assert.match(twelveHour.subjectEnglish, /12 hours/);
  assert.match(twelveHour.bodyHindi, /12 घंटे/);
  assert.match(oneHour.subjectEnglish, /1 hour/);
  assert.match(oneHour.bodyHindi, /1 घंटे/);
  assert.match(oneHour.bodyEnglish, /charged as a full day/);
});

test('money formatting preserves paise only when needed', () => {
  assert.equal(formatReminderMoney(150000), '₹1,500');
  assert.equal(formatReminderMoney(150050), '₹1,500.50');
  assert.throws(() => formatReminderMoney(10.5), /integer amount in paise/);
});

test('custom bilingual content is trimmed, bounded and can be combined', () => {
  const content = prepareCustomBilingualContent({
    subjectEnglish: ' Service reminder ',
    subjectHindi: ' सेवा रिमाइंडर ',
    bodyEnglish: ' Please visit the shop. ',
    bodyHindi: ' कृपया दुकान पर आएं। ',
  });
  const combined = combineBilingualMessage(content);

  assert.equal(content.subjectEnglish, 'Service reminder');
  assert.equal(content.templateKey, 'custom_bilingual');
  assert.match(combined, /Please visit the shop/);
  assert.match(combined, /कृपया दुकान पर आएं/);
  assert.match(combined, /--------------------/);
});

test('message templates reject missing variables and incomplete custom content', () => {
  assert.throws(
    () => renderRentalReminderContent('rental_activation_confirmation', {
      ...variables,
      customerName: '',
    }),
    /customerName is required/
  );
  assert.throws(
    () => renderRentalReminderContent('unknown', variables),
    /Unsupported rental reminder template/
  );
  assert.throws(
    () => prepareCustomBilingualContent({ bodyEnglish: 'English only' }),
    /bodyHindi is required/
  );
});
