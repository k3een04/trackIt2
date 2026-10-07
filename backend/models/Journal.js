const mongoose = require('mongoose');

const journalSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Student ID is required'],
      index: true,
    },
    supervisorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
    },
    week: {
      type: String,
      // Not required while a journal is still a draft: a trainee may start
      // writing before a supervisor is assigned, and week 1 only begins at
      // that assignment. Submit always stamps the week, so a handed-in
      // journal can never be missing one.
      required: function () {
        return this.status !== 'draft';
      },
      description: 'OJT week label (e.g. "Week 3"), stamped by the server',
    },
    dayCovered: {
      type: String,
      enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
      sparse: true,
      description: 'The specific day covered by this journal entry',
    },
    narrative: {
      type: String,
      required: [true, 'Narrative is required'],
    },
    identifiedTheories: [
      {
        course: String, // e.g., "CITE1003"
        courseName: String, // e.g., "Computer Programming"
        category: String, // e.g., "Software Development"
        theory: String, // The identified theory or practice
      },
    ],
    theoriesExtractedAt: {
      type: Date,
      sparse: true,
      description: 'Timestamp when AI extracted theories from narrative',
    },
    photoDataUrl: {
      type: String,
      sparse: true,
    },
    status: {
      type: String,
      enum: ['draft', 'submitted', 'reviewed'],
      default: 'submitted',
    },
    submittedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    reviewedAt: {
      type: Date,
      sparse: true,
    },
    supervisorReview: {
      type: String,
      sparse: true,
    },
    supervisorSigned: {
      type: Boolean,
      default: false,
      index: true,
    },
    supervisorSignedAt: {
      type: Date,
      sparse: true,
    },
    supervisorSignature: {
      type: String,
      sparse: true,
    },
    coordinatorApproved: {
      type: Boolean,
      default: false,
      index: true,
    },
    coordinatorApprovedAt: {
      type: Date,
      sparse: true,
    },
    coordinatorRemarks: {
      type: String,
      sparse: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Journal', journalSchema);
