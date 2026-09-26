/**
 * End-to-end check of the inactivity notification flow against a live MongoDB.
 *
 * Creates a throwaway coordinator + trainee, backdates the trainee's DTR records
 * so they look like they missed 3+ consecutive OJT days, then verifies:
 *   1. the status resolves to INACTIVE
 *   2. exactly ONE coordinator notification is created
 *   3. re-running the sweep does NOT create a duplicate
 *   4. a fresh time in flips them back to ACTIVE with one "active again" notice
 *
 * Run with:  node backend/test-inactivity-flow.js
 * Requires MONGODB_URI (backend/.env is loaded automatically).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const assert = require('assert');
const mongoose = require('mongoose');
const User = require('./models/User');
const DTR = require('./models/DTR');
const Notification = require('./models/Notification');
const { calculateStudentActivityStatus } = require('./services/activityStatusService');
const { runActivityStatusSweep } = require('./services/notificationService');

const stamp = Date.now();
const coordinatorEmail = `test-coord-${stamp}@example.com`;
const studentEmail = `test-student-${stamp}@example.com`;

function dayKey(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

/** Offsets (days before today) of the N most recent Mon-Fri days, newest first. */
function applicableOffsets(count) {
  const out = [];
  let cursor = 0;
  while (out.length < count) {
    const value = new Date();
    value.setHours(12, 0, 0, 0);
    value.setDate(value.getDate() + cursor);
    if ([1, 2, 3, 4, 5].includes(value.getDay())) out.push(cursor);
    cursor -= 1;
  }
  return out;
}

