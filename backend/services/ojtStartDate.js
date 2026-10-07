/**
 * OJT start date - the moment week 1 begins for a trainee.
 *
 * A trainee can register long before a coordinator places them with a company,
 * so counting weeks from account creation would hand them a journal deadline
 * they could never have met. Week 1 therefore starts when they first get a
 * supervisor. `User.supervisorAssignedAt` records that moment; students who
 * were already assigned before the field existed are backfilled here on read
 * (lazily, so no migration run is needed) from the "Supervisor assigned"
 * notification the coordinator's assignment posted, falling back to account
 * creation when no notification survived.
 */
const User = require('../models/User');
const Notification = require('../models/Notification');

/** "Week 1" for day 0-6 after the start date, "Week 2" for day 7-13, ... */
function ojtWeekLabel(startDate, now = new Date()) {
  if (!startDate) return null;
  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) return null;
  const elapsedDays = Math.floor((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  const week = Math.floor(elapsedDays / 7) + 1;
  return week >= 1 ? `Week ${week}` : null;
}

/** Same as ojtWeekLabel but returns the bare number, or null. */
function ojtWeekNumber(startDate, now = new Date()) {
  const label = ojtWeekLabel(startDate, now);
  return label ? Number(label.replace(/\D+/g, '')) : null;
}

/**
 * Earliest "Supervisor assigned" notice per trainee, in one query. Returns a
 * Map of studentId (string) -> Date, covering only the ids that have one.
 */
async function firstAssignmentNotices(studentIds) {
  const dates = new Map();
  if (!studentIds.length) return dates;
  try {
    const notices = await Notification.find({
      recipientId: { $in: studentIds },
      title: 'Supervisor assigned',
    })
      .sort({ createdAt: 1 })
      .select('recipientId createdAt')
      .lean();
    notices.forEach((notice) => {
      const key = String(notice.recipientId);
      if (!dates.has(key)) dates.set(key, new Date(notice.createdAt));
    });
  } catch (error) {
    console.error('[OJT Start Date] Notification lookup failed:', error.message);
  }
  return dates;
}

function derivedStartDate(student, noticeDate) {
  if (noticeDate) return noticeDate;
  if (student.createdAt) return new Date(student.createdAt);
  return new Date();
}

/**
 * Backfill every passed trainee that is placed but still missing the field.
 * Batched: one notification query and one bulk write for the whole cohort, so
 * it is safe to call from hot coordinator endpoints.
 *
 * @returns {Map<string, Date>} studentId (string) -> OJT start date for all
 *   passed trainees that have a supervisor
 */
async function backfillOjtStartDates(students = []) {
  const result = new Map();
  const pending = students.filter((s) => s && s.supervisorId && !s.supervisorAssignedAt);
  if (!pending.length) {
    students.forEach((s) => {
      if (s && s.supervisorAssignedAt) result.set(String(s._id), new Date(s.supervisorAssignedAt));
    });
    return result;
  }

  const notices = await firstAssignmentNotices(pending.map((s) => s._id));
  const ops = [];

  pending.forEach((student) => {
    const derived = derivedStartDate(student, notices.get(String(student._id)));
    student.supervisorAssignedAt = derived;
    result.set(String(student._id), derived);
    ops.push({
      updateOne: {
        filter: { _id: student._id, supervisorAssignedAt: { $exists: false } },
        update: { $set: { supervisorAssignedAt: derived } },
      },
    });
  });

  try {
    if (ops.length) await User.bulkWrite(ops);
  } catch (error) {
    console.error('[OJT Start Date] Bulk backfill failed:', error.message);
  }

  return result;
}

/**
 * Resolve (and persist, when missing) the OJT start date for one student.
 *
 * @param {import('mongoose').Document|Object} student - needs _id,
 *   supervisorId, createdAt and (optionally) supervisorAssignedAt
 * @returns {Date|null} null when the trainee has no supervisor yet, i.e. their
 *   OJT clock has not started
 */
async function resolveOjtStartDate(student) {
  if (!student) return null;
  if (student.supervisorAssignedAt) return new Date(student.supervisorAssignedAt);
  // Not placed yet: no week counting until a supervisor exists.
  if (!student.supervisorId) return null;

  const notices = await firstAssignmentNotices([student._id]);
  const derived = derivedStartDate(student, notices.get(String(student._id)));

  try {
    await User.updateOne(
      { _id: student._id, supervisorAssignedAt: { $exists: false } },
      { $set: { supervisorAssignedAt: derived } }
    );
    student.supervisorAssignedAt = derived;
  } catch (error) {
    console.error('[OJT Start Date] Backfill failed:', error.message);
  }

  return derived;
}

/**
 * Display fallback for week-based UI that must render even before a supervisor
 * is assigned (hours charts, overview cards): assignment date, else account
 * creation, else now.
 */
function ojtStartDateForDisplay(student) {
  if (!student) return new Date();
  if (student.supervisorAssignedAt) return new Date(student.supervisorAssignedAt);
  return student.createdAt ? new Date(student.createdAt) : new Date();
}

module.exports = {
  ojtWeekLabel,
  ojtWeekNumber,
  resolveOjtStartDate,
  backfillOjtStartDates,
  ojtStartDateForDisplay,
};
