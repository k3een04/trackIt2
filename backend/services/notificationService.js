const Notification = require('../models/Notification');
const User = require('../models/User');
const {
  STATUS_ACTIVE,
  STATUS_INACTIVE,
  DEFAULT_LOOKBACK_DAYS,
  evaluateStatus,
  loadAttendanceSummariesForAll,
  startOfDay,
  addDays,
} = require('./activityStatusService');

const NOTIFICATION_TYPES = ['journal', 'attendance', 'dtr', 'system', 'inactivity', 'activity'];

/**
 * Insert notifications, skipping (and reporting) any item whose `dedupeKey`
 * already exists. Combined with the sparse unique index on Notification the
 * `insertMany` is the authority: if two sweeps race, one insert hits the
 * duplicate-key error and is discarded instead of spamming the coordinator.
 */
async function createNotifications(items) {
  try {
    const candidates = (Array.isArray(items) ? items : [items])
      .filter((item) => item && item.recipientId && item.title && item.message)
      .map((item) => ({
        recipientId: item.recipientId,
        recipientRole: item.recipientRole || 'supervisor',
        actorId: item.actorId || null,
        actorName: item.actorName || '',
        type: NOTIFICATION_TYPES.includes(item.type) ? item.type : 'system',
        title: String(item.title).slice(0, 160),
        message: String(item.message).slice(0, 500),
        refModel: ['Journal', 'DTR', 'User'].includes(item.refModel) ? item.refModel : null,
        refId: item.refId || null,
        unread: item.unread !== false,
        dedupeKey: item.dedupeKey || undefined,
        meta: item.meta || undefined,
      }));
    if (!candidates.length) return [];

    // Pre-filter keys already stored so the common "sweep already ran" path
    // issues no writes at all.
    const keys = candidates.map((item) => item.dedupeKey).filter(Boolean);
    if (keys.length) {
      const existing = await Notification.find({ dedupeKey: { $in: keys } })
        .select('dedupeKey')
        .lean();
      const seen = new Set(existing.map(doc => doc.dedupeKey));
      const fresh = candidates.filter(item => !item.dedupeKey || !seen.has(item.dedupeKey));
      if (!fresh.length) return [];

      try {
        return await Notification.insertMany(fresh, { ordered: false });
      } catch (error) {
        // 11000 = lost the race against a concurrent sweep. Retry without the
        // colliding keys so the non-duplicate items still land.
        if (error && error.code === 11000 && fresh.some(item => item.dedupeKey)) {
          const survivors = [];
          for (const item of fresh) {
            if (!item.dedupeKey) { survivors.push(item); continue; }
            try {
              await Notification.create(item);
            } catch (inner) {
              if (!inner || inner.code !== 11000) throw inner;
            }
          }
          return survivors;
        }
        throw error;
      }
    }

    return await Notification.insertMany(candidates, { ordered: false });
  } catch (error) {
    console.error('[Notifications] Failed to persist notifications:', error.message);
    return [];
  }
}

async function resolveRecipientsForTrainee(trainee) {
  const supervisors = [];
  const coordinators = [];
  try {
    if (trainee && trainee.supervisorId) {
      const supervisor = await User.findById(trainee.supervisorId).select('fullName role isActive');
      if (supervisor && supervisor.isActive !== false) supervisors.push(supervisor);
    }
    const coordinatorList = await User.find({ role: 'coordinator', isActive: true })
      .select('fullName role isActive')
      .limit(25);
    coordinators.push(...coordinatorList);
  } catch (error) {
    console.error('[Notifications] Failed to resolve recipients:', error.message);
  }
  return { supervisors, coordinators };
}

function traineeLabel(trainee) {
  if (!trainee) return 'A trainee';
  return trainee.fullName || 'A trainee';
}

function formatTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function notifyJournalSubmitted({ journal, trainee, week }) {
  const label = traineeLabel(trainee);
  const { supervisors, coordinators } = await resolveRecipientsForTrainee(trainee);
  const items = [];
  supervisors.forEach((supervisor) => {
    items.push({
      recipientId: supervisor._id,
      recipientRole: 'supervisor',
      actorId: trainee ? trainee._id : null,
      actorName: label,
      type: 'journal',
      title: 'Journal submitted',
      message: `${label} submitted ${week || 'a weekly'} journal for review.`,
      refModel: 'Journal',
      refId: journal ? journal._id : null,
    });
  });
  coordinators.forEach((coordinator) => {
    items.push({
      recipientId: coordinator._id,
      recipientRole: 'coordinator',
      actorId: trainee ? trainee._id : null,
      actorName: label,
      type: 'journal',
      title: 'Journal submitted',
      message: `${label} submitted ${week || 'a weekly'} journal.`,
      refModel: 'Journal',
      refId: journal ? journal._id : null,
    });
  });
  return createNotifications(items);
}

