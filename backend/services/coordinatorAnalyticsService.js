/**
 * Coordinator descriptive analytics service.
 *
 * Centralizes the aggregation behind the coordinator dashboard so that the KPI
 * cards, charts, and the automated report generator all read from one
 * consistent view of the recorded data:
 *   - trainee records (User)
 *   - attendance / DTR records (DTR)
 *   - weekly journals (Journal)
 *   - supervisor performance appraisals (User.supervisorRating)
 *
 * Every number the dashboard shows is derived here, which is what makes the
 * dashboard "centralized": attendance, DTR, journals, performance appraisals,
 * and trainee records are gathered and summarized in a single response.
 */

const User = require('../models/User');
const DTR = require('../models/DTR');
const Journal = require('../models/Journal');
const {
  STATUS_ACTIVE,
  STATUS_INACTIVE,
  evaluateStatus,
  loadAttendanceSummariesForAll,
  startOfDay: activityStartOfDay,
  addDays: activityAddDays,
  DEFAULT_LOOKBACK_DAYS,
  INACTIVITY_THRESHOLD_DAYS,
} = require('./activityStatusService');

const DEFAULT_REQUIRED_HOURS = 486;
const ATTENDANCE_WINDOW_DAYS = 30;
const JOURNAL_WINDOW_DAYS = 90;
const CONCEPT_WINDOW_DAYS = 30;
const MONTH_TREND_COUNT = 6;
const WEEK_TREND_COUNT = 8;
const RECENT_DTR_LIMIT = 10;
const TOP_TRAINEE_LIMIT = 8;
const TOP_PERFORMER_LIMIT = 5;

// Rating bands used to summarize the monthly performance appraisals.
const PERFORMANCE_BANDS = [
  { key: 'excellent', label: 'Excellent (4.5 - 5.0)', minRating: 4.5 },
  { key: 'good', label: 'Good (3.5 - 4.4)', minRating: 3.5 },
  { key: 'satisfactory', label: 'Satisfactory (2.5 - 3.4)', minRating: 2.5 },
  { key: 'needsImprovement', label: 'Needs Improvement (below 2.5)', minRating: 0 },
];

// ────────────────────────────────────────────────────────────────────────────
// NUMERIC / DATE HELPERS
// ────────────────────────────────────────────────────────────────────────────

function round(value, decimals = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(numeric * factor) / factor;
}

function percent(part, whole, decimals = 1) {
  const numerator = Number(part) || 0;
  const denominator = Number(whole) || 0;
  if (denominator <= 0) return 0;
  return round((numerator / denominator) * 100, decimals);
}

