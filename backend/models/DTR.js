const mongoose = require('mongoose');

const dtrSchema = new mongoose.Schema(
  {
    traineeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Trainee ID is required'],
      index: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      sparse: true,
    },
    companyName: {
      type: String,
      sparse: true,
    },
    date: {
      type: Date,
      default: Date.now,
      index: true,
    },
    timeIn: {
      type: Date,
      sparse: true,
    },
    timeOut: {
      type: Date,
      sparse: true,
    },
    hoursRendered: {
      type: Number,
      default: 0,
    },
    geoTag: {
      latitude: {
        type: Number,
        sparse: true,
      },
      longitude: {
        type: Number,
        sparse: true,
      },
      accuracy: {
        type: Number,
        sparse: true,
      },
    },
    geofenceValidated: {
      type: Boolean,
      default: false,
      description: 'Whether time in/out was validated to be within company geofence',
    },
    qrToken: {
      type: String,
      sparse: true,
    },
    verifiedBySupervisor: {
      type: Boolean,
      default: false,
    },
    supervisorSignature: {
      type: String,
      sparse: true, // digital signature hash or base64
    },
    status: {
      type: String,
      enum: {
        values: ['present', 'late', 'absent', 'excused'],
        message: 'Status must be one of: present, late, absent, excused',
      },
      default: 'present',
    },
    remarks: {
      type: String,
      sparse: true,
    },
  },
  {
    timestamps: true,
    collection: 'dtr',
  }
);

// Index for efficient queries
dtrSchema.index({ traineeId: 1, date: 1 });
dtrSchema.index({ companyId: 1, date: 1 });

module.exports = mongoose.model('DTR', dtrSchema);
