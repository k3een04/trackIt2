/**
 * Forgot-password flow: emails a 6-digit code to the school Microsoft account
 * and returns a short-lived reset token once that code checks out.
 *
 * Security properties:
 *  - the code is only stored as a bcrypt hash with a 10 minute expiry
 *  - a wrong code increments an attempt counter; after MAX_VERIFY_ATTEMPTS the
 *    code is thrown away and a new one has to be requested
 *  - one email per account every RESEND_COOLDOWN_SECONDS, and a best-effort
 *    hourly cap per address
 *  - requesting a code for an unknown address reveals nothing (the route sends
 *    the same generic answer either way)
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const emailService = require('./emailService');

const CODE_LENGTH = 6;
const CODE_TTL_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_REQUESTS_PER_HOUR = 5;

// The reset fields are select:false, so every read has to ask for them
const RESET_FIELDS =
  '+passwordResetCodeHash +passwordResetExpiresAt +passwordResetAttempts +passwordResetRequestedAt';

// Best-effort hourly counter. A serverless deployment may run several isolated
// instances, so the per-account cooldown stored in MongoDB is the authoritative
// limit and this map only deflects obvious hammering.
const requestLog = new Map();

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function generateCode() {
  return String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

async function hashResetCode(code) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(code, salt);
}

function hasActiveCode(user) {
  return Boolean(user && user.passwordResetCodeHash && user.passwordResetExpiresAt);
}

function isExpired(user) {
  return !user.passwordResetExpiresAt || new Date(user.passwordResetExpiresAt).getTime() <= Date.now();
}

// Seconds left of a cooldown window that started at `date`
function secondsLeft(date, windowSeconds) {
  if (!date) {
    return 0;
  }
  const remaining = Math.ceil(windowSeconds - (Date.now() - new Date(date).getTime()) / 1000);
  return remaining > 0 ? remaining : 0;
}

function takeHourlySlot(email) {
  const now = Date.now();
  const entry = requestLog.get(email);

  if (!entry || now - entry.windowStart >= 60 * 60 * 1000) {
    requestLog.set(email, { windowStart: now, count: 1 });
    return { allowed: true };
  }

  if (entry.count >= MAX_REQUESTS_PER_HOUR) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((entry.windowStart + 60 * 60 * 1000 - now) / 1000),
    };
  }

  entry.count += 1;
  return { allowed: true };
}

function findUserForReset(email) {
  return User.findOne({ email: normalizeEmail(email) }).select(RESET_FIELDS);
}

function storeCode(userId, code) {
  return User.updateOne(
    { _id: userId },
    {
      $set: {
        passwordResetCodeHash: code.hash,
        passwordResetExpiresAt: code.expiresAt,
        passwordResetAttempts: 0,
        passwordResetRequestedAt: new Date(),
      },
    },
  );
}

// Drop the pending code (used after a reset, after too many attempts, or when
// the email could not be delivered)
function clearReset(userId) {
  return User.updateOne(
    { _id: userId },
    {
      $unset: {
        passwordResetCodeHash: '',
        passwordResetExpiresAt: '',
        passwordResetAttempts: '',
      },
    },
  );
}

function buildResetEmail({ fullName, code }) {
  const name = fullName ? String(fullName).split(' ')[0] : 'there';
  const safeName = emailService.escapeHtml(name);
  const safeCode = emailService.escapeHtml(code);

  const subject = `TrackIT password reset code: ${code}`;

  const text = [
    `Hi ${name},`,
    '',
    `Your TrackIT password reset code is: ${code}`,
    '',
    `The code expires in ${CODE_TTL_MINUTES} minutes. Enter it on the TrackIT login page to choose a new password.`,
    '',
    'If you did not ask for this code you can ignore this email - your password stays the same.',
    '',
    'TrackIT - OJT Monitoring Platform',
  ].join('\n');

  const html = `
  <div style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0a0f1e;padding:28px;">
    <div style="max-width:520px;margin:0 auto;background:#111827;border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:28px;color:#e2e8f0;">
      <div style="font-size:20px;font-weight:800;letter-spacing:-0.02em;color:#ffffff;margin-bottom:4px;">
        Track<span style="color:#00c8aa;">IT</span>
      </div>
      <p style="font-size:13px;color:#94a3b8;margin:0 0 20px;">OJT Monitoring Platform</p>
      <p style="font-size:15px;margin:0 0 12px;">Hi ${safeName},</p>
      <p style="font-size:15px;margin:0 0 20px;">Use this code to reset the password of your TrackIT account:</p>
      <div style="font-family:Consolas,Monaco,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#00c8aa;background:rgba(0,200,170,0.08);border:1px solid rgba(0,200,170,0.35);border-radius:12px;padding:16px 20px;text-align:center;margin-bottom:22px;">
        ${safeCode}
      </div>
      <p style="font-size:14px;color:#cbd5e1;margin:0 0 10px;">This code expires in ${CODE_TTL_MINUTES} minutes and can only be used once.</p>
      <p style="font-size:14px;color:#cbd5e1;margin:0 0 20px;">If you did not request a password reset, you can safely ignore this email - your password will not change.</p>
      <p style="font-size:12px;color:#64748b;margin:0;">Sent automatically by TrackIT. Please do not reply to this message.</p>
    </div>
  </div>`.trim();

  return { subject, text, html };
}

/**
 * Ask for a reset code.
 * Returns one of:
 *   { status: 'sent', delivery: 'email' | 'console', codeExpiresInMinutes }
 *   { status: 'unknown-account' }  - caller answers exactly like 'sent'
 *   { status: 'cooldown', retryAfterSeconds }
 *   { status: 'rate-limited', retryAfterSeconds }
 *   { status: 'send-failed' }
 */
