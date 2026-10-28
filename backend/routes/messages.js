const express = require('express');
const mongoose = require('mongoose');
const { authenticateToken } = require('../middleware/auth');
const Message = require('../models/Message');
const User = require('../models/User');

const router = express.Router();

const ROLE_LABELS = {
  student: 'Trainee',
  supervisor: 'Supervisor',
  coordinator: 'Coordinator',
};

const CONTACT_FIELDS = [
  'fullName',
  'email',
  'role',
  'studentId',
  'companyName',
  'department',
  'coordinatorDepartment',
  'companyDepartment',
  'companyPosition',
].join(' ');

const MAX_BODY_LENGTH = 2000;
const CONTACT_LIMIT = 1000;
const THREAD_LIMIT = 200;

function contactShape(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    fullName: doc.fullName || 'Unnamed user',
    role: doc.role || 'student',
    roleLabel: ROLE_LABELS[doc.role] || 'User',
    studentId: doc.studentId || '',
    companyName: doc.companyName || '',
    position: doc.companyPosition || '',
    department:
      doc.department || doc.coordinatorDepartment || doc.companyDepartment || '',
    email: doc.email || '',
  };
}

function messageShape(doc, viewerId) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    senderId: String(doc.senderId),
    recipientId: String(doc.recipientId),
    body: doc.body || '',
    mine: String(doc.senderId) === String(viewerId),
    readAt: doc.readAt || null,
    createdAt: doc.createdAt || null,
  };
}

