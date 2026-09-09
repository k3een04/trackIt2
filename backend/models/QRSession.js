const mongoose = require('mongoose');

const qrSessionSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      unique: true,
      required: [true, 'QR token is required'],
      index: true,
    },
    expiresAt: {
      type: Date,
      required: [true, 'Expiration time is required'],
      index: true, // For cleanup of old tokens
    },
    used: {
      type: Boolean,
      default: false,
      index: true, // For checking if token has been used
    },
    usedAt: {
      type: Date,
      sparse: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      sparse: true,
    },
    companyName: {
      type: String,
      sparse: true,
      index: true,
    },
    supervisorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
    },
    traineeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
    collection: 'qr_sessions',
  }
);

// Auto-delete expired tokens
qrSessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

module.exports = mongoose.model('QRSession', qrSessionSchema);
