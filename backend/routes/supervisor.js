const express = require('express');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const User = require('../models/User');
const DTR = require('../models/DTR');
const Journal = require('../models/Journal');

const router = express.Router();

// All routes require supervisor authentication
router.use(authenticateToken, authorizeRole('supervisor'));

// @route   GET /api/supervisor/trainees
// @desc    Get trainees assigned to the logged-in supervisor with verified hours
// @access  Private (Supervisor only)
router.get('/trainees', async (req, res) => {
  try {
    // Query students whose supervisorId matches the logged-in supervisor
    const trainees = await User.find({
      role: 'student',
      supervisorId: req.user.id,
    })
      .select('-password')
      .sort({ fullName: 1 });

    // Calculate verified hours for each trainee
    const traineesWithVerifiedHours = await Promise.all(
      trainees.map(async (trainee) => {
        const traineeObj = trainee.toObject();

        // Get only verified DTR records for this trainee (with both timeIn and timeOut)
        const verifiedDTRs = await DTR.find({
          traineeId: trainee._id,
          verifiedBySupervisor: true,
          timeIn: { $exists: true, $ne: null },
          timeOut: { $exists: true, $ne: null },
        });

        // Calculate total verified hours
        let verifiedHours = 0;
        verifiedDTRs.forEach(record => {
          if (record.hoursRendered && record.hoursRendered > 0) {
            verifiedHours += parseFloat(record.hoursRendered) || 0;
          }
        });

        // Round to 1 decimal place
        traineeObj.completedHours = Math.round(verifiedHours * 10) / 10;
        traineeObj.requiredHours = trainee.requiredHours || 486;
        traineeObj.remainingHours = Math.max(0, traineeObj.requiredHours - traineeObj.completedHours);

        return traineeObj;
      })
    );

    res.status(200).json({
      success: true,
      count: traineesWithVerifiedHours.length,
      data: traineesWithVerifiedHours,
    });
  } catch (error) {
    console.error('Supervisor trainees error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching assigned trainees',
    });
  }
});

// @route   GET /api/supervisor/dtr/:traineeId
// @desc    Get DTR records for a trainee in a specific month
// @access  Private (Supervisor only)
router.get('/dtr/:traineeId', async (req, res) => {
  try {
    const { traineeId } = req.params;
    const { month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({
        success: false,
        message: 'Month and year parameters are required',
      });
    }

    // Verify the trainee is assigned to this supervisor
    const trainee = await User.findById(traineeId);
    if (!trainee || trainee.supervisorId.toString() !== req.user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this trainee DTR',
      });
    }

    // Parse the month and year
    const monthNum = parseInt(month);
    const yearNum = parseInt(year);
    const startDate = new Date(yearNum, monthNum - 1, 1);
    const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59); // last day of month at end of day

    console.log('DTR Query - Trainee:', traineeId, 'Start:', startDate, 'End:', endDate);

    // Fetch DTR records for the trainee in the specified month
    const dtrRecords = await DTR.find({
      traineeId: traineeId,
      date: {
        $gte: startDate,
        $lte: endDate,
      },
    })
      .sort({ date: 1 })
      .lean();

    // Calculate summary stats
    let totalDaysPresent = 0;
    let totalHours = 0;
    let totalOvertime = 0;

    dtrRecords.forEach((record) => {
      if (record.status !== 'absent') {
        totalDaysPresent++;
        totalHours += record.hoursRendered || 0;
      }
      if (record.hoursRendered > 8) {
        totalOvertime += record.hoursRendered - 8;
      }
    });

    res.status(200).json({
      success: true,
      data: {
        records: dtrRecords,
        summary: {
          totalDaysPresent,
          totalHours: parseFloat(totalHours.toFixed(2)),
          totalOvertime: parseFloat(totalOvertime.toFixed(2)),
        },
      },
    });
  } catch (error) {
    console.error('DTR fetch error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching DTR records',
    });
  }
});

// @route   POST /api/supervisor/rate-trainee
// @desc    Give a performance rating to a trainee (0-5 stars)
// @access  Private (Supervisor only)
router.post('/rate-trainee', async (req, res) => {
  try {
    const { traineeId, rating } = req.body;

    if (!traineeId || rating === undefined) {
      return res.status(400).json({
        success: false,
        message: 'traineeId and rating are required',
      });
    }

    if (rating < 0 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 0 and 5',
      });
    }

    // Verify the trainee is assigned to this supervisor
    const trainee = await User.findById(traineeId);
    if (!trainee || trainee.supervisorId.toString() !== req.user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to rate this trainee',
      });
    }

    // Update trainee's rating
    const updated = await User.findByIdAndUpdate(
      traineeId,
      {
        supervisorRating: rating,
        supervisorRatingDate: new Date(),
      },
      { new: true }
    ).select('supervisorRating supervisorRatingDate fullName');

    res.status(200).json({
      success: true,
      message: 'Rating submitted successfully',
      data: updated,
    });
  } catch (error) {
    console.error('Error rating trainee:', error);
    res.status(500).json({
      success: false,
      message: 'Server error submitting rating',
    });
  }
});

