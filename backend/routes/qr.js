const express = require('express');
const router = express.Router();
const QRSession = require('../models/QRSession');
const DTR = require('../models/DTR');
const User = require('../models/User');
const Company = require('../models/Company');
const { generateQRSession, validateQRToken, markQRTokenAsUsed, calculateHoursRendered } = require('../services/qrService');

/**
 * GET /api/qr/generate?companyName=...&supervisorId=...&traineeId=...
 * Generate current QR code for company display (shown on supervisor's screen)
 * Auto-refreshes every 5 minutes via frontend polling
 */
router.get('/generate', async (req, res) => {
  try {
    let { companyName, supervisorId, traineeId } = req.query;

    if (!companyName) {
      return res.status(400).json({
        success: false,
        error: 'companyName query parameter is required',
      });
    }

    // Convert string "undefined" to null
    if (supervisorId === 'undefined' || !supervisorId) {
      supervisorId = null;
    }
    if (traineeId === 'undefined' || !traineeId) {
      traineeId = null;
    }

    // Check if trainee already completed time in/out for today
    if (traineeId) {
      const today = new Date();
      const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

      const todayDTR = await DTR.findOne({
        traineeId: traineeId,
        date: {
          $gte: startOfDay,
          $lte: endOfDay,
        },
        timeIn: { $exists: true, $ne: null },
        timeOut: { $exists: true, $ne: null },
      });

      if (todayDTR) {
        console.log('⏹️ Trainee already completed time in/out for today:', traineeId);
        return res.status(400).json({
          success: false,
          error: 'You have already completed your time in and time out for today. No QR code can be generated.',
          alreadyTimedOut: true,
        });
      }
    }

    // Build the proper base URL from the request
    const protocol = req.protocol || 'http';
    const host = req.get('host') || 'localhost:5000';
    const baseUrl = `${protocol}://${host}`;

    // Generate QR directly using company name from user data
    console.log('📱 Generating QR for company:', { companyName, supervisorId, traineeId, baseUrl });
    
    const qrData = await generateQRSession(null, supervisorId, companyName, baseUrl, traineeId);

    res.status(200).json({
      success: true,
      data: qrData,
    });
  } catch (error) {
    console.error('Error generating QR:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate QR code',
    });
  }
});

/**
 * GET /api/qr/scan/:token
 * Called when trainee scans QR with phone camera - shows confirmation page
 * The QRSession stores the traineeId
 */
