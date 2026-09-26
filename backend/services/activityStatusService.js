/**
 * Centralized trainee activity status service.
 *
 * Single source of truth for the ACTIVE / INACTIVE label shown by the
 * coordinator analytics, the coordinator notifications and the dashboards.
 *
 * The status is derived from the recorded DTR (time in / attendance) history -
 * it is never typed in by a user and never trusted from the browser:
 *
 *   DTR history -> applicable OJT days -> consecutive missed days
 *                -> status -> coordinator notification
 *
 * Inactivity rule: a trainee becomes INACTIVE once they have missed
 * `INACTIVITY_THRESHOLD_DAYS` (3) *consecutive applicable OJT days* without a
 * time in. "Applicable" means the trainee was actually expected to work on that
 * calendar day: non-working days (weekends by default), official holidays and
 * approved/excused absences are skipped, so
 *
 *   Fri (missed) | Sat | Sun | Mon (missed) | Tue (missed)
 *
 * counts as 3 missed OJT days, not 5 calendar days.
 */

const User = require('../models/User');
const DTR = require('../models/DTR');

const STATUS_ACTIVE = 'ACTIVE';
const STATUS_INACTIVE = 'INACTIVE';

// How many consecutive missed OJT days flip a trainee to INACTIVE.
const INACTIVITY_THRESHOLD_DAYS = 3;

// How far back the walk goes before it gives up looking for an attendance
// record. Bounded so a trainee with years of history cannot stall the query.
const DEFAULT_LOOKBACK_DAYS = 90;

// Calendar days a trainee may sit at 0 recorded time-ins right after signing up
// before the inactivity rule is allowed to apply (new-student protection).
const NEW_STUDENT_GRACE_DAYS = 3;

const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5]; // Mon-Fri; 0 = Sunday
const DEFAULT_DAY_END = '17:00';

// ────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────────────────

/** OJT working days, e.g. OJT_WORK_DAYS=1,2,3,4,5 (0=Sunday ... 6=Saturday). */
function configuredWorkDays() {
  const raw = String(process.env.OJT_WORK_DAYS || '').trim();
  if (!raw) return DEFAULT_WORK_DAYS;
  const parsed = raw
    .split(',')
    .map(part => Number(part.trim()))
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
  return parsed.length ? parsed : DEFAULT_WORK_DAYS;
}

/** Official non-OJT holidays, e.g. OJT_HOLIDAYS=2026-12-25,2026-01-01. */
function configuredHolidays() {
  return new Set(
    String(process.env.OJT_HOLIDAYS || '')
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
  );
}

// ────────────────────────────────────────────────────────────────────────────
// DATE HELPERS (all bucketing uses the server timezone, matching how DTR
// `date` values are written - see coordinatorAnalyticsService).
// ────────────────────────────────────────────────────────────────────────────

function startOfDay(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
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

function daysBetween(from, to) {
  const a = startOfDay(from).getTime();
  const b = startOfDay(to).getTime();
  return Math.round((b - a) / 86400000);
}

function serverTimezoneOffset(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

/** "HH:MM" -> minutes since midnight; returns null when unusable. */
function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * The trainee's scheduled end of shift as minutes since midnight. Used to decide
 * whether *today* has already ended (and therefore may count as a missed day).
 * Falls back to OJT_DEFAULT_DAY_END and then to 17:00.
 */
function scheduledDayEndMinutes(trainee) {
  return (
    parseClock(trainee && trainee.schedule && trainee.schedule.endTime) ??
    parseClock(process.env.OJT_DEFAULT_DAY_END) ??
    17 * 60
  );
}

/**
 * The most recent day whose attendance is settled. A day still in progress is
 * not a missed day yet: a trainee who has not scanned in at 09:00 has not been
 * absent, so today's DTR must not push anybody to INACTIVE.
 */
function lastSettledDay(now, trainee) {
  const today = startOfDay(now);
  const endMinutes = scheduledDayEndMinutes(trainee);
  const elapsed = now.getHours() * 60 + now.getMinutes();
  return elapsed >= endMinutes ? today : addDays(today, -1);
}

/** Was the trainee expected to work this calendar day? */
function isApplicableDay(date, workDays, holidays) {
  if (holidays.has(dayKey(date))) return false;
  return workDays.includes(date.getDay());
}

// ────────────────────────────────────────────────────────────────────────────
// ATTENDANCE LOADING
// ────────────────────────────────────────────────────────────────────────────

/**
 * Collapses the raw DTR documents of one trainee into the two facts the status
 * rule needs: which days they recorded a time in, and which days they were
 * formally excused.
 */
function summarizeAttendance(docs) {
  const attendedDays = new Set();
  const excusedDays = new Set();
  let lastTimeIn = null;

  (docs || []).forEach(doc => {
    const day = doc && doc.date ? dayKey(doc.date) : null;
    if (!day) return;

    if (doc.timeIn) {
      attendedDays.add(day);
      const timeIn = new Date(doc.timeIn);
      if (!lastTimeIn || timeIn > lastTimeIn) lastTimeIn = timeIn;
    } else if (doc.status === 'excused') {
      // Approved leave / excused absence - never counted as a missed day.
      excusedDays.add(day);
    }
  });

  return { attendedDays, excusedDays, lastTimeIn };
}

/** Attendance summary for a single trainee. */
async function loadAttendanceSummary(traineeId, windowStart) {
  const docs = await DTR.find({ traineeId, date: { $gte: windowStart } })
    .select('date timeIn timeOut status')
    .lean();
  return summarizeAttendance(docs);
}

/**
 * Attendance summaries for every trainee in one aggregation, used by the sweep
 * so a full check costs 1 query instead of 1 query per student.
 */
async function loadAttendanceSummariesForAll(windowStart) {
  const timezone = serverTimezoneOffset();
  const rows = await DTR.aggregate([
    { $match: { date: { $gte: windowStart } } },
    {
      $group: {
        _id: '$traineeId',
        lastTimeIn: { $max: '$timeIn' },
        attendedDays: {
          $addToSet: {
            $cond: [
              { $ifNull: ['$timeIn', false] },
              { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone } },
              '$$REMOVE',
            ],
          },
        },
        excusedDays: {
          $addToSet: {
            $cond: [
              { $eq: ['$status', 'excused'] },
              { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone } },
              '$$REMOVE',
            ],
          },
        },
      },
    },
  ]);

  const summaries = new Map();
  rows.forEach(row => {
    summaries.set(row._id.toString(), {
      attendedDays: new Set(row.attendedDays || []),
      excusedDays: new Set(row.excusedDays || []),
      lastTimeIn: row.lastTimeIn ? new Date(row.lastTimeIn) : null,
    });
  });
  return summaries;
}

