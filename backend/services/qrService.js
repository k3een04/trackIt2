const crypto = require('crypto');
const QRCode = require('qrcode');
const QRSession = require('../models/QRSession');
const os = require('os');

const QR_VALIDITY_SECONDS = 30; // QR code regenerates every 30 seconds

/**
 * Get the server's network IP address (not localhost)
 * @returns {String} IPv4 address or 'localhost' if none found
 */
const getNetworkIP = () => {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // Skip internal and non-IPv4 addresses
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  } catch (error) {
    console.error('Error getting network IP:', error);
  }
  return 'localhost';
};

/**
 * Generate a new QR session and token for a supervisor/company
 * @param {String} companyId - MongoDB ObjectId of the company (optional, can be null)
 * @param {String} supervisorId - MongoDB ObjectId of the supervisor (optional)
 * @param {String} companyName - Name of the company (required if companyId is null)
 * @param {String} baseUrl - Base URL for QR code (optional, uses env or defaults to localhost)
 * @param {String} traineeId - MongoDB ObjectId of the trainee (optional, for clock in/out)
 * @returns {Object} { qrImage, token, expiresAt }
 */
const generateQRSession = async (companyId = null, supervisorId = null, companyName = null, baseUrl = null, traineeId = null) => {
  try {
    // Use companyName as the identifier if companyId is not provided
    const identifier = companyId || companyName;
    
    if (!identifier) {
      throw new Error('Either companyId or companyName must be provided');
    }

    // Invalidate old tokens for this company/identifier
    if (companyId) {
      await QRSession.deleteMany({ companyId });
    } else if (companyName) {
      await QRSession.deleteMany({ companyName });
    }

    // Generate secure random token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + QR_VALIDITY_SECONDS * 1000);

    // Save to database
    const qrSessionData = {
      token,
      expiresAt,
      supervisorId,
      traineeId,
    };
    
    if (companyId) {
      qrSessionData.companyId = companyId;
    } else {
      qrSessionData.companyName = companyName;
    }

    await QRSession.create(qrSessionData);

    // QR encodes a scan URL with the token (includes traineeId for direct clock in/out)
    // Use provided baseUrl, or environment variable, or default to localhost
    let url = baseUrl || process.env.BASE_URL || 'http://localhost:5000';
    
    // If localhost was detected, replace with actual network IP so phone can scan it
    if (url.includes('localhost') || url.includes('127.0.0.1')) {
      const networkIP = getNetworkIP();
      const port = url.includes(':') ? url.split(':')[2] : '5000';
      url = `http://${networkIP}:${port}`;
      console.log(`🌐 Replaced localhost with network IP: ${url}`);
    }
    
    const scanUrl = `${url}/api/qr/scan/${token}`;

    // Generate QR code as data URL
    const qrImage = await QRCode.toDataURL(scanUrl, {
      errorCorrectionLevel: 'H',
      type: 'image/png',
      quality: 0.95,
      margin: 1,
      width: 300,
      color: {
        dark: '#0a0f1e',
        light: '#ffffff',
      },
    });

    return {
      qrImage,
      token,
      expiresAt,
      scanUrl,
    };
  } catch (error) {
    console.error('Error generating QR session:', error);
    throw error;
  }
};

/**
 * Validate a QR token
 * @param {String} token - QR token to validate
 * @returns {Object} QRSession document or null if invalid/expired/already used
 */
const validateQRToken = async (token) => {
  try {
    const session = await QRSession.findOne({ token });

    if (!session) {
      return { valid: false, error: 'Invalid QR code' };
    }

    if (new Date() > session.expiresAt) {
      return { valid: false, error: 'QR code expired. Please scan the updated code.' };
    }

    if (session.used) {
      return { valid: false, error: 'This QR code has already been used. Please scan the updated code.' };
    }

    return { valid: true, session };
  } catch (error) {
    console.error('Error validating QR token:', error);
    throw error;
  }
};

/**
 * Mark a QR token as used
 * @param {String} token - QR token to mark as used
 * @returns {Object} Updated QRSession document
 */
const markQRTokenAsUsed = async (token) => {
  try {
    const session = await QRSession.findOneAndUpdate(
      { token },
      {
        used: true,
        usedAt: new Date(),
      },
      { new: true }
    );
    return session;
  } catch (error) {
    console.error('Error marking QR token as used:', error);
    throw error;
  }
};

/**
 * Calculate hours rendered between timeIn and timeOut
 * @param {Date} timeIn - Check-in time
 * @param {Date} timeOut - Check-out time
 * @returns {Number} Hours rendered (rounded to 2 decimals)
 */
const calculateHoursRendered = (timeIn, timeOut) => {
  const milliseconds = new Date(timeOut) - new Date(timeIn);
  const hours = milliseconds / (1000 * 60 * 60);
  return parseFloat(hours.toFixed(2));
};

module.exports = {
  generateQRSession,
  validateQRToken,
  markQRTokenAsUsed,
  calculateHoursRendered,
};