async function requestReset(email) {
  const normalized = normalizeEmail(email);
  const user = await findUserForReset(normalized);

  if (!user) {
    return { status: 'unknown-account' };
  }

  const hourly = takeHourlySlot(normalized);
  if (!hourly.allowed) {
    return { status: 'rate-limited', retryAfterSeconds: hourly.retryAfterSeconds };
  }

  const cooldown = secondsLeft(user.passwordResetRequestedAt, RESEND_COOLDOWN_SECONDS);
  if (cooldown > 0) {
    return { status: 'cooldown', retryAfterSeconds: cooldown };
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);
  await storeCode(user._id, { hash: await hashResetCode(code), expiresAt });

  if (!emailService.isConfigured()) {
    const transport = emailService.describeTransport();
    console.warn(
      `[password-reset] No mail transport is configured, so the code is only ` +
      `printed here instead of being emailed. Reset code for ${normalized} ` +
      `is ${code} (valid ${CODE_TTL_MINUTES} minutes). ` +
      `Set SMTP_* (see backend/.env.example) to deliver it for real. ` +
      `Transport currently detected: ${transport.transport}.`,
    );

    return {
      status: 'sent',
      delivery: 'console',
      codeExpiresInMinutes: CODE_TTL_MINUTES,
    };
  }

  try {
    const { subject, text, html } = buildResetEmail({ fullName: user.fullName, code });
    await emailService.sendMail({ to: normalized, subject, text, html });

    return { status: 'sent', delivery: 'email', codeExpiresInMinutes: CODE_TTL_MINUTES };
  } catch (error) {
    console.error('[password-reset] Could not send the reset email:', error.message);
    await clearReset(user._id);
    return { status: 'send-failed' };
  }
}

/**
 * Check the code the user typed in.
 * Returns { status: 'valid', user } or
 *   { status: 'invalid', attemptsLeft? } | { status: 'expired' } |
 *   { status: 'too-many-attempts' } | { status: 'no-code' }
 */
async function verifyResetCode({ email, code }) {
  const user = await findUserForReset(email);

  if (!hasActiveCode(user)) {
    return { status: 'no-code' };
  }

  if (isExpired(user)) {
    await clearReset(user._id);
    return { status: 'expired' };
  }

  if ((user.passwordResetAttempts || 0) >= MAX_VERIFY_ATTEMPTS) {
    await clearReset(user._id);
    return { status: 'too-many-attempts' };
  }

  const matches = await bcrypt.compare(String(code || ''), user.passwordResetCodeHash);

  if (!matches) {
    const attempts = (user.passwordResetAttempts || 0) + 1;
    await User.updateOne({ _id: user._id }, { $set: { passwordResetAttempts: attempts } });

    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await clearReset(user._id);
      return { status: 'too-many-attempts' };
    }

    return { status: 'invalid', attemptsLeft: MAX_VERIFY_ATTEMPTS - attempts };
  }

  return { status: 'valid', user };
}

module.exports = {
  CODE_LENGTH,
  CODE_TTL_MINUTES,
  RESEND_COOLDOWN_SECONDS,
  MAX_VERIFY_ATTEMPTS,
  buildResetEmail,
  clearReset,
  generateCode,
  requestReset,
  verifyResetCode,
};

