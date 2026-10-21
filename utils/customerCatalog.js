import AppError from './AppError.js';

export const customerCatalogFilters = (condition) => {
  const value = condition === undefined ? '' : condition;
  if (typeof value !== 'string' || !['', 'new', 'used'].includes(value.trim().toLowerCase())) {
    throw new AppError('condition must be new or used', 400);
  }

  if (value.trim().toLowerCase() === 'used') {
    return [{ condition: 'used' }, { type: /^machine$/i }];
  }

  return [
    { $or: [{ condition: 'new' }, { condition: null }, { condition: '' }] },
    { availabilityStatus: { $nin: ['sold', 'unavailable'] } },
  ];
};
