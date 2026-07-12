const productTextFields = [
  'name',
  'type',
  'category',
  'subCategory',
  'brand',
  'description',
  'size',
  'model',
];

export const normalizeTextValue = (value) =>
  typeof value === 'string' ? value.trim() : value;

export const normalizeCategoryBrandValue = (value) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export const normalizeProductFields = (productData) => {
  const normalizedData = { ...productData };

  for (const field of productTextFields) {
    if (normalizedData[field] !== undefined) {
      normalizedData[field] = normalizeTextValue(normalizedData[field]);
    }
  }

  if (normalizedData.category !== undefined) {
    normalizedData.category = normalizeCategoryBrandValue(normalizedData.category);
  }

  if (normalizedData.brand !== undefined) {
    normalizedData.brand = normalizeCategoryBrandValue(normalizedData.brand);
  }

  return normalizedData;
};
