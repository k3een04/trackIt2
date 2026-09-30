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
/**
 * Convert an absolute instant's time-of-day into the client's local
 * wall-clock minutes (0-1439).
 *
 * timezoneOffsetMinutes is minutes EAST of UTC, i.e. equivalent to
 * `-new Date().getTimezoneOffset()` in the browser:
 *   UTC+8 (Philippines)  =>  480
 *   UTC-5 (New York)     => -300
 *
 * To get the client wall clock from an instant, ADD the offset to the UTC
 * time-of-day. (Previously this subtracted the offset, which produced the
 * opposite meridian's time-of-day and broke the ±10-minute attendance window
 * for any student not in the server's own timezone.)
 */
function getMinutesInClientTimezone(currentTime, timezoneOffsetMinutes) {
  const offset = Number(timezoneOffsetMinutes);
  if (!Number.isFinite(offset) || Math.abs(offset) > 840) {
    // No valid offset supplied → best effort with the server's local time
    return currentTime.getHours() * 60 + currentTime.getMinutes();
  }

  const clientTime = new Date(currentTime.getTime() + offset * 60 * 1000);
  return clientTime.getUTCHours() * 60 + clientTime.getUTCMinutes();
}

/**
 * Seconds-of-day in the client's wall clock (0-86399). Same fallback rules as
 * getMinutesInClientTimezone, but keeps the seconds so lateness can be judged
 * against the exact punch instant instead of the whole minute.
 */
function getSecondsInClientTimezone(currentTime, timezoneOffsetMinutes) {
  const offset = Number(timezoneOffsetMinutes);
  if (!Number.isFinite(offset) || Math.abs(offset) > 840) {
    return currentTime.getHours() * 3600 + currentTime.getMinutes() * 60 + currentTime.getSeconds();
  }

  const clientTime = new Date(currentTime.getTime() + offset * 60 * 1000);
  return clientTime.getUTCHours() * 3600 + clientTime.getUTCMinutes() * 60 + clientTime.getUTCSeconds();
}

/**
 * How many seconds after the scheduled start a time-in may land before it is
 * considered LATE. 120s covers clock skew between the student's device and
 * the server plus the final seconds of the scheduled minute: a punch at
 * exactly the scheduled time (e.g. 12:20 for a 12:20 start) is ALWAYS on
 * time, while a punch more than 2 minutes after the start is LATE.
 */
const LATE_GRACE_SECONDS = 120;

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
  const label = action === 'time-out' ? 'time-out' : 'time-in';

  const formatWindowMinutes = (minutes) => {
    const wrapped = ((minutes % 1440) + 1440) % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
  };

  // LATE-BY-DESIGN: the old ±10-minute allowance is removed. Time-in stays
  // open once the scheduled start passes (any arrival after the start is a
  // valid but LATE time-in) and is only blocked while it is still before the
  // scheduled start. Lateness is judged on SECONDS against the exact punch
  // instant (plus LATE_GRACE_SECONDS of clock-skew tolerance), so punching at
  // exactly the scheduled time (12:20 for a 12:20 start) is never LATE.
  if (action === 'time-in') {
    const startSeconds = startMinutes * 60;
    const deltaSeconds = getSecondsInClientTimezone(currentTime, timezoneOffsetMinutes) - startSeconds;
    const allowed = deltaSeconds >= -60; // device/server clock-skew tolerance
    const late = deltaSeconds > LATE_GRACE_SECONDS;
    const lateMinutes = late ? Math.max(1, Math.round(deltaSeconds / 60)) : 0;
    return {
      allowed,
      late,
      lateMinutes,
      message: !allowed
        ? `Time in opens at the scheduled start (${formatWindowMinutes(startMinutes)})`
        : late
          ? `Timed in ${lateMinutes} min after the scheduled start (${formatWindowMinutes(startMinutes)})`
          : `On-time time-in (scheduled start ${formatWindowMinutes(startMinutes)})`,
    };
  }

  const windowStart = endMinutes - 10;
  const allowed = currentMinutes >= windowStart;
  return {
    allowed,
    message: allowed
      ? `Within time-out window (from ${formatWindowMinutes(windowStart)})`
      : `Time out opens 10 minutes before the scheduled end (${formatWindowMinutes(endMinutes)})`,
  };
}

module.exports = {
  calculateDistance,
  validateGeofence,
  validateSchedule,
  validateAttendanceWindow,
};
