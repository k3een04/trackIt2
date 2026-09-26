const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Recipient ID is required'],
      index: true,
    },
    recipientRole: {
      type: String,
      enum: ['student', 'supervisor', 'coordinator'],
      required: [true, 'Recipient role is required'],
      index: true,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
    },
    actorName: {
      type: String,
      sparse: true,
    },
    type: {
      type: String,
      enum: ['journal', 'attendance', 'dtr', 'system'],
      default: 'system',
      index: true,
    },
    title: {
      type: String,
      required: [true, 'Notification title is required'],
      trim: true,
    },
    message: {
      type: String,
      required: [true, 'Notification message is required'],
      trim: true,
    },
    refModel: {
      type: String,
      enum: ['Journal', 'DTR', 'User', null],
      default: null,
      sparse: true,
    },
    refId: {
      type: mongoose.Schema.Types.ObjectId,
      sparse: true,
    },
    unread: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'notifications',
  }
);

notificationSchema.index({ recipientId: 1, createdAt: -1 });
notificationSchema.index({ recipientId: 1, unread: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
