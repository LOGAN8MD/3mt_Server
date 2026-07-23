import 'dotenv/config';
import mongoose from 'mongoose';

const shouldApply = process.argv.includes('--apply');

const connectToDatabase = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not configured');
  }

  await mongoose.connect(process.env.MONGO_URI);
};

const disconnectFromDatabase = async () => {
  await mongoose.disconnect();
};

const migrateLegacyUserRoles = async () => {
  await connectToDatabase();

  const usersCollection = mongoose.connection.collection('users');
  const legacyUserFilter = { role: 'user' };
  const legacyUsers = await usersCollection
    .find(legacyUserFilter, {
      projection: {
        _id: 1,
        name: 1,
        email: 1,
        role: 1,
        isAdmin: 1,
        createdAt: 1,
      },
    })
    .sort({ createdAt: 1 })
    .toArray();

  console.log(`Found ${legacyUsers.length} legacy user role record(s).`);

  if (legacyUsers.length > 0) {
    console.table(
      legacyUsers.map((user) => ({
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        isAdmin: user.isAdmin,
      }))
    );
  }

  if (!shouldApply) {
    console.log('Dry run complete. Re-run with --apply to migrate role=user records to role=employee.');
    return;
  }

  const result = await usersCollection.updateMany(
    legacyUserFilter,
    {
      $set: {
        role: 'employee',
        isAdmin: false,
      },
    }
  );

  console.log(`Migration complete. Matched: ${result.matchedCount}. Modified: ${result.modifiedCount}.`);
};

migrateLegacyUserRoles()
  .catch((error) => {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(disconnectFromDatabase);
