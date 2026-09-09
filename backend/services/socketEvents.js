/**
 * Emit DTR time in event
 * @param {String|ObjectId} traineeId - User ID of the trainee
 * @param {String} companyName - Company name
 * @param {Object} dtrData - DTR record data
 */
const emitTimeIn = (traineeId, companyName, dtrData) => {
  if (!global.io) {
    console.error('❌ Socket.io not initialized');
    return;
  }

  // Convert traineeId to string if it's an ObjectId
  const traineeIdStr = traineeId.toString();
  console.log(`📤 Emitting timeIn event to user_${traineeIdStr}`);

  global.io.to(`user_${traineeIdStr}`).emit('timeIn', {
    success: true,
    message: 'Time In recorded',
    data: dtrData,
    timestamp: new Date().toISOString(),
  });

  // Notify supervisor's company room
  if (companyName) {
    console.log(`📤 Emitting studentTimeIn event to company_${companyName}`);
    global.io.to(`company_${companyName}`).emit('studentTimeIn', {
      traineeId: traineeIdStr,
      companyName,
      data: dtrData,
      timestamp: new Date().toISOString(),
    });
  }

  // Notify coordinator dashboard
  console.log('📤 Broadcasting coordinatorUpdate to all coordinators');
  global.io.emit('coordinatorUpdate', {
    type: 'timeIn',
    traineeId: traineeIdStr,
    companyName,
    timestamp: new Date().toISOString(),
  });
};

/**
 * Emit DTR time out event
 * @param {String|ObjectId} traineeId - User ID of the trainee
 * @param {String} companyName - Company name
 * @param {Object} dtrData - DTR record data with hours rendered
 */
const emitTimeOut = (traineeId, companyName, dtrData, hoursRendered) => {
  if (!global.io) {
    console.error('❌ Socket.io not initialized');
    return;
  }

  // Convert traineeId to string if it's an ObjectId
  const traineeIdStr = traineeId.toString();
  console.log(`📤 Emitting timeOut event to user_${traineeIdStr} with ${hoursRendered}h worked`);

  global.io.to(`user_${traineeIdStr}`).emit('timeOut', {
    success: true,
    message: 'Time Out recorded',
    data: dtrData,
    hoursRendered,
    timestamp: new Date().toISOString(),
  });

  // Notify supervisor's company room
  if (companyName) {
    console.log(`📤 Emitting studentTimeOut event to company_${companyName}`);
    global.io.to(`company_${companyName}`).emit('studentTimeOut', {
      traineeId: traineeIdStr,
      companyName,
      data: dtrData,
      hoursRendered,
      timestamp: new Date().toISOString(),
    });
  }

  // Notify coordinator dashboard
  console.log('📤 Broadcasting coordinatorUpdate to all coordinators');
  global.io.emit('coordinatorUpdate', {
    type: 'timeOut',
    traineeId: traineeIdStr,
    companyName,
    hoursRendered,
    timestamp: new Date().toISOString(),
  });
};

/**
 * Emit QR code generated event
 * @param {String} companyName - Company name
 * @param {Object} qrData - QR code data
 */
const emitQRGenerated = (companyName, qrData) => {
  if (!global.io) {
    console.error('❌ Socket.io not initialized');
    return;
  }

  console.log(`📤 Emitting qrGenerated event to company_${companyName}`);

  global.io.to(`company_${companyName}`).emit('qrGenerated', {
    success: true,
    data: qrData,
    timestamp: new Date().toISOString(),
  });
};

/**
 * Emit QR code used/exhausted event
 * @param {String} companyName - Company name
 * @param {String} token - QR token that was used
 */
const emitQRUsed = (companyName, token) => {
  if (!global.io) {
    console.error('❌ Socket.io not initialized');
    return;
  }

  console.log(`📤 Emitting qrUsed event to company_${companyName}`);

  global.io.to(`company_${companyName}`).emit('qrUsed', {
    message: 'QR code has been scanned. A new one will be generated.',
    token,
    timestamp: new Date().toISOString(),
  });
};

/**
 * Emit DTR stats update for dashboard refresh
 * @param {String} traineeId - User ID
 * @param {Object} stats - Updated stats object
 */
const emitStatsUpdate = (traineeId, stats) => {
  if (!global.io) {
    console.error('❌ Socket.io not initialized for emitStatsUpdate');
    return;
  }

  const traineeIdStr = traineeId.toString();
  console.log(`📊 Emitting statsUpdate event to user_${traineeIdStr}:`, stats);

  global.io.to(`user_${traineeIdStr}`).emit('statsUpdate', {
    success: true,
    data: stats,
    timestamp: new Date().toISOString(),
  });
};

/**
 * Emit supervisor dashboard update
 * @param {String} companyName - Company name
 * @param {Array} dtrRecords - Updated DTR records
 */
const emitSupervisorDashboardUpdate = (companyName, dtrRecords) => {
  if (!global.io) return;

  global.io.to(`company_${companyName}`).emit('supervisorDashboardUpdate', {
    success: true,
    data: dtrRecords,
    timestamp: new Date().toISOString(),
  });
};

/**
 * Emit coordinator dashboard update
 * @param {Object} data - Update data
 */
const emitCoordinatorDashboardUpdate = (data) => {
  if (!global.io) return;

  global.io.emit('coordinatorDashboardUpdate', {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  });
};

module.exports = {
  emitTimeIn,
  emitTimeOut,
  emitQRGenerated,
  emitQRUsed,
  emitStatsUpdate,
  emitSupervisorDashboardUpdate,
  emitCoordinatorDashboardUpdate,
};
