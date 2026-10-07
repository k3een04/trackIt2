const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const Journal = require('../models/Journal');
const User = require('../models/User');
const DTR = require('../models/DTR');
const { resolveOjtStartDate, ojtWeekLabel } = require('../services/ojtStartDate');
const {
  extractTheoriesFromNarrative,
  extractTheoriesLocally,
  summarizeText,
} = require('../services/summaryService');

/**
 * A draft the student is still writing. Returned-for-revision journals also
 * carry status 'draft' but are distinguished by the supervisor's review note,
 * so they keep flowing through the supervisor's Returned queue.
 */
function isPureDraft(journal) {
  return !!journal && journal.status === 'draft' && !journal.supervisorReview;
}

/** Verified DTR hours a trainee has rendered, all time. */
async function completedVerifiedHours(studentId) {
  const records = await DTR.find({ traineeId: studentId, verifiedBySupervisor: true })
    .select('hoursRendered')
    .lean();
  return records.reduce((sum, record) => sum + (record.hoursRendered || 0), 0);
}

/**
 * Week label for a journal, decided by the server so the student never picks
 * one: a revision keeps the week it was originally filed under, everything
 * else takes the trainee's current OJT week (week 1 = first supervisor
 * placement).
 *
 * @returns {{week: string}|{error: {status: number, code: string, message: string}}}
 */
async function resolveSubmissionWeek({ student, journalId }) {
  let target = null;

  if (journalId) {
    const existing = await Journal.findOne({ _id: journalId, studentId: student._id });
    if (!existing) {
      return { error: { status: 404, code: 'NOT_FOUND', message: 'Journal not found' } };
    }
    if (existing.status !== 'draft') {
      return {
        error: { status: 409, code: 'ALREADY_SUBMITTED', message: 'This journal has already been submitted.' },
      };
    }
    target = existing;
    if (existing.week) return { week: existing.week, journal: existing };
    // Filed before a supervisor was assigned: fall through and stamp a week now,
    // but keep the same document so the weekless draft is not orphaned.
  }

  const startDate = await resolveOjtStartDate(student);
  const week = ojtWeekLabel(startDate);
  if (!week) {
    return {
      error: {
        status: 409,
        code: 'NO_SUPERVISOR',
        message: 'A supervisor must be assigned before journals can be submitted.',
      },
    };
  }
  return target ? { week, journal: target } : { week };
}

/**
 * Guard shared by submit and draft save: once every required hour is rendered
 * the OJT is over and no further journal can be handed in.
 * @returns {{error: Object}|null}
 */
async function ojtPeriodCompleteError(student) {
  const completed = await completedVerifiedHours(student._id);
  const required = student.requiredHours || 486;
  if (completed < required) return null;
  return {
    error: {
      status: 409,
      code: 'OJT_PERIOD_COMPLETE',
      message: `OJT Period Complete - you have rendered ${Math.round(completed * 10) / 10} of ${required} required hours.`,
    },
  };
}

// Extract IT theories from narrative (replaces /summarize)
router.post('/extract-theories', authenticateToken, async (req, res) => {
  try {
    const { narrative } = req.body;

    if (!narrative || narrative.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Narrative is required for theory extraction',
      });
    }

    console.log('[Journal Route] Processing theory extraction request');
    console.log('[Journal Route] Narrative length:', narrative.length);
    
    const identifiedTheories = await extractTheoriesFromNarrative(narrative);

    res.status(200).json({
      success: true,
      message: 'Theories extracted successfully',
      data: {
        identifiedTheories,
      },
    });
  } catch (error) {
    console.error('[Journal Route] Error extracting theories:', error);
    const fallbackTheories = extractTheoriesLocally(req.body?.narrative || '');
    res.status(200).json({
      success: true,
      message: 'Theories extracted using curriculum matching',
      data: {
        identifiedTheories: fallbackTheories,
      },
    });
  }
});

// Legacy endpoint for backward compatibility
router.post('/summarize', authenticateToken, async (req, res) => {
  try {
    const { narrative, concepts = [] } = req.body;

    if (!narrative || narrative.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Narrative is required for summarization',
      });
    }

    console.log('[Journal Route] Processing (deprecated) summarization request');
    
    const summary = await summarizeText(narrative, 200, concepts);

    res.status(200).json({
      success: true,
      message: 'Summary generated successfully',
      data: {
        summary,
      },
    });
  } catch (error) {
    console.error('[Journal Route] Error generating summary:', error);
    res.status(500).json({
      success: false,
      message: 'Error generating summary',
      error: error.message,
    });
  }
});

