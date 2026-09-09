/**
 * Geofencing Service
 * Handles location validation and distance calculations for attendance tracking
 */

/**
 * Calculate distance between two coordinates using Haversine formula
 * Returns distance in meters
 * @param {Number} lat1 - Latitude of point 1
 * @param {Number} lon1 - Longitude of point 1
 * @param {Number} lat2 - Latitude of point 2
 * @param {Number} lon2 - Longitude of point 2
 * @returns {Number} Distance in meters
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth's radius in meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance;
}

/**
 * Validate if trainee's current location is within company geofence
 * @param {Object} traineeCoordinates - { latitude, longitude, accuracy }
 * @param {Object} companyGeofence - { latitude, longitude, radiusMeters }
 * @returns {Object} { isInRange, distanceMeters, message }
 */
function validateGeofence(traineeCoordinates, companyGeofence) {
  if (!traineeCoordinates || !traineeCoordinates.latitude || !traineeCoordinates.longitude) {
    return {
      isInRange: false,
      distanceMeters: null,
      message: 'Unable to retrieve trainee location',
    };
  }

  if (!companyGeofence || !companyGeofence.latitude || !companyGeofence.longitude) {
    return {
      isInRange: false,
      distanceMeters: null,
      message: 'Company geofence location not configured',
    };
  }

  const distance = calculateDistance(
    traineeCoordinates.latitude,
    traineeCoordinates.longitude,
    companyGeofence.latitude,
    companyGeofence.longitude
  );

  const radiusMeters = companyGeofence.radiusMeters || 100;
  const isInRange = distance <= radiusMeters;

  return {
    isInRange,
    distanceMeters: Math.round(distance),
    radiusMeters,
    message: isInRange
      ? `Within geofence (${Math.round(distance)}m from company location)`
      : `Outside geofence (${Math.round(distance)}m from company location, allowed: ${radiusMeters}m)`,
  };
}

/**
 * Validate trainee's time against supervisor schedule
 * @param {Date} currentTime - Current time
 * @param {Object} schedule - { startTime, endTime, allowsOvertime, overtimeStartTime, overtimeEndTime }
 * @returns {Object} { isWithinSchedule, status, message }
 */
function getMinutesInClientTimezone(currentTime, timezoneOffsetMinutes) {
  const offset = Number(timezoneOffsetMinutes);
  if (!Number.isFinite(offset) || Math.abs(offset) > 840) {
    return currentTime.getHours() * 60 + currentTime.getMinutes();
  }

  const clientTime = new Date(currentTime.getTime() - offset * 60 * 1000);
  return clientTime.getUTCHours() * 60 + clientTime.getUTCMinutes();
}

function validateSchedule(currentTime, schedule, timezoneOffsetMinutes) {
  if (!schedule) {
    return {
      isWithinSchedule: true,
      status: 'no_schedule',
      message: 'No schedule configured - time tracking allowed',
    };
  }

  const timeOfDay = getMinutesInClientTimezone(currentTime, timezoneOffsetMinutes);

  // Parse schedule times (assuming HH:MM format)
  const parseTime = (timeStr) => {
    if (!timeStr) return null;
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
  };

  const startMinutes = parseTime(schedule.startTime);
  const endMinutes = parseTime(schedule.endTime);

  if (startMinutes == null || endMinutes == null) {
    return {
      isWithinSchedule: true,
      status: 'invalid_schedule',
      message: 'Schedule format invalid - time tracking allowed',
    };
  }

  // Check if within regular hours
  if (timeOfDay >= startMinutes && timeOfDay <= endMinutes) {
    return {
      isWithinSchedule: true,
      status: 'within_hours',
      message: `Within scheduled hours (${schedule.startTime} - ${schedule.endTime})`,
    };
  }

  // Check if overtime is allowed
  if (schedule.allowsOvertime) {
    const overtimeStartMinutes = parseTime(schedule.overtimeStartTime);
    const overtimeEndMinutes = parseTime(schedule.overtimeEndTime);

    if (overtimeStartMinutes && overtimeEndMinutes && timeOfDay >= overtimeStartMinutes && timeOfDay <= overtimeEndMinutes) {
      return {
        isWithinSchedule: true,
        status: 'within_overtime',
        message: `Within overtime window (${schedule.overtimeStartTime} - ${schedule.overtimeEndTime})`,
      };
    }
  }

  return {
    isWithinSchedule: false,
    status: 'outside_schedule',
    message: `Outside scheduled hours (${schedule.startTime} - ${schedule.endTime}). Overtime allowed: ${schedule.allowsOvertime}`,
  };
}

function validateAttendanceWindow(currentTime, schedule, action, timezoneOffsetMinutes) {
  if (!schedule) {
    return { allowed: true, message: 'No schedule configured - time tracking allowed' };
  }

  const parseTime = (timeStr) => {
    if (!timeStr) return null;
    const [hours, minutes] = timeStr.split(':').map(Number);
    return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
  };

  const startMinutes = parseTime(schedule.startTime);
  const endMinutes = parseTime(schedule.endTime);
  if (startMinutes == null || endMinutes == null) {
    return { allowed: true, message: 'Schedule format invalid - time tracking allowed' };
  }

  const currentMinutes = getMinutesInClientTimezone(currentTime, timezoneOffsetMinutes);
  const windowStart = action === 'time-out' ? endMinutes : startMinutes;
  const windowEnd = windowStart + 5;
  const allowed = currentMinutes >= windowStart && currentMinutes <= windowEnd;
  const label = action === 'time-out' ? 'time-out' : 'time-in';

  return {
    allowed,
    message: allowed
      ? `Within ${label} window (${String(Math.floor(windowStart / 60)).padStart(2, '0')}:${String(windowStart % 60).padStart(2, '0')} - ${String(Math.floor(windowEnd / 60)).padStart(2, '0')}:${String(windowEnd % 60).padStart(2, '0')})`
      : `Outside ${label} window. Allowed for 5 minutes from the scheduled ${label === 'time-in' ? 'start' : 'end'} time.`,
  };
}

module.exports = {
  calculateDistance,
  validateGeofence,
  validateSchedule,
  validateAttendanceWindow,
};
