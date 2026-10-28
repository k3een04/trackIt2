const mongoose = require('mongoose');

/**
 * One direct message between two TrackIT users. Messaging is deliberately
 * one-to-one: the trainee talks to their assigned supervisor and the
 * coordinators, the supervisor talks to their trainees and the coordinators,
 * and a coordinator can reach anyone. The route layer enforces those rules;
 * this schema only stores the pair that was allowed through.
 */
const messageSchema = new mongoose.Schema(
  {
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Sender ID is required'],
      index: true,
    },
    senderRole: {
      type: String,
      enum: ['student', 'supervisor', 'coordinator'],
      required: [true, 'Sender role is required'],
    },
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
    },
    body: {
      type: String,
      required: [true, 'Message body is required'],
      trim: true,
      maxlength: [2000, 'A message cannot be longer than 2000 characters'],
    },
    /** Set when the recipient opens the thread; drives the unread badges. */
    readAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'messages',
  }
);

// The pair index serves both "thread with this person" and the inbox summary,
// because either user can be on either side of the conversation.
messageSchema.index({ senderId: 1, recipientId: 1, createdAt: 1 });
messageSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