// Save or update a journal draft (autosave)
router.post('/draft', authenticateToken, async (req, res) => {
  try {
    const { journalId, dayCovered, narrative, identifiedTheories = [], photoDataUrl } = req.body;
    const studentId = req.user.id;

    const student = await User.findById(studentId).select('supervisorId supervisorAssignedAt createdAt');
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const VALID_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const cleanDayCovered = VALID_DAYS.includes(dayCovered) ? dayCovered : undefined;

    const cleanTheories = Array.isArray(identifiedTheories)
      ? identifiedTheories
          .filter((t) => t && (t.course || t.courseName || t.category || t.theory))
          .map((t) => ({
            course: t.course || '',
            courseName: t.courseName || '',
            category: t.category || '',
            theory: t.theory || '',
          }))
      : [];

    // The week is never chosen by the student: a resumed journal keeps its own
    // week, everything else takes the current OJT week. Before a supervisor is
    // assigned the week stays empty - it is stamped when the journal is handed in.
    let journal = null;
    if (journalId) {
      journal = await Journal.findOne({ _id: journalId, studentId });
      if (!journal) {
        return res.status(404).json({ success: false, message: 'Journal not found' });
      }
      if (journal.status !== 'draft') {
        return res.status(409).json({
          success: false,
          code: 'NOT_A_DRAFT',
          message: 'Only drafts can be autosaved. This journal has already been submitted.',
        });
      }
    }

    let week = journal && journal.week ? journal.week : null;
    if (!week) {
      week = ojtWeekLabel(await resolveOjtStartDate(student));
    }

    // Upsert: resume the target draft, else reuse the draft already filed for
    // this week. A journal returned for revision is only ever touched through
    // an explicit resume (journalId), so a fresh draft can never clobber it.
    if (!journal) {
      // The week already has an entry waiting on the student: open that one
      // (Resume) rather than starting a second document for the same week.
      if (week) {
        const returnedForRevision = await Journal.findOne({
          studentId,
          week,
          status: 'draft',
          supervisorReview: { $ne: null },
        });
        if (returnedForRevision) {
          return res.status(409).json({
            success: false,
            code: 'REVISION_PENDING',
            message: `${week} was returned for revision - resume that journal instead of starting a new one.`,
            data: returnedForRevision,
          });
        }
      }

      const weekFilter = week
        ? { week }
        : { $or: [{ week: null }, { week: '' }, { week: { $exists: false } }] };
      journal = await Journal.findOne({
        studentId,
        status: 'draft',
        supervisorReview: null,
        ...weekFilter,
      });
    }

    if (journal) {
      journal.narrative = narrative || '';
      journal.identifiedTheories = cleanTheories;
      journal.theoriesExtractedAt = new Date();
      if (cleanDayCovered) journal.dayCovered = cleanDayCovered;
      if (photoDataUrl) journal.photoDataUrl = photoDataUrl;
      if (week && !journal.week) journal.week = week;
      if (student.supervisorId) journal.supervisorId = student.supervisorId;
      await journal.save();
    } else {
      journal = new Journal({
        studentId,
        narrative: narrative || '',
        identifiedTheories: cleanTheories,
        theoriesExtractedAt: new Date(),
        status: 'draft',
        ...(week ? { week } : {}),
        ...(cleanDayCovered ? { dayCovered: cleanDayCovered } : {}),
        ...(student.supervisorId ? { supervisorId: student.supervisorId } : {}),
        ...(photoDataUrl ? { photoDataUrl } : {}),
      });
      await journal.save();
    }

    res.status(200).json({ success: true, message: 'Draft saved', data: journal });
  } catch (error) {
    console.error('[Journal Draft] Error:', error);
    res.status(500).json({ success: false, message: 'Error saving draft', error: error.message });
  }
});

// Delete a draft the student never submitted (returned-for-revision journals
// stay: the supervisor already has them in the Returned queue).
router.delete('/draft/:journalId', authenticateToken, async (req, res) => {
  try {
    const journal = await Journal.findById(req.params.journalId);
    if (!journal) {
      return res.status(404).json({ success: false, message: 'Draft not found' });
    }
    if (journal.studentId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this draft' });
    }
    if (journal.status !== 'draft' || journal.supervisorReview) {
      return res.status(409).json({
        success: false,
        code: 'NOT_DELETABLE',
        message: 'Only drafts that were never submitted can be deleted.',
      });
    }

    await journal.deleteOne();
    res.status(200).json({ success: true, message: 'Draft deleted' });
  } catch (error) {
    console.error('[Journal Draft Delete] Error:', error);
    res.status(500).json({ success: false, message: 'Error deleting draft', error: error.message });
  }
});