function startOfDay(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function endOfDay(date) {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value;
}

function addDays(date, days) {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
}

function dayKey(date) {
  const value = new Date(date);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function monthKey(date) {
  const value = new Date(date);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  return `${value.getFullYear()}-${month}`;
}

/**
 * UTC offset of the server (e.g. "+08:00"). DTR timestamps are stored with
 * `date: new Date()`, so bucketing them by day in the server's local time keeps
 * the trend charts aligned with how the records were created.
 */
function serverTimezoneOffset(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatHours(value) {
  return `${round(value, 1).toLocaleString('en-US', { maximumFractionDigits: 1 })} h`;
}

function formatCount(value) {
  return (Number(value) || 0).toLocaleString('en-US');
}

function formatPercent(value) {
  return `${round(value, 1).toFixed(1)}%`;
}

function performanceBandOf(rating) {
  if (typeof rating !== 'number') return 'unrated';
  const band = PERFORMANCE_BANDS.find(item => rating >= item.minRating);
  return band ? band.key : 'needsImprovement';
}

// ────────────────────────────────────────────────────────────────────────────
// ATTENDANCE TREND (daily buckets → monthly + weekly series)
// ────────────────────────────────────────────────────────────────────────────

function createEmptyDayBucket() {
  return { hours: 0, present: 0, late: 0, absent: 0, excused: 0, records: 0 };
}

/**
 * Verified DTR records grouped per calendar day (server-local days).
 * Falls back to in-process bucketing if the aggregation is not supported by the
 * connected MongoDB build, so the dashboard never loses its trend charts.
 */
async function loadAttendanceTrend(traineeIds, since, timezone) {
  const dailyBuckets = new Map();

  try {
    const rows = await DTR.aggregate([
      {
        $match: {
          traineeId: { $in: traineeIds },
          verifiedBySupervisor: true,
          date: { $gte: since },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone } },
          hours: { $sum: { $cond: [{ $gt: ['$hoursRendered', 0] }, '$hoursRendered', 0] } },
          present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
          late: { $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
          excused: { $sum: { $cond: [{ $eq: ['$status', 'excused'] }, 1, 0] } },
          records: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    rows.forEach(row => {
      dailyBuckets.set(row._id, {
        hours: Number(row.hours) || 0,
        present: row.present || 0,
        late: row.late || 0,
        absent: row.absent || 0,
        excused: row.excused || 0,
        records: row.records || 0,
      });
    });

    return dailyBuckets;
  } catch (error) {
    console.warn('[CoordinatorAnalytics] Daily aggregation unavailable, bucketing in process instead:', error.message);

    const records = await DTR.find({
      traineeId: { $in: traineeIds },
      verifiedBySupervisor: true,
      date: { $gte: since },
    })
      .select('date hoursRendered status')
      .lean();

    records.forEach(record => {
      const key = dayKey(record.date);
      const bucket = dailyBuckets.get(key) || createEmptyDayBucket();
      bucket.hours += Number(record.hoursRendered) > 0 ? Number(record.hoursRendered) : 0;
      bucket.records += 1;
      if (Object.prototype.hasOwnProperty.call(bucket, record.status)) {
        bucket[record.status] += 1;
      }
      dailyBuckets.set(key, bucket);
    });

    return dailyBuckets;
  }
}

/**
 * Totals for the daily buckets that fall inside an inclusive day-key range.
 */
function summarizeDailyBuckets(dailyBuckets, startKey, endKey) {
  const totals = createEmptyDayBucket();
  let activeDays = 0;

  dailyBuckets.forEach((bucket, day) => {
    if (day < startKey || day > endKey) return;
    activeDays += 1;
    totals.hours += bucket.hours;
    totals.present += bucket.present;
    totals.late += bucket.late;
    totals.absent += bucket.absent;
    totals.excused += bucket.excused;
    totals.records += bucket.records;
  });

  return { ...totals, hours: round(totals.hours), activeDays };
}

function buildMonthlySeries(dailyBuckets, now) {
  const monthlyHours = [];
  const monthlyAttendance = [];

  for (let index = MONTH_TREND_COUNT - 1; index >= 0; index -= 1) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - index, 1);
    const key = monthKey(monthDate);
    const label = monthDate.toLocaleDateString('en-US', { month: 'short' });
    const totals = createEmptyDayBucket();

    dailyBuckets.forEach((bucket, day) => {
      if (!day.startsWith(key)) return;
      totals.hours += bucket.hours;
      totals.present += bucket.present;
      totals.late += bucket.late;
      totals.absent += bucket.absent;
      totals.excused += bucket.excused;
      totals.records += bucket.records;
    });

    monthlyHours.push({ label, month: key, hours: round(totals.hours) });
    monthlyAttendance.push({
      label,
      month: key,
      hours: round(totals.hours),
      present: totals.present,
      late: totals.late,
      absent: totals.absent,
      excused: totals.excused,
      records: totals.records,
    });
  }

  return { monthlyHours, monthlyAttendance };
}

function buildWeeklySeries(dailyBuckets, now) {
  const weeklyHours = [];

  for (let index = WEEK_TREND_COUNT - 1; index >= 0; index -= 1) {
    const windowEnd = addDays(now, -(index * 7));
    const windowStart = addDays(windowEnd, -6);
    const startKey = dayKey(windowStart);
    const endKey = dayKey(windowEnd);
    const totals = createEmptyDayBucket();

    dailyBuckets.forEach((bucket, day) => {
      if (day < startKey || day > endKey) return;
      totals.hours += bucket.hours;
      totals.present += bucket.present;
      totals.late += bucket.late;
      totals.absent += bucket.absent;
      totals.excused += bucket.excused;
      totals.records += bucket.records;
    });

    weeklyHours.push({
      label: windowStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      range: `${formatDate(windowStart)} – ${formatDate(windowEnd)}`,
      startDate: startKey,
      endDate: endKey,
      hours: round(totals.hours),
      present: totals.present,
      late: totals.late,
      absent: totals.absent,
      excused: totals.excused,
      records: totals.records,
    });
  }

  return weeklyHours;
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN AGGREGATION
// ────────────────────────────────────────────────────────────────────────────

/**
 * Builds the complete descriptive analytics payload for the coordinator
 * dashboard: overall statistics, attendance/DTR, trainee progress, performance
 * appraisals, journal status, department breakdown, and the automatically
 * generated findings used by the report generator.
 */
async function buildCoordinatorAnalytics() {
  const now = new Date();
  const timezone = serverTimezoneOffset(now);

  const students = await User.find({ role: 'student' })
    .select('_id fullName studentId department section requiredHours companyName isActive supervisorRating supervisorRatingDate supervisorId createdAt schedule activityStatus inactivityStartDate')
    .lean();

  const traineeIds = students.map(student => student._id);
  const traineeNameById = new Map(students.map(student => [student._id.toString(), student.fullName]));
  const activeTrainees = students.filter(student => student.isActive !== false).length;

  // Attendance-derived ACTIVE / INACTIVE labels. Resolved once, from the same
  // service the notifications and the student profile use, so the analytics
  // table can never disagree with the coordinator's bell.
  const activityMap = new Map();
  try {
    const attendanceSummaries = await loadAttendanceSummariesForAll(
      activityStartOfDay(activityAddDays(now, -DEFAULT_LOOKBACK_DAYS))
    );
    students.forEach(student => {
      const attendance = attendanceSummaries.get(student._id.toString()) || {
        attendedDays: new Set(),
        excusedDays: new Set(),
        lastTimeIn: null,
      };
      activityMap.set(student._id.toString(), evaluateStatus({ trainee: student, attendance, now }));
    });
  } catch (error) {
    // Never let a status lookup take the whole analytics payload down: fall back
    // to the last persisted label so the table still renders.
    console.error('[CoordinatorAnalytics] Activity status lookup failed:', error.message);
    students.forEach(student => {
      activityMap.set(student._id.toString(), {
        status: student.activityStatus || STATUS_ACTIVE,
        lastTimeIn: null,
        consecutiveMissedDays: 0,
        daysSinceLastAttendance: null,
        inactivityStartDate: student.inactivityStartDate || null,
        isNewStudent: false,
        evaluatedAt: now.toISOString(),
      });
    });
  }

  const trendWindowStart = new Date(now.getFullYear(), now.getMonth() - (MONTH_TREND_COUNT - 1), 1);
  const attendanceWindowStart = addDays(now, -ATTENDANCE_WINDOW_DAYS);
  const journalWindowStart = addDays(now, -JOURNAL_WINDOW_DAYS);
  const journalTrendStart = startOfDay(addDays(now, -(WEEK_TREND_COUNT * 7)));
  const conceptWindowStart = addDays(now, -CONCEPT_WINDOW_DAYS);
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  // ── Attendance & DTR ────────────────────────────────────────────────────
  const dailyBucketsPromise = loadAttendanceTrend(traineeIds, trendWindowStart, timezone);

  const attendanceStatusAggPromise = DTR.aggregate([
    {
      $match: {
        traineeId: { $in: traineeIds },
        verifiedBySupervisor: true,
        date: { $gte: attendanceWindowStart },
      },
    },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const attendancePerTraineeAggPromise = DTR.aggregate([
    {
      $match: {
        traineeId: { $in: traineeIds },
        verifiedBySupervisor: true,
        date: { $gte: attendanceWindowStart },
      },
    },
    {
      $group: {
        _id: '$traineeId',
        present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
        late: { $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] } },
        absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
        excused: { $sum: { $cond: [{ $eq: ['$status', 'excused'] }, 1, 0] } },
        records: { $sum: 1 },
        hours: { $sum: { $cond: [{ $gt: ['$hoursRendered', 0] }, '$hoursRendered', 0] } },
        days: { $addToSet: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone } } },
      },
    },
    { $project: { present: 1, late: 1, absent: 1, excused: 1, records: 1, hours: 1, dayCount: { $size: '$days' } } },
  ]);

  const todayPresentPromise = DTR.countDocuments({
    traineeId: { $in: traineeIds },
    verifiedBySupervisor: true,
    timeIn: { $exists: true, $ne: null },
    date: { $gte: todayStart, $lte: todayEnd },
  });

  const hoursByTraineeAggPromise = DTR.aggregate([
    {
      $match: {
        traineeId: { $in: traineeIds },
        verifiedBySupervisor: true,
        hoursRendered: { $gt: 0 },
      },
    },
    { $group: { _id: '$traineeId', totalHours: { $sum: '$hoursRendered' }, records: { $sum: 1 } } },
  ]);

  const dtrTotalsPromise = (async () => {
    const [total, verified, verifiedWithHours, pendingVerification] = await Promise.all([
      DTR.countDocuments({ traineeId: { $in: traineeIds } }),
      DTR.countDocuments({ traineeId: { $in: traineeIds }, verifiedBySupervisor: true }),
      DTR.countDocuments({ traineeId: { $in: traineeIds }, verifiedBySupervisor: true, hoursRendered: { $gt: 0 } }),
      DTR.countDocuments({
        traineeId: { $in: traineeIds },
        verifiedBySupervisor: false,
        timeIn: { $exists: true, $ne: null },
      }),
    ]);
    return { total, verified, verifiedWithHours, pendingVerification };
  })();

  const recentDTRDocsPromise = DTR.find({ traineeId: { $in: traineeIds } })
    .select('traineeId companyName date timeIn timeOut hoursRendered status verifiedBySupervisor')
    .sort({ date: -1, timeIn: -1 })
    .limit(RECENT_DTR_LIMIT)
    .lean();

  // ── Companies, journals, concept analytics ──────────────────────────────
  const topCompaniesAggPromise = User.aggregate([
    { $match: { role: 'student', companyName: { $exists: true, $ne: null, $ne: '' } } },
    { $group: { _id: '$companyName', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5 },
  ]);

  const topConceptAggPromise = Journal.aggregate([
    {
      $match: {
        submittedAt: { $gte: conceptWindowStart },
        concepts: { $exists: true, $ne: [] },
      },
    },
    { $unwind: '$concepts' },
    { $match: { concepts: { $ne: null, $ne: '' } } },
    { $group: { _id: '$concepts', count: { $sum: 1 }, trainees: { $addToSet: '$studentId' } } },
    { $project: { count: 1, traineeCount: { $size: '$trainees' } } },
    { $sort: { count: -1 } },
    { $limit: 1 },
  ]);

  const journalStatusCountsPromise = (async () => {
    const recentMatch = { submittedAt: { $gte: journalWindowStart } };
    const [awaitingSupervisor, returnedToSupervisor, awaitingCoordinator, approved] = await Promise.all([
      Journal.countDocuments({
        ...recentMatch,
        supervisorSigned: false,
        $or: [{ coordinatorRemarks: { $exists: false } }, { coordinatorRemarks: null }],
      }),
      Journal.countDocuments({
        ...recentMatch,
        supervisorSigned: false,
        coordinatorRemarks: { $exists: true, $ne: null },
      }),
      Journal.countDocuments({ ...recentMatch, supervisorSigned: true, coordinatorApproved: false }),
      Journal.countDocuments({ ...recentMatch, coordinatorApproved: true }),
    ]);
    return { awaitingSupervisor, returnedToSupervisor, awaitingCoordinator, approved };
  })();

  const journalTotalsPromise = (async () => {
    const [total, submitted, reviewed, draft] = await Promise.all([
      Journal.countDocuments({ studentId: { $in: traineeIds } }),
      Journal.countDocuments({ studentId: { $in: traineeIds }, status: 'submitted' }),
      Journal.countDocuments({ studentId: { $in: traineeIds }, status: 'reviewed' }),
      Journal.countDocuments({ studentId: { $in: traineeIds }, status: 'draft' }),
    ]);
    return { total, submitted, reviewed, draft };
  })();

  const journalCountsByTraineePromise = Journal.aggregate([
    { $match: { studentId: { $in: traineeIds } } },
    {
      $group: {
        _id: '$studentId',
        total: { $sum: 1 },
        submitted: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
        reviewed: { $sum: { $cond: [{ $eq: ['$status', 'reviewed'] }, 1, 0] } },
        incomplete: { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } },
        approved: { $sum: { $cond: [{ $eq: ['$coordinatorApproved', true] }, 1, 0] } },
        awaitingCoordinator: {
          $sum: {
            $cond: [{ $and: [{ $eq: ['$supervisorSigned', true] }, { $eq: ['$coordinatorApproved', false] }] }, 1, 0],
          },
        },
      },
    },
  ]);

  const weeklyJournalsAggPromise = Journal.aggregate([
    { $match: { studentId: { $in: traineeIds }, submittedAt: { $gte: journalTrendStart } } },
    {
      $group: {
        _id: { year: { $year: '$submittedAt' }, week: { $week: '$submittedAt' } },
        count: { $sum: 1 },
        approved: { $sum: { $cond: [{ $eq: ['$coordinatorApproved', true] }, 1, 0] } },
      },
    },
    { $sort: { '_id.year': 1, '_id.week': 1 } },
  ]);

  const [
    dailyBuckets,
    attendanceStatusAgg,
    attendancePerTraineeAgg,
    todayPresent,
    hoursByTraineeAgg,
    dtrTotals,
    recentDTRDocs,
    topCompaniesAgg,
    topConceptAgg,
    journalStatusCounts,
    journalTotals,
    journalCountsByTrainee,
    weeklyJournalsAgg,
  ] = await Promise.all([
    dailyBucketsPromise,
    attendanceStatusAggPromise,
    attendancePerTraineeAggPromise,
    todayPresentPromise,
    hoursByTraineeAggPromise,
    dtrTotalsPromise,
    recentDTRDocsPromise,
    topCompaniesAggPromise,
    topConceptAggPromise,
    journalStatusCountsPromise,
    journalTotalsPromise,
    journalCountsByTraineePromise,
    weeklyJournalsAggPromise,
  ]);

  // ── Trainee records → progress, totals, appraisals, follow-up flags ─────
  const hoursMap = new Map();
  hoursByTraineeAgg.forEach(row => {
    hoursMap.set(row._id.toString(), { totalHours: round(row.totalHours), records: row.records || 0 });
  });

  const attendanceMap = new Map();
  attendancePerTraineeAgg.forEach(row => {
    attendanceMap.set(row._id.toString(), {
      present: row.present || 0,
      late: row.late || 0,
      absent: row.absent || 0,
      excused: row.excused || 0,
      records: row.records || 0,
      hours: round(row.hours),
      dayCount: row.dayCount || 0,
    });
  });

  const journalMap = new Map();
  journalCountsByTrainee.forEach(row => {
    journalMap.set(row._id.toString(), {
      total: row.total || 0,
      submitted: row.submitted || 0,
      reviewed: row.reviewed || 0,
      incomplete: row.incomplete || 0,
      approved: row.approved || 0,
      awaitingCoordinator: row.awaitingCoordinator || 0,
    });
  });

  const traineeProgress = [];
  const followUp = [];
  const performanceBuckets = { excellent: 0, good: 0, satisfactory: 0, needsImprovement: 0, unrated: 0 };
  let completionSum = 0;
  let totalCompletedHours = 0;
  let totalRemainingHours = 0;
  let totalRequiredHours = 0;
  let completedTraineeCount = 0;
  let onTrackCount = 0;
  let behindCount = 0;
  let ratedSum = 0;
  let ratedCount = 0;
  let lastAppraisalDate = null;
  let earliestRegistration = null;

  students.forEach(student => {
    const key = student._id.toString();
    const requiredHours = student.requiredHours || DEFAULT_REQUIRED_HOURS;
    const hoursRecord = hoursMap.get(key);
    const completedHours = hoursRecord ? hoursRecord.totalHours : 0;
    const remainingHours = round(Math.max(0, requiredHours - completedHours));
    const completionRate = percent(completedHours, requiredHours);
    const attendance = attendanceMap.get(key) ||
      { present: 0, late: 0, absent: 0, excused: 0, records: 0, hours: 0, dayCount: 0 };
    const journals = journalMap.get(key) ||
      { total: 0, submitted: 0, reviewed: 0, incomplete: 0, approved: 0, awaitingCoordinator: 0 };
    const rating = typeof student.supervisorRating === 'number' ? student.supervisorRating : null;
    const band = performanceBandOf(rating);

    const registeredAt = student.createdAt ? new Date(student.createdAt) : null;
    if (registeredAt && (!earliestRegistration || registeredAt < earliestRegistration)) {
      earliestRegistration = registeredAt;
    }

    completionSum += requiredHours > 0 ? completedHours / requiredHours : 0;
    totalCompletedHours += completedHours;
    totalRemainingHours += remainingHours;
    totalRequiredHours += requiredHours;

    performanceBuckets[band] += 1;

    if (rating !== null) {
      ratedSum += rating;
      ratedCount += 1;
      const ratingDate = student.supervisorRatingDate ? new Date(student.supervisorRatingDate) : null;
      if (ratingDate && (!lastAppraisalDate || ratingDate > lastAppraisalDate)) {
        lastAppraisalDate = ratingDate;
      }
    }

    const isActive = student.isActive !== false;
    const activity = activityMap.get(key) || {
      status: STATUS_ACTIVE,
      lastTimeIn: null,
      consecutiveMissedDays: 0,
      daysSinceLastAttendance: null,
      inactivityStartDate: null,
    };
    const activityStatus = activity.status === STATUS_INACTIVE ? STATUS_INACTIVE : STATUS_ACTIVE;
    const isInactive = activityStatus === STATUS_INACTIVE;

    // `status` keeps its original hour-completion meaning (used by the existing
    // "Completed / In Progress" badges and the report), while `activityStatus`
    // is the attendance-derived ACTIVE / INACTIVE label requested for the
    // analytics table. Inactive trainees are forced out of the "on track" count
    // so the KPI cards do not count somebody who stopped showing up as healthy.
    let status = 'In Progress';
    if (completedHours >= requiredHours && requiredHours > 0) {
      status = 'Completed';
      if (!isInactive) {
        completedTraineeCount += 1;
        onTrackCount += 1;
      }
    } else if (!isActive) {
      status = 'Inactive';
    } else if (isInactive) {
      status = 'Inactive';
    } else if (completionRate >= 50) {
      onTrackCount += 1;
    } else {
      behindCount += 1;
    }

    const journalsSubmitted = journals.submitted + journals.reviewed;

    traineeProgress.push({
      id: student._id,
      name: student.fullName,
      studentId: student.studentId || '—',
      department: student.department || 'Unassigned',
      section: student.section || '—',
      company: student.companyName || 'Unassigned',
      hasSupervisor: Boolean(student.supervisorId),
      requiredHours,
      completedHours: round(completedHours),
      remainingHours,
      completionRate,
      attendanceRate: percent(attendance.present + attendance.late, attendance.records),
      daysRecorded: attendance.dayCount,
      lateCount: attendance.late,
      absentCount: attendance.absent,
      excusedCount: attendance.excused,
      journalsSubmitted,
      journalsIncomplete: journals.incomplete,
      rating,
      performanceBand: band,
      status,
      // Attendance-derived activity (services/activityStatusService.js)
      activityStatus,
      lastTimeIn: activity.lastTimeIn,
      daysSinceLastAttendance: activity.daysSinceLastAttendance,
      consecutiveMissedDays: activity.consecutiveMissedDays,
      inactivityStartDate: activity.inactivityStartDate,
      isNewStudent: Boolean(activity.isNewStudent),
    });

    // Automated follow-up flags (drive the "Needs Attention" panel + reports)
    const flags = [];
    if (!student.companyName || !student.supervisorId) flags.push('No company / supervisor assigned');
    if (isInactive) {
      flags.push(
        `Inactive - ${activity.consecutiveMissedDays} consecutive OJT day(s) without a time in` +
        (activity.daysSinceLastAttendance !== null
          ? ` (last time in ${activity.daysSinceLastAttendance} day(s) ago)`
          : ' (no time in recorded)')
      );
    }
    if (!isInactive && isActive && attendance.records === 0) flags.push('No verified attendance in the last 30 days');
    else if (!isInactive && isActive && completionRate < 50) flags.push('Below 50% hour completion');
    if (isActive && rating === null) flags.push('No performance appraisal yet');
    if (journals.incomplete > 0) flags.push(`${journals.incomplete} incomplete journal${journals.incomplete > 1 ? 's' : ''}`);
    if (isActive && journals.total === 0) flags.push('No journals submitted yet');
    if (attendance.late >= 3) flags.push(`${attendance.late} late record${attendance.late > 1 ? 's' : ''} in the last 30 days`);

    if (flags.length > 0) {
      followUp.push({
        id: student._id,
        name: student.fullName,
        studentId: student.studentId || '—',
        company: student.companyName || 'Unassigned',
        completionRate,
        activityStatus,
        flags,
      });
    }
  });

  traineeProgress.sort((a, b) => b.completedHours - a.completedHours);
  followUp.sort((a, b) => a.completionRate - b.completionRate);

  const inactiveTraineeCount = traineeProgress.filter(
    trainee => trainee.activityStatus === STATUS_INACTIVE
  ).length;
  const activeTraineeCount = traineeProgress.length - inactiveTraineeCount;

  // ── Attendance summary + trends ─────────────────────────────────────────
  const attendanceStatusBreakdown = { present: 0, late: 0, absent: 0, excused: 0 };
  attendanceStatusAgg.forEach(row => {
    if (Object.prototype.hasOwnProperty.call(attendanceStatusBreakdown, row._id)) {
      attendanceStatusBreakdown[row._id] = row.count || 0;
    }
  });
  const attendanceRecords30 = Object.values(attendanceStatusBreakdown).reduce((sum, value) => sum + value, 0);
  const attendanceRate30 = percent(
    attendanceStatusBreakdown.present + attendanceStatusBreakdown.late,
    attendanceRecords30
  );
  const punctualityRate30 = percent(
    attendanceStatusBreakdown.present,
    attendanceStatusBreakdown.present + attendanceStatusBreakdown.late
  );

  const last30DayTotals = summarizeDailyBuckets(
    dailyBuckets,
    dayKey(attendanceWindowStart),
    dayKey(now)
  );
  const avgDailyHours30 = last30DayTotals.activeDays > 0
    ? round(last30DayTotals.hours / last30DayTotals.activeDays, 2)
    : 0;

  const weeklyHours = buildWeeklySeries(dailyBuckets, now);
  const { monthlyHours, monthlyAttendance } = buildMonthlySeries(dailyBuckets, now);

  const recent4WeeksHours = weeklyHours.slice(-4).reduce((sum, week) => sum + week.hours, 0);
  const avgHoursPerDay = round(recent4WeeksHours / 28, 2);
  const projectedDaysRemaining = avgHoursPerDay > 0
    ? Math.ceil(totalRemainingHours / avgHoursPerDay)
    : null;
  const projectedCompletionAt = projectedDaysRemaining !== null ? addDays(now, projectedDaysRemaining) : null;

  const attendancePerTrainee = traineeProgress.map(trainee => {
    const attendance = attendanceMap.get(trainee.id.toString()) ||
      { present: 0, late: 0, absent: 0, excused: 0, records: 0, hours: 0, dayCount: 0 };
    return {
      id: trainee.id,
      name: trainee.name,
      studentId: trainee.studentId,
      company: trainee.company,
      daysRecorded: attendance.dayCount,
      present: attendance.present,
      late: attendance.late,
      absent: attendance.absent,
      excused: attendance.excused,
      records: attendance.records,
      attendanceRate: trainee.attendanceRate,
      hoursLast30Days: round(attendance.hours),
      verifiedHours: trainee.completedHours,
    };
  });

  const recentRecords = recentDTRDocs.map(record => ({
    id: record._id,
    traineeName: traineeNameById.get(record.traineeId.toString()) || 'Unknown trainee',
    company: record.companyName || '—',
    date: record.date,
    timeIn: record.timeIn || null,
    timeOut: record.timeOut || null,
    hoursRendered: round(record.hoursRendered),
    status: record.status || 'present',
    verified: Boolean(record.verifiedBySupervisor),
  }));

  const attendance = {
    records: dtrTotals.total,
    verifiedRecords: dtrTotals.verified,
    recordsWithHours: dtrTotals.verifiedWithHours,
    unverifiedRecords: dtrTotals.total - dtrTotals.verified,
    pendingVerification: dtrTotals.pendingVerification,
    todayPresent,
    todayAbsent: Math.max(activeTrainees - todayPresent, 0),
    attendanceRate: attendanceRate30,
    punctualityRate: punctualityRate30,
    avgDailyHours: avgDailyHours30,
    activeDays: last30DayTotals.activeDays,
    avgHoursPerRecord: dtrTotals.verifiedWithHours > 0
      ? round(totalCompletedHours / dtrTotals.verifiedWithHours, 2)
      : 0,
    avgHoursPerTrainee: students.length > 0 ? round(totalCompletedHours / students.length, 1) : 0,
    statusBreakdown: attendanceStatusBreakdown,
    statusWindowDays: ATTENDANCE_WINDOW_DAYS,
    monthlyHours,
    monthlyAttendance,
    weeklyHours,
    perTrainee: attendancePerTrainee,
    recentRecords,
  };

  // ── Performance appraisals (monthly appraisal results) ──────────────────
  const avgPerformance = ratedCount > 0 ? round(ratedSum / ratedCount, 2) : 0;
  const avgPerformancePercent = ratedCount > 0 ? percent(ratedSum, ratedCount * 5) : 0;
  const avgCompletionRate = students.length > 0 ? round((completionSum / students.length) * 100, 1) : 0;

  const topPerformers = traineeProgress
    .filter(trainee => trainee.rating !== null)
    .sort((a, b) => (b.rating - a.rating) || (b.completedHours - a.completedHours))
    .slice(0, TOP_PERFORMER_LIMIT);

  const performanceBands = PERFORMANCE_BANDS.map(band => ({
    key: band.key,
    label: band.label,
    count: performanceBuckets[band.key],
    share: percent(performanceBuckets[band.key], students.length),
  }));

  const performance = {
    average: avgPerformance,
    averagePercent: avgPerformancePercent,
    ratedCount,
    unratedCount: performanceBuckets.unrated,
    ratedRate: percent(ratedCount, students.length),
    distribution: performanceBuckets,
    // Kept for backwards compatibility with the existing dashboard JS.
    buckets: performanceBuckets,
    bands: performanceBands,
    topPerformers,
    lastAppraisalAt: lastAppraisalDate ? lastAppraisalDate.toISOString() : null,
    lastAppraisalLabel: lastAppraisalDate ? formatDate(lastAppraisalDate) : null,
  };

  // ── Journal status ─────────────────────────────────────────────────────
  const journalsByStatus = {
    submitted: journalTotals.submitted,
    pending: Math.max(
      journalTotals.submitted - journalStatusCounts.awaitingCoordinator - journalStatusCounts.approved,
      0
    ),
    reviewed: journalTotals.reviewed,
    incomplete: journalTotals.draft,
  };
  const journalsSubmittedTotal = journalsByStatus.submitted + journalsByStatus.reviewed;

  // One weekly journal per active trainee per program week is the expectation.
  const programWeeks = earliestRegistration
    ? Math.max(1, Math.ceil((now - earliestRegistration) / (7 * 24 * 60 * 60 * 1000)))
    : 0;
  const expectedSubmissions = activeTrainees * programWeeks;
  const journalCompletionRate = Math.min(percent(journalsSubmittedTotal, expectedSubmissions), 100);

  const journalPerTrainee = traineeProgress.map(trainee => {
    const journals = journalMap.get(trainee.id.toString()) ||
      { total: 0, submitted: 0, reviewed: 0, incomplete: 0, approved: 0, awaitingCoordinator: 0 };
    return {
      id: trainee.id,
      name: trainee.name,
      studentId: trainee.studentId,
      company: trainee.company,
      total: journals.total,
      submitted: journals.submitted,
      reviewed: journals.reviewed,
      pending: journals.awaitingCoordinator,
      approved: journals.approved,
      incomplete: journals.incomplete,
      expected: programWeeks,
      completionRate: programWeeks > 0
        ? Math.min(percent(journals.submitted + journals.reviewed, programWeeks), 100)
        : 0,
    };
  });

  const journals = {
    total: journalTotals.total,
    byStatus: journalsByStatus,
    reviewBreakdown: {
      awaitingSupervisor: journalStatusCounts.awaitingSupervisor,
      returnedToSupervisor: journalStatusCounts.returnedToSupervisor,
      awaitingCoordinator: journalStatusCounts.awaitingCoordinator,
      approved: journalStatusCounts.approved,
    },
    submittedTotal: journalsSubmittedTotal,
    expectedSubmissions,
    programWeeks,
    completionRate: journalCompletionRate,
    approvedRate: percent(journalStatusCounts.approved, journalsSubmittedTotal),
    incompleteTrainees: journalPerTrainee.filter(entry => entry.incomplete > 0).length,
    traineesWithoutJournals: journalPerTrainee.filter(entry => entry.total === 0).length,
    perTrainee: journalPerTrainee,
    weeklyTrend: weeklyJournalsAgg.map(row => ({
      label: `W${row._id.week} ${row._id.year}`,
      submitted: row.count,
      approved: row.approved,
    })),
    windowDays: JOURNAL_WINDOW_DAYS,
  };

  // ── Department breakdown (descriptive comparison across departments) ────
  const departmentMap = new Map();
  traineeProgress.forEach(trainee => {
    const entry = departmentMap.get(trainee.department) || {
      department: trainee.department,
      trainees: 0,
      active: 0,
      completed: 0,
      completedHours: 0,
      requiredHours: 0,
      ratingSum: 0,
      ratingCount: 0,
    };
    entry.trainees += 1;
    if (trainee.status !== 'Inactive') entry.active += 1;
    if (trainee.status === 'Completed') entry.completed += 1;
    entry.completedHours += trainee.completedHours;
    entry.requiredHours += trainee.requiredHours;
    if (trainee.rating !== null) {
      entry.ratingSum += trainee.rating;
      entry.ratingCount += 1;
    }
    departmentMap.set(trainee.department, entry);
  });

  const departments = [...departmentMap.values()]
    .map(entry => ({
      department: entry.department,
      trainees: entry.trainees,
      active: entry.active,
      completed: entry.completed,
      completedHours: round(entry.completedHours),
      remainingHours: round(Math.max(0, entry.requiredHours - entry.completedHours)),
      avgCompletionRate: percent(entry.completedHours, entry.requiredHours),
      avgRating: entry.ratingCount > 0 ? round(entry.ratingSum / entry.ratingCount, 2) : null,
    }))
    .sort((a, b) => b.trainees - a.trainees);

  // ── Centralized "needs attention" list ─────────────────────────────────
  const unassignedTrainees = traineeProgress.filter(
    trainee => !trainee.hasSupervisor || trainee.company === 'Unassigned'
  ).length;

  const attention = [];
  if (inactiveTraineeCount > 0) {
    attention.push({
      level: 'high',
      title: `${inactiveTraineeCount} trainee${inactiveTraineeCount > 1 ? 's have' : ' has'} missed 3 consecutive OJT days`,
      detail: 'Marked inactive: no time in recorded on three consecutive applicable OJT days. See the Status column in Trainee Progress.',
      action: 'trainees',
    });
  }
  if (journalStatusCounts.awaitingCoordinator > 0) {
    attention.push({
      level: 'high',
      title: `${journalStatusCounts.awaitingCoordinator} journal${journalStatusCounts.awaitingCoordinator > 1 ? 's' : ''} awaiting your approval`,
      detail: 'Supervisor-signed journals are ready for coordinator approval.',
      action: 'journal-review',
    });
  }
  if (dtrTotals.pendingVerification > 0) {
    attention.push({
      level: 'high',
      title: `${dtrTotals.pendingVerification} DTR record${dtrTotals.pendingVerification > 1 ? 's' : ''} pending supervisor verification`,
      detail: 'Hours are only counted once the supervisor verifies the DTR record.',
      action: 'trainees',
    });
  }
  if (unassignedTrainees > 0) {
    attention.push({
      level: 'medium',
      title: `${unassignedTrainees} trainee${unassignedTrainees > 1 ? 's' : ''} without a company / supervisor`,
      detail: 'Assign a supervisor so attendance and appraisals can be recorded.',
      action: 'trainees',
    });
  }
  if (behindCount > 0) {
    attention.push({
      level: 'medium',
      title: `${behindCount} active trainee${behindCount > 1 ? 's are' : ' is'} below 50% completion`,
      detail: 'Review their attendance and remaining OJT hours.',
      action: 'trainees',
    });
  }
  if (journalsByStatus.incomplete > 0) {
    attention.push({
      level: 'medium',
      title: `${journalsByStatus.incomplete} journal${journalsByStatus.incomplete > 1 ? 's' : ''} still in draft`,
      detail: 'Draft journals are not counted as submitted.',
      action: 'journal-review',
    });
  }
  if (performanceBuckets.unrated > 0) {
    attention.push({
      level: 'low',
      title: `${performanceBuckets.unrated} trainee${performanceBuckets.unrated > 1 ? 's have' : ' has'} no performance appraisal`,
      detail: 'Supervisors have not submitted a rating for these trainees yet.',
      action: 'trainees',
    });
  }
  if (attendanceStatusBreakdown.absent > 0) {
    attention.push({
      level: 'low',
      title: `${attendanceStatusBreakdown.absent} absent record${attendanceStatusBreakdown.absent > 1 ? 's' : ''} in the last ${ATTENDANCE_WINDOW_DAYS} days`,
      detail: 'Absences may need a remark or excused documentation.',
      action: 'trainees',
    });
  }
  if (attention.length === 0) {
    attention.push({
      level: 'info',
      title: 'All recorded data is up to date',
      detail: 'No pending verifications, approvals, or missing records were found.',
      action: null,
    });
  }

  // ── Automatically generated findings (summarized from recorded data) ────
  const topCompanies = topCompaniesAgg.map(row => ({ name: row._id, count: row.count }));
  const topCompany = topCompanies[0] || { name: 'No company data', count: 0 };
  const topConcept = topConceptAgg[0] || { _id: null, count: 0, traineeCount: 0 };

  const hoursByTraineeList = traineeProgress
    .map(trainee => ({ name: trainee.name, hours: trainee.completedHours }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, TOP_TRAINEE_LIMIT);

  const narrativeParts = {
    enrollment:
      `${formatCount(students.length)} trainee(s) are enrolled in the OJT program — ${formatCount(activeTrainees)} active, ` +
      `${formatCount(completedTraineeCount)} already completed, ${formatCount(behindCount)} below 50% completion.`,
    hours:
      `Verified attendance totals ${formatHours(totalCompletedHours)} of ${formatCount(totalRequiredHours)} required hours, ` +
      `leaving ${formatHours(totalRemainingHours)} (average completion ${formatPercent(avgCompletionRate)}).`,
    attendance:
      `In the last ${ATTENDANCE_WINDOW_DAYS} days there were ${formatCount(attendanceRecords30)} verified DTR record(s): ` +
      `${formatCount(attendanceStatusBreakdown.present)} present, ${formatCount(attendanceStatusBreakdown.late)} late, ` +
      `${formatCount(attendanceStatusBreakdown.absent)} absent, ${formatCount(attendanceStatusBreakdown.excused)} excused ` +
      `(attendance rate ${formatPercent(attendanceRate30)}, punctuality ${formatPercent(punctualityRate30)}).`,
    pace: projectedCompletionAt
      ? `Trainees recorded ${formatHours(avgDailyHours30)} per active day over the last ${ATTENDANCE_WINDOW_DAYS} days; ` +
        `at that pace the remaining hours would take about ${formatCount(projectedDaysRemaining)} day(s) ` +
        `(around ${formatDate(projectedCompletionAt)}).`
      : 'No verified hours were recorded in the last 30 days, so no completion pace could be projected.',
    performance: ratedCount > 0
      ? `Performance appraisals average ${avgPerformance} of 5 (${formatPercent(avgPerformancePercent)}) across ` +
        `${formatCount(ratedCount)} rated trainee(s): ${formatCount(performanceBuckets.excellent)} excellent, ` +
        `${formatCount(performanceBuckets.good)} good, ${formatCount(performanceBuckets.satisfactory)} satisfactory, ` +
        `${formatCount(performanceBuckets.needsImprovement)} needs improvement.`
      : 'No supervisor performance appraisal has been recorded yet.',
    journals:
      `Journals: ${formatCount(journalsSubmittedTotal)} submitted of ${formatCount(expectedSubmissions)} expected ` +
      `(${formatPercent(journalCompletionRate)}), ${formatCount(journalStatusCounts.approved)} approved, ` +
      `${formatCount(journalStatusCounts.awaitingCoordinator)} awaiting coordinator review, ` +
      `${formatCount(journalStatusCounts.awaitingSupervisor)} awaiting supervisor signature, ` +
      `${formatCount(journalsByStatus.incomplete)} still in draft.`,
    companies:
      `Top partner company: ${topCompany.name} (${formatCount(topCompany.count)} trainee(s)). ` +
      `Most applied theory in the last ${CONCEPT_WINDOW_DAYS} days: ${topConcept._id || 'No concept data'} ` +
      `(${formatCount(topConcept.count)} journal entries).`,
    followUp: followUp.length > 0
      ? `${formatCount(followUp.length)} trainee(s) need follow-up ` +
        `(${followUp.slice(0, 5).map(entry => entry.name).join(', ')}${followUp.length > 5 ? ', …' : ''}) — ` +
        'see the attention list for the specific findings.'
      : null,
    activity:
      `${formatCount(activeTraineeCount)} trainee(s) are ACTIVE and ${formatCount(inactiveTraineeCount)} are INACTIVE. ` +
      `A trainee is marked inactive after missing ${INACTIVITY_THRESHOLD_DAYS} consecutive applicable OJT days ` +
      'without a recorded time in; weekends, holidays and approved leave are not counted.',
  };

  const narrative = Object.values(narrativeParts).filter(Boolean);

  const summary = {
    studentCount: students.length,
    activeTrainees,
    // Attendance-derived activity split (services/activityStatusService.js)
    activeActivityTrainees: activeTraineeCount,
    inactiveTrainees: inactiveTraineeCount,
    inactivityThresholdDays: INACTIVITY_THRESHOLD_DAYS,
    completedTrainees: completedTraineeCount,
    onTrackTrainees: onTrackCount,
    behindTrainees: behindCount,
    pendingSubmissions: dtrTotals.pendingVerification + journalStatusCounts.awaitingCoordinator,
    pendingDTRs: dtrTotals.pendingVerification,
    pendingJournals: journalStatusCounts.awaitingCoordinator,
    unassignedTrainees,
    totalRequiredHours: round(totalRequiredHours),
    totalCompletedHours: round(totalCompletedHours),
    totalRemainingHours: round(totalRemainingHours),
    avgCompletionRate,
    avgPerformance,
    avgPerformancePercent,
    ratedCount,
    unratedCount: performanceBuckets.unrated,
    attendanceRate: attendanceRate30,
    journalCompletionRate,
    projectedCompletionAt: projectedCompletionAt ? projectedCompletionAt.toISOString() : null,
    topCompany: { name: topCompany.name, count: topCompany.count },
    topCompanies,
    topConcept: {
      name: topConcept._id || 'No concept data',
      count: topConcept.count || 0,
      traineeCount: topConcept.traineeCount || 0,
    },
  };

  return {
    generatedAt: now.toISOString(),
    programPeriod: {
      from: earliestRegistration ? earliestRegistration.toISOString() : null,
      to: now.toISOString(),
      weeksElapsed: programWeeks,
      label: earliestRegistration
        ? `${formatDate(earliestRegistration)} – ${formatDate(now)}`
        : 'No trainee records yet',
    },
    summary,
    hoursByTrainee: hoursByTraineeList,
    traineeProgress,
    attendance,
    performance,
    journals,
    departments,
    attention,
    followUp,
    narrative,
    narrativeParts,
    // Kept for backwards compatibility with the existing dashboard JS.
    journalStatusBreakdown: {
      awaitingSupervisor: journalStatusCounts.awaitingSupervisor,
      returnedToSupervisor: journalStatusCounts.returnedToSupervisor,
      awaitingCoordinator: journalStatusCounts.awaitingCoordinator,
      approved: journalStatusCounts.approved,
    },
    journalWindowDays: JOURNAL_WINDOW_DAYS,
    conceptWindowDays: CONCEPT_WINDOW_DAYS,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// AUTOMATED REPORT GENERATION
// ────────────────────────────────────────────────────────────────────────────

const REPORT_TITLES = {
  summary: 'Semester Summary Report',
  trainees: 'Trainee Data Report',
  attendance: 'Attendance & DTR Report',
  journals: 'Journal Analytics Report',
};

function metricRows(pairs) {
  return pairs
    .filter(pair => Array.isArray(pair) && pair.length >= 2)
    .map(pair => [pair[0], pair[1]]);
}

function overviewMetricRows(analytics) {
  const { summary, attendance, journals } = analytics;
  return metricRows([
    ['Trainees enrolled', formatCount(summary.studentCount)],
    ['Active trainees', formatCount(summary.activeTrainees)],
    ['Completed OJT', formatCount(summary.completedTrainees)],
    ['Active trainees below 50% completion', formatCount(summary.behindTrainees)],
    ['Required hours (whole cohort)', formatCount(summary.totalRequiredHours)],
    ['Verified hours completed', formatHours(summary.totalCompletedHours)],
    ['Hours remaining', formatHours(summary.totalRemainingHours)],
    ['Average completion rate', formatPercent(summary.avgCompletionRate)],
    ['Average performance appraisal', `${summary.avgPerformance} of 5 (${formatPercent(summary.avgPerformancePercent)})`],
    ['Rated / unrated trainees', `${formatCount(summary.ratedCount)} / ${formatCount(summary.unratedCount)}`],
    ['Pending submissions', formatCount(summary.pendingSubmissions)],
    ['Trainees without company / supervisor', formatCount(summary.unassignedTrainees)],
    ['Attendance rate (last 30 days)', formatPercent(attendance.attendanceRate)],
    ['Journal completion rate', formatPercent(journals.completionRate)],
    [
      'Projected cohort completion',
      summary.projectedCompletionAt ? formatDate(summary.projectedCompletionAt) : 'Not enough attendance data',
    ],
  ]);
}

function traineeProgressSection(analytics) {
  return {
    title: 'Trainee Progress',
    description:
      'Verified DTR hours completed and remaining per trainee. Activity Status is derived from the ' +
      `attendance history: a trainee is INACTIVE after ${INACTIVITY_THRESHOLD_DAYS} consecutive applicable OJT days without a time in.`,
    columns: [
      'Trainee', 'Student ID', 'Department', 'Section', 'Company',
      'Completed (h)', 'Remaining (h)', 'Completion', 'Days Recorded',
      'Activity Status', 'Last Time In', 'Days Since Attendance', 'Progress Status', 'Rating',
    ],
    rows: analytics.traineeProgress.map(trainee => [
      trainee.name,
      trainee.studentId,
      trainee.department,
      trainee.section,
      trainee.company,
      round(trainee.completedHours, 1).toFixed(1),
      round(trainee.remainingHours, 1).toFixed(1),
      formatPercent(trainee.completionRate),
      formatCount(trainee.daysRecorded),
      trainee.activityStatus || STATUS_ACTIVE,
      trainee.lastTimeIn ? formatDate(trainee.lastTimeIn) : 'Never',
      trainee.daysSinceLastAttendance === null || trainee.daysSinceLastAttendance === undefined
        ? '—'
        : formatCount(trainee.daysSinceLastAttendance),
      trainee.status,
      trainee.rating === null ? 'Not rated' : `${trainee.rating} / 5`,
    ]),
    emptyText: 'No trainee records found.',
  };
}

function attendanceSummarySection(analytics) {
  const { attendance } = analytics;
  return {
    title: `Attendance Summary (DTR, last ${attendance.statusWindowDays} days)`,
    description: 'Attendance status mix and DTR record counts.',
    columns: ['Metric', 'Value'],
    rows: metricRows([
      ['DTR records on file (all time)', formatCount(attendance.records)],
      ['Supervisor-verified DTR records', formatCount(attendance.verifiedRecords)],
      ['Records pending verification', formatCount(attendance.pendingVerification)],
      ['Present today', formatCount(attendance.todayPresent)],
      ['Absent today (active trainees)', formatCount(attendance.todayAbsent)],
      ['Present / late / absent / excused', `${formatCount(attendance.statusBreakdown.present)} / ${formatCount(attendance.statusBreakdown.late)} / ${formatCount(attendance.statusBreakdown.absent)} / ${formatCount(attendance.statusBreakdown.excused)}`],
      ['Attendance rate', formatPercent(attendance.attendanceRate)],
      ['Punctuality rate (on-time among present + late)', formatPercent(attendance.punctualityRate)],
      ['Average hours per active day', formatHours(attendance.avgDailyHours)],
      ['Average hours per verified record', formatHours(attendance.avgHoursPerRecord)],
      ['Average verified hours per trainee', formatHours(attendance.avgHoursPerTrainee)],
    ]),
  };
}

function attendanceTrendSection(analytics) {
  return {
    title: 'Attendance Trend',
    description: 'Verified hours and attendance status per week.',
    columns: ['Week', 'Hours', 'Present', 'Late', 'Absent', 'Excused'],
    rows: analytics.attendance.weeklyHours.map(week => [
      week.label,
      round(week.hours, 1).toFixed(1),
      formatCount(week.present),
      formatCount(week.late),
      formatCount(week.absent),
      formatCount(week.excused),
    ]),
    emptyText: 'No verified attendance in the selected window.',
  };
}

function attendancePerTraineeSection(analytics) {
  return {
    title: 'Trainee Attendance',
    description: 'Attendance status per trainee for the last 30 days.',
    columns: ['Trainee', 'Student ID', 'Days Recorded', 'Present', 'Late', 'Absent', 'Excused', 'Attendance Rate', 'Verified Hours'],
    rows: analytics.attendance.perTrainee.map(row => [
      row.name,
      row.studentId,
      formatCount(row.daysRecorded),
      formatCount(row.present),
      formatCount(row.late),
      formatCount(row.absent),
      formatCount(row.excused),
      formatPercent(row.attendanceRate),
      round(row.verifiedHours, 1).toFixed(1),
    ]),
    emptyText: 'No trainee records found.',
  };
}

function recentDTRSection(analytics) {
  return {
    title: 'Recent DTR Records',
    description: 'Latest time in / time out entries recorded by trainees.',
    columns: ['Trainee', 'Date', 'Time In', 'Time Out', 'Hours', 'Status', 'Verified'],
    rows: analytics.attendance.recentRecords.map(record => [
      record.traineeName,
      formatDate(record.date),
      formatTime(record.timeIn),
      formatTime(record.timeOut),
      round(record.hoursRendered, 1).toFixed(1),
      record.status,
      record.verified ? 'Yes' : 'No',
    ]),
    emptyText: 'No DTR records found.',
  };
}

function performanceSummarySection(analytics) {
  const { performance } = analytics;
  return {
    title: 'Performance Appraisal Summary',
    description: 'Summarized results of the supervisor performance appraisals.',
    columns: ['Metric', 'Value'],
    rows: metricRows([
      ['Average rating', performance.ratedCount > 0 ? `${performance.average} of 5` : 'No appraisals yet'],
      ['Average performance', formatPercent(performance.averagePercent)],
      ['Rated trainees', formatCount(performance.ratedCount)],
      ['Unrated trainees', formatCount(performance.unratedCount)],
      ['Rating coverage', formatPercent(performance.ratedRate)],
      ['Most recent appraisal', performance.lastAppraisalLabel || 'No appraisals yet'],
    ]),
  };
}

function performanceBandSection(analytics) {
  return {
    title: 'Performance Distribution',
    description: 'Trainees per appraisal rating band.',
    columns: ['Rating Band', 'Trainees', 'Share'],
    rows: analytics.performance.bands.map(band => [
      band.label,
      formatCount(band.count),
      formatPercent(band.share),
    ]),
  };
}

function journalStatusSection(analytics) {
  const { journals } = analytics;
  return {
    title: 'Journal Status',
    description: 'Submitted, pending, and incomplete weekly journals.',
    columns: ['Metric', 'Value'],
    rows: metricRows([
      ['Journals on file', formatCount(journals.total)],
      ['Submitted', formatCount(journals.byStatus.submitted)],
      ['Reviewed', formatCount(journals.byStatus.reviewed)],
      ['Pending review', formatCount(journals.byStatus.pending)],
      ['Incomplete (draft)', formatCount(journals.byStatus.incomplete)],
      ['Coordinator approved', formatCount(journals.reviewBreakdown.approved)],
      ['Awaiting coordinator approval', formatCount(journals.reviewBreakdown.awaitingCoordinator)],
      ['Awaiting supervisor signature', formatCount(journals.reviewBreakdown.awaitingSupervisor)],
      ['Returned to supervisor', formatCount(journals.reviewBreakdown.returnedToSupervisor)],
      ['Expected submissions', formatCount(journals.expectedSubmissions)],
      ['Completion rate', formatPercent(journals.completionRate)],
      ['Approval rate', formatPercent(journals.approvedRate)],
    ]),
  };
}

function journalPerTraineeSection(analytics) {
  return {
    title: 'Journal Progress per Trainee',
    description: 'Journal submissions, approvals, and drafts per trainee.',
    columns: ['Trainee', 'Student ID', 'Journals', 'Submitted', 'Reviewed', 'Pending', 'Approved', 'Draft'],
    rows: analytics.journals.perTrainee.map(row => [
      row.name,
      row.studentId,
      formatCount(row.total),
      formatCount(row.submitted),
      formatCount(row.reviewed),
      formatCount(row.pending),
      formatCount(row.approved),
      formatCount(row.incomplete),
    ]),
    emptyText: 'No trainee records found.',
  };
}

function journalWeeklySection(analytics) {
  return {
    title: 'Journal Submissions per Week',
    description: 'Weekly submissions and coordinator approvals.',
    columns: ['Week', 'Submitted', 'Coordinator Approved'],
    rows: analytics.journals.weeklyTrend.map(row => [
      row.label,
      formatCount(row.submitted),
      formatCount(row.approved),
    ]),
    emptyText: 'No journal submissions in the selected window.',
  };
}

function departmentSection(analytics) {
  return {
    title: 'Department Breakdown',
    description: 'Trainees and average progress per department.',
    columns: ['Department', 'Trainees', 'Active', 'Completed', 'Avg Completion', 'Avg Rating', 'Verified Hours'],
    rows: analytics.departments.map(entry => [
      entry.department,
      formatCount(entry.trainees),
      formatCount(entry.active),
      formatCount(entry.completed),
      formatPercent(entry.avgCompletionRate),
      entry.avgRating === null ? 'Not rated' : `${entry.avgRating} of 5`,
      round(entry.completedHours, 1).toFixed(1),
    ]),
    emptyText: 'No department data found.',
  };
}

function followUpSection(analytics) {
  return {
    title: 'Trainees Needing Follow-up',
    description: 'Automatically detected from attendance, journal, and appraisal records.',
    columns: ['Trainee', 'Student ID', 'Company', 'Completion', 'Findings'],
    rows: analytics.followUp.map(entry => [
      entry.name,
      entry.studentId,
      entry.company,
      formatPercent(entry.completionRate),
      entry.flags.join('; '),
    ]),
    emptyText: 'No follow-up items detected.',
  };
}

function buildHighlights(analytics) {
  const { summary, attendance, journals } = analytics;
  return [
    {
      label: 'Trainees Enrolled',
      value: formatCount(summary.studentCount),
      hint: `${formatCount(summary.activeTrainees)} active`,
    },
    {
      label: 'Completed OJT',
      value: formatCount(summary.completedTrainees),
      hint: `${formatCount(summary.behindTrainees)} below 50%`,
    },
    {
      label: 'Verified Hours',
      value: formatHours(summary.totalCompletedHours),
      hint: `${formatHours(summary.totalRemainingHours)} remaining`,
    },
    {
      label: 'Avg Completion',
      value: formatPercent(summary.avgCompletionRate),
      hint: 'Verified hours vs required',
    },
    {
      label: 'Avg Performance',
      value: formatPercent(summary.avgPerformancePercent),
      hint: `${summary.avgPerformance} of 5 appraisal average`,
    },
    {
      label: 'Attendance Rate',
      value: formatPercent(attendance.attendanceRate),
      hint: `Last ${attendance.statusWindowDays} days`,
    },
    {
      label: 'Journal Completion',
      value: formatPercent(journals.completionRate),
      hint: `${formatCount(journals.submittedTotal)} submitted`,
    },
    {
      label: 'Pending Submissions',
      value: formatCount(summary.pendingSubmissions),
      hint: `${formatCount(summary.pendingDTRs)} DTR • ${formatCount(summary.pendingJournals)} journals`,
    },
  ];
}

function buildReportSections(analytics, type) {
  switch (type) {
    case 'trainees':
      return [traineeProgressSection(analytics), departmentSection(analytics), followUpSection(analytics)];
    case 'attendance':
      return [
        attendanceSummarySection(analytics),
        attendanceTrendSection(analytics),
        attendancePerTraineeSection(analytics),
        recentDTRSection(analytics),
      ];
    case 'journals':
      return [
        journalStatusSection(analytics),
        journalWeeklySection(analytics),
        journalPerTraineeSection(analytics),
      ];
    case 'summary':
    default:
      return [
        {
          title: 'Overall Statistics',
          description: 'Centralized statistics gathered from trainee, DTR, journal, and appraisal records.',
          columns: ['Metric', 'Value'],
          rows: overviewMetricRows(analytics),
        },
        attendanceSummarySection(analytics),
        attendanceTrendSection(analytics),
        performanceSummarySection(analytics),
        performanceBandSection(analytics),
        journalStatusSection(analytics),
        journalWeeklySection(analytics),
        departmentSection(analytics),
        traineeProgressSection(analytics),
        followUpSection(analytics),
      ];
  }
}

function buildReportNarrative(analytics, type) {
  const parts = analytics.narrativeParts || {};

  switch (type) {
    case 'attendance':
      return [parts.attendance, parts.pace, parts.followUp].filter(Boolean);
    case 'journals':
      return [parts.journals, parts.enrollment, parts.followUp].filter(Boolean);
    case 'trainees':
      return [parts.enrollment, parts.hours, parts.followUp].filter(Boolean);
    case 'summary':
    default:
      return analytics.narrative || [];
  }
}

function buildCsvPayload(analytics, type, dateStamp) {
  const filenames = {
    summary: `TrackIT_Semester_Summary_${dateStamp}.csv`,
    trainees: `TrackIT_Trainee_Data_${dateStamp}.csv`,
    attendance: `TrackIT_Attendance_Logs_${dateStamp}.csv`,
    journals: `TrackIT_Journal_Analytics_${dateStamp}.csv`,
  };

  let section = traineeProgressSection(analytics);
  if (type === 'attendance') section = attendancePerTraineeSection(analytics);
  else if (type === 'journals') section = journalPerTraineeSection(analytics);

  return {
    filename: filenames[type] || `TrackIT_Report_${dateStamp}.csv`,
    headers: section.columns,
    rows: section.rows,
  };
}

/**
 * Turns the analytics payload into a printable / downloadable report.
 *
 * @param {Object} analytics   Output of buildCoordinatorAnalytics()
 * @param {Object} [options]   { type: 'summary' | 'trainees' | 'attendance' | 'journals', generatedBy }
 */
function buildAutomatedReport(analytics, options = {}) {
  const type = REPORT_TITLES[options.type] ? options.type : 'summary';
  const generatedAt = analytics.generatedAt || new Date().toISOString();
  const dateStamp = dayKey(new Date(generatedAt));
  const generatedBy = options.generatedBy || null;

  return {
    type,
    title: REPORT_TITLES[type],
    subtitle: `Automated report generated from recorded TrackIT data on ${formatDateTime(generatedAt)}`,
    generatedAt,
    generatedBy: generatedBy
      ? { fullName: generatedBy.fullName || 'Coordinator', email: generatedBy.email || '' }
      : null,
    period: analytics.programPeriod,
    highlights: buildHighlights(analytics),
    narrative: buildReportNarrative(analytics, type),
    sections: buildReportSections(analytics, type),
    csv: buildCsvPayload(analytics, type, dateStamp),
  };
}

module.exports = {
  buildCoordinatorAnalytics,
  buildAutomatedReport,
};
