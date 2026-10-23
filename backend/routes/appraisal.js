const express = require('express');
const mongoose = require('mongoose');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const Appraisal = require('../models/Appraisal');
const User = require('../models/User');
const DTR = require('../models/DTR');
const {
  CATEGORIES,
  CRITERIA,
  RATING_EQUIVALENTS,
  INFO_FIELDS,
  PERIOD_RE,
  evaluationPeriodLabel,
  sanitizeRatings,
  sanitizeInfo,
  summarize,
} = require('../services/appraisalCriteria');

const router = express.Router();

// Every appraisal route requires a valid JWT; individual routes then restrict
// to the supervisor or student role and re-check record ownership server-side.
router.use(authenticateToken);

// Filipino given names are frequently followed by a compound surname particle
// ("Juan Dela Cruz", "Ana De La Cruz"); those surnames span multiple tokens.
const NAME_PARTICLES = new Set(['dela', 'del', 'de', 'dels', 'la', 'las', 'los', 'di', 'van', 'von', 'san', 'st']);

/**
 * Best-effort split of the stored `fullName` into the official form's
 * Last / First / M.I. fields. The User model only stores a single fullName, so
 * these are prefills the supervisor may correct before submitting — nothing is
 * invented (an unparsable name simply yields empty fields).
 */
function splitFullName(fullName) {
  const tokens = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { lastName: '', firstName: '', mi: '' };
  if (tokens.length === 1) return { lastName: '', firstName: tokens[0], mi: '' };
  if (tokens.length === 2) return { lastName: tokens[1], firstName: tokens[0], mi: '' };

  // 3+ tokens: "Given Particle Surname..." -> whole tail is the surname.
  const tailIsCompound = NAME_PARTICLES.has(tokens[1].toLowerCase());
  if (tailIsCompound) {
    return { lastName: tokens.slice(1).join(' '), firstName: tokens[0], mi: '' };
  }
  return { lastName: tokens.slice(2).join(' '), firstName: tokens[0], mi: tokens[1] };
}

/** Verified DTR hours the trainee rendered inside the monthly period (YYYY-MM). */
async function verifiedHoursInPeriod(traineeId, period) {
  const [year, month] = period.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const records = await DTR.find({
    traineeId,
    verifiedBySupervisor: true,
    date: { $gte: start, $lt: end },
  }).select('hoursRendered').lean();
  const total = records.reduce((sum, record) => sum + (Number(record.hoursRendered) || 0), 0);
  return { total: Math.round(total * 100) / 100, count: records.length };
}

/** Trainee + supervisor snapshot used to prefill the official form fields. */
async function buildInfoDefaults({ trainee, supervisor, period }) {
  const names = splitFullName(trainee.fullName);
  const yearMatch = /^(\d)/.exec(trainee.section || '');
  const yearLevel = yearMatch ? `${yearMatch[1]}th Year` : '';
  const hours = await verifiedHoursInPeriod(trainee._id, period);

  return {
    lastName: names.lastName,
    firstName: names.firstName,
    mi: names.mi,
    stiCampus: '', // not stored anywhere — left blank, never invented
    program: '', // not stored anywhere — left blank, never invented
    yearLevel,
    section: trainee.section || '',
    hostTrainingEstablishment: trainee.companyName || '',
    departmentAssigned: trainee.department || '',
    ojtSupervisor: supervisor.fullName || '',
    designation: supervisor.companyPosition || '',
    evaluationPeriodLabel: evaluationPeriodLabel(period),
    totalHours: hours.count ? String(hours.total) : '',
  };
}

/**
 * Load a trainee and verify this supervisor is assigned to them.
 * Returns { trainee, supervisor } or { error: { status, message } }.
 */
async function loadAssignedTrainee(traineeId, supervisorId) {
  if (!mongoose.Types.ObjectId.isValid(traineeId)) {
    return { error: { status: 400, message: 'Invalid trainee ID.' } };
  }
  const trainee = await User.findOne({
    _id: traineeId,
    role: 'student',
  }).select('fullName studentId section department companyName supervisorId').lean();
  if (!trainee) return { error: { status: 404, message: 'Trainee not found.' } };
  if (!trainee.supervisorId || trainee.supervisorId.toString() !== supervisorId.toString()) {
    return { error: { status: 403, message: 'You can only manage appraisals for your assigned trainees.' } };
  }
  const supervisor = await User.findById(supervisorId)
    .select('fullName companyPosition signatureDataUrl').lean();
  return { trainee, supervisor: supervisor || {} };
}

function sanitizeOverallRemarks(value) {
  return typeof value === 'string' ? value.trim().slice(0, 3000) : '';
}

// ────────────────────────────────────────────────────────────────────────────
// Supervisor routes
// ────────────────────────────────────────────────────────────────────────────

// @route   GET /api/appraisal/criteria
// @desc    Official criteria, categories and rating-equivalent table
// @access  Private (Supervisor only)
router.get('/criteria', authorizeRole('supervisor'), (req, res) => {
  res.json({
    success: true,
    data: {
      categories: CATEGORIES,
      criteria: CRITERIA,
      ratingEquivalents: RATING_EQUIVALENTS,
      infoFields: INFO_FIELDS,
    },
  });
});