// Submit a journal entry. The week is never picked by the student: it is the
// trainee's current OJT week (week 1 = first supervisor placement), or the
// journal's own week when a returned entry is being revised.
router.post('/submit', authenticateToken, async (req, res) => {
  try {
    const { journalId, dayCovered, narrative, identifiedTheories = [], photoDataUrl } = req.body;
    const studentId = req.user.id;

    if (!narrative || !String(narrative).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Narrative is required',
      });
    }

    if (photoDataUrl != null && photoDataUrl !== '' && !String(photoDataUrl).startsWith('data:image/')) {
      return res.status(400).json({
        success: false,
        message: 'Photo must be an image data URL',
      });
    }

    // MongoDB's BSON document limit is 16MB — keep the photo well under it
    // (the frontend compresses photos, this is a server-side guardrail).
    const MAX_PHOTO_CHARS = 10_485_760; // ~10MB base64 ≈ 7.5MB image
    if (photoDataUrl && String(photoDataUrl).length > MAX_PHOTO_CHARS) {
      return res.status(400).json({
        success: false,
        message: 'Photo is too large. Please attach a smaller image (max ~7MB).',
      });
    }

    // dayCovered is an optional enum — only set it when it is a valid weekday.
    // Mongoose rejects an explicit null for enum paths, so omit it otherwise.
    const VALID_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const cleanDayCovered = VALID_DAYS.includes(dayCovered) ? dayCovered : undefined;

    // Sanitize theories: drop null/empty entries so a stray item can't fail validation
    const cleanTheories = Array.isArray(identifiedTheories)
      ? identifiedTheories
          .filter((t) => t && (t.course || t.courseName || t.category || t.theory))
          .map((t) => ({
            course: t.course || '',
            courseName: t.courseName || '',
            category: t.category || '',
            theory: t.theory || '',
          }))
      : [];

    // Get student info to find supervisor
    const student = await User.findById(studentId).select(
      'fullName supervisorId companyName requiredHours supervisorAssignedAt createdAt'
    );
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    // The programme is over once every required hour has been rendered.
    const periodDone = await ojtPeriodCompleteError(student);
    if (periodDone) {
      return res
        .status(periodDone.error.status)
        .json({ success: false, code: periodDone.error.code, message: periodDone.error.message });
    }

    const resolved = await resolveSubmissionWeek({ student, journalId });
    if (resolved.error) {
      return res
        .status(resolved.error.status)
        .json({ success: false, code: resolved.error.code, message: resolved.error.message });
    }
    const week = resolved.week;

    // One journal per week. The clash only counts against handed-in journals:
    // drafts (including the one being revised) stay out of the way.
    const clash = await Journal.findOne({ studentId, week, status: { $ne: 'draft' } });
    if (clash) {
      return res.status(409).json({
        success: false,
        code: 'WEEK_ALREADY_SUBMITTED',
        message: `A journal for ${week} has already been submitted.`,
      });
    }

    // Revising a returned journal updates it in place; otherwise hand in the
    // draft already written for this week, or start a fresh journal.
    let journal = resolved.journal || null;
    if (!journal) {
      journal = await Journal.findOne({
        studentId,
        week,
        status: 'draft',
        supervisorReview: null,
      });
    }

    if (journal) {
      journal.narrative = narrative;
      journal.identifiedTheories = cleanTheories;
      journal.theoriesExtractedAt = new Date();
      if (cleanDayCovered) journal.dayCovered = cleanDayCovered;
      if (photoDataUrl) journal.photoDataUrl = photoDataUrl;
      journal.week = week;
      journal.status = 'submitted';
      journal.submittedAt = new Date();
      if (student.supervisorId) journal.supervisorId = student.supervisorId;
      await journal.save();
    } else {
      const journalData = {
        studentId,
        week,
        narrative,
        identifiedTheories: cleanTheories,
        theoriesExtractedAt: new Date(),
        status: 'submitted',
      };
      if (cleanDayCovered) journalData.dayCovered = cleanDayCovered;
      if (student.supervisorId) journalData.supervisorId = student.supervisorId;
      if (photoDataUrl) journalData.photoDataUrl = photoDataUrl;

      journal = new Journal(journalData);
      await journal.save();
    }

    try {
      const { notifyJournalSubmitted } = require('../services/notificationService');
      await notifyJournalSubmitted({ journal, trainee: student, week });
    } catch (notifyError) {
      console.error('[Journal Submit] Notification error:', notifyError.message);
    }

    res.status(201).json({
      success: true,
      message: 'Journal submitted successfully',
      data: journal,
    });
  } catch (error) {
    console.error('[Journal Submit] Error:', error);
    console.error('[Journal Submit] Error name:', error.name);
    console.error('[Journal Submit] Error code:', error.code);
    console.error('[Journal Submit] Error details:', error.errors);
    // Map the "document too large" MongoDB error to a clear user-facing message
    const isTooLarge =
      error?.code === 10334 ||
      /BSONObjectTooLarge|offset.*out of range|ERR_OUT_OF_RANGE/i.test(
        `${error?.message || ''} ${error?.code || ''}`
      );
    const details =
      error?.name === 'ValidationError' && error?.errors
        ? Object.values(error.errors).map((e) => e?.message).filter(Boolean)
        : undefined;
    res.status(error?.name === 'ValidationError' ? 400 : 500).json({
      success: false,
      message: isTooLarge
        ? 'Journal photo is too large to store. Please attach a smaller image.'
        : details?.length
          ? `Journal validation failed: ${details.join('; ')}`
          : 'Error submitting journal',
      error: error.message,
      code: error.code,
      details,
    });
  }
});

