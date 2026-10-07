const express = require('express');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const User = require('../models/User');
const DTR = require('../models/DTR');
const Journal = require('../models/Journal');
const Company = require('../models/Company');
const Notification = require('../models/Notification');
const {
  buildCoordinatorAnalytics,
  buildAutomatedReport,
} = require('../services/coordinatorAnalyticsService');
const {
  listInactiveTraineeIds,
  startOfDay,
  addDays,
} = require('../services/activityStatusService');

const router = express.Router();

// Notification types that describe something actually happening in the system
// (journal lifecycle, attendance, activity transitions). `system` housekeeping
// notices such as "Supervisor assigned" are deliberately excluded: the Overview
// feed is an activity feed, not a copy of the notification bell.
const ACTIVITY_NOTIFICATION_TYPES = ['journal', 'attendance', 'inactivity', 'activity'];

// How many activities the Overview feed shows. The card scrolls, so this is a
// feed window rather than a page.
const RECENT_ACTIVITY_LIMIT = 15;

// Attendance Issues looks at this many days back, matching the window the
// coordinator analytics already reports attendance against.
const ATTENTION_WINDOW_DAYS = 30;

// The student dashboard offers "Week 1" .. "Week 17" as its journal selector
// (ojtdashboard.js). A trainee who is past that range has no required journal
// left to be missing.
const TOTAL_OJT_WEEKS = 17;

/**
 * The OJT week a trainee is on today. Same rule the student dashboard uses:
 * Week 1 covers the first 7 days after the OJT start date, which is the first
 * supervisor placement (see services/ojtStartDate.js).
 */
function currentOjtWeek(startDate, now) {
  if (!startDate) return null;
  const elapsed = now.getTime() - new Date(startDate).getTime();
  const week = Math.floor(elapsed / (7 * 24 * 60 * 60 * 1000)) + 1;
  return week >= 1 ? week : null;
}

/** "Week 12" | "week12" | "12" -> 12; anything unparseable -> null. */
function weekNumberOf(label) {
  const match = /(\d+)/.exec(String(label || ''));
  return match ? Number(match[1]) : null;
}

/**
 * Trainees that have not submitted the journal required for the OJT week they
 * are currently on. Drafts do not count as a submission - the student has not
 * actually handed the journal in yet.
 */
async function summarizeMissingJournals(activeTrainees, now) {
  const requiredWeekByTrainee = new Map();

  // Week 1 starts at the first supervisor placement, same origin the student
  // dashboard counts from. Backfills legacy rows in a single batched write.
  const { backfillOjtStartDates, ojtStartDateForDisplay } = require('../services/ojtStartDate');
  await backfillOjtStartDates(activeTrainees);

  activeTrainees.forEach(trainee => {
    const week = currentOjtWeek(ojtStartDateForDisplay(trainee), now);
    // Outside the programme's 17 weeks there is no required journal.
    if (week === null || week > TOTAL_OJT_WEEKS) return;
    requiredWeekByTrainee.set(String(trainee._id), week);
  });

  if (!requiredWeekByTrainee.size) return { count: 0, traineeIds: [] };

  const requiredWeeks = [...new Set(requiredWeekByTrainee.values())];

  const submitted = await Journal.find({
    studentId: { $in: [...requiredWeekByTrainee.keys()] },
    // Matched as a pattern rather than an exact label so a differently written
    // week ("week 3", "Week 03", "3") is still recognised as this week's
    // journal instead of being counted as missing.
    week: {
      $in: requiredWeeks.map(week => new RegExp(`^\\s*(?:week\\s*)?0*${week}\\s*$`, 'i')),
    },
    status: { $ne: 'draft' },
  })
    .select('studentId week')
    .lean();

  const submittedKeys = new Set();
  submitted.forEach(journal => {
    const week = weekNumberOf(journal.week);
    if (week === null) return;
    submittedKeys.add(`${journal.studentId}|${week}`);
  });

  const traineeIds = [];
  requiredWeekByTrainee.forEach((week, traineeId) => {
    if (!submittedKeys.has(`${traineeId}|${week}`)) traineeIds.push(traineeId);
  });

  return { count: traineeIds.length, traineeIds };
}

/** Trim a Notification down to what the Recent Activity card renders. */
function activityShape(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    type: doc.type || 'system',
    message: doc.message || doc.title || '',
    createdAt: doc.createdAt || null,
  };
}