async function notifyTimeIn({ trainee, dtr }) {
  const label = traineeLabel(trainee);
  const { supervisors, coordinators } = await resolveRecipientsForTrainee(trainee);
  const items = [];
  supervisors.forEach((supervisor) => {
    items.push({
      recipientId: supervisor._id,
      recipientRole: 'supervisor',
      actorId: trainee ? trainee._id : null,
      actorName: label,
      type: 'attendance',
      title: 'Trainee timed in',
      message: `${label} timed in${dtr && dtr.timeIn ? ` at ${formatTime(dtr.timeIn)}` : ''}.`,
      refModel: 'DTR',
      refId: dtr ? dtr._id : null,
    });
  });
  coordinators.forEach((coordinator) => {
    items.push({
      recipientId: coordinator._id,
      recipientRole: 'coordinator',
      actorId: trainee ? trainee._id : null,
      actorName: label,
      type: 'attendance',
      title: 'Trainee timed in',
      message: `${label} timed in${dtr && dtr.timeIn ? ` at ${formatTime(dtr.timeIn)}` : ''}.`,
      refModel: 'DTR',
      refId: dtr ? dtr._id : null,
    });
  });
  return createNotifications(items);
}

async function notifyTimeOut({ trainee, dtr }) {
  const label = traineeLabel(trainee);
  const { supervisors } = await resolveRecipientsForTrainee(trainee);
  const hours = dtr && dtr.hoursRendered ? ` (${Number(dtr.hoursRendered).toFixed(2)} hrs)` : '';
  const items = supervisors.map((supervisor) => ({
    recipientId: supervisor._id,
    recipientRole: 'supervisor',
    actorId: trainee ? trainee._id : null,
    actorName: label,
    type: 'attendance',
    title: 'Trainee timed out',
    message: `${label} timed out${dtr && dtr.timeOut ? ` at ${formatTime(dtr.timeOut)}` : ''}${hours}.`,
    refModel: 'DTR',
    refId: dtr ? dtr._id : null,
  }));
  return createNotifications(items);
}

async function notifyDtrNeedsSignature({ trainee, dtr }) {
  const label = traineeLabel(trainee);
  const { supervisors } = await resolveRecipientsForTrainee(trainee);
  const items = supervisors.map((supervisor) => ({
    recipientId: supervisor._id,
    recipientRole: 'supervisor',
    actorId: trainee ? trainee._id : null,
    actorName: label,
    type: 'dtr',
    title: 'DTR needs signature',
    message: `${label}'s DTR for ${formatDate(dtr ? dtr.date : null)} is ready for signature.`,
    refModel: 'DTR',
    refId: dtr ? dtr._id : null,
  }));
  return createNotifications(items);
}

async function notifyJournalSigned({ journal, trainee, supervisorName, coordinatorVisible = true }) {
  const label = traineeLabel(trainee);
  const { coordinators } = await resolveRecipientsForTrainee(trainee);
  const weekLabel = journal && journal.week ? journal.week : 'weekly';
  const items = [];
  if (coordinatorVisible) {
    coordinators.forEach((coordinator) => {
      items.push({
        recipientId: coordinator._id,
        recipientRole: 'coordinator',
        actorId: trainee ? trainee._id : null,
        actorName: label,
        type: 'journal',
        title: 'Journal signed',
        message: `${label}'s ${weekLabel} journal was signed${supervisorName ? ` by ${supervisorName}` : ''} and is ready for approval.`,
        refModel: 'Journal',
        refId: journal ? journal._id : null,
      });
    });
  }
  if (trainee && trainee._id) {
    items.push({
      recipientId: trainee._id,
      recipientRole: 'student',
      actorId: null,
      actorName: supervisorName || 'Supervisor',
      type: 'journal',
      title: 'Journal signed',
      message: `Your ${weekLabel} journal was signed${supervisorName ? ` by ${supervisorName}` : ''}.`,
      refModel: 'Journal',
      refId: journal ? journal._id : null,
    });
  }
  return createNotifications(items);
}