// @route   GET /api/appraisal/context?traineeId=&period=
// @desc    Trainee snapshot defaults + any existing record for the period
// @access  Private (Supervisor only, assigned trainees)
router.get('/context', authorizeRole('supervisor'), async (req, res) => {
  try {
    const { traineeId, period } = req.query;
    if (!PERIOD_RE.test(period || '')) {
      return res.status(400).json({ success: false, message: 'Evaluation period must be in YYYY-MM format.' });
    }
    const { trainee, supervisor, error } = await loadAssignedTrainee(traineeId, req.user.id);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const [defaults, record] = await Promise.all([
      buildInfoDefaults({ trainee, supervisor, period }),
      Appraisal.findOne({ traineeId: trainee._id, period }).lean(),
    ]);

    res.json({
      success: true,
      data: {
        trainee: {
          _id: trainee._id,
          fullName: trainee.fullName,
          studentId: trainee.studentId || '',
          section: trainee.section || '',
          department: trainee.department || '',
          companyName: trainee.companyName || '',
        },
        defaults,
        record: record || null,
      },
    });
  } catch (error) {
    console.error('Appraisal context error:', error);
    res.status(500).json({ success: false, message: 'Server error loading appraisal context.' });
  }
});

// @route   GET /api/appraisal/trainee/:traineeId
// @desc    All appraisals (drafts + submitted) for one assigned trainee
// @access  Private (Supervisor only, assigned trainees)
router.get('/trainee/:traineeId', authorizeRole('supervisor'), async (req, res) => {
  try {
    const { error } = await loadAssignedTrainee(req.params.traineeId, req.user.id);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const records = await Appraisal.find({ traineeId: req.params.traineeId })
      .sort({ period: -1 })
      .lean();
    res.json({ success: true, data: records });
  } catch (error) {
    console.error('Appraisal trainee list error:', error);
    res.status(500).json({ success: false, message: 'Server error loading appraisals.' });
  }
});

/**
 * Shared save/submit handler. Totals are ALWAYS recomputed server-side from
 * the ratings — a client cannot post its own subtotals or grade.
 */
async function saveAppraisal(req, res, { submitting }) {
  const { traineeId, period, info, ratings } = req.body;
  if (!PERIOD_RE.test(period || '')) {
    return res.status(400).json({ success: false, message: 'Evaluation period must be in YYYY-MM format.' });
  }
  const { supervisor, error } = await loadAssignedTrainee(traineeId, req.user.id);
  if (error) return res.status(error.status).json({ success: false, message: error.message });

  const ratingResult = sanitizeRatings(ratings, { requireComplete: submitting });
  if (ratingResult.errors.length) {
    return res.status(400).json({
      success: false,
      message: submitting
        ? 'The evaluation is incomplete or contains invalid ratings.'
        : 'The evaluation contains invalid ratings.',
      data: { errors: ratingResult.errors },
    });
  }

  const infoResult = sanitizeInfo(info, {
    supervisorName: supervisor.fullName,
    supervisorPosition: supervisor.companyPosition,
    period,
  });
  if (infoResult.errors.length) {
    return res.status(400).json({
      success: false,
      message: 'The form information is invalid.',
      data: { errors: infoResult.errors },
    });
  }

  const summary = summarize(ratingResult.ratings);
  const now = new Date();

  const update = {
    supervisorId: req.user.id,
    info: infoResult.info,
    ratings: ratingResult.ratings,
    overallRemarks: sanitizeOverallRemarks(req.body.overallRemarks),
    recommendedCompletion: req.body.recommendedCompletion === true,
    // Server-computed only; the $set keeps clients from forging a grade.
    subtotals: summary.subtotals,
    totalScore: summary.totalScore,
    ratingEquivalent: summary.ratingEquivalent,
    isComplete: summary.isComplete,
  };
  if (submitting) {
    update.status = 'submitted';
    update.submittedAt = now;
    update.supervisorSignature = {
      // Snapshot of the supervisor's e-signature at submit time. Stays null
      // when no signature was recorded — the PDF must not claim one exists.
      dataUrl: supervisor.signatureDataUrl || null,
      signedByName: supervisor.fullName || '',
      signedAt: now,
    };
  }

  // `status` may only live in one operator: submit sets it in $set, while a
  // brand-new submitted record must not fall back to the draft default.
  const setOnInsert = { traineeId, period };
  if (!submitting) setOnInsert.status = 'draft';

  try {
    const record = await Appraisal.findOneAndUpdate(
      { traineeId, period },
      {
        $set: update,
        $setOnInsert: setOnInsert,
      },
      { upsert: true, new: true, runValidators: true }
    ).lean();

    res.json({
      success: true,
      message: submitting
        ? 'Appraisal submitted and signed.'
        : 'Draft saved. Reopen it any time before submitting.',
      data: record,
    });
  } catch (saveError) {
    // A concurrent submit won the race on the (traineeId, period) unique index.
    if (saveError && saveError.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'This appraisal was just submitted and is now locked.',
      });
    }
    // Submitted appraisals are locked: a draft/submit against an existing
    // submitted record flips status in $set, so guard explicitly first.
    if (saveError && saveError.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: saveError.message });
    }
    console.error('Appraisal save error:', saveError);
    res.status(500).json({ success: false, message: 'Server error saving the appraisal.' });
  }
}