// Get journals for a student
router.get('/my-journals', authenticateToken, async (req, res) => {
  try {
    const studentId = req.user.id;
    const journals = await Journal.find({ studentId }).sort({ submittedAt: -1 });

    res.status(200).json({
      success: true,
      data: journals,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching journals',
      error: error.message,
    });
  }
});

// Get a specific journal
router.get('/:journalId', authenticateToken, async (req, res) => {
  try {
    const User = require('../models/User');
    const journal = await Journal.findById(req.params.journalId).populate('studentId', 'fullName email supervisorId').populate('supervisorId', 'fullName email');

    if (!journal) {
      return res.status(404).json({
        success: false,
        message: 'Journal not found',
      });
    }

    // Check authorization: student can view their own journal, supervisor can view journals from assigned trainees, or coordinator can view supervisor-signed journals
    const isStudent = journal.studentId._id.toString() === req.user.id;
    const isSupervisor = req.user.role === 'supervisor' && journal.studentId.supervisorId.toString() === req.user.id;
    const isCoordinator = req.user.role === 'coordinator' && journal.supervisorSigned === true;

    if (!isStudent && !isSupervisor && !isCoordinator) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this journal',
      });
    }

    res.status(200).json({
      success: true,
      data: journal,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching journal',
      error: error.message,
    });
  }
});

// Update journal
router.put('/:journalId', authenticateToken, async (req, res) => {
  try {
    const journal = await Journal.findById(req.params.journalId);

    if (!journal) {
      return res.status(404).json({
        success: false,
        message: 'Journal not found',
      });
    }

    if (journal.studentId.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this journal',
      });
    }

    const { narrative, dayCovered, identifiedTheories, photoDataUrl } = req.body;

    if (narrative) journal.narrative = narrative;
    if (dayCovered) journal.dayCovered = dayCovered;
    if (identifiedTheories) {
      journal.identifiedTheories = identifiedTheories;
      journal.theoriesExtractedAt = new Date();
    }
    if (photoDataUrl) {
      if (!photoDataUrl.startsWith('data:image/')) {
        return res.status(400).json({
          success: false,
          message: 'Photo must be an image data URL',
        });
      }
      if (photoDataUrl.length > 10_485_760) {
        return res.status(400).json({
          success: false,
          message: 'Photo is too large. Please attach a smaller image (max ~7MB).',
        });
      }
      journal.photoDataUrl = photoDataUrl;
    }
    // status and week are deliberately not accepted here: handing a journal in
    // goes through POST /submit so the server can stamp the week, check the
    // supervisor and enforce the OJT period.
    await journal.save();

    res.status(200).json({
      success: true,
      message: 'Journal updated successfully',
      data: journal,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating journal',
      error: error.message,
    });
  }
});

module.exports = router;
