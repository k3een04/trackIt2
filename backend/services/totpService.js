const crypto = require('crypto');

/**
 * Minimal RFC 6238 (TOTP) + RFC 4648 base32 implementation.
 *
 * Authenticator apps (Google Authenticator, Microsoft Authenticator, Authy...)
 * all speak this format: the server hands out a base32 secret (normally as a QR
 * code) and the app then shows a new 6-digit code every 30 seconds.
 *
 * Implemented with Node's built-in crypto so no extra dependency is required.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_DIGITS = 6;
const PERIOD_SECONDS = 30;
const SECRET_BYTES = 20; // 160-bit secret, per RFC 4226 section 4
const DEFAULT_ISSUER = 'TrackIT';

// Encode a buffer to base32 (the setup-key format authenticator apps expect)
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

// Decode a base32 setup key back to bytes
function base32Decode(secret) {
  const normalized = String(secret || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base32 secret');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

// Random setup key for a new account
function generateSecret() {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

// 8-byte big-endian counter of the current 30 second time step
function buildCounterBuffer(timestampMs) {
  const counter = Math.floor(timestampMs / 1000 / PERIOD_SECONDS);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter % 0x100000000, 4);
  return buffer;
}

// The numeric code an authenticator app displays for the given moment
function generateCode(secret, timestampMs = Date.now(), digits = DEFAULT_DIGITS) {
  const hmac = crypto
    .createHmac('sha1', base32Decode(secret))
    .update(buildCounterBuffer(timestampMs))
    .digest();

  // Dynamic truncation (RFC 4226 section 5.3)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Check a code typed by the user. A window of 1 accepts the previous and next
 * time step as well, which tolerates small clock differences between the
 * phone and the server.
 */
function verifyCode(secret, code, window = 1) {
  const candidate = String(code || '').replace(/\D/g, '');
  if (!secret || candidate.length !== DEFAULT_DIGITS) {
    return false;
  }

  try {
    for (let step = -window; step <= window; step++) {
      const timestamp = Date.now() + step * PERIOD_SECONDS * 1000;
      if (generateCode(secret, timestamp) === candidate) {
        return true;
      }
    }
  } catch (error) {
    // A corrupted stored secret can never produce a matching code
    return false;
  }

  return false;
}

// otpauth:// URI that authenticator apps can scan or import
function buildOtpauthUrl({ secret, accountName, issuer = DEFAULT_ISSUER }) {
  const label = encodeURIComponent(`${issuer}:${accountName || 'account'}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DEFAULT_DIGITS),
    period: String(PERIOD_SECONDS),
  });

  return `otpauth://totp/${label}?${params.toString()}`;
}

// QR code (data URL) for the otpauth URI, reusing the bundled qrcode package
async function generateQrCodeDataUrl(otpauthUrl) {
  const QRCode = require('qrcode');
  return QRCode.toDataURL(otpauthUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
  });
}

module.exports = {
  DEFAULT_DIGITS,
  DEFAULT_ISSUER,
  PERIOD_SECONDS,
  base32Encode,
  base32Decode,
  generateSecret,
  generateCode,
  verifyCode,
  buildOtpauthUrl,
  generateQrCodeDataUrl,
};
