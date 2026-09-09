const express = require('express');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const User = require('../models/User');

const router = express.Router();

// @route   GET /api/dashboard/student/:studentId
// @desc    Get student dashboard data from MongoDB
// @access  Private (Student only)
router.get('/student/:studentId', authenticateToken, authorizeRole('student'), async (req, res) => {
  try {
    const { studentId } = req.params;

    // Verify that the authenticated user is the one requesting their own data
    if (req.user.id !== studentId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this student data',
      });
    }

    // Find student user
    const student = await User.findById(studentId);
    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found',
      });
    }

    // Return student data (mock OJT data for now)
    // In a production app, you'd fetch from separate collections:
    // - AttendanceRecords
    // - JournalSubmissions
    // - DutyLogs
    // - DTRRecords
    res.status(200).json({
      success: true,
      data: {
        student: {
          id: student._id,
          fullName: student.fullName,
          email: student.email,
          studentId: student.studentId,
          department: student.department,
        },
        stats: {
          completedHours: 312,
          totalRequired: 600,
          daysPresent: 24,
          pendingJournals: 3,
          remainingHours: 288,
          progressPercentage: 52,
        },
        recentActivity: [
          {
            type: 'attendance',
            message: 'Clocked in at 8:00 AM',
            date: new Date(),
          },
          {
            type: 'journal',
            message: 'Weekly journal approved',
            date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
          {
            type: 'dutylog',
            message: 'Duty log submitted',
            date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
          },
        ],
      },
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching dashboard data',
    });
  }
});

// @route   GET /api/dashboard/profile
// @desc    Get current authenticated user profile
// @access  Private
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching profile',
    });
  }
});

// @route   PUT /api/dashboard/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { fullName, studentId, department, companyName, companyPosition, signatureDataUrl } = req.body;

    const updateData = {};
    if (fullName) updateData.fullName = fullName;
    if (studentId) updateData.studentId = studentId;
    if (department) updateData.department = department;
    if (companyName) updateData.companyName = companyName;
    if (companyPosition) updateData.companyPosition = companyPosition;

    if (signatureDataUrl) {
      if (!signatureDataUrl.startsWith('data:image/')) {
        return res.status(400).json({
          success: false,
          message: 'Signature must be an image data URL',
        });
      }

      if (signatureDataUrl.length > 1_500_000) {
        return res.status(400).json({
          success: false,
          message: 'Signature image is too large. Please upload a smaller image.',
        });
      }

      updateData.signatureDataUrl = signatureDataUrl;
    }

    const user = await User.findByIdAndUpdate(req.user.id, updateData, {
      new: true,
      runValidators: true,
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: user,
    });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating profile',
    });
  }
});

module.exports = router;
