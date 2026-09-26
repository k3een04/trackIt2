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
      enum: ['journal', 'attendance', 'dtr', 'system', 'inactivity', 'activity'],
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
    /**
     * Stable identity of the event that produced this notification, e.g.
     * "inactivity:<studentId>:<YYYY-MM-DD of first missed OJT day>".
     * A sparse unique index turns the notification writer into an idempotent
     * upsert, so re-running the inactivity check any number of times can never
     * create a second copy of the same event. Left undefined for the existing
     * ad-hoc notifications, which keep their current "always insert" behaviour.
     *
     * The recipient id is part of the key: the same event must be delivered to
     * every coordinator independently.
     */
    dedupeKey: {
      type: String,
      sparse: true,
      unique: true,
    },
    /**
     * Extra context for the dashboard (student id/code, course, section,
     * consecutive missed days, date the student became inactive, ...).
     */
    meta: {
      type: mongoose.Schema.Types.Mixed,
      sparse: true,
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