/**
 * Reject any save that would modify a locked (submitted) appraisal.
 * Runs before both draft and submit so the 409 message stays precise.
 */
async function rejectIfLocked(traineeId, period, res) {
  const existing = await Appraisal.findOne({ traineeId, period }).select('status').lean();
  if (existing && existing.status !== 'draft') {
    res.status(409).json({
      success: false,
      message: 'This appraisal has already been submitted and is locked. It can no longer be edited.',
    });
    return true;
  }
  return false;
}

// @route   POST /api/appraisal/draft
// @desc    Create or update a draft appraisal (partial ratings allowed)
// @access  Private (Supervisor only, assigned trainees)
router.post('/draft', authorizeRole('supervisor'), async (req, res) => {
  try {
    const { traineeId, period } = req.body;
    if (!PERIOD_RE.test(period || '')) {
      return res.status(400).json({ success: false, message: 'Evaluation period must be in YYYY-MM format.' });
    }
    if (!mongoose.Types.ObjectId.isValid(traineeId)) {
      return res.status(400).json({ success: false, message: 'Invalid trainee ID.' });
    }
    if (await rejectIfLocked(traineeId, period, res)) return;
    await saveAppraisal(req, res, { submitting: false });
  } catch (error) {
    console.error('Appraisal draft error:', error);
    res.status(500).json({ success: false, message: 'Server error saving the draft.' });
  }
});

// @route   POST /api/appraisal/submit
// @desc    Submit & sign: requires all nine ratings, snapshots the signature,
//          locks the record against further edits
// @access  Private (Supervisor only, assigned trainees)
router.post('/submit', authorizeRole('supervisor'), async (req, res) => {
  try {
    const { traineeId, period } = req.body;
    if (!PERIOD_RE.test(period || '')) {
      return res.status(400).json({ success: false, message: 'Evaluation period must be in YYYY-MM format.' });
    }
    if (!mongoose.Types.ObjectId.isValid(traineeId)) {
      return res.status(400).json({ success: false, message: 'Invalid trainee ID.' });
    }
    if (await rejectIfLocked(traineeId, period, res)) return;
    await saveAppraisal(req, res, { submitting: true });
  } catch (error) {
    console.error('Appraisal submit error:', error);
    res.status(500).json({ success: false, message: 'Server error submitting the appraisal.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Shared record fetch (role-aware) + student routes
// ────────────────────────────────────────────────────────────────────────────

// @route   GET /api/appraisal/record/:id
// @desc    One full record for PDF generation. Students only see their own
//          finalized records; supervisors only records of their trainees.
// @access  Private (Student or Supervisor)
router.get('/record/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid appraisal ID.' });
    }
    const record = await Appraisal.findById(id).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Appraisal not found.' });

    if (req.user.role === 'student') {
      if (record.traineeId.toString() !== req.user.id.toString()) {
        return res.status(403).json({ success: false, message: 'Not authorized to view this appraisal.' });
      }
      // Drafts are never exposed to students.
      if (record.status === 'draft') {
        return res.status(403).json({ success: false, message: 'This appraisal has not been finalized yet.' });
      }
    } else if (req.user.role === 'supervisor') {
      const isOwner = record.supervisorId && record.supervisorId.toString() === req.user.id.toString();
      let isAssigned = false;
      if (!isOwner) {
        const trainee = await User.findById(record.traineeId).select('supervisorId').lean();
        isAssigned = !!trainee && !!trainee.supervisorId && trainee.supervisorId.toString() === req.user.id.toString();
      }
      if (!isOwner && !isAssigned) {
        return res.status(403).json({ success: false, message: 'Not authorized to view this appraisal.' });
      }
    } else {
      return res.status(403).json({ success: false, message: 'Not authorized to view this appraisal.' });
    }

    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Appraisal record error:', error);
    res.status(500).json({ success: false, message: 'Server error loading the appraisal.' });
  }
});

// @route   GET /api/appraisal/mine
// @desc    The signed-in student's finalized appraisals (drafts excluded)
// @access  Private (Student only)
router.get('/mine', authorizeRole('student'), async (req, res) => {
  try {
    const records = await Appraisal.find({
      traineeId: req.user.id,
      status: { $ne: 'draft' },
    }).sort({ period: -1 }).lean();

    res.json({
      success: true,
      data: records.map((record) => ({
        _id: record._id,
        period: record.period,
        periodLabel: (record.info && record.info.evaluationPeriodLabel) || evaluationPeriodLabel(record.period),
        status: record.status,
        totalScore: record.totalScore,
        ratingEquivalent: record.ratingEquivalent,
        isComplete: record.isComplete,
        submittedAt: record.submittedAt,
      })),
    });
  } catch (error) {
    console.error('Appraisal mine error:', error);
    res.status(500).json({ success: false, message: 'Server error loading your appraisals.' });
  }
});

module.exports = router;
