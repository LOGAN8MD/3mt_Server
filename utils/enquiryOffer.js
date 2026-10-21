import AppError from './AppError.js';

export const enquiryOfferSnapshot = (product, quantity, intent = 'sale') => {
  if (!['sale', 'rent'].includes(intent)) throw new AppError('intent must be sale or rent', 400);
  const offer = product.availabilityType || 'sale';
  const status = product.availabilityStatus || 'available';
  if (!(offer === intent || offer === 'both')) throw new AppError(`${product.name}: selected offer is no longer available`, 409);
  if (status !== 'available' && !(status === 'on_rent' && intent === 'rent')) throw new AppError(`${product.name}: ${status}`, 409);
  const stock = product.stock == null ? 1 : Number(product.stock);
  if (intent === 'sale' && (!Number.isFinite(stock) || quantity > stock)) throw new AppError(`${product.name}: requested quantity exceeds current stock`, 409);
  if (intent === 'rent' && quantity !== 1) throw new AppError('Rental enquiries must be for one machine', 400);
  const value = intent === 'rent' ? product.rentalPrice : product.price;
  if (value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) <= 0) throw new AppError(`${product.name}: price needs confirmation`, 409);
  if (intent === 'rent' && !['day', 'week', 'month'].includes(product.rentPeriod)) throw new AppError('Rental period needs confirmation', 409);
  return {
    intent,
    conditionSnapshot: product.condition || 'new',
    availabilityStatusSnapshot: status,
    priceSnapshot: intent === 'sale' ? Number(value) : 0,
    lineTotal: intent === 'sale' ? Number(value) * quantity : 0,
    ...(intent === 'rent' ? { rentalPriceSnapshot: Number(value), rentPeriodSnapshot: product.rentPeriod, securityDepositSnapshot: Number(product.securityDeposit || 0) } : {}),
  };
};