// @route   GET /api/supervisor/journals
// @desc    Get all submitted journals from trainees assigned to this supervisor
// @access  Private (Supervisor only)
router.get('/journals', async (req, res) => {
  try {
    // Get all trainees assigned to this supervisor
    const trainees = await User.find({
      role: 'student',
      supervisorId: req.user.id,
    }).select('_id');

    const traineeIds = trainees.map(t => t._id);

    // Get all journals from these trainees
    const journals = await Journal.find({
      studentId: { $in: traineeIds },
      supervisorSigned: false, // Only show unsigned journals
    })
      .populate('studentId', 'fullName studentId email')
      .sort({ submittedAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: journals.length,
      data: journals,
    });
  } catch (error) {
    console.error('Error fetching journals:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching journals',
    });
  }
});

// @route   GET /api/supervisor/journals/signed
// @desc    Get all signed journals from trainees assigned to this supervisor
// @access  Private (Supervisor only)
router.get('/journals/signed', async (req, res) => {
  try {
    // Get all trainees assigned to this supervisor
    const trainees = await User.find({
      role: 'student',
      supervisorId: req.user.id,
    }).select('_id');

    const traineeIds = trainees.map(t => t._id);

    // Get all signed journals from these trainees
    const journals = await Journal.find({
      studentId: { $in: traineeIds },
      supervisorSigned: true, // Only signed journals
    })
      .populate('studentId', 'fullName studentId email')
      .sort({ supervisorSignedAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: journals.length,
      data: journals,
    });
  } catch (error) {
    console.error('Error fetching signed journals:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching signed journals',
    });
  }
});

// @route   GET /api/supervisor/journals/returned
// @desc    Get all returned journals from trainees assigned to this supervisor
// @access  Private (Supervisor only)
router.get('/journals/returned', async (req, res) => {
  try {
    // Get all trainees assigned to this supervisor
    const trainees = await User.find({
      role: 'student',
      supervisorId: req.user.id,
    }).select('_id');

    const traineeIds = trainees.map(t => t._id);

    // Get all returned journals from these trainees (status: draft with supervisorReview)
    const journals = await Journal.find({
      studentId: { $in: traineeIds },
      status: 'draft',
      supervisorReview: { $exists: true, $ne: null },
    })
      .populate('studentId', 'fullName studentId email')
      .sort({ submittedAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: journals.length,
      data: journals,
    });
  } catch (error) {
    console.error('Error fetching returned journals:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching returned journals',
    });
  }
});

// @route   POST /api/supervisor/journals/:journalId/sign
// @desc    Sign a journal entry and add supervisor remarks
// @access  Private (Supervisor only)
router.post('/journals/:journalId/sign', async (req, res) => {
  try {
    const { journalId } = req.params;
    const { remarks } = req.body;

    // Get the journal
    const journal = await Journal.findById(journalId).populate('studentId', 'supervisorId');

    if (!journal) {
      return res.status(404).json({
        success: false,
        message: 'Journal not found',
      });
    }

    // Verify trainee is assigned to this supervisor
    if (journal.studentId.supervisorId.toString() !== req.user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to sign this journal',
      });
    }

    // Resolve supervisor profile for e-signature snapshot
    const supervisorProfile = await User.findById(req.user.id).select('fullName signatureDataUrl');
    const signatureSnapshot = supervisorProfile?.signatureDataUrl
      || `Verified by ${req.user.fullName} on ${new Date().toLocaleString()}`;

    // Update journal with signature
    const updated = await Journal.findByIdAndUpdate(
      journalId,
      {
        status: 'reviewed',
        supervisorSigned: true,
        supervisorSignedAt: new Date(),
        supervisorSignature: signatureSnapshot,
        supervisorReview: remarks || null,
      },
      { new: true }
    ).populate('studentId', 'fullName studentId email');

    res.status(200).json({
      success: true,
      message: 'Journal signed successfully',
      data: updated,
    });
  } catch (error) {
    console.error('Error signing journal:', error);
    res.status(500).json({
      success: false,
      message: 'Server error signing journal',
    });
  }
});

