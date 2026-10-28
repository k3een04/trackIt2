/**
 * TrackIT — Sidebar messenger
 * ---------------------------------------------------------------------------
 * Adds a Messages button to the bottom of the dashboard sidebar. Clicking it
 * opens a popup with the allowed contacts for the signed-in role and the
 * one-to-one conversation with the selected person.
 *
 * The module is shared by the OJT, supervisor and coordinator dashboards and
 * talks to /api/messages. It polls while the panel is open, and only polls the
 * unread count while it is closed, so it stays quiet in the background.
 *
 * This version includes:
 * - Optimized polling intervals (typing: 1s, contacts: 3s)
 * - WebSocket support for real-time message and typing events
 * - Immediate recipient notification for new messages
 * - Reduced latency for typing indicators
 */
 (function () {
   'use strict';

   const API_BASE =
     (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') &&
     window.location.port !== '5000' &&
     window.location.port !== ''
       ? 'http://localhost:5000/api'
       : '/api';

   const token = localStorage.getItem('trackit_token') || window.authToken || '';

   let user = null;
   try {
     user = JSON.parse(localStorage.getItem('trackit_user') || 'null');
   } catch (error) {
     user = null;
   }
   if (!user && window.currentUser) user = window.currentUser;

   const ALLOWED_ROLES = ['student', 'supervisor', 'coordinator'];
   if (!token || !user || !ALLOWED_ROLES.includes(user.role)) return;

   const state = {
     open: false,
     view: 'list',
     contacts: [],
     contactsSignature: '',
     activeId: null,
     activeContact: null,
     activeLastMessageAt: null,
     messages: [],
     search: '',
     unreadTotal: 0,
     loadingContacts: false,
     loadingThread: false,
     sending: false,
     status: '',
     forceScroll: false,
     otherTyping: false,
     contactsView: '',
     contactsStatus: 0,
     socketConnected: false,
   };

   const els = {
     panel: null,
     listView: null,
     threadView: null,
     contacts: null,
     search: null,
     headerBadge: null,
     thread: null,
     threadName: null,
     threadSub: null,
     threadAvatar: null,
     composer: null,
     input: null,
     send: null,
     status: null,
     launchers: [],
     launcherBadges: [],
   };

   let contactsTimer = null;
   let badgeTimer = null;
   let typingTimer = null;
   let typingStopTimer = null;
   let typingSentAt = 0;
   let typingAnnouncedFor = null;
   let typingCheckInFlight = false;
   let socket = null;
   let socketRetryTimer = null;

   // ── WebSocket connection management ───────────────────────────────────────

   function connectSocket() {
     if (socket && socket.connected) return;

     // Use the same API base for WebSocket connection
     const wsUrl = API_BASE.replace('/api', '') + '/socket.io';
     socket = io(wsUrl, {
       auth: { token },
       transports: ['websocket', 'polling'],
       reconnection: true,
       reconnectionDelay: 1000,
       reconnectionAttempts: 10,
     });

     socket.on('connect', () => {
       console.log('[Messenger] WebSocket connected');
       state.socketConnected = true;
       if (socketRetryTimer) {
         clearTimeout(socketRetryTimer);
         socketRetryTimer = null;
       }

       // Subscribe to user's personal room
       socket.emit('join', { userId: user.id });
     });

     socket.on('disconnect', (reason) => {
       console.log('[Messenger] WebSocket disconnected:', reason);
       state.socketConnected = false;
       if (reason === 'io server disconnect') {
         // Server initiated disconnect, reconnect immediately
         socket.connect();
       }
     });

     socket.on('connect_error', (error) => {
       console.error('[Messenger] WebSocket connection error:', error);
       state.socketConnected = false;
     });

     socket.on('reconnect', (attempt) => {
       console.log('[Messenger] WebSocket reconnected (attempt', attempt, ')');
       state.socketConnected = true;
       // Re-subscribe on reconnection
       socket.emit('join', { userId: user.id });
     });

     // Message received event
     socket.on('message:new', (data) => {
       console.log('[Messenger] Message received via WebSocket:', data);
       handleIncomingMessage(data);
     });

     // Typing event
     socket.on('typing:update', (data) => {
       console.log('[Messenger] Typing update via WebSocket:', data);
       if (state.activeId === data.recipientId && data.typing !== state.otherTyping) {
         setOtherTyping(data.typing);
       }
     });

     socket.on('error', (error) => {
       console.error('[Messenger] WebSocket error:', error);
     });

     socket.onAny((event, ...args) => {
       console.log('[Messenger] WebSocket event:', event, args);
     });
   }

   function disconnectSocket() {
     if (socket) {
       socket.disconnect();
       socket = null;
       state.socketConnected = false;
     }
     if (socketRetryTimer) {
       clearTimeout(socketRetryTimer);
       socketRetryTimer = null;
     }
   }

   // ── Helper functions ────────────────────────────────────────────────────

   function escapeHtml(value) {
     if (value === null || value === undefined) return '';
     return String(value)
       .replace(/&/g, '&amp;')
       .replace(/</g, '&lt;')
       .replace(/>/g, '&gt;')
       .replace(/"/g, '&quot;')
       .replace(/'/g, '&#039;');
   }

   function initials(name) {
     const parts = String(name || '')
       .trim()
       .split(/\s+/)
       .filter(Boolean);
     if (!parts.length) return '?';
     const first = parts[0].charAt(0);
     const second = parts.length > 1 ? parts[1].charAt(0) : parts[0].charAt(1) || '';
     return (first + second).toUpperCase();
   }

   function avatarInner(contact) {
     const picture = contact && contact.profilePictureDataUrl;
     if (picture) {
       return `<img class="avatar-img" src="${escapeHtml(picture)}" alt="">`;
     }
     return escapeHtml(initials(contact && contact.fullName));
   }

   function asDate(value) {
     const date = value ? new Date(value) : null;
     return date && !Number.isNaN(date.getTime()) ? date : null;
   }

   function isSameDay(a, b) {
     return (
       a.getFullYear() === b.getFullYear() &&
       a.getMonth() === b.getMonth() &&
       a.getDate() === b.getDate()
     );
   }

   function formatTime(value) {
     const date = asDate(value);
     if (!date) return '';
     return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
   }

   function formatContactTime(value) {
     const date = asDate(value);
     if (!date) return '';
     const now = new Date();
     if (isSameDay(date, now)) return formatTime(date);
     const yesterday = new Date(now);
     yesterday.setDate(now.getDate() - 1);
     if (isSameDay(date, yesterday)) return 'Yesterday';
     if (date.getFullYear() === now.getFullYear()) {
       return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
     }
     return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
   }

   function dayLabel(value) {
     const date = asDate(value);
     if (!date) return '';
     const now = new Date();
     if (isSameDay(date, now)) return 'Today';
     const yesterday = new Date(now);
     yesterday.setDate(now.getDate() - 1);
     if (isSameDay(date, yesterday)) return 'Yesterday';
     return date.toLocaleDateString([], {
       month: 'short',
       day: 'numeric',
       year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
     });
   }

   function scrollToBottom() {
     if (!els.thread) return;
     els.thread.scrollTop = els.thread.scrollHeight;
   }

   function isNearBottom() {
     if (!els.thread) return true;
     return els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight < 80;
   }

   function setStatus(message) {
     state.status = message || '';
     if (!els.status) return;
     if (state.status) {
       els.status.textContent = state.status;
       els.status.hidden = false;
     } else {
       els.status.textContent = '';
       els.status.hidden = true;
     }
   }

   // ── Typing indicator ─────────────────────────────────────────────────────

   function typingIndicatorHtml() {
     return (
       '<div class="tk-msg-typing" role="status" aria-live="polite">' +
       '<span class="tk-msg-typing__bubble" aria-hidden="true"><span></span><span></span><span></span></span>' +
       '<span class="tk-msg-typing__label">typing…</span>' +
       '</div>'
     );
   }

   function setContactTyping(contactId, typing) {
     if (!contactId) return;
     let changed = false;
     state.contacts = state.contacts.map((contact) => {
       if (String(contact.id) !== String(contactId)) return contact;
       if (Boolean(contact.typing) === Boolean(typing)) return contact;
       changed = true;
       return { ...contact, typing: Boolean(typing) };
     });
     if (changed) renderContacts();
   }

   function setOtherTyping(value) {
     const next = Boolean(value);
     if (state.otherTyping === next) return;
     state.otherTyping = next;
     setContactTyping(state.activeId, next);
     if (state.activeContact) setThreadHeader(state.activeContact);
     if (state.view === 'thread') {
       const stick = isNearBottom();
       renderThread();
       if (stick) scrollToBottom();
     }
   }

   function stopTyping() {
     if (typingStopTimer) {
       clearTimeout(typingStopTimer);
       typingStopTimer = null;
     }
     const contactId = typingAnnouncedFor;
     typingAnnouncedFor = null;
     typingSentAt = 0;
     if (!contactId) return;

     // Stop typing via API (for backward compatibility)
     api(`/messages/${encodeURIComponent(contactId)}/typing`, {
       method: 'POST',
       body: JSON.stringify({ typing: false }),
     });

     // Stop typing via WebSocket if connected
     if (socket && socket.connected) {
       socket.emit('typing:stop', { recipientId: contactId, typerId: user.id });
     }
   }

   function noteTyping() {
     if (!state.open || state.view !== 'thread' || !state.activeId) return;

     const text = els.input ? els.input.value : '';
     if (!text.trim()) {
       stopTyping();
       return;
     }

     const contactId = state.activeId;
     const now = Date.now();
     if (typingAnnouncedFor !== contactId || now - typingSentAt >= 2500) {
       typingAnnouncedFor = contactId;
       typingSentAt = now;

       // Announce typing via API (for backward compatibility)
       api(`/messages/${encodeURIComponent(contactId)}/typing`, {
         method: 'POST',
         body: JSON.stringify({ typing: true }),
       });

       // Announce typing via WebSocket if connected
       if (socket && socket.connected) {
         socket.emit('typing:start', { recipientId: contactId, typerId: user.id });
       }
     }

     if (typingStopTimer) clearTimeout(typingStopTimer);
     typingStopTimer = setTimeout(stopTyping, 3000);
   }

   async function checkTyping() {
     if (!state.open || state.view !== 'thread' || !state.activeId || document.hidden) return;
     if (typingCheckInFlight) return;

     const contactId = state.activeId;
     typingCheckInFlight = true;

     try {
       const result = await api(`/messages/${encodeURIComponent(contactId)}/typing`);
       if (!result || !result.success) return;
       if (state.activeId !== contactId || !state.open || state.view !== 'thread') return;

       setOtherTyping(Boolean(result.typing));
     } finally {
       typingCheckInFlight = false;
     }
   }

   async function api(path, options = {}) {
     try {
       const response = await fetch(`${API_BASE}${path}`, {
         ...options,
         cache: 'no-store',
         headers: {
           'Content-Type': 'application/json',
           Authorization: `Bearer ${token}`,
         },
       });
       if (response.status === 401) {
         setStatus('Your session expired. Refresh the page to sign in again.');
         return null;
       }
       const payload = await response.json().catch(() => null);
       if (payload && typeof payload === 'object') {
         payload.__status = response.status;
       }
       return payload;
     } catch (error) {
       console.error('[Messenger] Request failed:', error);
       return null;
     }
   }

   // ── Message handling ────────────────────────────────────────────────────

   function handleIncomingMessage(data) {
     console.log('[Messenger] Handling incoming message:', data);

     // If the message is for the active thread, add it immediately
     if (state.view === 'thread' && state.activeId === data.recipientId) {
       // Add the message to the thread
       if (!state.messages.some(msg => msg.id === data.id)) {
         state.messages.push(data);
         state.activeLastMessageAt = data.createdAt;
         state.forceScroll = true;
         renderThread();

         // Update contact with unread count
         const contact = state.contacts.find(c => c.id === data.senderId);
         if (contact) {
           contact.unread = (contact.unread || 0) + 1;
           contact.lastMessage = data.body;
           contact.lastMessageAt = data.createdAt;
           contact.lastMessageMine = false;
           contact.typing = false;
           setContactTyping(contact.id, false);
         }

         // Refresh contacts to update unread badges
         refreshContacts({ silent: true });
       }
     } else {
       // Message arrived for a different conversation, refresh contacts to update preview
       refreshContacts({ silent: true });
     }
   }

   // ── Badge ─────────────────────────────────────────────────────────────────

   function setUnreadCount(count) {
     const total = Number(count) || 0;
     state.unreadTotal = total;
     const label = total > 99 ? '99+' : String(total);
     els.launcherBadges.forEach((badge) => {
       if (!badge) return;
       badge.textContent = label;
       badge.hidden = total === 0;
     });
     if (els.headerBadge) {
       els.headerBadge.textContent = label;
       els.headerBadge.hidden = total === 0;
     }
   }

   async function refreshUnread() {
     if (document.hidden) return;
     const result = await api('/messages/unread-count');
     if (result && result.success) setUnreadCount(result.unreadTotal);
   }

   // ── Contacts ──────────────────────────────────────────────────────────────\n
   function contactMatchesSearch(contact) {\n     if (!state.search) return true;\n     const needle = state.search.toLowerCase();\n     return [contact.fullName, contact.roleLabel, contact.companyName, contact.studentId, contact.email]\n       .filter(Boolean)\n       .some((value) => String(value).toLowerCase().includes(needle));\n   }\n\n   function contactsSignature() {\n     return state.contacts\n       .map((contact) =>\n         [\n           contact.id,\n           contact.unread,\n           contact.lastMessageAt || '',\n           contact.lastMessage || '',\n           contact.profilePictureDataUrl ? '1' : '0',\n           contact.typing ? '1' : '0',\n         ].join('|')\n       )\n       .join('§');\n   }\n\n   function emptyStateHeading() {\n     if (user.role === 'supervisor') return 'No trainees to message yet';\n     if (user.role === 'coordinator') return 'No people to message yet';\n     return 'No supervisor assigned yet';\n   }\n\n   function emptyStateCopy() {\n     if (user.role === 'supervisor') {\n       return 'Once a coordinator assigns trainees to you, they will appear here.';\n     }\n     if (user.role === 'coordinator') {\n       return 'Active trainees and supervisors will appear here.';\n     }\n     return 'Your supervisor and coordinators will appear here once you are assigned.';\n   }\n\n   function renderContactsError(status) {\n     if (!els.contacts) return;\n     state.contactsView = 'error';\n     state.contactsStatus = status || 0;\n\n     let heading = \"Couldn't load your contacts\";\n     let hint = 'Check your connection and try again.';\n     if (status === 404) {\n       heading = 'Messaging is not available on this server';\n       hint = 'The backend is running an older build. Restart it, then try again.';\n     } else if (status === 401 || status === 403) {\n       heading = 'Your session has expired';\n       hint = 'Refresh the page to sign in again.';\n     }\n\n     els.contacts.innerHTML =\n       '<div class=\"tk-msg-empty\">' +\n       '<svg width=\"26\" height=\"26\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"9\"></circle><line x1=\"12\" y1=\"8\" x2=\"12\" y2=\"13\"></line><line x1=\"12\" y1=\"16.5\" x2=\"12\" y2=\"16.5\"></line></svg>' +\n       `<strong>${escapeHtml(heading)}</strong>` +\n       `<span>${escapeHtml(hint)}</span>` +\n       '<button type=\"button\" class=\"tk-msg-retry\" data-msg-action=\"retry\">Try again</button>' +\n       '</div>';\n   }\n\n   function renderContacts() {\n     if (!els.contacts) return;\n\n     state.contactsView = 'list';\n\n     if (state.loadingContacts && !state.contacts.length) {\n       els.contacts.innerHTML =\n         '<div class=\"tk-msg-empty\"><strong>Loading conversations…</strong></div>';\n       return;\n     }\n\n     if (!state.contacts.length) {\n       els.contacts.innerHTML =\n         '<div class=\"tk-msg-empty\">' +\n         '<svg width=\"26\" height=\"26\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" aria-hidden=\"true\"><path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"></path></svg>' +\n         `<strong>${escapeHtml(emptyStateHeading())}</strong>` +\n         `<span>${escapeHtml(emptyStateCopy())}</span>` +\n         '</div>';\n       return;\n     }\n\n     const visible = state.contacts.filter(contactMatchesSearch);\n     if (!visible.length) {\n       els.contacts.innerHTML =\n         '<div class=\"tk-msg-empty\"><strong>No matches</strong><span>Try a different name.</span></div>';\n       return;\n     }\n\n     els.contacts.innerHTML = visible\n       .map((contact) => {\n         const active = contact.id === state.activeId ? ' is-active' : '';\n         const roleClass =\n           contact.role === 'supervisor'\n             ? ' tk-msg-role--supervisor'\n             : contact.role === 'coordinator'\n               ? ' tk-msg-role--coordinator'\n               : '';\n         const avatarRole =\n           contact.role === 'supervisor'\n             ? ' tk-msg-avatar--supervisor'\n             : contact.role === 'coordinator'\n               ? ' tk-msg-avatar--coordinator'\n               : '';\n         const preview = contact.typing\n           ? 'typing…'\n           : contact.lastMessage\n             ? `${contact.lastMessageMine ? 'You: ' : ''}${contact.lastMessage}`\n             : contact.companyName || contact.department || 'Start a conversation';\n         const unread = contact.unread\n           ? `<span class=\"tk-msg-contact__unread\">${contact.unread > 99 ? '99+' : contact.unread}</span>`\n           : '';\n\n         return (\n           `<button type=\"button\" class=\"tk-msg-contact${active}\" data-contact-id=\"${escapeHtml(contact.id)}\">` +\n           `<span class=\"tk-msg-avatar${avatarRole}\">${avatarInner(contact)}</span>` +\n           '<span class=\"tk-msg-contact__main\">' +\n           '<span class=\"tk-msg-contact__top\">' +\n           `<span class=\"tk-msg-contact__name\">${escapeHtml(contact.fullName)}</span>` +\n           `<span class=\"tk-msg-contact__time\">${escapeHtml(formatContactTime(contact.lastMessageAt))}</span>` +\n           '</span>' +\n           '<span class=\"tk-msg-contact__meta\">' +\n           `<span class=\"tk-msg-role${roleClass}\">${escapeHtml(contact.roleLabel)}</span>` +\n           '</span>' +\n           `<span class=\"tk-msg-contact__preview${contact.typing ? ' tk-msg-contact__preview--typing' : ''}\">${escapeHtml(preview)}</span>` +\n           '</span>' +\n           unread +\n           '</button>'\n         );\n       })\n       .join('');\n   }\n\n   async function refreshContacts(options = {}) {\n     const { silent = false } = options;\n     if (state.loadingContacts) return;\n     state.loadingContacts = true;\n     if (!silent && !state.contacts.length) renderContacts();\n\n     const result = await api('/messages/contacts');\n     state.loadingContacts = false;\n\n     if (!result || !result.success) {\n       if (!state.contacts.length) renderContactsError(result ? result.__status : 0);\n       return;\n     }\n\n     state.contacts = Array.isArray(result.data) ? result.data : [];\n     if (typeof result.unreadTotal === 'number') setUnreadCount(result.unreadTotal);\n\n     if (state.activeId) {\n       const active = state.contacts.find((contact) => contact.id === state.activeId);\n       if (active) state.activeContact = { ...state.activeContact, ...active, unread: 0 };\n\n       if (\n         state.view === 'thread' &&\n         active &&\n         String(active.lastMessageAt || '') !== String(state.activeLastMessageAt || '')\n       ) {\n         refreshThreadSilently();\n       }\n     }\n\n     const signature = contactsSignature();\n     if (\n       signature !== state.contactsSignature ||\n       state.search ||\n       state.contactsView !== 'list'\n     ) {\n       state.contactsSignature = signature;\n       renderContacts();\n     }\n   }\n\n   // ── Thread ────────────────────────────────────────────────────────────────\n\n   function setThreadHeader(contact) {\n     if (!contact) return;\n     if (els.threadName) els.threadName.textContent = contact.fullName || 'Conversation';\n     if (els.threadSub) {\n       const bits = state.otherTyping\n         ? ['typing…']\n         : [contact.roleLabel, contact.companyName || contact.department].filter(Boolean);\n       els.threadSub.textContent = bits.join(' · ');\n       els.threadSub.classList.toggle('tk-msg-thread__sub--typing', state.otherTyping);\n     }\n     if (els.threadAvatar) {\n       els.threadAvatar.innerHTML = avatarInner(contact);\n       els.threadAvatar.className =\n         'tk-msg-avatar tk-msg-avatar--lg' +\n         (contact.role === 'supervisor'\n           ? ' tk-msg-avatar--supervisor'\n           : contact.role === 'coordinator'\n             ? ' tk-msg-avatar--coordinator'\n             : '');\n     }\n   }\n\n   function renderThread() {\n     if (!els.thread) return;\n     const stickToBottom = isNearBottom() || state.forceScroll;\n\n     if (state.loadingThread && !state.messages.length) {\n       els.thread.innerHTML =\n         '<div class=\"tk-msg-empty\"><strong>Loading messages…</strong></div>';\n       return;\n     }\n\n     if (!state.messages.length) {\n       els.thread.innerHTML =\n         '<div class=\"tk-msg-empty\">' +\n         '<svg width=\"26\" height=\"26\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" aria-hidden=\"true\"><path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"></path></svg>' +\n         '<strong>No messages yet</strong>' +\n         '<span>Say hello to start the conversation.</span>' +\n         '</div>' +\n         (state.otherTyping ? typingIndicatorHtml() : '');\n       return;\n     }\n\n     const parts = [];\n     let currentDay = '';\n     for (const message of state.messages) {\n       const date = asDate(message.createdAt) || new Date();\n       const key = date.toDateString();\n       if (key !== currentDay) {\n         currentDay = key;\n         parts.push(`<div class=\"tk-msg-day\">${escapeHtml(dayLabel(date))}</div>`);\n       }\n       parts.push(\n         `<div class=\"tk-msg-bubble${message.mine ? ' tk-msg-bubble--mine' : ''}\">` +\n           escapeHtml(message.body) +\n           `<span class=\"tk-msg-bubble__time\">${escapeHtml(formatTime(date))}</span>` +\n           '</div>'\n       );\n     }\n     if (state.otherTyping) parts.push(typingIndicatorHtml());\n     els.thread.innerHTML = parts.join('');\n\n     if (stickToBottom) {\n       scrollToBottom();\n       state.forceScroll = false;\n     }\n   }\n\n   async function loadThread(contactId) {\n     state.loadingThread = true;\n     state.messages = [];\n     renderThread();\n\n     const result = await api(`/messages/${encodeURIComponent(contactId)}`);\n     if (state.activeId !== contactId) return;\n\n     state.loadingThread = false;\n\n     if (!result || !result.success) {\n       setStatus((result && result.message) || 'Could not open this conversation.');\n       renderThread();\n       return;\n     }\n\n     state.messages = Array.isArray(result.data) ? result.data : [];\n     state.otherTyping = Boolean(result.typing);\n     setContactTyping(state.activeId, state.otherTyping);\n     if (result.contact) {\n       state.activeContact = { ...state.activeContact, ...result.contact, unread: 0 };\n       setThreadHeader(state.activeContact);\n     }\n     state.activeLastMessageAt =\n       state.messages.length > 0\n         ? state.messages[state.messages.length - 1].createdAt\n         : null;\n     state.forceScroll = true;\n     renderThread();\n\n     // Opening the thread marked everything as read on the server.\n     const contact = state.contacts.find((item) => item.id === contactId);\n     if (contact) contact.unread = 0;\n     state.contactsSignature = contactsSignature();\n     renderContacts();\n     refreshUnread();\n   }\n\n   async function refreshThreadSilently() {\n     if (!state.activeId || state.sending || document.hidden) return;\n     const contactId = state.activeId;\n     const result = await api(`/messages/${encodeURIComponent(contactId)}`);\n     if (!result || !result.success || state.activeId !== contactId) return;\n\n     const next = Array.isArray(result.data) ? result.data : [];\n     const current = state.messages;\n     const nextTyping = Boolean(result.typing);\n     const changed =\n       next.length !== current.length ||\n       (next.length > 0 &&\n         current.length > 0 &&\n         next[next.length - 1].id !== current[current.length - 1].id);\n     if (!changed) {\n       setOtherTyping(nextTyping);\n       return;\n     }\n\n     state.messages = next;\n     state.otherTyping = nextTyping;\n     if (result.contact) {\n       state.activeContact = { ...state.activeContact, ...result.contact, unread: 0 };\n       setThreadHeader(state.activeContact);\n     }\n     state.activeLastMessageAt =\n       next.length > 0 ? next[next.length - 1].createdAt : null;\n     renderThread();\n     refreshUnread();\n   }\n\n   // ── View switching ───────────────────────────────────────────────────────\n\n   function showList() {\n     state.view = 'list';\n     stopTyping();\n     state.otherTyping = false;\n     setContactTyping(state.activeId, false);\n     if (els.listView) els.listView.hidden = false;\n     if (els.threadView) els.threadView.hidden = true;\n     if (els.panel) els.panel.scrollLeft = 0;\n     renderContacts();\n   }\n\n   function showThread() {\n     state.view = 'thread';\n     if (els.listView) els.listView.hidden = true;\n     if (els.threadView) els.threadView.hidden = false;\n     if (els.panel) els.panel.scrollLeft = 0;\n   }\n\n   function selectContact(contact) {\n     if (!contact) return;\n     stopTyping();\n     state.activeId = contact.id;\n     state.activeContact = contact;\n     state.activeLastMessageAt = null;\n     state.messages = [];\n     state.otherTyping = false;\n     state.forceScroll = true;\n     setStatus('');\n     setThreadHeader(contact);\n     showThread();\n     if (els.input) els.input.focus();\n     loadThread(contact.id);\n   }\n\n   // ── Open / close ──────────────────────────────────────────────────────────\n\n   function openPanel() {\n     if (state.open || !els.panel) return;\n     state.open = true;\n     els.panel.classList.add('is-open');\n     els.panel.setAttribute('aria-hidden', 'false');\n     els.launchers.forEach((launcher) => {\n       launcher.classList.add('is-open');\n       launcher.setAttribute('aria-expanded', 'true');\n     });\n     showList();\n     refreshContacts();\n     startPanelPolling();\n     // Connect WebSocket when panel opens\n     if (!socket || !socket.connected) {\n       connectSocket();\n     }\n   }\n\n   function closePanel() {\n     if (!state.open || !els.panel) return;\n     stopTyping();\n     setContactTyping(state.activeId, false);\n     state.otherTyping = false;\n     state.open = false;\n     els.panel.classList.remove('is-open');\n     els.panel.setAttribute('aria-hidden', 'true');\n     els.launchers.forEach((launcher) => {\n       launcher.classList.remove('is-open');\n       launcher.setAttribute('aria-expanded', 'false');\n     });\n     stopPanelPolling();\n     refreshUnread();\n     // Disconnect WebSocket when panel closes\n     disconnectSocket();\n   }\n\n   function togglePanel() {\n     if (state.open) closePanel();\n     else openPanel();\n   }\n\n   // ── Deep link from other parts of the dashboard ───────────────────────────\n\n   async function openWith(userId) {\n     if (!els.panel) init();\n     if (!els.panel) return false;\n\n     const id = String(userId || '').trim();\n     if (!id) return false;\n\n     await new Promise((resolve) => setTimeout(resolve, 0));\n\n     openPanel();\n\n     if (!/^[a-fA-F0-9]{24}$/.test(id)) {\n       setStatus('Choose the person from the list to start a conversation.');\n       return false;\n     }\n\n     let contact = state.contacts.find((item) => item.id === id);\n     if (!contact) {\n       const started = Date.now();\n       while (state.loadingContacts && Date.now() - started < 4000) {\n         await new Promise((resolve) => setTimeout(resolve, 80));\n       }\n       contact = state.contacts.find((item) => item.id === id);\n     }\n\n     if (contact) {\n       selectContact(contact);\n       return true;\n     }\n\n     selectContact({\n       id,\n       fullName: 'New conversation',\n       role: 'student',\n       roleLabel: 'Trainee',\n       companyName: '',\n       department: '',\n       unread: 0,\n       lastMessage: '',\n       lastMessageAt: null,\n     });\n     return true;\n   }\n\n   // ── Polling ───────────────────────────────────────────────────────────────\n\n   function startPanelPolling() {\n     stopPanelPolling();\n     contactsTimer = setInterval(() => {\n       if (document.hidden) return;\n       refreshContacts({ silent: true });\n     }, 3000);\n     typingTimer = setInterval(() => {\n       if (document.hidden) return;\n       checkTyping();\n     }, 1000);\n   }\n\n   function stopPanelPolling() {\n     if (contactsTimer) {\n       clearInterval(contactsTimer);\n       contactsTimer = null;\n     }\n     if (typingTimer) {\n       clearInterval(typingTimer);\n       typingTimer = null;\n     }\n   }\n\n   function startBadgePolling() {\n     if (badgeTimer) clearInterval(badgeTimer);\n     badgeTimer = setInterval(() => {\n       if (document.hidden || state.open) return;\n       refreshUnread();\n     }, 30000);\n   }\n\n   // ── Sending ───────────────────────────────────────────────────────────────\n\n   function autoGrowInput() {\n     if (!els.input) return;\n     els.input.style.height = 'auto';\n     els.input.style.height = `${Math.min(els.input.scrollHeight, 96)}px`;\n     if (els.send) els.send.disabled = !els.input.value.trim() || state.sending;\n   }\n\n   async function sendMessage() {\n     if (!els.input || !state.activeId || state.sending) return;\n     const body = els.input.value.trim();\n     if (!body) return;\n\n     stopTyping();\n     state.sending = true;\n     if (els.send) els.send.disabled = true;\n     setStatus('');\n\n     const result = await api(`/messages/${encodeURIComponent(state.activeId)}`, {\n       method: 'POST',\n       body: JSON.stringify({ body }),\n     });\n\n     state.sending = false;\n\n     if (!result || !result.success || !result.data) {\n       setStatus((result && result.message) || 'Message was not sent. Please try again.');\n       if (els.send) els.send.disabled = false;\n       return;\n     }\n\n     els.input.value = '';\n     autoGrowInput();\n     state.messages.push(result.data);\n     state.activeLastMessageAt = result.data.createdAt;\n     state.forceScroll = true;\n     renderThread();\n     if (els.input) els.input.focus();\n     refreshContacts({ silent: true });\n\n     // Emit message via WebSocket if connected\n     if (socket && socket.connected) {\n       socket.emit('message:new', result.data);\n     }\n   }\n\n   // ── Markup ────────────────────────────────────────────────────────────────\n\n   function chatIcon(size) {\n     return (\n       `<svg width=\"${size}\" height=\"${size}\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">` +\n       '<path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"></path>' +\n       '</svg>'\n     );\n   }\n\n   function buildLauncher(floating) {\n     const button = document.createElement('button');\n     button.type = 'button';\n     button.className = `tk-msg-launcher${floating ? ' tk-msg-launcher--floating' : ''}`;\n     button.setAttribute('aria-label', 'Open messages');\n     button.setAttribute('aria-haspopup', 'dialog');\n     button.setAttribute('aria-expanded', 'false');\n     button.innerHTML =\n       chatIcon(18) +\n       '<span class=\"tk-msg-launcher__label\">Messages</span>' +\n       '<span class=\"tk-msg-launcher__badge\" hidden>0</span>';\n     button.addEventListener('click', (event) => {\n       event.stopPropagation();\n       togglePanel();\n     });\n     els.launchers.push(button);\n     els.launcherBadges.push(button.querySelector('.tk-msg-launcher__badge'));\n     return button;\n   }\n\n   function buildPanel() {\n     const panel = document.createElement('div');\n     panel.className = 'tk-msg-panel';\n     panel.id = 'tk-msg-panel';\n     panel.setAttribute('role', 'dialog');\n     panel.setAttribute('aria-label', 'Messages');\n     panel.setAttribute('aria-hidden', 'true');\n     panel.innerHTML =\n       '<div class=\"tk-msg-panel__head\">' +\n       '<div class=\"tk-msg-panel__title\">' +\n       chatIcon(17) +\n       '<span>Messages</span>' +\n       '<span class=\"tk-msg-panel__badge\" hidden>0</span>' +\n       '</div>' +\n       '<button type=\"button\" class=\"tk-msg-iconbtn\" data-msg-action=\"close\" aria-label=\"Close messages\">' +\n       '<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><line x1=\"18\" y1=\"6\" x2=\"6\" y2=\"18\"></line><line x1=\"6\" y1=\"6\" x2=\"18\" y2=\"18\"></line></svg>' +\n       '</button>' +\n       '</div>' +\n       '<div class=\"tk-msg-panel__body\">' +\n       '<section class=\"tk-msg-listview\">' +\n       '<div class=\"tk-msg-search\">' +\n       '<svg width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" aria-hidden=\"true\"><circle cx=\"11\" cy=\"11\" r=\"7\"></circle><line x1=\"21\" y1=\"21\" x2=\"16.65\" y2=\"16.65\"></line></svg>' +\n       '<input type=\"search\" id=\"tk-msg-search\" placeholder=\"Search people\" autocomplete=\"off\" aria-label=\"Search people\">' +\n       '</div>' +\n       '<div class=\"tk-msg-contacts\" id=\"tk-msg-contacts\"></div>' +\n       '</section>' +\n       '<section class=\"tk-msg-threadview\" hidden>' +\n       '<div class=\"tk-msg-thread__head\">' +\n       '<button type=\"button\" class=\"tk-msg-iconbtn\" data-msg-action=\"back\" aria-label=\"Back to conversations\">' +\n       '<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><polyline points=\"15 18 9 12 15 6\"></polyline></svg>' +\n       '</button>' +\n       '<span class=\"tk-msg-avatar tk-msg-avatar--lg\" id=\"tk-msg-thread-avatar\">?</span>' +\n       '<div class=\"tk-msg-thread__who\">' +\n       '<div class=\"tk-msg-thread__name\" id=\"tk-msg-thread-name\">Conversation</div>' +\n       '<div class=\"tk-msg-thread__sub\" id=\"tk-msg-thread-sub\"></div>' +\n       '</div>' +\n       '</div>' +\n       '<div class=\"tk-msg-thread\" id=\"tk-msg-thread\"></div>' +\n       '<p class=\"tk-msg-status\" id=\"tk-msg-status\" hidden></p>' +\n       '<form class=\"tk-msg-composer\" id=\"tk-msg-composer\">' +\n       '<textarea id=\"tk-msg-input\" rows=\"1\" maxlength=\"2000\" placeholder=\"Write a message…\" aria-label=\"Message\"></textarea>' +\n       '<button type=\"submit\" class=\"tk-msg-send\" id=\"tk-msg-send\" aria-label=\"Send message\" disabled>' +\n       '<svg width=\"17\" height=\"17\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><line x1=\"22\" y1=\"2\" x2=\"11\" y2=\"13\"></line><polygon points=\"22 2 15 22 11 13 2 9 22 2\"></polygon></svg>' +\n       '</button>' +\n       '</form>' +\n       '</section>' +\n       '</div>';\n\n     els.panel = panel;\n     els.listView = panel.querySelector('.tk-msg-listview');\n     els.threadView = panel.querySelector('.tk-msg-threadview');\n     els.contacts = panel.querySelector('#tk-msg-contacts');\n     els.search = panel.querySelector('#tk-msg-search');\n     els.headerBadge = panel.querySelector('.tk-msg-panel__badge');\n     els.thread = panel.querySelector('#tk-msg-thread');\n     els.threadName = panel.querySelector('#tk-msg-thread-name');\n     els.threadSub = panel.querySelector('#tk-msg-thread-sub');\n     els.threadAvatar = panel.querySelector('#tk-msg-thread-avatar');\n     els.composer = panel.querySelector('#tk-msg-composer');\n     els.input = panel.querySelector('#tk-msg-input');\n     els.send = panel.querySelector('#tk-msg-send');\n     els.status = panel.querySelector('#tk-msg-status');\n\n     return panel;\n   }\n\n   function bindEvents() {\n     els.panel.addEventListener('click', (event) => {\n       const action = event.target.closest('[data-msg-action]');\n       if (action) {\n         const name = action.getAttribute('data-msg-action');\n         if (name === 'close') closePanel();\n         if (name === 'back') showList();\n         if (name === 'retry') {\n           state.contactsView = '';\n           refreshContacts();\n         }\n         return;\n       }\n\n       const contactButton = event.target.closest('[data-contact-id]');\n       if (contactButton) {\n         const id = contactButton.getAttribute('data-contact-id');\n         const contact = state.contacts.find((item) => item.id === id);\n         if (contact) selectContact(contact);\n       }\n     });\n\n     els.search.addEventListener('input', () => {\n       state.search = els.search.value.trim();\n       renderContacts();\n     });\n\n     els.composer.addEventListener('submit', (event) => {\n       event.preventDefault();\n       sendMessage();\n     });\n\n     els.input.addEventListener('input', () => {\n       autoGrowInput();\n       noteTyping();\n     });\n\n     els.input.addEventListener('blur', stopTyping);\n\n     document.addEventListener('visibilitychange', () => {\n       if (document.hidden) {\n         stopTyping();\n         disconnectSocket();\n       } else if (state.open && state.view === 'thread') {\n         checkTyping();\n         if (!socket || !socket.connected) {\n           connectSocket();\n         }\n       }\n     });\n\n     els.input.addEventListener('keydown', (event) => {\n       if (event.key === 'Enter' && !event.shiftKey) {\n         event.preventDefault();\n         sendMessage();\n       }\n     });\n\n     document.addEventListener('keydown', (event) => {\n       if (event.key !== 'Escape' || !state.open) return;\n       if (state.view === 'thread') showList();\n       else closePanel();\n     });\n\n     document.addEventListener('click', (event) => {\n       if (!state.open) return;\n       if (els.panel.contains(event.target)) return;\n       if (els.launchers.some((launcher) => launcher.contains(event.target))) return;\n       closePanel();\n     });\n\n     window.addEventListener('focus', () => {\n       if (!state.open) refreshUnread();\n       if (socket && !socket.connected) {\n         connectSocket();\n       }\n     });\n\n     // Handle WebSocket connection errors and attempt reconnection\n     if (socket) {\n       socket.on('error', (error) => {\n         console.error('[Messenger] WebSocket error:', error);\n         if (error.code === 'E_CLOSING' || error.message.includes('close')) {\n           // Connection is being closed, don't try to reconnect immediately\n           if (socketRetryTimer) clearTimeout(socketRetryTimer);\n           socketRetryTimer = setTimeout(() => {\n             if (!socket || !socket.connected) {\n               connectSocket();\n             }\n           }, 5000);\n         }\n       });\n     }\n   }\n\n   function init() {\n     if (document.getElementById('tk-msg-panel')) return;\n\n     const sidebar = document.querySelector('.sidebar');\n     const panel = buildPanel();\n     const sidebarLauncher = buildLauncher(false);\n     const floatingLauncher = buildLauncher(true);\n\n     if (sidebar) {\n       sidebar.classList.add('has-tk-msg');\n       sidebar.appendChild(sidebarLauncher);\n     } else {\n       sidebarLauncher.classList.add('tk-msg-launcher--floating');\n     }\n     document.body.appendChild(floatingLauncher);\n     document.body.appendChild(panel);\n\n     bindEvents();\n     refreshUnread();\n     startBadgePolling();\n\n     // Connect WebSocket on initialization\n     connectSocket();\n   }\n\n   if (document.readyState === 'loading') {\n     document.addEventListener('DOMContentLoaded', init, { once: true });\n   } else {\n     init();\n   }\n\n   // Public hook: the dashboards use `openWith(traineeId)` from their own\n   // \"Message\" buttons; the rest is available for debugging.\n   window.TrackITMessenger = {\n     open: openPanel,\n     close: closePanel,\n     openWith,\n     refresh: refreshUnread,\n     isOpen: () => state.open,\n     connectSocket,\n     disconnectSocket,\n   };\n})();