async function notifyJournalReturned({ journal, trainee, reason, byRole = 'supervisor', byName = '' }) {
  const label = traineeLabel(trainee);
  const weekLabel = journal && journal.week ? journal.week : 'weekly';
  const items = [];
  if (trainee && trainee._id) {
    items.push({
      recipientId: trainee._id,
      recipientRole: 'student',
      actorId: null,
      actorName: byName || 'Reviewer',
      type: 'journal',
      title: 'Journal returned for revision',
      message: `Your ${weekLabel} journal was returned for revision${reason ? `: ${reason}` : '.'}`,
      refModel: 'Journal',
      refId: journal ? journal._id : null,
    });
  }
  if (byRole === 'coordinator') {
    const { supervisors } = await resolveRecipientsForTrainee(trainee);
    supervisors.forEach((supervisor) => {
      items.push({
        recipientId: supervisor._id,
        recipientRole: 'supervisor',
        actorId: null,
        actorName: byName || 'Coordinator',
        type: 'journal',
        title: 'Journal returned by coordinator',
        message: `${label}'s ${weekLabel} journal was returned for supervisor review${reason ? `: ${reason}` : '.'}`,
        refModel: 'Journal',
        refId: journal ? journal._id : null,
      });
    });
  }
  return createNotifications(items);
}

async function notifyJournalApproved({ journal, trainee, coordinatorName = '' }) {
  const weekLabel = journal && journal.week ? journal.week : 'weekly';
  const items = [];
  if (trainee && trainee._id) {
    items.push({
      recipientId: trainee._id,
      recipientRole: 'student',
      actorId: null,
      actorName: coordinatorName || 'Coordinator',
      type: 'journal',
      title: 'Journal approved',
      message: `Your ${weekLabel} journal was approved${coordinatorName ? ` by ${coordinatorName}` : ''}.`,
      refModel: 'Journal',
      refId: journal ? journal._id : null,
    });
  }
  return createNotifications(items);
}

async function notifyDtrVerified({ trainee, dtr, supervisorName = '' }) {
  const items = [];
  if (trainee && trainee._id) {
    items.push({
      recipientId: trainee._id,
      recipientRole: 'student',
      actorId: null,
      actorName: supervisorName || 'Supervisor',
      type: 'dtr',
      title: 'DTR verified',
      message: `Your DTR for ${formatDate(dtr ? dtr.date : null)} was verified${supervisorName ? ` by ${supervisorName}` : ''}.`,
      refModel: 'DTR',
      refId: dtr ? dtr._id : null,
    });
  }
  return createNotifications(items);
}

async function notifySupervisorAssigned({ trainee, supervisor }) {
  const items = [];
  if (supervisor && supervisor._id) {
    items.push({
      recipientId: supervisor._id,
      recipientRole: 'supervisor',
      actorId: trainee ? trainee._id : null,
      actorName: traineeLabel(trainee),
      type: 'system',
      title: 'New trainee assigned',
      message: `${traineeLabel(trainee)} was assigned to you${trainee && trainee.companyName ? ` at ${trainee.companyName}` : ''}.`,
      refModel: 'User',
      refId: trainee ? trainee._id : null,
    });
  }
  if (trainee && trainee._id) {
    items.push({
      recipientId: trainee._id,
      recipientRole: 'student',
      actorId: null,
      actorName: supervisor && supervisor.fullName ? supervisor.fullName : 'Coordinator',
      type: 'system',
      title: 'Supervisor assigned',
      message: `${supervisor && supervisor.fullName ? `${supervisor.fullName} is` : 'A supervisor was'} assigned as your OJT supervisor.`,
      refModel: 'User',
      refId: supervisor ? supervisor._id : null,
    });
  }
  return createNotifications(items);
}

/**
 * Coordinator notification for a trainee that just crossed the inactivity
 * threshold. `dedupeKey` pins it to the specific inactivity event
 * (trainee + first missed OJT day), so re-running the check - on every
 * dashboard load, every DTR write, on the scheduled sweep - can never post a
 * second copy.
 */
async function notifyStudentInactive({ trainee, status }) {
  if (!trainee || !trainee._id || !status) return [];
  if (status.status !== STATUS_INACTIVE) return [];

  const label = traineeLabel(trainee);
  const missed = status.consecutiveMissedDays;
  const eventDay = status.inactivityStartDate || status.evaluatedAt;
  const { coordinators } = await resolveRecipientsForTrainee(trainee);
  if (!coordinators.length) return [];

  return createNotifications(coordinators.map(coordinator => ({
    recipientId: coordinator._id,
    recipientRole: 'coordinator',
    actorId: trainee._id,
    actorName: label,
    type: 'inactivity',
    title: 'Student Inactive',
    message: `${label} has not recorded attendance for ${missed} consecutive OJT days and has been marked inactive. Date: ${formatDate(eventDay)}.`,
    refModel: 'User',
    refId: trainee._id,
    dedupeKey: `inactivity:${trainee._id}:${eventDay}:${coordinator._id}`,
    meta: {
      studentId: trainee.studentId || null,
      fullName: label,
      course: trainee.department || null,
      section: trainee.section || null,
      company: trainee.companyName || null,
      consecutiveMissedDays: missed,
      inactivityStartDate: eventDay,
      status: STATUS_INACTIVE,
    },
  })));
}