// @route   POST /api/supervisor/journals/:journalId/reject
// @desc    Return a journal for revision
// @access  Private (Supervisor only)
router.post('/journals/:journalId/reject', async (req, res) => {
  try {
    const { journalId } = req.params;
    const { remarks } = req.body;

    // Get the journal
    const journal = await Journal.findById(journalId).populate('studentId', 'supervisorId');

    if (!journal) {
      return res.status(404).json({
        success: false,
        message: 'Journal not found',
      });
    }

    // Verify trainee is assigned to this supervisor
    if (journal.studentId.supervisorId.toString() !== req.user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to reject this journal',
      });
    }

    // Update journal status back to draft with rejection remarks
    const updated = await Journal.findByIdAndUpdate(
      journalId,
      {
        status: 'draft',
        supervisorSigned: false,
        supervisorReview: remarks || 'Returned for revision',
      },
      { new: true }
    ).populate('studentId', 'fullName studentId email');

    res.status(200).json({
      success: true,
      message: 'Journal returned for revision',
      data: updated,
    });
  } catch (error) {
    console.error('Error rejecting journal:', error);
    res.status(500).json({
      success: false,
      message: 'Server error rejecting journal',
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// SCHEDULE MANAGEMENT (NEW - For Geofencing)
// ──────────────────────────────────────────────────────────────────────────

/**
 * POST /api/supervisor/schedule/set
 * Set work schedule for a trainee (time in, time out, overtime settings)
 */
router.post('/schedule/set', async (req, res) => {
  try {
    console.log('[Schedule Set] Request received');
    console.log('[Schedule Set] User ID:', req.user?.id);
    console.log('[Schedule Set] User Role:', req.user?.role);
    console.log('[Schedule Set] Body:', req.body);

    const { traineeId, startTime, endTime, allowsOvertime, overtimeStartTime, overtimeEndTime } = req.body;

    if (!traineeId) {
      console.log('[Schedule Set] Error: No traineeId provided');
      return res.status(400).json({
        success: false,
        message: 'traineeId is required',
      });
    }

    // Validate trainee assignment
    const trainee = await User.findById(traineeId);
    console.log('[Schedule Set] Trainee found:', !!trainee);
    if (trainee) {
      console.log('[Schedule Set] Trainee supervisorId:', trainee.supervisorId);
      console.log('[Schedule Set] Current user ID:', req.user.id);
      console.log('[Schedule Set] Match:', trainee.supervisorId.toString() === req.user.id.toString());
    }

    if (!trainee || trainee.supervisorId.toString() !== req.user.id.toString()) {
      console.log('[Schedule Set] Error: Trainee not found or not assigned to supervisor');
      return res.status(403).json({
        success: false,
        message: 'Not authorized to set schedule for this trainee',
      });
    }

    // Validate time format (HH:MM)
    const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      console.log('[Schedule Set] Error: Invalid time format');
      return res.status(400).json({
        success: false,
        message: 'Invalid time format. Use HH:MM (24-hour format)',
      });
    }

    if (allowsOvertime && (!overtimeStartTime || !overtimeEndTime)) {
      console.log('[Schedule Set] Error: Overtime enabled but times missing');
      return res.status(400).json({
        success: false,
        message: 'Overtime start and end times are required when overtime is enabled',
      });
    }

    if (allowsOvertime && (!timeRegex.test(overtimeStartTime) || !timeRegex.test(overtimeEndTime))) {
      console.log('[Schedule Set] Error: Invalid overtime time format');
      return res.status(400).json({
        success: false,
        message: 'Invalid overtime time format. Use HH:MM (24-hour format)',
      });
    }

    // Update trainee schedule
    trainee.schedule = {
      startTime,
      endTime,
      allowsOvertime: allowsOvertime || false,
      overtimeStartTime: overtimeStartTime || null,
      overtimeEndTime: overtimeEndTime || null,
      scheduleSetAt: new Date(),
    };

    await trainee.save();
    console.log('[Schedule Set] Schedule saved successfully');

    res.status(200).json({
      success: true,
      message: 'Schedule set successfully',
      data: trainee.schedule,
    });
  } catch (error) {
    console.error('[Schedule] Error setting schedule:', error);
    res.status(500).json({
      success: false,
      message: 'Error setting schedule',
      error: error.message,
    });
  }
});

/**
 * GET /api/supervisor/schedule/:traineeId
 * Get work schedule for a trainee
 */
router.get('/schedule/:traineeId', async (req, res) => {
  try {
    const { traineeId } = req.params;

    const trainee = await User.findById(traineeId);
    if (!trainee || trainee.supervisorId.toString() !== req.user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this trainee schedule',
      });
    }

    res.status(200).json({
      success: true,
      data: {
        traineeId: trainee._id,
        fullName: trainee.fullName,
        schedule: trainee.schedule || null,
      },
    });
  } catch (error) {
    console.error('[Schedule] Error fetching schedule:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching schedule',
      error: error.message,
    });
  }
});

/**
 * DELETE /api/supervisor/schedule/:traineeId
 * Clear schedule for a trainee
 */
router.delete('/schedule/:traineeId', async (req, res) => {
  try {
    const { traineeId } = req.params;

    const trainee = await User.findById(traineeId);
    if (!trainee || trainee.supervisorId.toString() !== req.user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete schedule for this trainee',
      });
    }

    trainee.schedule = null;
    await trainee.save();

    res.status(200).json({
      success: true,
      message: 'Schedule cleared successfully',
    });
  } catch (error) {
    console.error('[Schedule] Error clearing schedule:', error);
    res.status(500).json({
      success: false,
      message: 'Error clearing schedule',
      error: error.message,
    });
  }
});

module.exports = router;
