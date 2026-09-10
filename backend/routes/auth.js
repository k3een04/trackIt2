const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Generate JWT Token
const generateToken = (id, role) => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET || 'your_jwt_secret_key_here', {
    expiresIn: '7d',
  });
};

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

    // Validate role-specific required fields
    if (role === 'student') {
      if (!roleSpecificData.studentId || !roleSpecificData.department) {
        return res.status(400).json({
          success: false,
          message: 'Student role requires: studentId and department',
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

    // Create user object
    const userData = {
      fullName,
      email: email.toLowerCase(),
      password,
      role,
      ...roleSpecificData,
    };

    // Create user
    const user = await User.create(userData);

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
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

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
