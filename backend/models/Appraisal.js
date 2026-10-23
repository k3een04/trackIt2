const mongoose = require('mongoose');

/**
 * Performance Appraisal record — the official 100-point form
 * (Performance_Appraisal_All_Borders_Black.pdf) persisted per trainee per
 * monthly evaluation period.
 *
 * Design notes:
 * - `period` is YYYY-MM; the (traineeId, period) compound index is unique so a
 *   trainee can never have two appraisals for the same evaluation month.
 * - `ratings` is a map keyed by the nine official criterion keys. A missing
 *   score is stored as null — never 0 — so an unfinished draft can never be
 *   mistaken for a real evaluation.
 * - `info` is an immutable snapshot of the trainee/supervisor form fields taken
 *   at save time; empty fields stay empty (the PDF prints a blank/—).
 * - `subtotals`, `totalScore`, `ratingEquivalent` and `isComplete` are always
 *   recomputed server-side by services/appraisalCriteria.summarize() on every
 *   save/submit — clients cannot post their own totals.
 * - A submitted appraisal is locked: status flips to 'submitted' together with
 *   `submittedAt` and the supervisor signature snapshot, and routes reject any
 *   further draft/submit for that trainee+period.
 */
const appraisalSchema = new mongoose.Schema(
  {
    traineeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    supervisorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    period: {
      type: String,
      required: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
    },
    status: {
      type: String,
      enum: ['draft', 'submitted', 'acknowledged'],
      default: 'draft',
    },
    // Snapshot of the official form's trainee/period header fields.
    info: {
      type: Map,
      of: String,
      default: () => ({}),
    },
    // { technical_1: { score: 14 | null, remarks: '...' }, ... }
    ratings: {
      type: Map,
      of: new mongoose.Schema(
        {
          score: { type: Number, default: null },
          remarks: { type: String, default: '' },
        },
        { _id: false }
      ),
      default: () => ({}),
    },
    overallRemarks: {
      type: String,
      default: '',
      maxlength: 3000,
    },
    recommendedCompletion: {
      type: Boolean,
      default: false,
    },
    // Server-computed (never trusted from the client).
    subtotals: {
      type: Map,
      of: Number,
      default: () => ({}),
    },
    totalScore: {
      type: Number,
      default: null,
    },
    ratingEquivalent: {
      type: String,
      default: null,
    },
    isComplete: {
      type: Boolean,
      default: false,
    },
    // Set on submit; submitted records are locked.
    submittedAt: {
      type: Date,
      default: null,
    },
    // Snapshot of the supervisor's signature captured at submit time. Empty
    // when no signature was recorded — the PDF must not claim one exists.
    supervisorSignature: {
      dataUrl: { type: String, default: null },
      signedByName: { type: String, default: '' },
      signedAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

// One appraisal per trainee per evaluation month.
appraisalSchema.index({ traineeId: 1, period: 1 }, { unique: true });
appraisalSchema.index({ supervisorId: 1, status: 1 });
appraisalSchema.index({ traineeId: 1, status: 1 });

module.exports = mongoose.model('Appraisal', appraisalSchema);
