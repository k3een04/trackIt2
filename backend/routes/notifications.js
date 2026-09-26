const express = require('express');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const Notification = require('../models/Notification');

const router = express.Router();

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
    createdAt: item.createdAt || null,
    time: item.createdAt || null,
  };
}

async function listForRecipient(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const onlyUnread = String(req.query.unread || '').toLowerCase() === 'true';
    const filter = { recipientId: req.user.id };
    if (['journal', 'attendance', 'dtr', 'system'].includes(req.query.type)) {
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
    await Notification.updateMany({ recipientId: req.user.id, unread: true }, { $set: { unread: false } });
    res.status(200).json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating notifications', error: error.message });
  }
});

module.exports = router;