/**
 * Optional counterpart: tells the coordinator a previously inactive trainee is
 * back. Keyed to the exact time in that ended the streak, so a trainee who
 * returns once is announced once.
 */
async function notifyStudentActiveAgain({ trainee, status }) {
  if (!trainee || !trainee._id || !status) return [];
  if (status.status !== STATUS_ACTIVE || !status.lastTimeIn) return [];

  const label = traineeLabel(trainee);
  const { coordinators } = await resolveRecipientsForTrainee(trainee);
  if (!coordinators.length) return [];

  return createNotifications(coordinators.map(coordinator => ({
    recipientId: coordinator._id,
    recipientRole: 'coordinator',
    actorId: trainee._id,
    actorName: label,
    type: 'activity',
    title: 'Student Active Again',
    message: `${label} has recorded attendance and is now marked active. Last time in: ${formatDate(status.lastTimeIn)}.`,
    refModel: 'User',
    refId: trainee._id,
    dedupeKey: `active-again:${trainee._id}:${status.lastTimeIn}:${coordinator._id}`,
    meta: {
      studentId: trainee.studentId || null,
      fullName: label,
      lastTimeIn: status.lastTimeIn,
      status: STATUS_ACTIVE,
    },
  })));
}

/**
 * Recalculates the activity status of every trainee and raises the coordinator
 * notifications for the transitions that just happened.
 *
 * Idempotent by construction: the label is recomputed from the DTR history on
 * every run, and the notifications are keyed to the event, so running this ten
 * times in a row produces exactly the same database state as running it once.
 */
async function runActivityStatusSweep(options = {}) {
  const now = options.now || new Date();
  const windowStart = startOfDay(addDays(now, -DEFAULT_LOOKBACK_DAYS));

  const [trainees, summaries] = await Promise.all([
    User.find({ role: 'student' })
      .select('_id fullName studentId department section companyName createdAt schedule activityStatus inactivityStartDate')
      .lean(),
    loadAttendanceSummariesForAll(windowStart),
  ]);

  const results = [];
  const changed = [];

  trainees.forEach(trainee => {
    const attendance = summaries.get(trainee._id.toString()) || {
      attendedDays: new Set(),
      excusedDays: new Set(),
      lastTimeIn: null,
    };
    const status = evaluateStatus({ trainee, attendance, now });
    const previous = trainee.activityStatus || null;
    results.push({ trainee, status });
    if (previous !== status.status) changed.push({ trainee, status, previous });
  });

  // Persist the recalculated label so dashboards can sort/filter on it, and so
  // the transition (and therefore the notification) is only raised once.
  if (changed.length) {
    await Promise.all(changed.map(({ trainee, status }) =>
      User.updateOne(
        { _id: trainee._id },
        {
          $set: {
            activityStatus: status.status,
            activityStatusUpdatedAt: now,
            inactivityStartDate: status.status === STATUS_INACTIVE
              ? status.inactivityStartDate
              : null,
          },
        }
      ).catch(error => {
        console.error('[ActivityStatus] Failed to persist status:', error.message);
      })
    ));
  }

  // Only a real transition raises a notification.
  for (const { trainee, status } of changed) {
    if (status.status === STATUS_INACTIVE) {
      await notifyStudentInactive({ trainee, status });
    } else if (status.status === STATUS_ACTIVE) {
      await notifyStudentActiveAgain({ trainee, status });
    }
  }

  return {
    checkedAt: now.toISOString(),
    total: results.length,
    active: results.filter(entry => entry.status.status === STATUS_ACTIVE).length,
    inactive: results.filter(entry => entry.status.status === STATUS_INACTIVE).length,
    transitions: changed.length,
  };
}

module.exports = {
  createNotifications,
  notifyJournalSubmitted,
  notifyTimeIn,
  notifyTimeOut,
  notifyDtrNeedsSignature,
  notifyJournalSigned,
  notifyJournalReturned,
  notifyJournalApproved,
  notifyDtrVerified,
  notifySupervisorAssigned,
  notifyStudentInactive,
  notifyStudentActiveAgain,
  runActivityStatusSweep,
};