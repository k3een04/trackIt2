const jwt = require('jsonwebtoken');

// Purpose claim used by the short-lived token issued for the
// authenticator-app verification step
const TWO_FACTOR_SETUP_PURPOSE = '2fa-setup';

// Purpose claim used by the short-lived token issued after the emailed
// password-reset code was accepted
const PASSWORD_RESET_PURPOSE = 'password-reset';

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'No token provided. Please login first.',
    });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret_key_here', (err, user) => {
    if (err) {
      return res.status(401).json({
        success: false,
        message: 'Token expired or invalid. Please login again.',
      });
    }

    // Tokens issued for the authenticator setup step must never be accepted by
    // the regular protected routes.
    if (user.purpose) {
      return res.status(401).json({
        success: false,
        message: 'This verification token can only be used to confirm your authenticator app code.',
      });
    }

    req.user = user;
    next();
  });
};

// Middleware for the authenticator-app confirmation step only
const authenticateTwoFactorToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  const reject = () => res.status(401).json({
    success: false,
    message: 'Your verification session has expired. Please sign up or sign in again.',
  });

  if (!token) {
    return reject();
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret_key_here', (err, payload) => {
    if (err || !payload || payload.purpose !== TWO_FACTOR_SETUP_PURPOSE) {
      return reject();
    }

    req.user = payload;
    next();
  });
};

// Middleware for the password-reset step only (after the emailed code checks out)
const authenticatePasswordResetToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  const reject = () => res.status(401).json({
    success: false,
    message: 'Your password reset session has expired. Request a new code and try again.',
  });

  if (!token) {
    return reject();
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret_key_here', (err, payload) => {
    if (err || !payload || payload.purpose !== PASSWORD_RESET_PURPOSE) {
      return reject();
    }

    req.user = payload;
    next();
  });
};

// Middleware to verify specific user role
const authorizeRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required role: ${roles.join(', ')}`,
      });
    }
    next();
  };
};

module.exports = {
  authenticateToken,
  authenticateTwoFactorToken,
  authenticatePasswordResetToken,
  authorizeRole,
  TWO_FACTOR_SETUP_PURPOSE,
  PASSWORD_RESET_PURPOSE,
};
