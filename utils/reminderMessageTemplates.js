import { BUSINESS_TIME_ZONE } from './businessTime.js';

export const RENTAL_REMINDER_TEMPLATE_KEYS = Object.freeze([
  'rental_activation_confirmation',
  'rental_return_default',
]);

const formatDateTime = (value, locale) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Reminder date/time must be valid');

  return new Intl.DateTimeFormat(locale, {
    timeZone: BUSINESS_TIME_ZONE,
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
};

export const formatReminderMoney = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Reminder money must be a non-negative integer amount in paise');
  }

  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: value % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value / 100);
};

const requireText = (value, field) => {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${field} is required for reminder content`);
  return text;
};

const normalizeRentalVariables = (variables) => ({
  rentalCode: requireText(variables?.rentalCode, 'rentalCode'),
  customerName: requireText(variables?.customerName, 'customerName'),
  machineName: requireText(variables?.machineName, 'machineName'),
  handoverAt: formatDateTime(variables?.handoverAt, 'en-IN'),
  handoverAtHindi: formatDateTime(variables?.handoverAt, 'hi-IN'),
  expectedReturnAt: formatDateTime(variables?.expectedReturnAt, 'en-IN'),
  expectedReturnAtHindi: formatDateTime(variables?.expectedReturnAt, 'hi-IN'),
  plannedRentalCharge: formatReminderMoney(variables?.plannedRentalChargePaise),
  amountPaid: formatReminderMoney(variables?.rentalPaymentsReceivedPaise),
  remainingBalance: formatReminderMoney(variables?.remainingPlannedBalancePaise),
  securityDeposit: formatReminderMoney(variables?.securityDepositReceivedPaise),
});

const activationContent = (values) => ({
  subjectEnglish: `Rental confirmed: ${values.machineName}`,
  subjectHindi: `किराया पुष्टि: ${values.machineName}`,
  bodyEnglish: [
    `Hello ${values.customerName},`,
    '',
    `Thank you for choosing 3MT Machine Tools. Your rental of ${values.machineName} has been confirmed.`,
    `Rental ID: ${values.rentalCode}`,
    `Rental period: ${values.handoverAt} to ${values.expectedReturnAt}`,
    `Rental amount: ${values.plannedRentalCharge}`,
    `Amount paid: ${values.amountPaid}`,
    `Remaining balance: ${values.remainingBalance}`,
    `Security deposit: ${values.securityDeposit}`,
    '',
    `Please return the machine by ${values.expectedReturnAt}.`,
    'Thank you,',
    '3MT Machine Tools',
  ].join('\n'),
  bodyHindi: [
    `नमस्ते ${values.customerName},`,
    '',
    `3MT Machine Tools की सेवा चुनने के लिए धन्यवाद। ${values.machineName} का आपका किराया पक्का हो गया है।`,
    `किराया आईडी: ${values.rentalCode}`,
    `किराये की अवधि: ${values.handoverAtHindi} से ${values.expectedReturnAtHindi} तक`,
    `किराया राशि: ${values.plannedRentalCharge}`,
    `भुगतान की गई राशि: ${values.amountPaid}`,
    `बाकी राशि: ${values.remainingBalance}`,
    `सुरक्षा जमा: ${values.securityDeposit}`,
    '',
    `कृपया मशीन ${values.expectedReturnAtHindi} तक वापस करें।`,
    'धन्यवाद,',
    '3MT Machine Tools',
  ].join('\n'),
});

const offsetLabels = (offsetMinutes) => {
  if (offsetMinutes === 720) return { english: '12 hours', hindi: '12 घंटे' };
  if (offsetMinutes === 60) return { english: '1 hour', hindi: '1 घंटे' };
  if (!Number.isSafeInteger(offsetMinutes) || offsetMinutes < 0) {
    throw new TypeError('reminderOffsetMinutes must be a non-negative integer');
  }
  return { english: `${offsetMinutes} minutes`, hindi: `${offsetMinutes} मिनट` };
};

const returnContent = (values, offsetMinutes) => {
  const offset = offsetLabels(offsetMinutes);
  return {
    subjectEnglish: `Return reminder: ${values.machineName} is due in ${offset.english}`,
    subjectHindi: `वापसी रिमाइंडर: ${values.machineName} ${offset.hindi} में जमा करनी है`,
    bodyEnglish: [
      `Hello ${values.customerName},`,
      '',
      `This is a reminder that ${values.machineName} is due for return in ${offset.english}.`,
      `Rental ID: ${values.rentalCode}`,
      `Expected return: ${values.expectedReturnAt}`,
      `Rental amount: ${values.plannedRentalCharge}`,
      `Amount paid: ${values.amountPaid}`,
      `Remaining balance: ${values.remainingBalance}`,
      `Security deposit: ${values.securityDeposit}`,
      '',
      'Please return the machine on time. Additional usage after the return time is charged as a full day according to the agreed rental terms.',
      'Thank you,',
      '3MT Machine Tools',
    ].join('\n'),
    bodyHindi: [
      `नमस्ते ${values.customerName},`,
      '',
      `यह रिमाइंडर है कि ${values.machineName} को ${offset.hindi} में वापस जमा करना है।`,
      `किराया आईडी: ${values.rentalCode}`,
      `वापसी का समय: ${values.expectedReturnAtHindi}`,
      `किराया राशि: ${values.plannedRentalCharge}`,
      `भुगतान की गई राशि: ${values.amountPaid}`,
      `बाकी राशि: ${values.remainingBalance}`,
      `सुरक्षा जमा: ${values.securityDeposit}`,
      '',
      'कृपया मशीन समय पर वापस करें। तय वापसी समय के बाद अतिरिक्त उपयोग पर सहमत किराया नियमों के अनुसार पूरे दिन का शुल्क लगेगा।',
      'धन्यवाद,',
      '3MT Machine Tools',
    ].join('\n'),
  };
};

export const renderRentalReminderContent = (templateKey, variables) => {
  if (!RENTAL_REMINDER_TEMPLATE_KEYS.includes(templateKey)) {
    throw new TypeError(`Unsupported rental reminder template: ${templateKey}`);
  }

  const values = normalizeRentalVariables(variables);
  const rendered = templateKey === 'rental_activation_confirmation'
    ? activationContent(values)
    : returnContent(values, variables.reminderOffsetMinutes);

  return { ...rendered, templateKey, variables };
};

const normalizeCustomField = (value, field, { required = false, maxLength }) => {
  const text = String(value || '').trim();
  if (required && !text) throw new TypeError(`${field} is required`);
  if (text.length > maxLength) throw new TypeError(`${field} cannot exceed ${maxLength} characters`);
  return text;
};

export const prepareCustomBilingualContent = (content) => ({
  subjectEnglish: normalizeCustomField(content?.subjectEnglish, 'subjectEnglish', {
    maxLength: 200,
  }),
  subjectHindi: normalizeCustomField(content?.subjectHindi, 'subjectHindi', {
    maxLength: 200,
  }),
  bodyEnglish: normalizeCustomField(content?.bodyEnglish, 'bodyEnglish', {
    required: true,
    maxLength: 5000,
  }),
  bodyHindi: normalizeCustomField(content?.bodyHindi, 'bodyHindi', {
    required: true,
    maxLength: 5000,
  }),
  templateKey: 'custom_bilingual',
});

export const combineBilingualMessage = ({ bodyEnglish, bodyHindi }) =>
  `${requireText(bodyEnglish, 'bodyEnglish')}\n\n--------------------\n\n${requireText(bodyHindi, 'bodyHindi')}`;
