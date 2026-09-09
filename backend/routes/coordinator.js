const express = require('express');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const User = require('../models/User');
const DTR = require('../models/DTR');
const Journal = require('../models/Journal');

const router = express.Router();

// All routes require coordinator authentication
router.use(authenticateToken, authorizeRole('coordinator'));

// @route   GET /api/coordinator/trainees
// @desc    Get all trainees (students) with their assigned supervisor info and calculated completed hours
// @access  Private (Coordinator only)
router.get('/trainees', async (req, res) => {
  try {
    const trainees = await User.find({ role: 'student' })
      .populate('supervisorId', 'fullName email companyName companyPosition')
      .select('-password')
      .sort({ createdAt: -1 });

    // Calculate actual completed hours from verified DTR records for each trainee
    const traineesWithHours = await Promise.all(
      trainees.map(async (trainee) => {
        const traineeObj = trainee.toObject();

        // Get all verified DTR records for this trainee that have both timeIn and timeOut
        const verifiedDTRs = await DTR.find({
          traineeId: trainee._id,
          verifiedBySupervisor: true,
          timeIn: { $exists: true, $ne: null },
          timeOut: { $exists: true, $ne: null },
        });

        // Calculate total hours from verified records, only including complete records with hoursRendered
        let completedHours = 0;
        verifiedDTRs.forEach(record => {
          if (record.hoursRendered && record.hoursRendered > 0) {
            completedHours += parseFloat(record.hoursRendered) || 0;
          }
        });

        // Round to 1 decimal place to avoid floating point precision issues
        traineeObj.completedHours = Math.round(completedHours * 10) / 10;
        traineeObj.requiredHours = trainee.requiredHours || 486;
        traineeObj.remainingHours = Math.max(0, traineeObj.requiredHours - traineeObj.completedHours);

        return traineeObj;
      })
    );

    res.status(200).json({
      success: true,
      count: traineesWithHours.length,
      data: traineesWithHours,
    });
  } catch (error) {
    console.error('Coordinator trainees error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching trainees',
    });
  }
});

// @route   GET /api/coordinator/supervisors
// @desc    Get all registered supervisors for the assignment dropdown
// @access  Private (Coordinator only)
router.get('/supervisors', async (req, res) => {
  try {
    const supervisors = await User.find({ role: 'supervisor', isActive: true })
      .select('fullName email companyName companyPosition')
      .sort({ fullName: 1 });

    res.status(200).json({
      success: true,
      count: supervisors.length,
      data: supervisors,
    });
  } catch (error) {
    console.error('Coordinator supervisors error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching supervisors',
    });
  }
});

// @route   POST /api/coordinator/assign-supervisor
// @desc    Assign a supervisor to a trainee
// @access  Private (Coordinator only)
router.post('/assign-supervisor', async (req, res) => {
  try {
    const { traineeId, supervisorId } = req.body;

    // Validate required fields
    if (!traineeId || !supervisorId) {
      return res.status(400).json({
        success: false,
        message: 'Please provide both traineeId and supervisorId',
      });
    }

    // Verify trainee exists and is a student
    const trainee = await User.findById(traineeId);
    if (!trainee || trainee.role !== 'student') {
      return res.status(404).json({
        success: false,
        message: 'Trainee not found or is not a student',
      });
    }

    // Verify supervisor exists and is a supervisor
    const supervisor = await User.findById(supervisorId).populate('companyId', 'name');
    if (!supervisor || supervisor.role !== 'supervisor') {
      return res.status(404).json({
        success: false,
        message: 'Supervisor not found or is not a supervisor',
      });
    }

    // Assign supervisor to trainee
    trainee.supervisorId = supervisor._id;
    const supervisorCompanyName = supervisor.companyName || supervisor.companyId?.name;
    if (supervisorCompanyName) {
      trainee.companyName = supervisorCompanyName;
    }
    if (supervisor.companyId?._id) {
      trainee.companyId = supervisor.companyId._id;
    }
    await trainee.save();

    // Return updated trainee with populated supervisor
    const updatedTrainee = await User.findById(traineeId)
      .populate('supervisorId', 'fullName email companyName companyPosition')
      .select('-password');

    res.status(200).json({
      success: true,
      message: `Supervisor "${supervisor.fullName}" assigned to trainee "${trainee.fullName}" successfully`,
      data: updatedTrainee,
    });
  } catch (error) {
    console.error('Assign supervisor error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error assigning supervisor',
    });
  }
});

