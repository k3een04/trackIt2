/**
 * Official Performance Appraisal criteria (100-point system).
 *
 * Source of truth: Performance_Appraisal_All_Borders_Black.pdf — the official
 * STI form. Four weighted categories, nine indicators, maximum point values
 * and the rating-equivalent table are reproduced exactly as printed:
 *
 *   Technical Competence 30% (15 + 15)
 *   Attitude             30% (10 + 10 + 10)
 *   Quality of Work      25% (10 + 15)
 *   Attendance & Punctuality 15% (10 + 5)   = 100 points
 *
 * Every save/submit path must run through sanitizeRatings() + summarize() so
 * totals are always recomputed server-side and missing scores are never
 * silently treated as zero.
 */

const CATEGORIES = [
  { key: 'technical', label: 'TECHNICAL COMPETENCE (30%)', short: 'Technical Competence', weight: 30, max: 30 },
  { key: 'attitude', label: 'ATTITUDE (30%)', short: 'Attitude', weight: 30, max: 30 },
  { key: 'quality', label: 'QUALITY OF WORK (25%)', short: 'Quality of Work', weight: 25, max: 25 },
  { key: 'attendance', label: 'ATTENDANCE AND PUNCTUALITY (15%)', short: 'Attendance & Punctuality', weight: 15, max: 15 },
];

const CRITERIA = [
  {
    key: 'technical_1',
    category: 'technical',
    max: 15,
    short: 'Technical Competence 1',
    text: 'The student trainee exhibited knowledge and skills in accomplishing assigned tasks, following set standards.',
  },
  {
    key: 'technical_2',
    category: 'technical',
    max: 15,
    short: 'Technical Competence 2',
    text: 'The student trainee accomplished challenging assigned tasks on time without needing to redo them.',
  },
  {
    key: 'attitude_1',
    category: 'attitude',
    max: 10,
    short: 'Attitude 1',
    text: 'The student trainee effectively conveyed their needs, ideas, suggestions, or and chose appropriate words to ensure they were understood.',
  },
  {
    key: 'attitude_2',
    category: 'attitude',
    max: 10,
    short: 'Attitude 2',
    text: 'The student trainee showed respect to everyone and used constructive feedback from their supervisor for self-improvement.',
  },
  {
    key: 'attitude_3',
    category: 'attitude',
    max: 10,
    short: 'Attitude 3',
    text: 'The student trainee demonstrated a proactive approach by willingly taking on responsibilities within the assigned department/area.',
  },
  {
    key: 'quality_1',
    category: 'quality',
    max: 10,
    short: 'Quality of Work 1',
    text: 'The student trainee followed company rules, regulations, and standards in accomplishing assigned tasks.',
  },
  {
    key: 'quality_2',
    category: 'quality',
    max: 15,
    short: 'Quality of Work 2',
    text: 'The student trainee managed challenging tasks by creating solutions to address them.',
  },
  {
    key: 'attendance_1',
    category: 'attendance',
    max: 10,
    short: 'Attendance & Punctuality 1',
    text: 'The student trainee incurred no absences during the evaluation period.',
  },
  {
    key: 'attendance_2',
    category: 'attendance',
    max: 5,
    short: 'Attendance & Punctuality 2',
    text: 'The student trainee incurred no tardiness during the evaluation period.',
  },
];

/** Official rating-equivalent table (as printed on the form), highest first. */
const RATING_EQUIVALENTS = [
  { min: 98, max: 100, label: 'Excellent', range: '98 - 100' },
  { min: 89, max: 97, label: 'Very Good', range: '89 - 97' },
  { min: 80, max: 88, label: 'Satisfactory', range: '80 - 88' },
  { min: 75, max: 79, label: 'Fair', range: '75 - 79' },
  { min: 0, max: 74, label: 'Fail', range: 'Below 75' },
];

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const round2 = (n) => Math.round(n * 100) / 100;

/** 'YYYY-MM' -> 'April 1-30, 2026' (monthly evaluation period label). */
function evaluationPeriodLabel(period) {
  if (!PERIOD_RE.test(period || '')) return '';
  const [year, month] = period.split('-').map(Number);
  const monthName = new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long' });
  const lastDay = new Date(year, month, 0).getDate();
  return `${monthName} 1-${lastDay}, ${year}`;
}

/** Official rating-equivalent table, applied to the computed total (0-100). */
function ratingEquivalentFor(total) {
  if (typeof total !== 'number' || Number.isNaN(total)) return null;
  const band = RATING_EQUIVALENTS.find((entry) => total >= entry.min && total <= entry.max);
  if (band) return band.label;
  // "Below 75 → Fail" covers fractional totals such as 74.5 that fall between
  // whole-number bands; totals above 100 are impossible (scores are capped).
  return total < 75 ? 'Fail' : null;
}

