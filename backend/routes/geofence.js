const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const Company = require('../models/Company');
const DTR = require('../models/DTR');
const User = require('../models/User');
const { validateGeofence, validateSchedule, validateAttendanceWindow } = require('../services/geofencingService');

async function resolveCompanyForUser(userId) {
  const user = await User.findById(userId).select('companyId companyName role');
  if (!user) return { error: 'User not found', status: 404 };

  if (user.companyId) {
    const company = await Company.findById(user.companyId);
    if (company) return { user, company };
  }

  if (user.companyName) {
    const companyName = user.companyName.trim();
    const escapedName = companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let company = await Company.findOne({
      name: { $regex: new RegExp(`^${escapedName}$`, 'i') },
    });

    if (!company) {
      company = await Company.create({
        name: companyName,
        accreditationStatus: 'pending',
      });
    }

    user.companyId = company._id;
    await user.save();

    return { user, company };
  }

  return { error: 'Company not assigned', status: 400 };
}

/**
 * GET /api/geofence/company/current
 * Get the current supervisor's company geofence location
 */
router.get('/company/current', authenticateToken, authorizeRole('supervisor'), async (req, res) => {
  try {
    const resolved = await resolveCompanyForUser(req.user.id);
    if (resolved.error) {
      return res.status(resolved.status).json({ success: false, message: resolved.error });
    }

    const { company } = resolved;
    res.status(200).json({
      success: true,
      data: {
        companyId: company._id,
        companyName: company.name,
        geofenceLocation: company.geofenceLocation || null,
      },
    });
  } catch (error) {
    console.error('[Geofence Route] Error fetching current company geofence:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching company geofence',
      error: error.message,
    });
  }
});

/**
 * PUT /api/geofence/company/current
 * Update the current supervisor's company geofence location
 * Body: { latitude, longitude, radiusMeters }
 */
router.put('/company/current', authenticateToken, authorizeRole('supervisor'), async (req, res) => {
  try {
    const { latitude, longitude, radiusMeters } = req.body;

    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude are required',
      });
    }

    const resolved = await resolveCompanyForUser(req.user.id);
    if (resolved.error) {
      return res.status(resolved.status).json({ success: false, message: resolved.error });
    }

    const { company } = resolved;
    company.geofenceLocation = {
      latitude,
      longitude,
      radiusMeters: typeof radiusMeters === 'number' && radiusMeters > 0 ? radiusMeters : 100,
    };

    await company.save();

    res.status(200).json({
      success: true,
      message: 'Geofence location updated',
      data: {
        companyId: company._id,
        companyName: company.name,
        geofenceLocation: company.geofenceLocation,
      },
    });
  } catch (error) {
    console.error('[Geofence Route] Error updating current company geofence:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating company geofence',
      error: error.message,
    });
  }
});

/**
 * POST /api/geofence/validate
 * Validate if trainee is within company geofence and within allowed schedule
 * Body: { companyId, traineeCoordinates: { latitude, longitude, accuracy } }
 */