// @route   GET /api/stats/coordinator
// @desc    Get coordinator overview stats from MongoDB
// @access  Private (Coordinator only)
router.get('/coordinator', authenticateToken, authorizeRole('coordinator'), async (req, res) => {
  try {
    // Count students
    const totalStudents = await User.countDocuments({ role: 'student' });
    const activeStudents = await User.countDocuments({ role: 'student', isActive: true });
    const supervisorCount = await User.countDocuments({ role: 'supervisor' });

    // Get unique companies from students
    const companies = await User.distinct('companyName', {
      role: 'student',
      companyName: { $ne: null, $ne: '' }
    });

    // Get department breakdown
    const deptBreakdown = await User.aggregate([
      { $match: { role: 'student' } },
      { $group: { _id: '$department', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Get trainee list with supervisor populated (for overview charts)
    const trainees = await User.find({ role: 'student' })
      .populate('supervisorId', 'fullName companyName')
      .select('fullName studentId department companyName isActive createdAt completedHours requiredHours')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: {
        stats: {
          totalStudents,
          activeStudents,
          supervisorCount,
          companyCount: companies.length,
        },
        departmentBreakdown: deptBreakdown,
        trainees,
      },
    });
  } catch (error) {
    console.error('Coordinator stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching coordinator stats',
    });
  }
});

// @route   GET /api/stats/coordinator/overview
// @desc    Data behind the two Overview cards: the Pending Actions counters
//          (with the ids behind them, so the Trainees tab can filter to them)
//          and the Recent Activity feed.
//          Every number is derived from live records - nothing here is stored,
//          cached or mocked - so the counters move as soon as the underlying
//          journal / DTR / status data changes.
// @access  Private (Coordinator only)
router.get('/coordinator/overview', authenticateToken, authorizeRole('coordinator'), async (req, res) => {
  try {
    const now = new Date();
    const attentionWindowStart = startOfDay(addDays(now, -ATTENTION_WINDOW_DAYS));

    const [journalReviews, lateTraineeIds, inactiveTraineeIds, activeTrainees, activityDocs] =
      await Promise.all([
        // Journals actually ready for the coordinator to act on: signed by the
        // supervisor and not yet approved. Mirrors the Journal Review queue.
        Journal.countDocuments({ supervisorSigned: true, coordinatorApproved: false }),
        // Distinct trainees with at least one late attendance record in the window.
        DTR.distinct('traineeId', { status: 'late', date: { $gte: attentionWindowStart } }),
        // 3 consecutive applicable OJT days without a time in (shared logic).
        listInactiveTraineeIds(now),
        User.find({ role: 'student', isActive: true })
          .select('_id createdAt supervisorId supervisorAssignedAt')
          .lean(),
        Notification.find({
          recipientId: req.user.id,
          type: { $in: ACTIVITY_NOTIFICATION_TYPES },
        })
          .sort({ createdAt: -1 })
          .limit(RECENT_ACTIVITY_LIMIT)
          .lean(),
      ]);

    const missingJournals = await summarizeMissingJournals(activeTrainees, now);

    res.status(200).json({
      success: true,
      data: {
        pendingActions: {
          journalReviews,
          attendanceIssues: lateTraineeIds.length,
          inactiveTrainees: inactiveTraineeIds.length,
          missingJournals: missingJournals.count,
        },
        attentionTrainees: {
          late: lateTraineeIds.map(String),
          inactive: inactiveTraineeIds,
          missingJournal: missingJournals.traineeIds,
        },
        recentActivity: activityDocs.map(activityShape).filter(Boolean),
      },
    });
  } catch (error) {
    console.error('Coordinator overview error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching overview data',
    });
  }
});

// @route   GET /api/stats/coordinator/analytics
// @desc    Get descriptive analytics for the coordinator dashboard
//          (overall statistics, attendance/DTR, trainee progress,
//          performance appraisals, and journal status)
// @access  Private (Coordinator only)
router.get('/coordinator/analytics', authenticateToken, authorizeRole('coordinator'), async (req, res) => {
  try {
    const data = await buildCoordinatorAnalytics();

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('Coordinator analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching coordinator analytics',
    });
  }
});

// @route   GET /api/stats/coordinator/report
// @desc    Generate an automated descriptive report from the recorded data
//          (?type=summary|trainees|attendance|journals)
// @access  Private (Coordinator only)
router.get('/coordinator/report', authenticateToken, authorizeRole('coordinator'), async (req, res) => {
  try {
    const coordinatorPromise = (async () => {
      try {
        return await User.findById(req.user.id)
          .select('fullName email employeeId coordinatorDepartment')
          .lean();
      } catch (lookupError) {
        return null;
      }
    })();

    const [analytics, coordinator] = await Promise.all([buildCoordinatorAnalytics(), coordinatorPromise]);

    const report = buildAutomatedReport(analytics, {
      type: req.query.type,
      generatedBy: coordinator,
    });

    res.status(200).json({
      success: true,
      data: report,
    });
  } catch (error) {
    console.error('Coordinator report error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error generating coordinator report',
    });
  }
});


