const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const {
  authenticateToken,
  authenticateTwoFactorToken,
  TWO_FACTOR_SETUP_PURPOSE,
} = require('../middleware/auth');
const totpService = require('../services/totpService');
const schoolEmailService = require('../services/schoolEmailService');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_here';
const TWO_FACTOR_SETUP_TTL = '30m';

// Generate JWT Token. A "purpose" marks the short-lived token that is only
// valid for confirming the authenticator-app code.
const generateToken = (id, role, purpose) => {
  const payload = purpose ? { id, role, purpose } : { id, role };
  const expiresIn = purpose === TWO_FACTOR_SETUP_PURPOSE ? TWO_FACTOR_SETUP_TTL : '7d';

  return jwt.sign(payload, JWT_SECRET, { expiresIn });
};

// Roles that must confirm a code from their authenticator app after signing up
const TWO_FACTOR_ROLES = ['student', 'coordinator'];

// Only these role-specific fields may be written from the signup body, so a
// client can never set fields such as twoFactorEnabled or completedHours.
const ROLE_FIELDS = {
  student: ['studentId', 'department', 'section', 'companyName'],
  coordinator: ['department', 'employeeId', 'coordinatorDepartment'],
  supervisor: ['companyName', 'companyPosition', 'companyDepartment'],
};

function pickRoleFields(role, data = {}) {
  const allowed = ROLE_FIELDS[role] || [];

  return allowed.reduce((picked, field) => {
    if (data[field] !== undefined) {
      picked[field] = data[field];
    }
    return picked;
  }, {});
}

/**
 * Setup payload for an account that still has to confirm its authenticator app.
 * Reuses the stored secret so a QR code that was already scanned keeps working.
 */
async function buildTwoFactorSetupPayload(user) {
  if (!user.twoFactorSecret) {
    user.twoFactorSecret = totpService.generateSecret();
    await User.updateOne({ _id: user._id }, { $set: { twoFactorSecret: user.twoFactorSecret } });
  }

  const otpauthUrl = totpService.buildOtpauthUrl({
    secret: user.twoFactorSecret,
    accountName: user.email,
  });

  return {
    setupToken: generateToken(user._id, user.role, TWO_FACTOR_SETUP_PURPOSE),
    setupKey: user.twoFactorSecret,
    otpauthUrl,
    qrCode: await totpService.generateQrCodeDataUrl(otpauthUrl),
  };
}

