/**
 * Verifies the attendance -> consecutive missed OJT days -> ACTIVE/INACTIVE
 * rule in backend/services/activityStatusService.js without needing MongoDB.
 *
 * Run with:  node backend/test-activity-status.js
 */

const assert = require('assert');
const {
  evaluateStatus,
  INACTIVITY_THRESHOLD_DAYS,
  STATUS_ACTIVE,
  STATUS_INACTIVE,
} = require('./services/activityStatusService');

// A long-enough past date so nobody is ever treated as a brand-new student.
const LONG_AGO = new Date('2020-01-06T08:00:00');

function keyOf(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${d}`;
}

function day(offsetFromToday) {
  const value = new Date();
  value.setHours(0, 0, 0, 0);
  value.setDate(value.getDate() + offsetFromToday);
  return value;
}

/**
 * The offsets (days before today) of the most recent `count` applicable OJT
 * days, newest first. Mirrors the rule under test - Mon-Fri, so the suite gives
 * the same result no matter which weekday it is run on.
 */
function applicableOffsets(count) {
  const offsets = [];
  let cursor = 0;
  while (offsets.length < count) {
    if ([1, 2, 3, 4, 5].includes(day(cursor).getDay())) offsets.push(cursor);
    cursor -= 1;
  }
  return offsets;
}

/** Attendance built from "days ago" offsets that the trainee recorded a time in. */
function attendanceFrom(attendedOffsets) {
  return {
    attendedDays: new Set(attendedOffsets.map(offset => keyOf(day(offset)))),
    excusedDays: new Set(),
    lastTimeIn: attendedOffsets.length ? day(attendedOffsets[0]) : null,
  };
}

function evaluate(attendedOffsets, now = new Date(), overrides = {}) {
  return evaluateStatus({
    trainee: { _id: 't1', fullName: 'Test Student', createdAt: LONG_AGO, schedule: null, ...overrides },
    attendance: attendanceFrom(attendedOffsets),
    now,
  });
}

// Late evening, so "today" counts as a settled day and the end-of-shift guard
// does not suppress the count.
function settledNow(base = new Date()) {
  const value = new Date(base);
  value.setHours(18, 30, 0, 0);
  return value;
}

/**
 * `missedN` = the trainee missed exactly the N most recent applicable OJT days
 * and attended the 4 before those. Returns the status plus the offsets used, so
 * the assertions can reason in OJT days rather than calendar days.
 */
function withMissedDays(missedN, now = settledNow()) {
  const offsets = applicableOffsets(missedN + 4);
  const missed = offsets.slice(0, missedN);
  const attended = offsets.slice(missedN);
  return { status: evaluate(attended, now), missed, attended, now };
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

console.log('\n=== TrackIT activity status rule ===\n');

console.log('Test 1 - Active student (attended every recent OJT day)');
check('attended every applicable OJT day -> ACTIVE, 0 missed', () => {
  const { status } = withMissedDays(0);
  assert.strictEqual(status.status, STATUS_ACTIVE);
  assert.strictEqual(status.consecutiveMissedDays, 0);
  // "Days since attendance" is measured from the last time in, which is the
  // most recent applicable OJT day (not necessarily today - it can be Friday).
  assert.ok(status.daysSinceLastAttendance >= 0 && status.daysSinceLastAttendance <= 3,
    `unexpected daysSinceLastAttendance ${status.daysSinceLastAttendance}`);
});

console.log('\nTest 2 - One missed OJT day');
check('1 missed OJT day -> still ACTIVE', () => {
  const { status } = withMissedDays(1);
  assert.strictEqual(status.status, STATUS_ACTIVE, `got ${status.status}`);
  assert.strictEqual(status.consecutiveMissedDays, 1);
});

console.log('\nTest 3 - Two missed OJT days');
check('2 missed OJT days -> still ACTIVE', () => {
  const { status } = withMissedDays(2);
  assert.strictEqual(status.status, STATUS_ACTIVE, `got ${status.status}`);
  assert.strictEqual(status.consecutiveMissedDays, 2);
});

console.log('\nTest 4 - Three consecutive missed OJT days');
check('3 missed OJT days -> INACTIVE', () => {
  const { status } = withMissedDays(3);
  assert.strictEqual(status.status, STATUS_INACTIVE, `got ${status.status}`);
  assert.strictEqual(status.consecutiveMissedDays, 3);
  assert.ok(status.inactivityStartDate, 'inactivityStartDate must be set');
});

console.log('\nTest 5 - Inactive student returns');
check('time in after a 3-day OJT gap -> ACTIVE again', () => {
  // Attend only the most recent applicable OJT day; the 3 before it were missed.
  const offsets = applicableOffsets(4);
  const status = evaluate([offsets[0], offsets[3]], settledNow());
  assert.strictEqual(status.status, STATUS_ACTIVE, `got ${status.status}`);
  assert.strictEqual(status.consecutiveMissedDays, 0);
  assert.strictEqual(status.inactivityStartDate, null);
});

console.log('\nTest 6 - Threshold');
check('threshold constant is exactly 3', () => {
  assert.strictEqual(INACTIVITY_THRESHOLD_DAYS, 3);
});

console.log('\nEdge cases');
check('4 missed OJT days -> still INACTIVE', () => {
  const { status } = withMissedDays(4);
  assert.strictEqual(status.status, STATUS_INACTIVE, `got ${status.status}`);
  assert.strictEqual(status.consecutiveMissedDays, 4);
});

check('weekend is never counted as a missed OJT day', () => {
  // Attend the oldest of 6 recent applicable OJT days and miss the 5 after it.
  // Today is late in the week, so that span deliberately crosses a weekend:
  // ~7 calendar days, but only 5 applicable OJT days.
  const offsets = applicableOffsets(6);
  const calendarSpan = Math.abs(offsets[0] - offsets[5]);
  assert.ok(calendarSpan >= 7, `expected the span to cross a weekend (>= 7 days), got ${calendarSpan}`);

  const status = evaluate([offsets[5]], settledNow());
  assert.strictEqual(status.consecutiveMissedDays, 5,
    `expected 5 missed OJT days (weekend skipped), got ${status.consecutiveMissedDays}`);
  assert.ok(status.consecutiveMissedDays < calendarSpan,
    'the weekend must not be counted as an extra missed day');
  assert.strictEqual(status.status, STATUS_INACTIVE, '5 missed OJT days is past the threshold');
});

check('approved leave (excused) does not count as missed', () => {
  const now = settledNow();
  // Excuse the 4 most recent applicable OJT days and attend the 5th. With the
  // excuse in place the streak is 0; without it the same trainee would already
  // be INACTIVE.
  const offsets = applicableOffsets(5);
  const result = evaluateStatus({
    trainee: { _id: 't1', fullName: 'Test', createdAt: LONG_AGO, schedule: null },
    attendance: {
      attendedDays: new Set([keyOf(day(offsets[4]))]),
      excusedDays: new Set(offsets.slice(0, 4).map(offset => keyOf(day(offset)))),
      lastTimeIn: day(offsets[4]),
    },
    now,
  });
  assert.strictEqual(result.consecutiveMissedDays, 0, `got ${result.consecutiveMissedDays}`);
  assert.strictEqual(result.status, STATUS_ACTIVE, 'excused days must not trigger INACTIVE');

  // Same trainee, same gap, but the leave is no longer approved -> INACTIVE.
  const withoutExcuse = evaluate([offsets[4]], now);
  assert.strictEqual(withoutExcuse.status, STATUS_INACTIVE,
    'sanity: without the approved leave the same gap must be INACTIVE');
});

check('new student is never immediately inactive', () => {
  const now = settledNow();
  const brandNew = new Date(now);
  brandNew.setDate(brandNew.getDate() - 1);
  const result = evaluateStatus({
    trainee: { _id: 't1', fullName: 'New', createdAt: brandNew, schedule: null },
    attendance: { attendedDays: new Set(), excusedDays: new Set(), lastTimeIn: null },
    now,
  });
  assert.strictEqual(result.status, STATUS_ACTIVE);
  assert.strictEqual(result.isNewStudent, true);
});

check('a day still in progress is not counted before the shift ends', () => {
  const morning = new Date();
  morning.setHours(9, 0, 0, 0);
  // Miss 3 applicable days; the day in progress must not add a 4th.
  const offsets = applicableOffsets(4);
  const result = evaluate(offsets.slice(1), morning);
  // The newest applicable day may still be "today" at 09:00, in which case it
  // is not settled yet; the count must never exceed 3.
  assert.ok(result.consecutiveMissedDays <= 3, `got ${result.consecutiveMissedDays}`);
});

check('missing attendance data does not crash and returns a full shape', () => {
  // A long-established trainee with no DTR records at all is legitimately
  // INACTIVE (90 days of lookback, every applicable day missed) - what matters
  // is that it resolves safely instead of throwing.
  const result = evaluateStatus({
    trainee: { _id: 't1', fullName: 'Test', createdAt: LONG_AGO, schedule: null },
    attendance: null,
    now: settledNow(),
  });
  assert.strictEqual(result.status, STATUS_INACTIVE);
  assert.strictEqual(result.lastTimeIn, null);
  assert.strictEqual(result.daysSinceLastAttendance, null);
  assert.ok(result.consecutiveMissedDays > 0);
  assert.ok(result.inactivityStartDate, 'an inactive trainee must expose the event date');
});

check('a brand new trainee with no attendance stays ACTIVE', () => {
  const now = settledNow();
  const brandNew = new Date(now);
  brandNew.setDate(brandNew.getDate() - 1);
  const result = evaluateStatus({
    trainee: { _id: 't1', fullName: 'New', createdAt: brandNew, schedule: null },
    attendance: { attendedDays: new Set(), excusedDays: new Set(), lastTimeIn: null },
    now,
  });
  assert.strictEqual(result.status, STATUS_ACTIVE);
  assert.strictEqual(result.isNewStudent, true);
  assert.strictEqual(result.lastTimeIn, null);
  assert.strictEqual(result.daysSinceLastAttendance, null);
});

check('a single time in always resets the streak', () => {
  // 3 missed, then 3 more missed again: the streak never reaches 3 twice over.
  const offsets = applicableOffsets(7);
  const status = evaluate([offsets[0], offsets[1], offsets[2]], settledNow());
  assert.strictEqual(status.status, STATUS_ACTIVE, `got ${status.status}`);
  assert.strictEqual(status.consecutiveMissedDays, 0);
});

check('the inactivity event key is stable for a given missed streak', () => {
  // Same attendance, evaluated twice -> identical event identity, which is what
  // makes the coordinator notification fire once and only once.
  const first = withMissedDays(3).status;
  const second = withMissedDays(3).status;
  assert.strictEqual(first.inactivityStartDate, second.inactivityStartDate);
  assert.ok(first.inactivityStartDate);
});

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===\n`);
process.exit(failed.length ? 1 : 0);