// @route   GET /api/coordinator/journals
// @desc    Get journals pending coordinator review, including new submissions awaiting supervisor signature
// @access  Private (Coordinator only)
router.get('/journals', async (req, res) => {
  try {
    // Include new submissions so coordinators can see them, but exclude journals
    // already returned to a supervisor for revision.
    const journals = await Journal.find({
      coordinatorApproved: false,
      $or: [
        { supervisorSigned: true },
        {
          supervisorSigned: false,
          coordinatorRemarks: { $exists: false },
        },
      ],
    })
      .populate('studentId', 'fullName studentId email supervisorId')
      .populate('supervisorId', 'fullName email')
      .sort({ supervisorSignedAt: -1 })
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

// @route   GET /api/coordinator/journals/approved
// @desc    Get all coordinator-approved journals
// @access  Private (Coordinator only)
router.get('/journals/approved', async (req, res) => {
  try {
    // Get all coordinator-approved journals
    const journals = await Journal.find({
      coordinatorApproved: true,
    })
      .populate('studentId', 'fullName studentId email supervisorId')
      .populate('supervisorId', 'fullName email')
      .sort({ coordinatorApprovedAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: journals.length,
      data: journals,
    });
  } catch (error) {
    console.error('Error fetching approved journals:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching approved journals',
    });
  }
});

// @route   GET /api/coordinator/journals/returned
// @desc    Get all journals that were returned to supervisor by coordinator
// @access  Private (Coordinator only)
router.get('/journals/returned', async (req, res) => {
  try {
    // Get all journals that have been returned (supervisorSigned: false but coordinatorRemarks exist from coordinator)
    const journals = await Journal.find({
      supervisorSigned: false,
      coordinatorRemarks: { $exists: true, $ne: null },
    })
      .populate('studentId', 'fullName studentId email supervisorId')
      .populate('supervisorId', 'fullName email')
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

// @route   POST /api/coordinator/journals/:journalId/approve
// @desc    Approve a supervisor-signed journal
// @access  Private (Coordinator only)
router.post('/journals/:journalId/approve', async (req, res) => {
  try {
    const { journalId } = req.params;
    const { remarks } = req.body;

    // Get the journal
    const journal = await Journal.findById(journalId);

    if (!journal) {
      return res.status(404).json({
        success: false,
        message: 'Journal not found',
      });
    }

    // Check if journal is supervisor-signed
    if (!journal.supervisorSigned) {
      return res.status(400).json({
        success: false,
        message: 'Journal must be supervisor-signed before coordinator approval',
      });
    }

    // Update journal with approval
    const updated = await Journal.findByIdAndUpdate(
      journalId,
      {
        coordinatorApproved: true,
        coordinatorApprovedAt: new Date(),
        coordinatorRemarks: remarks || null,
        status: 'reviewed',
      },
      { new: true }
    )
      .populate('studentId', 'fullName studentId email')
      .populate('supervisorId', 'fullName email');

    res.status(200).json({
      success: true,
      message: 'Journal approved successfully',
      data: updated,
    });
  } catch (error) {
    console.error('Error approving journal:', error);
    res.status(500).json({
      success: false,
      message: 'Server error approving journal',
    });
  }
});

// @route   POST /api/coordinator/journals/:journalId/reject
// @desc    Reject a supervisor-signed journal and return to supervisor for revision
// @access  Private (Coordinator only)
router.post('/journals/:journalId/reject', async (req, res) => {
  try {
    const { journalId } = req.params;
    const { remarks } = req.body;

    // Get the journal
    const journal = await Journal.findById(journalId);

    if (!journal) {
      return res.status(404).json({
        success: false,
        message: 'Journal not found',
      });
    }

    // Reset supervisor signature so supervisor can review again
    const updated = await Journal.findByIdAndUpdate(
      journalId,
      {
        supervisorSigned: false,
        supervisorSignedAt: null,
        supervisorSignature: null,
        coordinatorRemarks: remarks || 'Returned for supervisor review',
      },
      { new: true }
    )
      .populate('studentId', 'fullName studentId email')
      .populate('supervisorId', 'fullName email');

    res.status(200).json({
      success: true,
      message: 'Journal returned for supervisor review',
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

module.exports = router;