// @route   GET /api/stats/supervisor
// @desc    Get supervisor overview stats from MongoDB
// @access  Private (Supervisor only)
router.get('/supervisor', authenticateToken, authorizeRole('supervisor'), async (req, res) => {
  try {
    // Count assigned trainees
    const assignedTrainees = await User.countDocuments({
      role: 'student',
      supervisorId: req.user.id,
    });
    const activeAssigned = await User.countDocuments({
      role: 'student',
      supervisorId: req.user.id,
      isActive: true,
    });

    // Get trainees assigned to this supervisor
    const trainees = await User.find({
      role: 'student',
      supervisorId: req.user.id,
    }).select('_id');

    const traineeIds = trainees.map(t => t._id);

    // Count unverified DTRs for assigned trainees (DTRs awaiting supervisor verification)
    const pendingDTRsCount = await DTR.countDocuments({
      traineeId: { $in: traineeIds },
      verifiedBySupervisor: false,
      status: { $in: ['present', 'late', 'early-leave'] },
      timeIn: { $exists: true, $ne: null },
      timeOut: { $exists: true, $ne: null },
    });

    // Count unsigned journals for assigned trainees. Drafts are excluded:
    // a journal the student has not handed in yet is not the supervisor's to
    // sign (returned-for-revision entries live in the Returned queue instead).
    const pendingJournalsCount = await Journal.countDocuments({
      studentId: { $in: traineeIds },
      supervisorSigned: false,
      status: { $ne: 'draft' },
    });

    res.status(200).json({
      success: true,
      data: {
        stats: {
          assignedTrainees,
          activeAssigned,
          pendingDTRs: pendingDTRsCount,
          pendingJournals: pendingJournalsCount,
          pendingAppraisals: 0,
        },
      },
    });
  } catch (error) {
    console.error('Supervisor stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching supervisor stats',
    });
  }
});