function atNoon(offset) {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() + offset);
  return value;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`\n=== Inactivity notification flow (live MongoDB) ===\n`);

  const coordinator = await User.create({
    fullName: 'Test Coordinator',
    email: coordinatorEmail,
    password: 'TestPass123',
    role: 'coordinator',
    isActive: true,
  });
  // Confirm this coordinator is actually in the recipient pool, otherwise the
  // notification would be addressed to somebody else entirely.
  const pool = await User.find({ role: 'coordinator', isActive: true }).select('email').lean();
  console.log(`  coordinator pool   : ${pool.length} active coordinator(s)`);
  assert.ok(
    pool.some(u => u._id.toString() === coordinator._id.toString()),
    'test coordinator must be in the active coordinator pool'
  );

  // Registered long ago so the new-student grace period never applies.
  // `timestamps: false` is required: with timestamps enabled Mongoose would
  // overwrite createdAt with the current time on the update.
  const trainee = await User.create({
    fullName: 'Test Trainee',
    email: studentEmail,
    password: 'TestPass123',
    role: 'student',
    studentId: `TEST-${stamp}`,
    department: 'CS',
    section: '4A',
  });
  await User.updateOne(
    { _id: trainee._id },
    { $set: { createdAt: new Date('2024-01-02T08:00:00') } },
    { timestamps: false }
  );
  const freshTrainee = await User.findById(trainee._id).lean();
  assert.ok(
    freshTrainee.createdAt.getFullYear() === 2024,
    'test setup: trainee must be backdated, got ' + freshTrainee.createdAt.toISOString()
  );

  // One time in 7 applicable OJT days ago, then nothing: 6 consecutive missed
  // applicable days, comfortably past the 3-day threshold.
  const offsets = applicableOffsets(7);
  const lastAttendedOffset = offsets[6];
  await DTR.create({
    traineeId: trainee._id,
    companyName: 'Test Co',
    date: atNoon(lastAttendedOffset),
    timeIn: atNoon(lastAttendedOffset),
    timeOut: atNoon(lastAttendedOffset),
    hoursRendered: 8,
    status: 'present',
  });

  // Inactivity notifications go to every active coordinator, so scope the
  // assertions to the coordinator this test created.
  const inactivityPattern = {
    recipientId: coordinator._id,
    dedupeKey: { $regex: `^inactivity:${trainee._id}:` },
  };
  const activePattern = {
    recipientId: coordinator._id,
    dedupeKey: { $regex: `^active-again:${trainee._id}:` },
  };
  if (process.env.DEBUG_STATUS === '1') {
    const docs = await DTR.find({ traineeId: trainee._id }).select('date timeIn status').lean();
    const { loadAttendanceSummary, lastSettledDay, startOfDay, addDays } =
      require('./services/activityStatusService');
    const now = new Date();
    const summary = await loadAttendanceSummary(
      trainee._id,
      startOfDay(addDays(now, -90))
    );
    console.log('  DEBUG now          :', now.toString());
    console.log('  DEBUG settled day  :', lastSettledDay(now, trainee).toString());
    console.log('  DEBUG DTR docs     :', JSON.stringify(docs));
    console.log('  DEBUG attendedDays :', [...summary.attendedDays]);
    console.log('  DEBUG lastTimeIn   :', summary.lastTimeIn);
    console.log('  DEBUG offsets used :', JSON.stringify(offsets));
    console.log('  DEBUG enrolledOn   :', new Date(trainee.createdAt).toString());
  }

  // ── 1. status resolves to INACTIVE ──────────────────────────────────────
  const status = await calculateStudentActivityStatus(trainee._id);
  console.log(`  status              : ${status.status}`);
  console.log(`  consecutiveMissed   : ${status.consecutiveMissedDays}`);
  console.log(`  inactivityStartDate : ${status.inactivityStartDate}`);
  console.log(`  daysSinceAttendance : ${status.daysSinceLastAttendance}`);
  assert.strictEqual(status.status, 'INACTIVE', 'trainee must be INACTIVE');
  assert.ok(status.consecutiveMissedDays >= 3, 'must be past the 3-day threshold');
  assert.ok(status.lastTimeIn, 'lastTimeIn must be reported');
  console.log('  PASS  status resolves to INACTIVE from the DTR history\n');

  // ── 2. first sweep creates exactly ONE coordinator notification ──────────
  const first = await runActivityStatusSweep();
  const afterFirst = await Notification.find(inactivityPattern).lean();
  const allRecipients = await Notification.find({
    dedupeKey: { $regex: `^inactivity:${trainee._id}:` },
  }).lean();
  console.log(`  sweep #1            : ${first.active} active / ${first.inactive} inactive`);
  console.log(`  coordinators in pool: ${pool.length}`);
  console.log(`  notifications       : ${afterFirst.length} for this coordinator, ` +
    `${allRecipients.length} across all recipients`);
  assert.strictEqual(afterFirst.length, 1, 'exactly one inactivity notification expected');
  // Every active coordinator must be told, each exactly once.
  assert.strictEqual(allRecipients.length, pool.length,
    'each active coordinator should receive exactly one notification');
  assert.strictEqual(afterFirst[0].recipientId.toString(), coordinator._id.toString(),
    'notification must be addressed to the coordinator');
  assert.strictEqual(afterFirst[0].type, 'inactivity');
  assert.strictEqual(afterFirst[0].unread, true, 'new notification starts unread');
  assert.ok(afterFirst[0].title.includes('Inactive'), 'title should say Student Inactive');
  assert.ok(afterFirst[0].message.includes('consecutive OJT days'), 'message should explain the rule');
  assert.strictEqual(afterFirst[0].meta.studentId, `TEST-${stamp}`);
  assert.strictEqual(afterFirst[0].meta.section, '4A');
  console.log(`  title               : ${afterFirst[0].title}`);
  console.log(`  message             : ${afterFirst[0].message}`);
  console.log(`  meta                : ${afterFirst[0].meta.consecutiveMissedDays} missed, ` +
    `${afterFirst[0].meta.course}/${afterFirst[0].meta.section}`);
  console.log('  PASS  one coordinator notification with full context\n');

  // ── 3. re-running never duplicates ──────────────────────────────────────
  for (let i = 0; i < 4; i += 1) await runActivityStatusSweep();
  const afterRepeat = await Notification.find(inactivityPattern).lean();
  console.log(`  after 4 more sweeps : ${afterRepeat.length} notification(s)`);
  assert.strictEqual(afterRepeat.length, 1,
    're-running the check must NOT create duplicate notifications');
  console.log('  PASS  repeated sweeps produce no duplicates\n');

  // ── 4. time in flips back to ACTIVE, exactly once ───────────────────────
  // A day is only counted as missed once it is over (see lastSettledDay), so a
  // time in recorded "today" only clears the streak if the shift has ended.
  // Backdate this time in to the most recent applicable OJT day to make the
  // return deterministic regardless of the hour the test runs.
  const returnDay = atNoon(applicableOffsets(1)[0]);
  await DTR.create({
    traineeId: trainee._id,
    companyName: 'Test Co',
    date: returnDay,
    timeIn: returnDay,
    timeOut: returnDay,
    hoursRendered: 8,
    status: 'present',
  });
  await runActivityStatusSweep();

  const backStatus = await calculateStudentActivityStatus(trainee._id);
  const activeAgain = await Notification.find(activePattern).lean();
  console.log(`  status after time in: ${backStatus.status}`);
  console.log(`  active-again notes  : ${activeAgain.length}`);
  assert.strictEqual(backStatus.status, 'ACTIVE', 'time in must return the trainee to ACTIVE');
  assert.strictEqual(backStatus.consecutiveMissedDays, 0, 'streak must be cleared');
  assert.strictEqual(activeAgain.length, 1, 'exactly one "active again" notification');
  assert.strictEqual(activeAgain[0].recipientId.toString(), coordinator._id.toString());
  console.log(`  message             : ${activeAgain[0].message}`);

  for (let i = 0; i < 3; i += 1) await runActivityStatusSweep();
  const activeAgainRepeat = await Notification.countDocuments(activePattern);
  assert.strictEqual(activeAgainRepeat, 1, 'no duplicate "active again" notification');
  console.log('  PASS  INACTIVE -> ACTIVE with a single notification\n');

  // ── 5. the label was persisted for dashboards to read ───────────────────
  const persisted = await User.findById(trainee._id).select('activityStatus').lean();
  assert.strictEqual(persisted.activityStatus, 'ACTIVE', 'persisted label must be ACTIVE');
  console.log('  PASS  activityStatus persisted on the user record\n');

  console.log('=== end-to-end inactivity flow OK ===\n');
}

async function cleanup() {
  const ids = { $in: [] };
  const users = await User.find({
    email: { $in: [coordinatorEmail, studentEmail] },
  }).select('_id').lean();
  users.forEach(user => ids.$in.push(user._id));

  await Promise.all([
    User.deleteMany({ _id: ids }),
    DTR.deleteMany({ traineeId: ids }),
    Notification.deleteMany({ recipientId: ids }),
  ]);
}

main()
  .then(cleanup)
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async error => {
    console.error('\n  FAILED:', error.message, '\n');
    try { await cleanup(); await mongoose.disconnect(); } catch (_) { /* best effort */ }
    process.exit(1);
  });
