const Notification = require('../models/Notification');
const User = require('../models/User');

async function createNotifications(items) {
  try {
    const docs = (Array.isArray(items) ? items : [items])
      .filter((item) => item && item.recipientId && item.title && item.message)
      .map((item) => ({
        recipientId: item.recipientId,
        recipientRole: item.recipientRole || 'supervisor',
        actorId: item.actorId || null,
        actorName: item.actorName || '',
        type: ['journal', 'attendance', 'dtr', 'system'].includes(item.type) ? item.type : 'system',
        title: String(item.title).slice(0, 160),
        message: String(item.message).slice(0, 500),
        refModel: ['Journal', 'DTR', 'User'].includes(item.refModel) ? item.refModel : null,
        refId: item.refId || null,
        unread: item.unread !== false,
      }));
    if (!docs.length) return [];
    return await Notification.insertMany(docs, { ordered: false });
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
};