router.get('/scan/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // 1. Validate token
    const validation = await validateQRToken(token);
    if (!validation.valid) {
      return res.status(validation.error === 'Invalid QR code' ? 404 : 410).send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>QR Scan Error</title>
            <style>
              body { font-family: Arial, sans-serif; background: #0a0f1e; color: #e2e8f0; margin: 0; padding: 20px; }
              .container { max-width: 500px; margin: 100px auto; text-align: center; }
              .error { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.5); padding: 20px; border-radius: 8px; }
              h1 { color: #ef4444; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="error">
                <h1>❌ Invalid QR Code</h1>
                <p>${validation.error}</p>
              </div>
            </div>
          </body>
        </html>
      `);
    }

    const session = validation.session;
    const traineeId = session.traineeId;

    if (!traineeId) {
      return res.status(400).send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>QR Scan Error</title>
            <style>
              body { font-family: Arial, sans-serif; background: #0a0f1e; color: #e2e8f0; margin: 0; padding: 20px; }
              .container { max-width: 500px; margin: 100px auto; text-align: center; }
              .error { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.5); padding: 20px; border-radius: 8px; }
              h1 { color: #ef4444; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="error">
                <h1>❌ Error</h1>
                <p>Trainee ID not found in QR session</p>
              </div>
            </div>
          </body>
        </html>
      `);
    }

    // 2. Verify trainee exists
    const trainee = await User.findById(traineeId);
    if (!trainee || trainee.role !== 'student') {
      return res.status(404).send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>QR Scan Error</title>
            <style>
              body { font-family: Arial, sans-serif; background: #0a0f1e; color: #e2e8f0; margin: 0; padding: 20px; }
              .container { max-width: 500px; margin: 100px auto; text-align: center; }
              .error { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.5); padding: 20px; border-radius: 8px; }
              h1 { color: #ef4444; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="error">
                <h1>❌ Trainee Not Found</h1>
                <p>Invalid trainee ID</p>
              </div>
            </div>
          </body>
        </html>
      `);
    }

    // 3. Check if trainee already scanned today for Time In/Out logic
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existing = await DTR.findOne({
      traineeId,
      date: { $gte: today, $lt: tomorrow },
    });

    // Determine if this should be Time In or Time Out
    const isClockingOut = existing && existing.timeIn && !existing.timeOut;
    const action = isClockingOut ? 'Time Out' : 'Time In';

    // 4. Process the clock in/out
    let result;
    if (isClockingOut) {
      // TIME OUT
      const hoursRendered = calculateHoursRendered(existing.timeIn, new Date());
      result = await DTR.findByIdAndUpdate(
        existing._id,
        {
          timeOut: new Date(),
          hoursRendered,
          qrToken: token,
        },
        { new: true }
      );

      // Update trainee's hours
      await User.findByIdAndUpdate(traineeId, {
        $inc: {
          completedHours: hoursRendered,
          remainingHours: -hoursRendered,
        },
      });

      // 4b. Mark the QR token as used (single-use enforcement)
      await markQRTokenAsUsed(token);
    } else {
      // TIME IN
      const dtrData = {
        traineeId,
        timeIn: new Date(),
        qrToken: token,
        date: new Date(),
      };

      if (session.companyId) {
        dtrData.companyId = session.companyId;
      } else if (session.companyName) {
        dtrData.companyName = session.companyName;
      }

      result = await DTR.create(dtrData);

      // 4b. Mark the QR token as used (single-use enforcement)
      await markQRTokenAsUsed(token);

      // Real-time updates removed (Socket.io disabled for stability)
    }

    // 5. Return success page
    const hours = isClockingOut ? 
      calculateHoursRendered(existing.timeIn, new Date()).toFixed(2) : 
      'N/A';

    res.status(200).send(`
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>QR Scan Success</title>
          <style>
            body { font-family: Arial, sans-serif; background: #0a0f1e; color: #e2e8f0; margin: 0; padding: 20px; }
            .container { max-width: 500px; margin: 100px auto; text-align: center; }
            .success { background: rgba(0, 200, 170, 0.1); border: 1px solid rgba(0, 200, 170, 0.5); padding: 30px; border-radius: 8px; }
            h1 { color: #00c8aa; font-size: 36px; margin: 0; }
            .time { font-size: 48px; color: #00c8aa; font-weight: bold; margin: 20px 0; }
            .name { font-size: 18px; color: #cbd5e1; }
            .hours { font-size: 14px; color: #94a3b8; margin-top: 15px; }
            .icon { font-size: 60px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success">
              <div class="icon">✅</div>
              <h1>${action}</h1>
              <div class="time">${new Date().toLocaleTimeString()}</div>
              <div class="name">${trainee.fullName}</div>
              ${isClockingOut ? `<div class="hours">Hours Worked: ${hours}h</div>` : ''}
            </div>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error processing QR scan:', error);
    res.status(500).send(`
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>QR Scan Error</title>
          <style>
            body { font-family: Arial, sans-serif; background: #0a0f1e; color: #e2e8f0; margin: 0; padding: 20px; }
            .container { max-width: 500px; margin: 100px auto; text-align: center; }
            .error { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.5); padding: 20px; border-radius: 8px; }
            h1 { color: #ef4444; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="error">
              <h1>❌ Error</h1>
              <p>${error.message || 'Failed to process QR scan'}</p>
            </div>
          </div>
        </body>
      </html>
    `);
  }
});

/**
 * POST /api/qr/scan/:token
 * Called when trainee scans QR - logs Time In or Time Out
 */
router.post('/scan/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { traineeId, latitude, longitude, accuracy } = req.body;

    // 1. Validate token
    const validation = await validateQRToken(token);
    if (!validation.valid) {
      return res.status(validation.error === 'Invalid QR code' ? 404 : 410).json({
        success: false,
        error: validation.error,
      });
    }

    const session = validation.session;

    // 2. Verify trainee exists
    const trainee = await User.findById(traineeId);
    if (!trainee || trainee.role !== 'student') {
      return res.status(404).json({
        success: false,
        error: 'Trainee not found',
      });
    }

    // 3. Check if trainee already scanned today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existing = await DTR.findOne({
      traineeId,
      date: { $gte: today, $lt: tomorrow },
    });

    if (existing && existing.timeIn && !existing.timeOut) {
      // TIME OUT - trainee is clocking out
      const hoursRendered = calculateHoursRendered(existing.timeIn, new Date());

      const updated = await DTR.findByIdAndUpdate(
        existing._id,
        {
          timeOut: new Date(),
          hoursRendered,
          qrToken: token,
        },
        { new: true }
      );

      // Update trainee's completed and remaining hours
      await User.findByIdAndUpdate(traineeId, {
        $inc: {
          completedHours: hoursRendered,
          remainingHours: -hoursRendered,
        },
      });

      // Mark the QR token as used (single-use enforcement)
      await markQRTokenAsUsed(token);

      return res.status(200).json({
        success: true,
        message: 'Time Out recorded',
        data: {
          dtr: updated,
          hoursRendered,
        },
      });
    }

    // TIME IN - trainee is clocking in
    const dtrData = {
      traineeId,
      timeIn: new Date(),
      geoTag: {
        latitude,
        longitude,
        accuracy,
      },
      qrToken: token,
      date: new Date(),
    };

    // Use companyId if available, otherwise use companyName
    if (session.companyId) {
      dtrData.companyId = session.companyId;
    } else if (session.companyName) {
      dtrData.companyName = session.companyName;
    }

    const dtr = await DTR.create(dtrData);

    await dtr.populate('traineeId', 'fullName studentId');

    // Mark the QR token as used (single-use enforcement)
    await markQRTokenAsUsed(token);

    // Emit real-time events
    emitTimeIn(traineeId, session.companyName, dtr);
    emitQRUsed(session.companyName, token);

    // Emit updated stats via Socket.io
    await calculateAndEmitStudentStats(traineeId, true).catch(err => 
      console.error('⚠️ Error emitting stats update:', err)
    );

    res.status(201).json({
      success: true,
      message: 'Time In recorded',
      data: dtr,
    });
  } catch (error) {
    console.error('Error processing QR scan:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process QR scan',
    });
  }
});

/**
 * PUT /api/qr/verify/:dtrId
 * Supervisor verify DTR and apply digital signature
 */
router.put('/verify/:dtrId', async (req, res) => {
  try {
    const { dtrId } = req.params;
    const { supervisorId, signature, remarks } = req.body;

    const dtr = await DTR.findById(dtrId);
    if (!dtr) {
      return res.status(404).json({
        success: false,
        error: 'DTR record not found',
      });
    }

    // Verify supervisor belongs to company
    const trainee = await User.findById(dtr.traineeId);
    if (trainee.supervisorId.toString() !== supervisorId) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - not the assigned supervisor',
      });
    }

    const updated = await DTR.findByIdAndUpdate(
      dtrId,
      {
        verifiedBySupervisor: true,
        supervisorSignature: signature,
        remarks: remarks || '',
      },
      { new: true }
    ).populate('traineeId', 'fullName studentId');

    res.status(200).json({
      success: true,
      message: 'DTR verified successfully',
      data: updated,
    });
  } catch (error) {
    console.error('Error verifying DTR:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to verify DTR',
    });
  }
});