router.post('/validate', authenticateToken, async (req, res) => {
  try {
    const { companyId, traineeCoordinates, timezoneOffsetMinutes } = req.body;
    const traineeId = req.user.id;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: 'Company ID is required',
      });
    }

    if (!traineeCoordinates || !traineeCoordinates.latitude || !traineeCoordinates.longitude) {
      return res.status(400).json({
        success: false,
        message: 'Trainee coordinates (latitude, longitude) are required',
      });
    }

    // Get company geofence data
    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found',
      });
    }

    if (!company.geofenceLocation || !company.geofenceLocation.latitude || !company.geofenceLocation.longitude) {
      return res.status(400).json({
        success: false,
        message: 'Company geofence location not configured',

      });
    }

    // Validate geofence
    const geofenceValidation = validateGeofence(traineeCoordinates, company.geofenceLocation);

    // Get trainee's schedule (if any)
    const trainee = await User.findById(traineeId);
    let scheduleValidation = { isWithinSchedule: true, status: 'no_schedule' };
    
    if (trainee && trainee.schedule) {
      scheduleValidation = validateSchedule(new Date(), trainee.schedule, timezoneOffsetMinutes);
    }

    const attendanceWindows = trainee?.schedule
      ? {
          timeIn: validateAttendanceWindow(new Date(), trainee.schedule, 'time-in', timezoneOffsetMinutes),
          timeOut: validateAttendanceWindow(new Date(), trainee.schedule, 'time-out', timezoneOffsetMinutes),
        }
      : { timeIn: { allowed: true }, timeOut: { allowed: true } };

    // Raw supervisor-set schedule times (for showing the set time out on the DTR page)
    const scheduleTimes = trainee?.schedule?.startTime && trainee?.schedule?.endTime
      ? { startTime: trainee.schedule.startTime, endTime: trainee.schedule.endTime }
      : null;

    res.status(200).json({
      success: true,
      message: 'Geofence validation complete',
      data: {
        geofence: geofenceValidation,
        schedule: scheduleValidation,
        attendanceWindows,
        scheduleTimes,
        canTimeIn: geofenceValidation.isInRange && scheduleValidation.isWithinSchedule,
      },
    });
  } catch (error) {
    console.error('[Geofence Route] Error validating geofence:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating geofence',
      error: error.message,

    });
  }
});

/**
 * GET /api/geofence/company/:companyId
 * Get company's geofence location data
 */
router.get('/company/:companyId', authenticateToken, async (req, res) => {
  try {
    const company = await Company.findById(req.params.companyId).select('name geofenceLocation');

    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found',
      });
    }

    res.status(200).json({
      success: true,
      data: {
        companyId: company._id,
        companyName: company.name,
        geofenceLocation: company.geofenceLocation || null,
      },
    });
  } catch (error) {
    console.error('[Geofence Route] Error fetching company geofence:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching company geofence',
      error: error.message,
    });
  }
});

/**
 * POST /api/geofence/time-in
 * Record trainee time-in with geolocation
 * Body: { companyId, coordinates: { latitude, longitude, accuracy } }
 */
router.post('/time-in', authenticateToken, async (req, res) => {
  try {
    const { companyId, coordinates } = req.body;
    const traineeId = req.user.id;

    if (!companyId || !coordinates) {
      return res.status(400).json({
        success: false,
        message: 'Company ID and coordinates are required',
      });
    }

    // Validate geofence first
    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found',
      });
    }

    const geofenceValidation = validateGeofence(coordinates, company.geofenceLocation);
    if (!geofenceValidation.isInRange) {
      return res.status(400).json({
        success: false,
        message: 'Outside geofence - time-in not allowed',
        data: geofenceValidation,
      });
    }

    const trainee = await User.findById(traineeId).select('schedule');
    const attendanceWindow = validateAttendanceWindow(new Date(), trainee?.schedule, 'time-in', req.body.timezoneOffsetMinutes);
    if (!attendanceWindow.allowed) {
      return res.status(400).json({
        success: false,
        message: attendanceWindow.message,
      });
    }

    // Check if trainee already timed in today
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

    const existingDTR = await DTR.findOne({
      traineeId,
      date: { $gte: startOfDay, $lte: endOfDay },
      timeIn: { $exists: true, $ne: null },
    });

    if (existingDTR) {
      return res.status(400).json({
        success: false,
        message: 'You have already timed in today',
      });
    }

    // Create or update DTR record
    let dtr = await DTR.findOne({
      traineeId,
      date: { $gte: startOfDay, $lte: endOfDay },
    });

    if (!dtr) {
      dtr = new DTR({
        traineeId,
        companyId,
        companyName: company.name,
        date: new Date(),
      });
    }

    dtr.timeIn = new Date();
    dtr.geoTag = {
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      accuracy: coordinates.accuracy || null,
    };
    dtr.geofenceValidated = true;

    await dtr.save();

    res.status(201).json({
      success: true,
      message: 'Time-in recorded successfully',
      data: {
        dtrId: dtr._id,
        timeIn: dtr.timeIn,
        coordinates: dtr.geoTag,
      },
    });
  } catch (error) {
    console.error('[Geofence Route] Error recording time-in:', error);
    res.status(500).json({
      success: false,
      message: 'Error recording time-in',
      error: error.message,
    });
  }
});

