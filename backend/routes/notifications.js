const express = require('express');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const Notification = require('../models/Notification');
const { runActivityStatusSweep } = require('../services/notificationService');
const {
  calculateStudentActivityStatus,
  INACTIVITY_THRESHOLD_DAYS,
} = require('../services/activityStatusService');

const router = express.Router();

const NOTIFICATION_TYPES = ['journal', 'attendance', 'dtr', 'system', 'inactivity', 'activity'];

// Serialises the inactivity sweep inside this process. The sweep is idempotent,
// but this also stops two concurrent requests from doing the same work twice.
let sweepInFlight = null;

/**
 * Runs the attendance-derived status check for every trainee and raises the
 * coordinator notifications for any status transition. Safe to call on every
 * coordinator dashboard load: the `dedupeKey` on the notifications means each
 * inactivity event produces exactly one notification, no matter how often this
 * runs.
 */
async function runStatusSweepOnce() {
  if (!sweepInFlight) {
    sweepInFlight = runActivityStatusSweep()
      .catch(error => {
        console.error('[ActivityStatus] Sweep failed:', error.message);
        return null;
      })
      .finally(() => { sweepInFlight = null; });
  }
  return sweepInFlight;
}

function notificationShape(doc) {
  const item = doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
  if (!item) return null;
  return {
    id: String(item._id),
    type: item.type || 'system',
    title: item.title || 'Notification',
    message: item.message || 'Notification',
    text: item.message || 'Notification',
    actorName: item.actorName || '',
    refModel: item.refModel || null,
    refId: item.refId ? String(item.refId) : null,
    unread: item.unread !== false,
    read: item.unread === false,
    meta: item.meta || null,
    createdAt: item.createdAt || null,
    time: item.createdAt || null,
  };
}

async function listForRecipient(req, res) {
  try {
    // Recalculate the attendance-derived status before answering, so the bell
    // reflects anything that happened since the last visit. The sweep is
    // deduplicated, so repeated dashboard loads do not spam the coordinator.
    await runStatusSweepOnce();

    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const onlyUnread = String(req.query.unread || '').toLowerCase() === 'true';
    const filter = { recipientId: req.user.id };
    if (NOTIFICATION_TYPES.includes(req.query.type)) {
      filter.type = req.query.type;
    }
    if (onlyUnread) filter.unread = true;

    const docs = await Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    const unreadCount = await Notification.countDocuments({ recipientId: req.user.id, unread: true });

    res.status(200).json({
      success: true,
      unreadCount,
      data: docs.map(notificationShape).filter(Boolean),
    });
  } catch (error) {
    console.error('[Notifications] Error listing notifications:', error);
    res.status(500).json({ success: false, message: 'Error fetching notifications', error: error.message });
  }
}

router.get('/', authenticateToken, listForRecipient);
router.get('/supervisor', authenticateToken, authorizeRole('supervisor'), listForRecipient);
router.get('/coordinator', authenticateToken, authorizeRole('coordinator'), listForRecipient);

router.get('/unread-count', authenticateToken, async (req, res) => {
  try {
    const unreadCount = await Notification.countDocuments({ recipientId: req.user.id, unread: true });
    res.status(200).json({ success: true, unreadCount });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching unread count', error: error.message });
  }
});

router.patch('/:id/read', authenticateToken, async (req, res) => {
  try {
    const doc = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipientId: req.user.id },
      { $set: { unread: false } },
      { new: true }
    ).lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Notification not found' });
    res.status(200).json({ success: true, data: notificationShape(doc) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating notification', error: error.message });
  }
});

router.patch('/read-all', authenticateToken, async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { recipientId: req.user.id, unread: true },
      { $set: { unread: false } }
    );
    res.status(200).json({
      success: true,
      message: 'All notifications marked as read',
      updated: result.modifiedCount || 0,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating notifications', error: error.message });
  }
});

/**
 * @route   POST /api/notifications/sweep
 * @desc    Run the attendance -> consecutive missed OJT days -> status check and
 *          raise the coordinator notifications for any new transition.
 *          Idempotent: safe to call from an external scheduler (cron) as well.
 * @access  Private (Coordinator only)
 */
router.post('/sweep', authenticateToken, authorizeRole('coordinator'), async (req, res) => {
  try {
    const summary = await runStatusSweepOnce();
    if (!summary) {
      return res.status(500).json({ success: false, message: 'Activity status sweep failed' });
    }
    res.status(200).json({ success: true, data: summary });
  } catch (error) {
    console.error('[ActivityStatus] Manual sweep error:', error);
    res.status(500).json({ success: false, message: 'Error running activity status sweep', error: error.message });
  }
});

/**
 * @route   GET /api/notifications/activity-status
 * @desc    Attendance-derived ACTIVE / INACTIVE status for a trainee.
 *          - ?studentId=<id>  coordinator/supervisor reading a trainee
 *          - no parameter      a trainee reading their own status
 *          A trainee can only ever resolve their own record; the status is
 *          computed on the server from the DTR history and cannot be written by
 *          the client.
 * @access  Private
 */
router.get('/activity-status', authenticateToken, async (req, res) => {
  try {
    let targetId = req.query.studentId ? String(req.query.studentId) : req.user.id;

    // A student may only look at themselves.
    if (req.user.role === 'student' && targetId !== String(req.user.id)) {
      return res.status(403).json({
        success: false,
        message: 'You are not allowed to view another student activity status',
      });
    }

    const status = await calculateStudentActivityStatus(targetId);
    if (!status) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    res.status(200).json({
      success: true,
      data: { studentId: targetId, ...status, thresholdDays: INACTIVITY_THRESHOLD_DAYS },
    });
  } catch (error) {
    console.error('[ActivityStatus] Status lookup error:', error);
    res.status(500).json({ success: false, message: 'Error resolving activity status', error: error.message });
  }
});

module.exports = router;