/**
 * GET /api/qr/dtr/stats/:traineeId
 * Get DTR statistics for a trainee (total hours, days worked, etc.)
 * NOTE: This route MUST come before /dtr/:traineeId to avoid route conflicts
 */
router.get('/dtr/stats/:traineeId', async (req, res) => {
  try {
    const { traineeId } = req.params;
    const { startDate, endDate } = req.query;

    let filter = { traineeId };

    if (startDate || endDate) {
      filter.date = {};
      if (startDate) {
        filter.date.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.date.$lte = new Date(endDate);
      }
    }

    const stats = await DTR.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalHours: { $sum: '$hoursRendered' },
          daysWorked: { $sum: 1 },
          averageHoursPerDay: { $avg: '$hoursRendered' },
          verifiedRecords: {
            $sum: { $cond: ['$verifiedBySupervisor', 1, 0] },
          },
        },
      },
    ]);

    const trainee = await User.findById(traineeId);

    res.status(200).json({
      success: true,
      data: {
        trainee: {
          fullName: trainee?.fullName,
          studentId: trainee?.studentId,
          requiredHours: trainee?.requiredHours || 486,
          completedHours: trainee?.completedHours || 0,
          remainingHours: trainee?.remainingHours || 486,
        },
        stats: stats[0] || {
          totalHours: 0,
          daysWorked: 0,
          averageHoursPerDay: 0,
          verifiedRecords: 0,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching DTR stats:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch DTR statistics',
    });
  }
});

/**
 * GET /api/qr/dtr/:traineeId
 * Fetch all DTR records for a trainee
 */
