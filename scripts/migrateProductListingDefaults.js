import 'dotenv/config';
import mongoose from 'mongoose';
import { DEFAULT_PRODUCT_RULES } from '../utils/productRules.js';

const shouldApply = process.argv.includes('--apply');
const listingDefaults = {
  condition: DEFAULT_PRODUCT_RULES.condition,
  availabilityType: DEFAULT_PRODUCT_RULES.availabilityType,
  availabilityStatus: DEFAULT_PRODUCT_RULES.availabilityStatus,
};

const missingOrEmptyField = (fieldName) => ({
  $or: [
    { [fieldName]: { $exists: false } },
    { [fieldName]: null },
    { [fieldName]: '' },
  ],
});

const migrationFilter = {
  $or: Object.keys(listingDefaults).flatMap((fieldName) =>
    missingOrEmptyField(fieldName).$or
  ),
};

const connectToDatabase = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not configured');
  }

  await mongoose.connect(process.env.MONGO_URI);
};

const inspectCollection = async (collectionName, label) => {
  const collection = mongoose.connection.collection(collectionName);
  const matchingCount = await collection.countDocuments(migrationFilter);
  const examples = await collection
    .find(migrationFilter, {
      projection: {
        _id: 1,
        name: 1,
        condition: 1,
        availabilityType: 1,
        availabilityStatus: 1,
      },
    })
    .limit(5)
    .toArray();

  console.log(`${label}: ${matchingCount} record(s) need listing defaults.`);

  if (examples.length > 0) {
    console.table(
      examples.map((record) => ({
        id: record._id.toString(),
        name: record.name,
        condition: record.condition,
        availabilityType: record.availabilityType,
        availabilityStatus: record.availabilityStatus,
      }))
    );
  }

  return { collection, matchingCount };
};

const applyDefaults = async (collection, label) => {
  let totalMatched = 0;
  let totalModified = 0;

  for (const [fieldName, defaultValue] of Object.entries(listingDefaults)) {
    const result = await collection.updateMany(
      missingOrEmptyField(fieldName),
      { $set: { [fieldName]: defaultValue } }
    );

    totalMatched += result.matchedCount;
    totalModified += result.modifiedCount;
  }

  console.log(`${label}: matched ${totalMatched} field update(s), modified ${totalModified}.`);
};

const migrateProductListingDefaults = async () => {
  await connectToDatabase();

  const collections = [
    { name: 'products', label: 'Product' },
    { name: 'pendingproducts', label: 'PendingProduct' },
  ];

  let totalRecords = 0;

  for (const { name, label } of collections) {
    const { collection, matchingCount } = await inspectCollection(name, label);
    totalRecords += matchingCount;

    if (shouldApply && matchingCount > 0) {
      await applyDefaults(collection, label);
    }
  }

  if (!shouldApply) {
    console.log(`Dry run complete. ${totalRecords} total record(s) need listing defaults.`);
    console.log('Re-run with --apply to migrate these records.');
    return;
  }

  console.log(`Migration apply complete. ${totalRecords} record(s) were targeted.`);
};

migrateProductListingDefaults()
  .catch((error) => {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
