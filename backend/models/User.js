const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// User Schema using Polymorphic Pattern
// Different user types (student, coordinator, supervisor) stored in same collection
// with discriminator 'role' to distinguish between them
const userSchema = new mongoose.Schema(
  {
    // Common fields for all roles
    fullName: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters'],
      select: false, // Don't return password by default
    },
    role: {
      type: String,
      enum: {
        values: ['student', 'coordinator', 'supervisor'],
        message: 'Role must be: student, coordinator, or supervisor',
      },
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },

    // Student-specific fields
    studentId: {
      type: String,
      sparse: true, // Allow null for non-student roles
      unique: true, // Ensure studentId is unique
      index: true,
    },
    supervisorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      sparse: true, // Allow null for non-student roles or unassigned students
    },
    department: {
      type: String,
      enum: {
        values: ['CICT', 'COE', 'CAS', 'CED', 'Other'],
        message: 'Invalid department selection',
      },
      sparse: true,
    },
    companyName: {
      type: String,
      sparse: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      sparse: true,
    },
    requiredHours: {
      type: Number,
      default: 486, // typical OJT hours
      sparse: true,
    },
    completedHours: {
      type: Number,
      default: 0,
      sparse: true,
    },
    remainingHours: {
      type: Number,
      default: 486,
      sparse: true,
    },
    // Trainee Schedule (set by supervisor)
    schedule: {
      startTime: {
        type: String,
        sparse: true,
        // Format: "HH:MM"
      },
      endTime: {
        type: String,
        sparse: true,
        // Format: "HH:MM"
      },
      allowsOvertime: {
        type: Boolean,
        default: false,
        sparse: true,
      },
      overtimeStartTime: {
        type: String,
        sparse: true,
        // Format: "HH:MM"
      },
      overtimeEndTime: {
        type: String,
        sparse: true,
        // Format: "HH:MM"
      },
      scheduleSetAt: {
        type: Date,
        sparse: true,
      },
    },

    // Coordinator-specific fields
    employeeId: {
      type: String,
      sparse: true,
    },
    coordinatorDepartment: {
      type: String,
      sparse: true,
    },

    // Supervisor-specific fields
    companyPosition: {
      type: String,
      sparse: true,
    },
    companyDepartment: {
      type: String,
      sparse: true,
    },

    // Student performance rating (given by supervisor)
    supervisorRating: {
      type: Number,
      min: 0,
      max: 5,
      sparse: true,
      default: null,
    },
    supervisorRatingDate: {
      type: Date,
      sparse: true,
    },
    signatureDataUrl: {
      type: String,
      sparse: true,
    },
  },
  {
    timestamps: true,
    collection: 'users', // All users in single collection
  }
);

// Hash password before saving
userSchema.pre('save', async function (next) {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified('password')) {
    return next();
  }

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare passwords
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Index for frequently queried fields
userSchema.index({ email: 1 });
userSchema.index({ role: 1 });
userSchema.index({ createdAt: -1 });

// Schema validation
userSchema.post('save', function (error, doc, next) {
  if (error.name === 'ValidationError') {
    next(error);
  } else {
    next(error);
  }
});

module.exports = mongoose.model('User', userSchema);