router.get('/dtr/:traineeId', async (req, res) => {
  try {
    const { traineeId } = req.params;
    const { startDate, endDate, limit = 30, page = 1 } = req.query;

    let filter = { traineeId };

    // Add date filtering if provided
    if (startDate || endDate) {
      filter.date = {};
      if (startDate) {
        filter.date.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.date.$lte = new Date(endDate);
      }
    }

    const skip = (page - 1) * limit;

    const records = await DTR.find(filter)
      .sort({ date: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('companyId', 'name address')
      .populate('traineeId', 'fullName studentId');

    const totalRecords = await DTR.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: records,
      pagination: {
        total: totalRecords,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(totalRecords / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching DTR records:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch DTR records',
    });
  }
});

/**
 * GET /api/qr/company/:companyId
 * Get all DTR records for employees at a specific company
 */
router.get('/company/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    const { startDate, endDate } = req.query;

    let filter = { companyId };

    if (startDate || endDate) {
      filter.date = {};
      if (startDate) {
        filter.date.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.date.$lte = new Date(endDate);
      }
    }

    const records = await DTR.find(filter)
      .sort({ date: -1, timeIn: -1 })
      .populate('traineeId', 'fullName studentId department')
      .populate('companyId', 'name');

    res.status(200).json({
      success: true,
      data: records,
    });
  } catch (error) {
    console.error('Error fetching company DTR records:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch company DTR records',
    });
  }
});

/**
 * POST /api/qr/direct/timein
 * Direct Time In without QR scanning (single device method)
 * Used by trainees who only have one device
 */
router.post('/direct/timein', async (req, res) => {
  try {
    const { traineeId, timestamp } = req.body;

    if (!traineeId) {
      return res.status(400).json({
        success: false,
        error: 'Trainee ID is required',
      });
    }

    // Verify trainee exists
    const trainee = await User.findById(traineeId);
    if (!trainee || trainee.role !== 'student') {
      return res.status(404).json({
        success: false,
        error: 'Trainee not found',
      });
    }

    // Check if trainee already has a time in for today
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

    const existing = await DTR.findOne({
      traineeId,
      date: { $gte: startOfDay, $lte: endOfDay },
    });

    if (existing && existing.timeIn && !existing.timeOut) {
      return res.status(400).json({
        success: false,
        error: 'You are already clocked in. Please clock out first.',
      });
    }

    if (existing && existing.timeIn && existing.timeOut) {
      return res.status(400).json({
        success: false,
        error: 'You have already completed your time in and time out for today.',
        alreadyTimedOut: true,
      });
    }

    // Create new DTR record for time in
    const dtrData = {
      traineeId,
      timeIn: new Date(timestamp || new Date()),
      date: new Date(),
      companyName: trainee.companyName || 'Not assigned',
      companyId: trainee.companyId,
    };

    const dtr = await DTR.create(dtrData);

    await dtr.populate('traineeId', 'fullName studentId');

    res.status(201).json({
      success: true,
      message: 'Clocked in successfully',
      data: dtr,
    });
  } catch (error) {
    console.error('Error processing direct time in:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process time in',
    });
  }
});

/**
 * POST /api/qr/direct/timeout
 * Direct Time Out without QR scanning (single device method)
 * Used by trainees who only have one device
 */
router.post('/direct/timeout', async (req, res) => {
  try {
    const { traineeId, timestamp } = req.body;

    if (!traineeId) {
      return res.status(400).json({
        success: false,
        error: 'Trainee ID is required',
      });
    }

    // Verify trainee exists
    const trainee = await User.findById(traineeId);
    if (!trainee || trainee.role !== 'student') {
      return res.status(404).json({
        success: false,
        error: 'Trainee not found',
      });
    }

    // Find today's DTR record
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

    const existing = await DTR.findOne({
      traineeId,
      date: { $gte: startOfDay, $lte: endOfDay },
      timeIn: { $exists: true, $ne: null },
      timeOut: { $exists: false },
    });

    if (!existing) {
      return res.status(400).json({
        success: false,
        error: 'No active time in record found for today. Please clock in first.',
      });
    }

    // Calculate hours rendered
    const hoursRendered = calculateHoursRendered(existing.timeIn, new Date(timestamp || new Date()));

    // Update DTR record with time out
    const updated = await DTR.findByIdAndUpdate(
      existing._id,
      {
        timeOut: new Date(timestamp || new Date()),
        hoursRendered,
      },
      { new: true }
    );

    // Update trainee's hours
    await User.findByIdAndUpdate(traineeId, {
      $inc: {
        completedHours: hoursRendered,
        remainingHours: -hoursRendered,
      },
    });

    res.status(200).json({
      success: true,
      message: 'Clocked out successfully',
      data: {
        dtr: updated,
        hoursRendered: hoursRendered.toFixed(2),
      },
    });
  } catch (error) {
    console.error('Error processing direct time out:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process time out',
    });
  }
});

module.exports = router;
