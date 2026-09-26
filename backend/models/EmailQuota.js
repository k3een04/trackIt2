const mongoose = require('mongoose');

/**
 * One document per UTC day that records how many transactional emails the
 * application has already handed to the mail provider.
 *
 * The counter lives in MongoDB on purpose: the free Brevo tier allows only
 * 300 emails per day, and that budget must survive a server restart and be
 * shared by every serverless instance, so an in-process counter is not enough.
 */
const emailQuotaSchema = new mongoose.Schema(
  {
    // UTC day key, e.g. "2026-09-27"
    day: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Emails actually accepted by the provider
    sent: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Requests refused because the daily budget was already spent
    blocked: {
      type: Number,
      default: 0,
    },
    lastSentAt: {
      type: Date,
    },
    lastBlockedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    collection: 'emailquotas',
  }
);

module.exports = mongoose.model('EmailQuota', emailQuotaSchema);
