/**
 * Global daily e-mail budget.
 *
 * The free Brevo plan allows only 300 emails per day for the whole account and
 * silently starts rejecting everything after that, which would lock every
 * student out of the password-reset flow. This service keeps a persistent,
 * atomic count of the emails the app has sent and refuses to hand over a
 * message once the configured budget for the day is spent.
 *
 * Design notes:
 *  - The counter is a single document per UTC day in MongoDB, so it survives a
 *    restart and is shared by all serverless instances.
 *  - A slot is *reserved* before the SMTP call and *released* again when the
 *    send fails, so a provider error never burns a real send.
 *  - The increment is a conditional `findOneAndUpdate`, which MongoDB applies
 *    atomically, so parallel requests cannot overshoot the limit.
 *
 * Environment variables (backend/.env):
 *   EMAIL_DAILY_LIMIT      - max emails per UTC day, default 200
 *                            (Brevo free = 300/day, so the default keeps
 *                            headroom for other transactional mail)
 *   EMAIL_QUOTA_ENABLED    - 'false' disables the budget entirely
 *   EMAIL_QUOTA_PAUSED     - 'true' is the emergency kill switch: no mail at all
 *   EMAIL_QUOTA_FAIL_OPEN  - 'true' allows mail when the counter cannot be read
 *                            (default false, so the budget is never exceeded)
 */

const EmailQuota = require('../models/EmailQuota');

// Used when the counter is unreachable and fail-open is enabled, so the caller
// still gets a sane number in the response.
let lastKnownCount = 0;

function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readFlag(name, fallback) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function isEnabled() {
  return readFlag('EMAIL_QUOTA_ENABLED', true);
}

function isPaused() {
  return readFlag('EMAIL_QUOTA_PAUSED', false);
}

function failsOpen() {
  return readFlag('EMAIL_QUOTA_FAIL_OPEN', false);
}

function getDailyLimit() {
  return Math.floor(readNumber('EMAIL_DAILY_LIMIT', 200));
}

// UTC day key, so the window rolls over at the same moment for every instance
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// Midnight UTC of the current day, used for the "budget resets in X" message
function nextResetAt() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function secondsUntilReset() {
  return Math.max(1, Math.ceil((nextResetAt().getTime() - Date.now()) / 1000));
}

function describeHours() {
  const hours = Math.max(1, Math.round(secondsUntilReset() / 3600));
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Make sure today's document exists. Kept separate from the increment because
 * an upsert whose filter contains an operator ($lt) cannot seed a new document.
 */
async function ensureToday() {
  const day = todayKey();
  await EmailQuota.updateOne(
    { day },
    { $setOnInsert: { day, sent: 0, blocked: 0 } },
    { upsert: true },
  );
  return day;
}

/**
 * Atomically claim one email from today's budget.
 * Returns { allowed: true, remaining, limit } or
 *   { allowed: false, reason: 'paused' | 'exhausted', limit?, sent?, retryAfterSeconds }
 */
async function reserve() {
  if (!isEnabled()) {
    return { allowed: true, remaining: Infinity, enforced: false };
  }

  if (isPaused()) {
    return { allowed: false, reason: 'paused', retryAfterSeconds: secondsUntilReset() };
  }

  const limit = getDailyLimit();
  const day = await ensureToday();

  // The `$lt` guard is part of the atomic update, so two parallel requests can
  // never both take the last slot.
  const doc = await EmailQuota.findOneAndUpdate(
    { day, sent: { $lt: limit } },
    { $inc: { sent: 1 }, $set: { lastSentAt: new Date() } },
    { new: true },
  );

  if (doc) {
    lastKnownCount = doc.sent;
    return { allowed: true, remaining: Math.max(0, limit - doc.sent), limit };
  }

  // Budget spent - record the refusal for diagnostics
  lastKnownCount = limit;
  await EmailQuota.updateOne({ day }, { $inc: { blocked: 1 }, $set: { lastBlockedAt: new Date() } })
    .catch(() => {});

  return {
    allowed: false,
    reason: 'exhausted',
    limit,
    sent: limit,
    retryAfterSeconds: secondsUntilReset(),
  };
}

/**
 * Give a reserved slot back when the provider never accepted the message, so a
 * temporary outage does not eat into the daily budget.
 */
async function release() {
  if (!isEnabled() || isPaused()) return;
  try {
    const day = todayKey();
    const doc = await EmailQuota.findOneAndUpdate(
      { day, sent: { $gt: 0 } },
      { $inc: { sent: -1 } },
      { new: true },
    );
    if (doc) lastKnownCount = doc.sent;
  } catch (error) {
    console.warn(`[email-quota] could not release a reserved slot: ${error.message}`);
  }
}

/** Read-only snapshot, used by the diagnostics endpoint. */
async function getStatus() {
  const limit = getDailyLimit();
  const base = {
    enabled: isEnabled(),
    paused: isPaused(),
    limit,
    day: todayKey(),
    resetsInSeconds: secondsUntilReset(),
  };

  if (!isEnabled()) {
    return { ...base, sent: 0, remaining: null, blocked: 0 };
  }

  try {
    const doc = await EmailQuota.findOne({ day: base.day }).lean();
    const sent = doc ? doc.sent : 0;
    return {
      ...base,
      sent,
      remaining: Math.max(0, limit - sent),
      blocked: doc ? doc.blocked : 0,
      lastSentAt: doc ? doc.lastSentAt : null,
    };
  } catch (error) {
    return { ...base, sent: lastKnownCount, remaining: null, blocked: 0, error: error.message };
  }
}

/**
 * Run `task` behind the budget. The task is only executed once a slot has been
 * claimed, and the slot is released again when the send throws.
 * Returns the task result, or a budget refusal object.
 */
async function withBudget(task, { purpose = 'email' } = {}) {
  const claim = await reserve();

  if (!claim.allowed) {
    if (failsOpen() && claim.reason === 'exhausted') {
      console.warn(
        `[email-quota] ${purpose}: budget spent (${claim.limit}/day) but ` +
          'EMAIL_QUOTA_FAIL_OPEN=true, so this send is allowed anyway.',
      );
    } else {
      return claim;
    }
  }

  try {
    const value = await task();
    return { ok: true, value, remaining: claim.remaining };
  } catch (error) {
    // The provider never took the message, so the slot is given back
    await release();
    throw error;
  }
}

module.exports = {
  describeHours,
  failsOpen,
  getDailyLimit,
  getStatus,
  isEnabled,
  isPaused,
  release,
  reserve,
  secondsUntilReset,
  withBudget,
};