/**
 * POST /api/geofence/time-out
 * Record trainee time-out with geolocation
 * Body: { companyId, coordinates: { latitude, longitude, accuracy } }
 */
router.post('/time-out', authenticateToken, async (req, res) => {
  try {
    const { companyId, coordinates } = req.body;
    const traineeId = req.user.id;

    if (!companyId || !coordinates) {
      return res.status(400).json({
        success: false,
        message: 'Company ID and coordinates are required',
      });
    }

    // Validate geofence
    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found',
      });
    }

    const geofenceValidation = validateGeofence(coordinates, company.geofenceLocation);
    if (!geofenceValidation.isInRange) {
      return res.status(400).json({
        success: false,
        message: 'Outside geofence - time-out not allowed',
        data: geofenceValidation,
      });
    }

    const trainee = await User.findById(traineeId).select('schedule');
    const attendanceWindow = validateAttendanceWindow(new Date(), trainee?.schedule, 'time-out', req.body.timezoneOffsetMinutes);
    if (!attendanceWindow.allowed) {
      return res.status(400).json({
        success: false,
        message: attendanceWindow.message,
      });
    }

    // Find today's DTR record
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

    const dtr = await DTR.findOne({
      traineeId,
      date: { $gte: startOfDay, $lte: endOfDay },
      timeIn: { $exists: true, $ne: null },
    });

    if (!dtr) {
      return res.status(400).json({
        success: false,
        message: 'No time-in record found for today',
      });
    }

    if (dtr.timeOut) {
      return res.status(400).json({
        success: false,
        message: 'You have already timed out today',
      });
    }

    // Calculate hours rendered
    const timeInDate = new Date(dtr.timeIn);
    const timeOutDate = new Date();
    const hoursRendered = (timeOutDate - timeInDate) / (1000 * 60 * 60);

    dtr.timeOut = timeOutDate;
    dtr.hoursRendered = Math.round(hoursRendered * 100) / 100; // Round to 2 decimal places
    dtr.geofenceValidated = true;

    await dtr.save();

    res.status(200).json({
      success: true,
      message: 'Time-out recorded successfully',
      data: {
        dtrId: dtr._id,
        timeIn: dtr.timeIn,
        timeOut: dtr.timeOut,
        hoursRendered: dtr.hoursRendered,
      },
    });
  } catch (error) {
    console.error('[Geofence Route] Error recording time-out:', error);
    res.status(500).json({
      success: false,
      message: 'Error recording time-out',
      error: error.message,
    });
  }
});

/**
 * GET /api/geofence/today-status
 * Get trainee's current DTR status for today
 */
router.get('/today-status', authenticateToken, async (req, res) => {
  try {
    const traineeId = req.user.id;
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

    const dtr = await DTR.findOne({
      traineeId,
      date: { $gte: startOfDay, $lte: endOfDay },
    });

    // Include the trainee's schedule so the client can show the expected time-out
    const trainee = await User.findById(traineeId).select('schedule');
    const schedule = trainee?.schedule?.startTime && trainee?.schedule?.endTime
      ? { startTime: trainee.schedule.startTime, endTime: trainee.schedule.endTime }
      : null;

    if (!dtr) {
      return res.status(200).json({
        success: true,
        data: {
          hasTimedIn: false,
          hasTimedOut: false,
          dtr: null,
          schedule,
        },
      });
    }

    res.status(200).json({
      success: true,
      data: {
        hasTimedIn: !!dtr.timeIn,
        hasTimedOut: !!dtr.timeOut,
        dtr: {
          dtrId: dtr._id,
          timeIn: dtr.timeIn || null,
          timeOut: dtr.timeOut || null,
          hoursRendered: dtr.hoursRendered || 0,
          geofenceValidated: dtr.geofenceValidated,
          companyName: dtr.companyName,
        },
        schedule,
      },
    });
  } catch (error) {
    console.error('[Geofence Route] Error fetching today status:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching today status',
      error: error.message,
    });
  }
});

module.exports = router;