// ────────────────────────────────────────────────────────────────────────────
// STATUS EVALUATION
// ────────────────────────────────────────────────────────────────────────────

/**
 * Pure evaluator - no I/O. Walks back from the last settled day and counts
 * applicable OJT days with no time in, stopping at the first day the trainee
 * did record one.
 */
function evaluateStatus({ trainee, attendance, now = new Date() }) {
  const workDays = configuredWorkDays();
  const holidays = configuredHolidays();
  const attendedDays = (attendance && attendance.attendedDays) || new Set();
  const excusedDays = (attendance && attendance.excusedDays) || new Set();
  const lastTimeIn = (attendance && attendance.lastTimeIn) || null;

  const windowStart = startOfDay(addDays(now, -DEFAULT_LOOKBACK_DAYS));
  // Never evaluate a day before the trainee enrolled, otherwise every brand new
  // account would be counted as absent since the epoch.
  const enrolledOn = trainee && trainee.createdAt ? startOfDay(new Date(trainee.createdAt)) : null;
  const daysSinceEnrolled = enrolledOn ? daysBetween(enrolledOn, now) : null;
  const isNewStudent = daysSinceEnrolled !== null && daysSinceEnrolled < NEW_STUDENT_GRACE_DAYS;

  let consecutiveMissedDays = 0;
  let inactivityStartDate = null;
  let cursor = lastSettledDay(now, trainee);
  const hardStop = windowStart.getTime();

  while (cursor.getTime() >= hardStop) {
    if (enrolledOn && cursor.getTime() < enrolledOn.getTime()) break;
    if (!isApplicableDay(cursor, workDays, holidays)) {
      cursor = addDays(cursor, -1);
      continue;
    }

    const key = dayKey(cursor);
    if (attendedDays.has(key)) break;          // back to work - streak over

    if (excusedDays.has(key)) {               // approved leave: neutral day
      cursor = addDays(cursor, -1);
      continue;
    }

    consecutiveMissedDays += 1;
    if (inactivityStartDate === null) inactivityStartDate = key;
    cursor = addDays(cursor, -1);
  }

  // A trainee who signed up days ago cannot be "inactive" yet.
  const status =
    !isNewStudent && consecutiveMissedDays >= INACTIVITY_THRESHOLD_DAYS
      ? STATUS_INACTIVE
      : STATUS_ACTIVE;

  return {
    status,
    lastTimeIn: lastTimeIn ? lastTimeIn.toISOString() : null,
    consecutiveMissedDays,
    daysSinceLastAttendance: lastTimeIn ? daysBetween(lastTimeIn, now) : null,
    // First day of the current missed streak - the identity of the event, and
    // the date reported in the coordinator notification.
    inactivityStartDate,
    isNewStudent,
    evaluatedAt: now.toISOString(),
    workDays,
  };
}

/**
 * Centralized status for one trainee. This is the function every caller should
 * use: coordinator analytics, the coordinator dashboard, the student profile
 * and the inactivity notification all resolve their status from here.
 *
 * @returns {Promise<Object|null>} null when the trainee does not exist.
 */
async function calculateStudentActivityStatus(traineeId, options = {}) {
  const now = options.now || new Date();
  const trainee = options.trainee || await User.findById(traineeId)
    .select('_id fullName studentId department section companyName createdAt schedule')
    .lean();
  if (!trainee) return null;

  const windowStart = startOfDay(addDays(now, -DEFAULT_LOOKBACK_DAYS));
  const attendance = options.attendance || await loadAttendanceSummary(trainee._id, windowStart);
  return evaluateStatus({ trainee, attendance, now });
}

module.exports = {
  STATUS_ACTIVE,
  STATUS_INACTIVE,
  INACTIVITY_THRESHOLD_DAYS,
  NEW_STUDENT_GRACE_DAYS,
  DEFAULT_LOOKBACK_DAYS,
  calculateStudentActivityStatus,
  evaluateStatus,
  lastSettledDay,
  isApplicableDay,
  configuredWorkDays,
  configuredHolidays,
  loadAttendanceSummary,
  loadAttendanceSummariesForAll,
  dayKey,
  daysBetween,
  startOfDay,
  addDays,
  serverTimezoneOffset,
};
