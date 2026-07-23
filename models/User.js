import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const normalizeRole = (role) => {
  if (!role || role === 'user') {
    return 'customer';
  }

  return role;
};

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please provide a name'],
      trim: true,
    },
    firstName: {
      type: String,
      trim: true,
      default: '',
    },
    lastName: {
      type: String,
      trim: true,
      default: '',
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      sparse: true,
    },
    password: {
      type: String,
      required: [
        function requirePassword() {
          return this.authProvider === 'local';
        },
        'Please provide a password',
      ],
      select: false,
    },
    phone: {
      type: String,
      trim: true,
      sparse: true,
    },
    address: {
      type: String,
      trim: true,
      default: '',
    },
    authProvider: {
      type: String,
      enum: ['local', 'google'],
      default: 'local',
    },
    googleId: {
      type: String,
      trim: true,
      sparse: true,
    },
    verificationMethod: {
      type: String,
      enum: ['email', 'mobile', null],
      default: null,
    },
    isVerified: {
      type: Boolean,
      default: function defaultIsVerified() {
        return !this.verificationMethod || this.authProvider === 'google';
      },
    },
    verifiedEmail: {
      type: Boolean,
      default: false,
    },
    verifiedPhone: {
      type: Boolean,
      default: false,
    },
    role: {
      type: String,
      enum: ['customer', 'employee', 'admin'],
      default: 'customer',
      set: normalizeRole,
    },
    isAdmin: {
      type: Boolean,
      default: false,
    },
    passwordResetVersion: {
      type: Number,
      default: 0,
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

userSchema.index({ email: 1 }, { unique: true, sparse: true });
userSchema.index({ phone: 1 }, { unique: true, sparse: true });
userSchema.index({ googleId: 1 }, { unique: true, sparse: true });
userSchema.index({ role: 1, createdAt: -1 });

userSchema.pre('validate', function syncAdminFlag(next) {
  this.role = normalizeRole(this.role);
  this.isAdmin = this.role === 'admin';
  next();
});

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    return next();
  }
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Compare entered password with hashed password
userSchema.methods.matchPassword = async function (enteredPassword) {
  if (!this.password) {
    return false;
  }

  return await bcrypt.compare(enteredPassword, this.password);
};

const User = mongoose.model('User', userSchema);
export default User;
