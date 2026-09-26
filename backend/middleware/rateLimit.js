/**
 * Small, dependency-free request rate limiter.
 *
 * Added to stop abuse of the public auth endpoints (credential stuffing on
 * /login, mass account creation on /register, and hammering /forgot-password
 * with thousands of different addresses, which would drain the Brevo free
 * tier). It is written by hand on purpose so the backend keeps its current
 * dependency set and nothing new has to be installed on Vercel.
 *
 * How it works:
 *  - a fixed window per key (normally the client IP) per route bucket
 *  - every rejection answers 429 with `retryAfterSeconds`, the same shape the
 *    login modal already understands
 *  - expired buckets are swept periodically so the map cannot grow forever
 *
 * Limitation: the counters live in memory, so on a serverless host each warm
 * instance counts separately. That is intentional - the persistent
 * per-account limits in passwordResetService plus the daily budget in
 * emailQuotaService are what actually protect the mail quota.
 */

const buckets = new Map();

// Sweep expired buckets every 5 minutes (unref'd so it never holds the process
// open on shutdown)
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 5 * 60 * 1000);

if (typeof sweeper.unref === 'function') sweeper.unref();

/**
 * Resolve the client address. `trust proxy` has to be enabled on the Express
 * app (see app.js) for req.ip to be the real address instead of the proxy's.
 */
function getClientIp(req) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  return String(ip);
}

function firstValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Build a limiter middleware.
 *
 * @param {object}   options
 * @param {number}   options.windowMs   window length in ms
 * @param {number}   options.max        requests allowed per window
 * @param {string}   options.name       bucket name, keeps routes independent
 * @param {string}   options.message    429 message shown to the user
 * @param {Function} [options.keyFn]    custom key, receives (req, ip)
 * @param {boolean}  [options.skipSuccessful] only count failed attempts
 */
function createRateLimiter({
  windowMs,
  max,
  name,
  message = 'Too many requests. Please wait a moment and try again.',
  keyFn = null,
  skipSuccessful = false,
}) {
  if (!name) throw new Error('createRateLimiter requires a name');

  return function rateLimit(req, res, next) {
    const ip = getClientIp(req);
    const key = `${name}:${keyFn ? keyFn(req, ip) : ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs, failures: 0 };
      buckets.set(key, bucket);
    }

    // Only count failures (e.g. wrong password) when asked to
    if (skipSuccessful) {
      res.on('finish', () => {
        if (res.statusCode >= 400) {
          bucket.failures += 1;
        }
      });
    } else {
      bucket.count += 1;
    }

    const used = skipSuccessful ? bucket.failures : bucket.count;
    const remaining = Math.max(0, max - used);
    const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);

    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));

    if (used < max) {
      return next();
    }

    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      success: false,
      retryAfterSeconds,
      message,
    });
  };
}

/** Read-only helper for the diagnostics endpoint. */
function describe() {
  return { buckets: buckets.size, sweeperActive: sweeper.isActive === true };
}

/** Test helper: forget every counter. */
function reset() {
  buckets.clear();
}

module.exports = {
  createRateLimiter,
  describe,
  firstValue,
  getClientIp,
  reset,
};