function dedupeById(users) {
  const seen = new Set();
  const out = [];
  for (const user of users) {
    const id = String(user._id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(user);
  }
  return out;
}

/**
 * Everyone the given user is allowed to start a conversation with.
 *
 * - trainee      -> assigned supervisor + coordinators
 * - supervisor   -> their own trainees + coordinators
 * - coordinator  -> every active user
 */
async function listAllowedContacts(user) {
  const active = { isActive: { $ne: false } };

  if (user.role === 'coordinator') {
    return User.find({ ...active, _id: { $ne: user.id } })
      .select(CONTACT_FIELDS)
      .sort({ role: 1, fullName: 1 })
      .limit(CONTACT_LIMIT)
      .lean();
  }

  if (user.role === 'supervisor') {
    const [trainees, coordinators] = await Promise.all([
      User.find({ ...active, role: 'student', supervisorId: user.id })
        .select(CONTACT_FIELDS)
        .sort({ fullName: 1 })
        .lean(),
      User.find({ ...active, role: 'coordinator' })
        .select(CONTACT_FIELDS)
        .sort({ fullName: 1 })
        .lean(),
    ]);
    return dedupeById([...trainees, ...coordinators]);
  }

  // Trainee: the supervisor they are actually assigned to, plus coordinators.
  const [me, coordinators] = await Promise.all([
    User.findById(user.id).select('supervisorId').lean(),
    User.find({ ...active, role: 'coordinator' })
      .select(CONTACT_FIELDS)
      .sort({ fullName: 1 })
      .lean(),
  ]);

  let supervisor = [];
  if (me && me.supervisorId) {
    const found = await User.findOne({ _id: me.supervisorId, ...active })
      .select(CONTACT_FIELDS)
      .lean();
    if (found) supervisor = [found];
  }

  return dedupeById([...supervisor, ...coordinators]);
}

/**
 * Resolve and authorise a recipient. Returns the recipient document, or
 * `null` when the pair is not allowed (the caller answers 403/404).
 */
async function resolveRecipient(user, otherId) {
  if (!mongoose.isValidObjectId(otherId)) return null;
  if (String(user.id) === String(otherId)) return null;

  const other = await User.findById(otherId).select(`${CONTACT_FIELDS} isActive`).lean();
  if (!other || other.isActive === false) return null;

  if (user.role === 'coordinator') return other;

  if (user.role === 'supervisor') {
    if (other.role === 'coordinator') return other;
    if (other.role !== 'student') return null;
    const student = await User.findById(otherId).select('supervisorId').lean();
    return String(student && student.supervisorId ? student.supervisorId : '') ===
      String(user.id)
      ? other
      : null;
  }

  // Trainee
  if (other.role === 'coordinator') return other;
  if (other.role !== 'supervisor') return null;
  const me = await User.findById(user.id).select('supervisorId').lean();
  return String(me && me.supervisorId ? me.supervisorId : '') === String(otherId)
    ? other
    : null;
}

/**
 * GET /api/messages/contacts
 * Inbox for the sidebar messenger: allowed contacts, unread counts and a
 * preview of the last message in each conversation.
 */
router.get('/contacts', authenticateToken, async (req, res) => {
  try {
    const viewerId = new mongoose.Types.ObjectId(req.user.id);

    const [contacts, unreadRows, recent] = await Promise.all([
      listAllowedContacts(req.user),
      Message.aggregate([
        { $match: { recipientId: viewerId, readAt: null } },
        { $group: { _id: '$senderId', count: { $sum: 1 } } },
      ]),
      Message.find({ $or: [{ senderId: viewerId }, { recipientId: viewerId }] })
        .sort({ createdAt: -1 })
        .limit(CONTACT_LIMIT)
        .select('senderId recipientId body createdAt')
        .lean(),
    ]);

    const unreadBySender = new Map(
      unreadRows.map((row) => [String(row._id), row.count])
    );

    const allowedIds = new Set(contacts.map((contact) => String(contact._id)));
    const unreadTotal = unreadRows
      .filter((row) => allowedIds.has(String(row._id)))
      .reduce((sum, row) => sum + row.count, 0);

    const lastByContact = new Map();
    for (const message of recent) {
      const otherId =
        String(message.senderId) === String(viewerId)
          ? String(message.recipientId)
          : String(message.senderId);
      if (!lastByContact.has(otherId)) lastByContact.set(otherId, message);
    }

    const data = contacts
      .map((contact) => {
        const id = String(contact._id);
        const last = lastByContact.get(id);
        return {
          ...contactShape(contact),
          unread: unreadBySender.get(id) || 0,
          lastMessage: last ? last.body : '',
          lastMessageMine: last ? String(last.senderId) === String(viewerId) : false,
          lastMessageAt: last ? last.createdAt : null,
        };
      })
      .sort((a, b) => {
        if (b.unread !== a.unread) return b.unread - a.unread;
        const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
        const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
        if (bTime !== aTime) return bTime - aTime;
        return a.fullName.localeCompare(b.fullName);
      });

    res.status(200).json({
      success: true,
      unreadTotal,
      data,
    });
  } catch (error) {
    console.error('[Messages] Error listing contacts:', error);
    res.status(500).json({
      success: false,
      message: 'Could not load your conversations',
      error: error.message,
    });
  }
});

/**
 * GET /api/messages/unread-count
 * Cheap endpoint for the launcher badge while the panel is closed.
 */
router.get('/unread-count', authenticateToken, async (req, res) => {
  try {
    // Only count senders the user can still open a thread with, so the badge
    // can never show a conversation that is no longer reachable.
    const contacts = await listAllowedContacts(req.user);
    const ids = contacts.map((contact) => contact._id);
    const unreadTotal = ids.length
      ? await Message.countDocuments({
          recipientId: req.user.id,
          readAt: null,
          senderId: { $in: ids },
        })
      : 0;
    res.status(200).json({ success: true, unreadTotal });
  } catch (error) {
    console.error('[Messages] Error counting unread messages:', error);
    res.status(500).json({
      success: false,
      message: 'Could not count unread messages',
      error: error.message,
    });
  }
});

/**
 * GET /api/messages/:userId
 * Full conversation with one person, oldest first. Opening it marks every
 * message they sent as read.
 */
router.get('/:userId', authenticateToken, async (req, res) => {
  try {
    const recipient = await resolveRecipient(req.user, req.params.userId);
    if (!recipient) {
      return res.status(403).json({
        success: false,
        message: 'You are not allowed to message this user',
      });
    }

    const viewerId = new mongoose.Types.ObjectId(req.user.id);
    const otherId = new mongoose.Types.ObjectId(recipient._id);

    await Message.updateMany(
      { senderId: otherId, recipientId: viewerId, readAt: null },
      { $set: { readAt: new Date() } }
    );

    const docs = await Message.find({
      $or: [
        { senderId: viewerId, recipientId: otherId },
        { senderId: otherId, recipientId: viewerId },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(THREAD_LIMIT)
      .lean();

    docs.reverse();

    res.status(200).json({
      success: true,
      contact: contactShape(recipient),
      data: docs.map((doc) => messageShape(doc, req.user.id)),
    });
  } catch (error) {
    console.error('[Messages] Error loading thread:', error);
    res.status(500).json({
      success: false,
      message: 'Could not load this conversation',
      error: error.message,
    });
  }
});

/**
 * POST /api/messages/:userId
 * Send one message. Body: { body: "..." }
 */
router.post('/:userId', authenticateToken, async (req, res) => {
  try {
    const recipient = await resolveRecipient(req.user, req.params.userId);
    if (!recipient) {
      return res.status(403).json({
        success: false,
        message: 'You are not allowed to message this user',
      });
    }

    const body = String(
      (req.body && (req.body.body || req.body.message || req.body.text)) || ''
    )
      .replace(/\r\n/g, '\n')
      .trim();

    if (!body) {
      return res.status(400).json({ success: false, message: 'Message cannot be empty' });
    }
    if (body.length > MAX_BODY_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `A message cannot be longer than ${MAX_BODY_LENGTH} characters`,
      });
    }

    const doc = await Message.create({
      senderId: req.user.id,
      senderRole: req.user.role,
      recipientId: recipient._id,
      recipientRole: recipient.role,
      body,
    });

    const shaped = messageShape(doc.toObject(), req.user.id);

    // Real-time delivery is optional: the dashboard falls back to polling when
    // the Socket.IO server is not running.
    try {
      if (global.io) {
        const sender = await User.findById(req.user.id).select('fullName').lean();
        global.io.to(`user_${recipient._id}`).emit('message:new', {
          ...shaped,
          senderName: sender ? sender.fullName : '',
        });
      }
    } catch (emitError) {
      console.error('[Messages] Socket emit failed:', emitError.message);
    }

    res.status(201).json({ success: true, data: shaped });
  } catch (error) {
    console.error('[Messages] Error sending message:', error);
    res.status(500).json({
      success: false,
      message: 'Could not send your message',
      error: error.message,
    });
  }
});

module.exports = router;
