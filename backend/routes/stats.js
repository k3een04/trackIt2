const express = require('express');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const User = require('../models/User');
const DTR = require('../models/DTR');
const Journal = require('../models/Journal');

const router = express.Router();

// @route   GET /api/stats/coordinator
// @desc    Get coordinator overview stats from MongoDB
// @access  Private (Coordinator only)
router.get('/coordinator', authenticateToken, authorizeRole('coordinator'), async (req, res) => {
  try {
    // Count students
    const totalStudents = await User.countDocuments({ role: 'student' });
    const activeStudents = await User.countDocuments({ role: 'student', isActive: true });
    const supervisorCount = await User.countDocuments({ role: 'supervisor' });

    // Get unique companies from students
    const companies = await User.distinct('companyName', {
      role: 'student',
      companyName: { $ne: null, $ne: '' }
    });

    // Get department breakdown
    const deptBreakdown = await User.aggregate([
      { $match: { role: 'student' } },
      { $group: { _id: '$department', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Get recent registrations (last 10 students)
    const recentRegistrations = await User.find({ role: 'student' })
      .select('fullName department companyName createdAt')
      .sort({ createdAt: -1 })
      .limit(10);

    // Get trainee list with supervisor populated (for overview section)
    const trainees = await User.find({ role: 'student' })
      .populate('supervisorId', 'fullName companyName')
      .select('fullName studentId department companyName isActive createdAt completedHours requiredHours')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: {
        stats: {
          totalStudents,
          activeStudents,
          supervisorCount,
          companyCount: companies.length,
        },
        departmentBreakdown: deptBreakdown,
        recentRegistrations,
        trainees,
      },
    });
  } catch (error) {
    console.error('Coordinator stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching coordinator stats',
    });
  }
});

// @route   GET /api/stats/coordinator/analytics
// @desc    Get coordinator analytics for charts and summary cards
// @access  Private (Coordinator only)
router.get('/coordinator/analytics', authenticateToken, authorizeRole('coordinator'), async (req, res) => {
  try {
    const students = await User.find({ role: 'student' })
      .select('_id fullName requiredHours companyName isActive')
      .lean();

    const studentIds = students.map(student => student._id);

    const hoursByTrainee = await DTR.aggregate([
      {
        $match: {
          traineeId: { $in: studentIds },
          verifiedBySupervisor: true,
          hoursRendered: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: '$traineeId',
          totalHours: { $sum: '$hoursRendered' },
        },
      },
    ]);

    const hoursMap = new Map(
      hoursByTrainee.map(item => [item._id.toString(), item.totalHours])
    );

    let completionSum = 0;
    students.forEach(student => {
      const requiredHours = student.requiredHours || 486;
      const hours = hoursMap.get(student._id.toString()) || 0;
      const rate = requiredHours > 0 ? hours / requiredHours : 0;
      completionSum += rate;
    });

    const avgCompletionRate = students.length > 0
      ? Math.round((completionSum / students.length) * 1000) / 10
      : 0;

    const topCompanyAgg = await User.aggregate([
      {
        $match: {
          role: 'student',
          isActive: true,
          companyName: { $exists: true, $ne: null, $ne: '' },
        },
      },
      {
        $group: {
          _id: '$companyName',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ]);

    const topCompany = topCompanyAgg[0] || { _id: null, count: 0 };

    const last30Days = new Date();
    last30Days.setDate(last30Days.getDate() - 30);

    const topConceptAgg = await Journal.aggregate([
      {
        $match: {
          submittedAt: { $gte: last30Days },
          concepts: { $exists: true, $ne: [] },
        },
      },
      { $unwind: '$concepts' },
      {
        $match: {
          concepts: { $ne: null, $ne: '' },
        },
      },
      {
        $group: {
          _id: '$concepts',
          count: { $sum: 1 },
          trainees: { $addToSet: '$studentId' },
        },
      },
      {
        $project: {
          count: 1,
          traineeCount: { $size: '$trainees' },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ]);

    const topConcept = topConceptAgg[0] || { _id: null, count: 0, traineeCount: 0 };

    const last90Days = new Date();
    last90Days.setDate(last90Days.getDate() - 90);
    const recentMatch = { submittedAt: { $gte: last90Days } };

    const [awaitingSupervisor, returnedToSupervisor, awaitingCoordinator, approved] = await Promise.all([
      Journal.countDocuments({
        ...recentMatch,
        supervisorSigned: false,
        $or: [
          { coordinatorRemarks: { $exists: false } },
          { coordinatorRemarks: null },
        ],
      }),
      Journal.countDocuments({
        ...recentMatch,
        supervisorSigned: false,
        coordinatorRemarks: { $exists: true, $ne: null },
      }),
      Journal.countDocuments({
        ...recentMatch,
        supervisorSigned: true,
        coordinatorApproved: false,
      }),
      Journal.countDocuments({
        ...recentMatch,
        coordinatorApproved: true,
      }),
    ]);

    const hoursByTraineeList = students.map(student => ({
      name: student.fullName,
      hours: Math.round((hoursMap.get(student._id.toString()) || 0) * 10) / 10,
    }))
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 8);

    res.status(200).json({
      success: true,
      data: {
        summary: {
          studentCount: students.length,
          avgCompletionRate,
          topCompany: {
            name: topCompany._id || 'No company data',
            count: topCompany.count || 0,
          },
          topConcept: {
            name: topConcept._id || 'No concept data',
            count: topConcept.count || 0,
            traineeCount: topConcept.traineeCount || 0,
          },
        },
        hoursByTrainee: hoursByTraineeList,
        journalStatusBreakdown: {
          awaitingSupervisor,
          returnedToSupervisor,
          awaitingCoordinator,
          approved,
        },
        journalWindowDays: 90,
        conceptWindowDays: 30,
      },
    });
  } catch (error) {
    console.error('Coordinator analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching coordinator analytics',
    });
  }
});

// @route   GET /api/stats/supervisor
// @desc    Get supervisor overview stats from MongoDB
// @access  Private (Supervisor only)
router.get('/supervisor', authenticateToken, authorizeRole('supervisor'), async (req, res) => {
  try {
    // Count assigned trainees
    const assignedTrainees = await User.countDocuments({
      role: 'student',
      supervisorId: req.user.id,
    });
    const activeAssigned = await User.countDocuments({
      role: 'student',
      supervisorId: req.user.id,
      isActive: true,
    });

    // Get trainees assigned to this supervisor
    const trainees = await User.find({
      role: 'student',
      supervisorId: req.user.id,
    }).select('_id');

    const traineeIds = trainees.map(t => t._id);

    // Count unverified DTRs for assigned trainees (DTRs awaiting supervisor verification)
    const pendingDTRsCount = await DTR.countDocuments({
      traineeId: { $in: traineeIds },
      verifiedBySupervisor: false,
      status: { $in: ['present', 'late', 'early-leave'] },
      timeIn: { $exists: true, $ne: null },
      timeOut: { $exists: true, $ne: null },
    });

    // Count unsigned journals for assigned trainees
    const pendingJournalsCount = await Journal.countDocuments({
      studentId: { $in: traineeIds },
      supervisorSigned: false,
    });

    res.status(200).json({
      success: true,
      data: {
        stats: {
          assignedTrainees,
          activeAssigned,
          pendingDTRs: pendingDTRsCount,
          pendingJournals: pendingJournalsCount,
          pendingAppraisals: 0,
        },
      },
    });
  } catch (error) {
    console.error('Supervisor stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching supervisor stats',
    });
  }
});

// @route   GET /api/supervisor/pending-actions
// @desc    Get all pending actions for supervisor (DTRs and journals to review)
// @access  Private (Supervisor only)
router.get('/pending-actions', authenticateToken, authorizeRole('supervisor'), async (req, res) => {
  try {
    // Get trainees assigned to this supervisor
    const trainees = await User.find({
      role: 'student',
      supervisorId: req.user.id,
    }).select('_id fullName');

    const traineeIds = trainees.map(t => t._id);
    const traineeMap = {};
    trainees.forEach(t => {
      traineeMap[t._id.toString()] = t.fullName;
    });

    const pendingActions = [];

    // Get pending DTRs (unverified DTRs for assigned trainees)
    const pendingDTRs = await DTR.find({
      traineeId: { $in: traineeIds },
      verifiedBySupervisor: false,
      status: { $in: ['present', 'late', 'early-leave'] },
      timeIn: { $exists: true, $ne: null },
      timeOut: { $exists: true, $ne: null },
    })
      .populate('traineeId', 'fullName')
      .sort({ date: -1 })
      .limit(10);

    pendingDTRs.forEach(dtr => {
      const date = new Date(dtr.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      pendingActions.push({
        type: 'dtr',
        id: dtr._id,
        title: 'DTR to Verify',
        trainee: dtr.traineeId.fullName,
        date: date,
        timestamp: dtr.date,
      });
    });

    // Get pending journals (unsigned journals for assigned trainees)
    const pendingJournals = await Journal.find({
      studentId: { $in: traineeIds },
      supervisorSigned: false,
    })
      .populate('studentId', 'fullName')
      .sort({ submittedAt: -1 })
      .limit(10);

    pendingJournals.forEach(journal => {
      const date = new Date(journal.submittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      pendingActions.push({
        type: 'journal',
        id: journal._id,
        title: 'Journal to Review',
        trainee: journal.studentId.fullName,
        week: journal.week,
        date: date,
        timestamp: journal.submittedAt,
      });
    });

    // Sort by most recent first
    pendingActions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.status(200).json({
      success: true,
      data: pendingActions.slice(0, 5), // Return top 5 pending actions
    });
  } catch (error) {
    console.error('Pending actions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching pending actions',
    });
  }
});

// @route   GET /api/stats/student
// @desc    Get student overview stats from MongoDB
// @access  Private (Student only)
router.get('/student', authenticateToken, authorizeRole('student'), async (req, res) => {
  try {
    // Get student profile with supervisor and company
    const student = await User.findById(req.user.id)
      .populate('supervisorId', 'fullName email companyName companyPosition signatureDataUrl')
      .populate('companyId', 'name address')
      .select('-password');

    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found',
      });
    }

    // Get verified DTR records only (verified by supervisor)
    // For this month only
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const verifiedDTRs = await DTR.find({
      traineeId: req.user.id,
      verifiedBySupervisor: true,
      date: { $gte: startOfMonth, $lte: endOfMonth }
    });

    // Calculate completed hours from verified records only
    let completedHours = 0;
    let daysPresent = 0;
    
    const uniqueDays = new Set();
    verifiedDTRs.forEach(record => {
      completedHours += record.hoursRendered || 0;
      
      // Count unique days (based on date, not including duplicates)
      const dateKey = new Date(record.date).toDateString();
      if (!uniqueDays.has(dateKey)) {
        uniqueDays.add(dateKey);
        // Count all verified days with hours rendered (present, late, etc.) - not absent
        if (record.status !== 'absent' && record.hoursRendered > 0) {
          daysPresent++;
        }
      }
    });

    // But for total completed hours, we need all-time verified records
    const allTimeVerifiedDTRs = await DTR.find({
      traineeId: req.user.id,
      verifiedBySupervisor: true,
    });

    let allTimeCompletedHours = 0;
    allTimeVerifiedDTRs.forEach(record => {
      allTimeCompletedHours += record.hoursRendered || 0;
    });

    const requiredHours = student.requiredHours || 486;
    const remainingHours = Math.max(0, requiredHours - allTimeCompletedHours);
    const progressPercentage = Math.round((allTimeCompletedHours / requiredHours) * 100);

    // Get journal submission count
    const submittedJournals = await Journal.countDocuments({
      studentId: req.user.id,
      status: { $in: ['submitted', 'reviewed'] }
    });

    // Get pending journals awaiting supervisor signature
    const pendingJournalsCount = await Journal.countDocuments({
      studentId: req.user.id,
      supervisorSigned: { $ne: true },
      status: 'submitted',
    });

    // Ensure supervisor is properly populated
    let supervisorData = student.supervisorId || null;
    if (student.supervisorId && typeof student.supervisorId === 'object' && !student.supervisorId.fullName) {
      // If supervisorId exists but wasn't properly populated, fetch it directly
      const supervisor = await User.findById(student.supervisorId, 'fullName email companyName companyPosition signatureDataUrl');
      supervisorData = supervisor;
    }

    console.log('📊 Student stats endpoint - Student:', {
      id: student._id,
      fullName: student.fullName,
      companyName: student.companyName,
      supervisorRating: student.supervisorRating,
      journalCount: submittedJournals,
      supervisorId: student.supervisorId,
      supervisor: supervisorData,
      company: student.companyId
    });

    res.status(200).json({
      success: true,
      data: {
        student: {
          id: student._id,
          fullName: student.fullName,
          email: student.email,
          studentId: student.studentId,
          department: student.department,
          companyName: student.companyName,
          isActive: student.isActive,
          createdAt: student.createdAt,
          supervisor: supervisorData,
          company: student.companyId || null,
          supervisorRating: student.supervisorRating || null,
        },
        // Calculate stats from verified DTR records
        stats: {
          completedHours: Math.round(allTimeCompletedHours * 10) / 10,
          totalRequired: requiredHours,
          daysPresent: daysPresent,
          journalSubmissions: submittedJournals,
          pendingJournals: pendingJournalsCount,
          remainingHours: remainingHours,
          progressPercentage: progressPercentage,
        },
      },
    });
  } catch (error) {
    console.error('Student stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching student stats',
    });
  }
});

module.exports = router;
