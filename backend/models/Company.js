const mongoose = require('mongoose');

const companySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Company name is required'],
      trim: true,
    },
    email: {
      type: String,
      sparse: true,
      lowercase: true,
    },
    phone: {
      type: String,
      sparse: true,
    },
    address: {
      type: String,
      sparse: true,
    },
    city: {
      type: String,
      sparse: true,
    },
    province: {
      type: String,
      sparse: true,
    },
    zipCode: {
      type: String,
      sparse: true,
    },
    // Geofencing Location for Attendance Tracking
    geofenceLocation: {
      latitude: {
        type: Number,
        sparse: true,
      },
      longitude: {
        type: Number,
        sparse: true,
      },
      radiusMeters: {
        type: Number,
        default: 100, // 100 meters default geofence radius
        sparse: true,
      },
    },
    industry: {
      type: String,
      sparse: true,
    },
    accreditationStatus: {
      type: String,
      enum: {
        values: ['accredited', 'pending', 'expired'],
        message: 'Status must be: accredited, pending, or expired',
      },
      default: 'pending',
    },
    accreditationDate: {
      type: Date,
      sparse: true,
    },
    expirationDate: {
      type: Date,
      sparse: true,
    },
    coordinatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    collection: 'companies',
  }
);

module.exports = mongoose.model('Company', companySchema);