/**
 * Validate the nine ratings supplied by a client.
 *
 * Scores may be numbers or numeric strings. A missing score is allowed for a
 * draft (it is stored as null, never as 0) but is an error when
 * `requireComplete` is true (submit). Returns { ratings, errors, missing }.
 */
function sanitizeRatings(raw, { requireComplete = false } = {}) {
  const ratings = {};
  const errors = [];
  const missing = [];
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  for (const criterion of CRITERIA) {
    const entry = source[criterion.key];
    const isPlainObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry);
    const rawScore = isPlainObject ? entry.score : entry;
    const rawRemarks = isPlainObject && typeof entry.remarks === 'string' ? entry.remarks : '';
    const remarks = rawRemarks.trim().slice(0, 300);

    let score = null;
    if (rawScore === '' || rawScore === null || rawScore === undefined) {
      missing.push(criterion);
    } else {
      const num = typeof rawScore === 'number' ? rawScore : Number(String(rawScore).trim());
      if (!Number.isFinite(num)) {
        errors.push(`${criterion.short}: rating must be a number.`);
      } else if (num < 0) {
        errors.push(`${criterion.short}: rating cannot be negative.`);
      } else if (num > criterion.max) {
        errors.push(`${criterion.short}: rating cannot exceed the maximum of ${criterion.max}.`);
      } else {
        score = round2(num);
      }
    }

    ratings[criterion.key] = { score, remarks };
  }

  if (requireComplete && missing.length) {
    errors.push(`Missing ratings for: ${missing.map((c) => c.short).join(', ')}.`);
  }

  return { ratings, errors, missing: missing.map((c) => c.key) };
}

/**
 * Recompute category subtotals, total and rating equivalent from stored
 * ratings. A category with any unscored indicator gets a null subtotal and the
 * whole evaluation is marked incomplete: an incomplete evaluation never
 * produces a total or a grade.
 */
function summarize(ratings) {
  const source = ratings && typeof ratings === 'object' ? ratings : {};
  const subtotals = {};
  const missing = [];
  let isComplete = true;
  let total = 0;

  for (const category of CATEGORIES) {
    let sum = 0;
    let complete = true;

    for (const criterion of CRITERIA.filter((c) => c.category === category.key)) {
      const entry = source[criterion.key];
      const score = entry && typeof entry === 'object' ? entry.score : null;
      if (score === null || score === undefined) {
        complete = false;
        missing.push(criterion.key);
      } else {
        sum += Number(score);
      }
    }

    subtotals[category.key] = complete ? round2(sum) : null;
    if (complete) total += sum;
    else isComplete = false;
  }

  const totalScore = isComplete ? round2(total) : null;

  return {
    subtotals,
    totalScore,
    ratingEquivalent: isComplete ? ratingEquivalentFor(totalScore) : null,
    isComplete,
    missing,
  };
}

/**
 * Validate the official form's information fields (snapshot of the trainee,
 * supervisor and period). Fields are optional: an empty field prints blank on
 * the PDF — nothing is ever invented. `ojtSupervisor` and `evaluationPeriodLabel`
 * are always taken from the server (authenticated supervisor + period), never
 * from the client payload.
 */
const INFO_FIELDS = [
  'lastName',
  'firstName',
  'mi',
  'stiCampus',
  'program',
  'yearLevel',
  'section',
  'hostTrainingEstablishment',
  'departmentAssigned',
  'ojtSupervisor',
  'designation',
  'evaluationPeriodLabel',
  'totalHours',
];

function sanitizeInfo(raw, { supervisorName = '', supervisorPosition = '', period = '' } = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const info = {};
  const errors = [];

  for (const field of INFO_FIELDS) {
    const value = typeof source[field] === 'string' ? source[field].trim() : '';
    info[field] = value.slice(0, 120);
  }

  // Server-authoritative fields: derived from the signed-in supervisor and the
  // requested evaluation period, not from client input.
  info.ojtSupervisor = (supervisorName || info.ojtSupervisor || '').slice(0, 120);
  info.designation = info.designation || (supervisorPosition || '').slice(0, 120);
  info.evaluationPeriodLabel = evaluationPeriodLabel(period);

  if (info.totalHours !== '') {
    const hours = Number(info.totalHours);
    if (!Number.isFinite(hours) || hours < 0) {
      errors.push('Total No. of Hours must be a nonnegative number.');
    }
  }

  return { info, errors };
}

module.exports = {
  CATEGORIES,
  CRITERIA,
  INFO_FIELDS,
  PERIOD_RE,
  RATING_EQUIVALENTS,
  evaluationPeriodLabel,
  ratingEquivalentFor,
  sanitizeRatings,
  sanitizeInfo,
  summarize,
};
