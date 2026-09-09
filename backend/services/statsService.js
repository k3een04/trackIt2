/**
 * Stats Service - Calculate student stats for real-time updates
 */
const User = require('../models/User');
const DTR = require('../models/DTR');
const Journal = require('../models/Journal');

/**
 * Calculate student stats and emit real-time update
 * @param {String} traineeId - Student user ID
 * @param {Boolean} shouldEmit - Whether to emit the stats (default: true)
 * @returns {Object} Calculated stats object
 */
async function calculateAndEmitStudentStats(traineeId, shouldEmit = true) {
  try {
    // Get student profile
    const student = await User.findById(traineeId)
      .populate('supervisorId', 'fullName email companyName companyPosition')
      .populate('companyId', 'name address')
      .select('-password');

    if (!student) {
      console.error('❌ Student not found:', traineeId);
      return null;
    }

    // Get all-time verified DTR records
    const allTimeVerifiedDTRs = await DTR.find({
      traineeId: traineeId,
      verifiedBySupervisor: true,
    });

    // Calculate all-time completed hours
    let allTimeCompletedHours = 0;
    allTimeVerifiedDTRs.forEach(record => {
      allTimeCompletedHours += record.hoursRendered || 0;
    });

    // Get this month's DTR records
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const verifiedDTRs = await DTR.find({
      traineeId: traineeId,
      verifiedBySupervisor: true,
      date: { $gte: startOfMonth, $lte: endOfMonth }
    });

    // Calculate this month's stats
    let completedHours = 0;
    let daysPresent = 0;
    const uniqueDays = new Set();
    
    verifiedDTRs.forEach(record => {
      completedHours += record.hoursRendered || 0;
      
      const dateKey = new Date(record.date).toDateString();
      if (!uniqueDays.has(dateKey)) {
        uniqueDays.add(dateKey);
        if (record.status !== 'absent' && record.hoursRendered > 0) {
          daysPresent++;
        }
      }
    });

    // Get journal submission count
    const submittedJournals = await Journal.countDocuments({
      studentId: traineeId,
      status: { $in: ['submitted', 'reviewed'] }
    });

    const requiredHours = student.requiredHours || 486;
    const remainingHours = Math.max(0, requiredHours - allTimeCompletedHours);
    const progressPercentage = Math.round((allTimeCompletedHours / requiredHours) * 100);

    const stats = {
      completedHours: Math.round(allTimeCompletedHours * 10) / 10,
      totalRequired: requiredHours,
      daysPresent: daysPresent,
      pendingJournals: 0, // Can be expanded if journal review system exists
      journalSubmissions: submittedJournals,
      remainingHours: remainingHours,
      progressPercentage: progressPercentage,
    };

    console.log(`📊 Calculated stats for student ${traineeId}:`, stats);

    return stats;
  } catch (error) {
    console.error('❌ Error calculating student stats:', error);
    return null;
  }
}

module.exports = {
  calculateAndEmitStudentStats,
};
