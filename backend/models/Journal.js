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
      required: [true, 'Week is required'],
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