// @route   GET /api/supervisor/pending-actions
// @desc    Get all pending actions for supervisor (DTRs and journals to review)
// @access  Private (Supervisor only)
router.get('/pending-actions', authenticateToken, authorizeRole('supervisor'), async (req, res) => {
  try {
    // Get trainees assigned to this supervisor
    const trainees = await User.find({
      role: 'student',
      supervisorId: req.user.id,
    }).select('_id fullName');

    const traineeIds = trainees.map(t => t._id);
    const traineeMap = {};
    trainees.forEach(t => {
      traineeMap[t._id.toString()] = t.fullName;
    });

    const pendingActions = [];

    // Get pending DTRs (unverified DTRs for assigned trainees)
    const pendingDTRs = await DTR.find({
      traineeId: { $in: traineeIds },
      verifiedBySupervisor: false,
      status: { $in: ['present', 'late', 'early-leave'] },
      timeIn: { $exists: true, $ne: null },
      timeOut: { $exists: true, $ne: null },
    })
      .populate('traineeId', 'fullName')
      .sort({ date: -1 })
      .limit(10);

    pendingDTRs.forEach(dtr => {
      const date = new Date(dtr.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      pendingActions.push({
        type: 'dtr',
        id: dtr._id,
        title: 'DTR to Verify',
        trainee: dtr.traineeId.fullName,
        date: date,
        timestamp: dtr.date,
      });
    });

    // Get pending journals (unsigned journals for assigned trainees).
    // Drafts are the student's own work in progress, never a pending action.
    const pendingJournals = await Journal.find({
      studentId: { $in: traineeIds },
      supervisorSigned: false,
      status: { $ne: 'draft' },
    })
      .populate('studentId', 'fullName')
      .sort({ submittedAt: -1 })
      .limit(10);

    pendingJournals.forEach(journal => {
      const date = new Date(journal.submittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      pendingActions.push({
        type: 'journal',
        id: journal._id,
        title: 'Journal to Review',
        trainee: journal.studentId.fullName,
        week: journal.week,
        date: date,
        timestamp: journal.submittedAt,
      });
    });

    // Sort by most recent first
    pendingActions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.status(200).json({
      success: true,
      data: pendingActions.slice(0, 5), // Return top 5 pending actions
    });
  } catch (error) {
    console.error('Pending actions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching pending actions',
    });
  }
});

// @route   GET /api/stats/student
// @desc    Get student overview stats from MongoDB
// @access  Private (Student only)
router.get('/student', authenticateToken, authorizeRole('student'), async (req, res) => {
  try {
    // Get student profile with supervisor and company
    const student = await User.findById(req.user.id)
      .populate('supervisorId', 'fullName email companyName companyPosition signatureDataUrl')
      .populate('companyId', 'name address')
      .select('-password');

    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found',
      });
    }

    // Journal weeks count from the first supervisor placement, not account
    // creation. Legacy students get the date derived and persisted here.
    const { resolveOjtStartDate } = require('../services/ojtStartDate');
    const ojtStartDate = await resolveOjtStartDate(student);

    // Older student records may have companyName without the company reference
    // required by the geofence and DTR endpoints. Resolve and persist it here.
    if (!student.companyId) {
      const companyName = student.companyName || student.supervisorId?.companyName;
      if (companyName) {
        const escapedName = companyName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const company = await Company.findOne({
          name: { $regex: new RegExp(`^${escapedName}$`, 'i') },
        }).select('name address geofenceLocation');

        if (company) {
          student.companyId = company._id;
          await student.save();
        }
      }
    }

    // Get verified DTR records only (verified by supervisor)
    // For this month only
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const verifiedDTRs = await DTR.find({
      traineeId: req.user.id,
      verifiedBySupervisor: true,
      date: { $gte: startOfMonth, $lte: endOfMonth }
    });

    // Calculate completed hours from verified records only
    let completedHours = 0;
    let daysPresent = 0;
    
    const uniqueDays = new Set();
    verifiedDTRs.forEach(record => {
      completedHours += record.hoursRendered || 0;
      
      // Count unique days (based on date, not including duplicates)
      const dateKey = new Date(record.date).toDateString();
      if (!uniqueDays.has(dateKey)) {
        uniqueDays.add(dateKey);
        // Count all verified days with hours rendered (present, late, etc.) - not absent
        if (record.status !== 'absent' && record.hoursRendered > 0) {
          daysPresent++;
        }
      }
    });

    // But for total completed hours, we need all-time verified records
    const allTimeVerifiedDTRs = await DTR.find({
      traineeId: req.user.id,
      verifiedBySupervisor: true,
    });

    let allTimeCompletedHours = 0;
    allTimeVerifiedDTRs.forEach(record => {
      allTimeCompletedHours += record.hoursRendered || 0;
    });

    const requiredHours = student.requiredHours || 486;
    const remainingHours = Math.max(0, requiredHours - allTimeCompletedHours);
    const progressPercentage = Math.round((allTimeCompletedHours / requiredHours) * 100);

    // Get journal submission count
    const submittedJournals = await Journal.countDocuments({
      studentId: req.user.id,
      status: { $in: ['submitted', 'reviewed'] }
    });

    // Get pending journals awaiting supervisor signature
    const pendingJournalsCount = await Journal.countDocuments({
      studentId: req.user.id,
      supervisorSigned: { $ne: true },
      status: 'submitted',
    });

    // Ensure supervisor is properly populated
    let supervisorData = student.supervisorId || null;
    if (student.supervisorId && typeof student.supervisorId === 'object' && !student.supervisorId.fullName) {
      // If supervisorId exists but wasn't properly populated, fetch it directly
      const supervisor = await User.findById(student.supervisorId, 'fullName email companyName companyPosition signatureDataUrl');
      supervisorData = supervisor;
    }

    console.log('📊 Student stats endpoint - Student:', {
      id: student._id,
      fullName: student.fullName,
      companyName: student.companyName,
      supervisorRating: student.supervisorRating,
      journalCount: submittedJournals,
      supervisorId: student.supervisorId,
      supervisor: supervisorData,
      company: student.companyId
    });

    res.status(200).json({
      success: true,
      data: {
        student: {
          id: student._id,
          fullName: student.fullName,
          email: student.email,
          studentId: student.studentId,
          department: student.department,
          companyName: student.companyName,
          isActive: student.isActive,
          createdAt: student.createdAt,
          supervisor: supervisorData,
          hasSupervisor: !!student.supervisorId,
          supervisorAssignedAt: ojtStartDate ? ojtStartDate.toISOString() : null,
          company: student.companyId || null,
          supervisorRating: student.supervisorRating || null,
        },
        // Calculate stats from verified DTR records
        stats: {
          completedHours: Math.round(allTimeCompletedHours * 10) / 10,
          totalRequired: requiredHours,
          daysPresent: daysPresent,
          journalSubmissions: submittedJournals,
          pendingJournals: pendingJournalsCount,
          remainingHours: remainingHours,
          progressPercentage: progressPercentage,
        },
      },
    });
  } catch (error) {
    console.error('Student stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching student stats',
    });
  }
});

module.exports = router;