// @route   POST /api/auth/register
// @desc    Register a new user
// @access  Public
router.post('/register', async (req, res) => {
  try {
    const { fullName, email, password, role, ...roleSpecificData } = req.body;

    // Validate required fields
    if (!fullName || !email || !password || !role) {
      return res.status(400).json({
        success: false,
        message: 'Please provide fullName, email, password, and role',
      });
    }

    // Check if user already exists
    const userExists = await User.findOne({ email: email.toLowerCase() });
    if (userExists) {
      return res.status(400).json({
        success: false,
        message: 'Email already registered',
      });
    }


    // Validate role
    if (!['student', 'coordinator', 'supervisor'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role. Must be: student, coordinator, or supervisor',
      });
    }

    // Students and coordinators must sign up with their STI (school) email
    if (TWO_FACTOR_ROLES.includes(role) && !schoolEmailService.isSchoolEmail(email)) {
      return res.status(400).json({
        success: false,
        message: schoolEmailService.getSchoolEmailError(),
      });
    }

    // Validate role-specific required fields
    if (role === 'student') {
      if (!roleSpecificData.studentId || !roleSpecificData.department || !roleSpecificData.section) {
        return res.status(400).json({
          success: false,
          message: 'Student role requires: studentId, department, and section',
        });
      }
      
      // Check if studentId already exists
      const studentExists = await User.findOne({ studentId: roleSpecificData.studentId });
      if (studentExists) {
        return res.status(400).json({
          success: false,
          message: 'Student ID already registered',
        });
      }
    }

    if (role === 'coordinator') {
      if (!roleSpecificData.department) {
        return res.status(400).json({
          success: false,
          message: 'Coordinator role requires: department',
        });
      }
    }

    if (role === 'supervisor') {
      if (!roleSpecificData.companyName || !roleSpecificData.companyPosition) {
        return res.status(400).json({
          success: false,
          message: 'Supervisor role requires: companyName and companyPosition',
        });
      }
    }

    // Create user object (only whitelisted role fields are written)
    const userData = {
      fullName,
      email: email.toLowerCase(),
      password,
      role,
      ...pickRoleFields(role, roleSpecificData),
    };

    // Students and coordinators confirm an authenticator-app code before the
    // account can be used
    const requiresTwoFactorSetup = TWO_FACTOR_ROLES.includes(role);
    if (requiresTwoFactorSetup) {
      userData.twoFactorSecret = totpService.generateSecret();
      userData.twoFactorPending = true;
      userData.twoFactorEnabled = false;
    }

    // Create user
    const user = await User.create(userData);

    if (requiresTwoFactorSetup) {
      const setup = await buildTwoFactorSetupPayload(user);

      return res.status(201).json({
        success: true,
        message: 'Account created. Confirm a code from your authenticator app to activate it.',
        requiresTwoFactor: true,
        account: {
          fullName: user.fullName,
          email: user.email,
          role: user.role,
        },
        ...setup,
      });
    }

    // Generate token
    const token = generateToken(user._id, user.role);

    // Return success response
    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token,
      user: {
        _id: user._id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        studentId: user.studentId,
        department: user.department,
        section: user.section,
        companyName: user.companyName,
        companyPosition: user.companyPosition,
      },
    });
  } catch (error) {
    console.error('Registration error:', error);

    // Handle validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', '),
      });
    }

    // Handle duplicate key errors
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Email already registered',
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Server error during registration',
    });
  }
});

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password',
      });
    }

    // Find user and include password field
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password +twoFactorSecret');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    // Check password
    const isPasswordMatch = await user.matchPassword(password);
    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    // Account created but the authenticator app code was never confirmed:
    // hand back a fresh setup payload so the student/coordinator can finish
    if (user.twoFactorPending && !user.twoFactorEnabled) {
      const setup = await buildTwoFactorSetupPayload(user);

      return res.status(403).json({
        success: false,
        requiresTwoFactorSetup: true,
        message: 'Your account still needs authenticator verification. Enter the code from your authenticator app to activate it.',
        account: {
          fullName: user.fullName,
          email: user.email,
          role: user.role,
        },
        ...setup,
      });
    }

    // Generate token
    const token = generateToken(user._id, user.role);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        _id: user._id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        studentId: user.studentId,
        department: user.department,
        section: user.section,
        companyName: user.companyName,
        companyPosition: user.companyPosition,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login',
    });
  }
});

// @route   POST /api/auth/verify-2fa
// @desc    Confirm a 6-digit code from the authenticator app to activate a new account
// @access  Private (two-factor setup token only)
router.post('/verify-2fa', authenticateTwoFactorToken, async (req, res) => {
  try {
    const { code } = req.body;

    const user = await User.findById(req.user.id).select('+twoFactorSecret');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Account not found. Please sign up again.',
      });
    }

    // Already confirmed (page refreshed or button pressed twice)
    if (user.twoFactorEnabled) {
      return res.status(200).json({
        success: true,
        message: 'Your authenticator app is already confirmed. You can log in now.',
      });
    }

    if (!user.twoFactorSecret) {
      return res.status(400).json({
        success: false,
        message: 'No authenticator setup was found for this account. Please sign up again.',
      });
    }

    if (!totpService.verifyCode(user.twoFactorSecret, code)) {
      return res.status(400).json({
        success: false,
        message: 'That code is not valid. Open your authenticator app, wait for the next code and try again.',
      });
    }

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          twoFactorEnabled: true,
          twoFactorPending: false,
          twoFactorVerifiedAt: new Date(),
        },
      }
    );

    res.status(200).json({
      success: true,
      message: 'Authenticator app confirmed. Your account is now active.',
    });
  } catch (error) {
    console.error('Two-factor verification error:', error);

    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', '),
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error while confirming your authenticator app',
    });
  }
});

// @route   POST /api/auth/change-password
// @desc    Change password for the authenticated user (works for all roles)
// @access  Private
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // Validate input
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide currentPassword and newPassword',
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters',
      });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        success: false,
        message: 'New password must be different from the current password',
      });
    }

    // Find user (any role) and include the password field for comparison
    const user = await User.findById(req.user.id).select('+password');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Verify the current password
    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      // 400 (not 401): the token is valid, only the supplied password is wrong.
      // The dashboards auto-logout on 401 responses.
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect',
      });
    }

    // Assign and save — the new password is hashed automatically by the pre-save hook
    user.password = newPassword;
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Password changed successfully',
    });
  } catch (error) {
    console.error('Change password error:', error);

    // Handle validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', '),
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error while changing password',
    });
  }
});

module.exports = router;
