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
    view: 'list', // 'list' | 'thread'
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
    // '' until the list renders; 'error' when the request failed. Used so a
    // successful retry repaints over the error state even with 0 contacts.
    contactsView: '',
    contactsStatus: 0,
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
  let typingStopTimer = null;
  let typingSentAt = 0;
  let typingAnnouncedFor = null;
  let updatesTimer = null;
  let updatesInFlight = false;

  // ── Helpers ───────────────────────────────────────────────────────────────

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

  /** Avatar contents: the contact's picture when set, otherwise initials. */
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
  //
  // Typing is ephemeral on the server (5 s TTL). We announce at most once every
  // 2.5 s while the field has text, send an explicit stop after 3 s without a
  // keystroke, and poll the other person's state only while their thread is on
  // screen. Polling keeps this working without Socket.IO.

  function typingIndicatorHtml() {
    return (
      '<div class="tk-msg-typing" role="status" aria-live="polite">' +
      '<span class="tk-msg-typing__bubble" aria-hidden="true"><span></span><span></span><span></span></span>' +
      '<span class="tk-msg-typing__label">typing…</span>' +
      '</div>'
    );
  }

  /**
   * Mirror the typing flag onto the contact list so the preview row shows
   * "typing…" too, without waiting for the slower 6 s contacts refresh.
   */
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

    api(`/messages/${encodeURIComponent(contactId)}/typing`, {
      method: 'POST',
      body: JSON.stringify({ typing: false }),
    });
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
    // Re-announce at least every 1.2s while keys are going down. The server
    // keeps the flag alive for 5s, so this keeps the indicator continuously
    // fresh on the recipient's side without a write per keystroke.
    if (typingAnnouncedFor !== contactId || now - typingSentAt >= 1200) {
      typingAnnouncedFor = contactId;
      typingSentAt = now;
      api(`/messages/${encodeURIComponent(contactId)}/typing`, {
        method: 'POST',
        body: JSON.stringify({ typing: true }),
      });
    }

    if (typingStopTimer) clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(stopTyping, 3000);
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
        // Keep the HTTP status on the payload so callers can tell "no people"
        // apart from "the server has no messaging routes yet" (404).
        payload.__status = response.status;
      }
      return payload;
    } catch (error) {
      console.error('[Messenger] Request failed:', error);
      return null;
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

  // ── Contacts ──────────────────────────────────────────────────────────────

  function contactMatchesSearch(contact) {
    if (!state.search) return true;
    const needle = state.search.toLowerCase();
    return [contact.fullName, contact.roleLabel, contact.companyName, contact.studentId, contact.email]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  }

  function contactsSignature() {
    return state.contacts
      .map((contact) =>
        [
          contact.id,
          contact.unread,
          contact.lastMessageAt || '',
          contact.lastMessage || '',
          contact.profilePictureDataUrl ? '1' : '0',
          contact.typing ? '1' : '0',
        ].join('|')
      )
      .join('§');
  }

  function emptyStateHeading() {
    if (user.role === 'supervisor') return 'No trainees to message yet';
    if (user.role === 'coordinator') return 'No people to message yet';
    return 'No supervisor assigned yet';
  }

  function emptyStateCopy() {
    if (user.role === 'supervisor') {
      return 'Once a coordinator assigns trainees to you, they will appear here.';
    }
    if (user.role === 'coordinator') {
      return 'Active trainees and supervisors will appear here.';
    }
    return 'Your supervisor and coordinators will appear here once you are assigned.';
  }

  function renderContactsError(status) {
    if (!els.contacts) return;
    state.contactsView = 'error';
    state.contactsStatus = status || 0;

    let heading = "Couldn't load your contacts";
    let hint = 'Check your connection and try again.';
    if (status === 404) {
      heading = 'Messaging is not available on this server';
      hint = 'The backend is running an older build. Restart it, then try again.';
    } else if (status === 401 || status === 403) {
      heading = 'Your session has expired';
      hint = 'Refresh the page to sign in again.';
    }

    els.contacts.innerHTML =
      '<div class="tk-msg-empty">' +
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><line x1="12" y1="8" x2="12" y2="13"></line><line x1="12" y1="16.5" x2="12" y2="16.5"></line></svg>' +
      `<strong>${escapeHtml(heading)}</strong>` +
      `<span>${escapeHtml(hint)}</span>` +
      '<button type="button" class="tk-msg-retry" data-msg-action="retry">Try again</button>' +
      '</div>';
  }

  function renderContacts() {
    if (!els.contacts) return;

    state.contactsView = 'list';

    if (state.loadingContacts && !state.contacts.length) {
      els.contacts.innerHTML =
        '<div class="tk-msg-empty"><strong>Loading conversations…</strong></div>';
      return;
    }

    if (!state.contacts.length) {
      els.contacts.innerHTML =
        '<div class="tk-msg-empty">' +
        '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>' +
        `<strong>${escapeHtml(emptyStateHeading())}</strong>` +
        `<span>${escapeHtml(emptyStateCopy())}</span>` +
        '</div>';
      return;
    }

    const visible = state.contacts.filter(contactMatchesSearch);
    if (!visible.length) {
      els.contacts.innerHTML =
        '<div class="tk-msg-empty"><strong>No matches</strong><span>Try a different name.</span></div>';
      return;
    }

    els.contacts.innerHTML = visible
      .map((contact) => {
        const active = contact.id === state.activeId ? ' is-active' : '';
        const roleClass =
          contact.role === 'supervisor'
            ? ' tk-msg-role--supervisor'
            : contact.role === 'coordinator'
              ? ' tk-msg-role--coordinator'
              : '';
        const avatarRole =
          contact.role === 'supervisor'
            ? ' tk-msg-avatar--supervisor'
            : contact.role === 'coordinator'
              ? ' tk-msg-avatar--coordinator'
              : '';
        const preview = contact.typing
          ? 'typing…'
          : contact.lastMessage
            ? `${contact.lastMessageMine ? 'You: ' : ''}${contact.lastMessage}`
            : contact.companyName || contact.department || 'Start a conversation';
        const unread = contact.unread
          ? `<span class="tk-msg-contact__unread">${contact.unread > 99 ? '99+' : contact.unread}</span>`
          : '';

        return (
          `<button type="button" class="tk-msg-contact${active}" data-contact-id="${escapeHtml(contact.id)}">` +
          `<span class="tk-msg-avatar${avatarRole}">${avatarInner(contact)}</span>` +
          '<span class="tk-msg-contact__main">' +
          '<span class="tk-msg-contact__top">' +
          `<span class="tk-msg-contact__name">${escapeHtml(contact.fullName)}</span>` +
          `<span class="tk-msg-contact__time">${escapeHtml(formatContactTime(contact.lastMessageAt))}</span>` +
          '</span>' +
          '<span class="tk-msg-contact__meta">' +
          `<span class="tk-msg-role${roleClass}">${escapeHtml(contact.roleLabel)}</span>` +
          '</span>' +
          `<span class="tk-msg-contact__preview${contact.typing ? ' tk-msg-contact__preview--typing' : ''}">${escapeHtml(preview)}</span>` +
          '</span>' +
          unread +
          '</button>'
        );
      })
      .join('');
  }

  async function refreshContacts(options = {}) {
    const { silent = false } = options;
    if (state.loadingContacts) return;
    state.loadingContacts = true;
    if (!silent && !state.contacts.length) renderContacts();

    const result = await api('/messages/contacts');
    state.loadingContacts = false;

    if (!result || !result.success) {
      if (!state.contacts.length) renderContactsError(result ? result.__status : 0);
      return;
    }

    state.contacts = Array.isArray(result.data) ? result.data : [];
    if (typeof result.unreadTotal === 'number') setUnreadCount(result.unreadTotal);

    if (state.activeId) {
      const active = state.contacts.find((contact) => contact.id === state.activeId);
      if (active) state.activeContact = { ...state.activeContact, ...active, unread: 0 };

      // The inbox summary is the cheapest way to detect a new reply: only when
      // the active contact's last message changes do we pull the whole thread.
      if (
        state.view === 'thread' &&
        active &&
        String(active.lastMessageAt || '') !== String(state.activeLastMessageAt || '')
      ) {
        refreshThreadSilently();
      }
    }

    const signature = contactsSignature();
    if (
      signature !== state.contactsSignature ||
      state.search ||
      state.contactsView !== 'list'
    ) {
      state.contactsSignature = signature;
      renderContacts();
    }
  }

  // ── Thread ────────────────────────────────────────────────────────────────

  function setThreadHeader(contact) {
    if (!contact) return;
    if (els.threadName) els.threadName.textContent = contact.fullName || 'Conversation';
    if (els.threadSub) {
      const bits = state.otherTyping
        ? ['typing…']
        : [contact.roleLabel, contact.companyName || contact.department].filter(Boolean);
      els.threadSub.textContent = bits.join(' · ');
      els.threadSub.classList.toggle('tk-msg-thread__sub--typing', state.otherTyping);
    }
    if (els.threadAvatar) {
      els.threadAvatar.innerHTML = avatarInner(contact);
      els.threadAvatar.className =
        'tk-msg-avatar tk-msg-avatar--lg' +
        (contact.role === 'supervisor'
          ? ' tk-msg-avatar--supervisor'
          : contact.role === 'coordinator'
            ? ' tk-msg-avatar--coordinator'
            : '');
    }
  }

  function renderThread() {
    if (!els.thread) return;
    const stickToBottom = isNearBottom() || state.forceScroll;

    if (state.loadingThread && !state.messages.length) {
      els.thread.innerHTML =
        '<div class="tk-msg-empty"><strong>Loading messages…</strong></div>';
      return;
    }

    if (!state.messages.length) {
      els.thread.innerHTML =
        '<div class="tk-msg-empty">' +
        '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>' +
        '<strong>No messages yet</strong>' +
        '<span>Say hello to start the conversation.</span>' +
        '</div>' +
        (state.otherTyping ? typingIndicatorHtml() : '');
      return;
    }

    const parts = [];
    let currentDay = '';
    for (const message of state.messages) {
      const date = asDate(message.createdAt) || new Date();
      const key = date.toDateString();
      if (key !== currentDay) {
        currentDay = key;
        parts.push(`<div class="tk-msg-day">${escapeHtml(dayLabel(date))}</div>`);
      }
      parts.push(
        `<div class="tk-msg-bubble${message.mine ? ' tk-msg-bubble--mine' : ''}">` +
          escapeHtml(message.body) +
          `<span class="tk-msg-bubble__time">${escapeHtml(formatTime(date))}</span>` +
          '</div>'
      );
    }
    if (state.otherTyping) parts.push(typingIndicatorHtml());
    els.thread.innerHTML = parts.join('');

    if (stickToBottom) {
      scrollToBottom();
      state.forceScroll = false;
    }
  }

  async function loadThread(contactId) {
    state.loadingThread = true;
    state.messages = [];
    renderThread();

    const result = await api(`/messages/${encodeURIComponent(contactId)}`);
    if (state.activeId !== contactId) return;

    state.loadingThread = false;

    if (!result || !result.success) {
      setStatus((result && result.message) || 'Could not open this conversation.');
      renderThread();
      return;
    }

    state.messages = Array.isArray(result.data) ? result.data : [];
    state.otherTyping = Boolean(result.typing);
    setContactTyping(state.activeId, state.otherTyping);
    if (result.contact) {
      state.activeContact = { ...state.activeContact, ...result.contact, unread: 0 };
      setThreadHeader(state.activeContact);
    }
    state.activeLastMessageAt =
      state.messages.length > 0
        ? state.messages[state.messages.length - 1].createdAt
        : null;
    state.forceScroll = true;
    renderThread();

    // Opening the thread marked everything as read on the server.
    const contact = state.contacts.find((item) => item.id === contactId);
    if (contact) contact.unread = 0;
    state.contactsSignature = contactsSignature();
    renderContacts();
    refreshUnread();
  }

  async function refreshThreadSilently() {
    if (!state.activeId || state.sending || document.hidden) return;
    const contactId = state.activeId;
    const result = await api(`/messages/${encodeURIComponent(contactId)}`);
    if (!result || !result.success || state.activeId !== contactId) return;

    const next = Array.isArray(result.data) ? result.data : [];
    const current = state.messages;
    const nextTyping = Boolean(result.typing);
    const changed =
      next.length !== current.length ||
      (next.length > 0 &&
        current.length > 0 &&
        next[next.length - 1].id !== current[current.length - 1].id);
    if (!changed) {
      setOtherTyping(nextTyping);
      return;
    }

    state.messages = next;
    state.otherTyping = nextTyping;
    if (result.contact) {
      state.activeContact = { ...state.activeContact, ...result.contact, unread: 0 };
      setThreadHeader(state.activeContact);
    }
    state.activeLastMessageAt =
      next.length > 0 ? next[next.length - 1].createdAt : null;
    renderThread();
    refreshUnread();
  }

  // ── View switching ────────────────────────────────────────────────────────

  function showList() {
    state.view = 'list';
    stopTyping();
    state.otherTyping = false;
    setContactTyping(state.activeId, false);
    if (els.listView) els.listView.hidden = false;
    if (els.threadView) els.threadView.hidden = true;
    // Switching views used to focus the search box, which made the panel's
    // overflow:hidden box scroll sideways and clipped the avatars. Keep the
    // panel anchored at 0,0 instead.
    if (els.panel) els.panel.scrollLeft = 0;
    renderContacts();
    // No thread on screen — the fast delta poll has nothing to watch.
    stopThreadPolling();
  }

  function showThread() {
    state.view = 'thread';
    if (els.listView) els.listView.hidden = true;
    if (els.threadView) els.threadView.hidden = false;
    if (els.panel) els.panel.scrollLeft = 0;
    startThreadPolling();
  }

  function selectContact(contact) {
    if (!contact) return;
    stopTyping();
    state.activeId = contact.id;
    state.activeContact = contact;
    state.activeLastMessageAt = null;
    state.messages = [];
    state.otherTyping = false;
    state.forceScroll = true;
    setStatus('');
    setThreadHeader(contact);
    showThread();
    if (els.input) els.input.focus();
    loadThread(contact.id);
  }

  // ── Open / close ──────────────────────────────────────────────────────────

  function openPanel() {
    if (state.open || !els.panel) return;
    state.open = true;
    els.panel.classList.add('is-open');
    els.panel.setAttribute('aria-hidden', 'false');
    els.launchers.forEach((launcher) => {
      launcher.classList.add('is-open');
      launcher.setAttribute('aria-expanded', 'true');
    });
    showList();
    refreshContacts();
    startPanelPolling();
  }

  function closePanel() {
    if (!state.open || !els.panel) return;
    stopTyping();
    setContactTyping(state.activeId, false);
    state.otherTyping = false;
    state.open = false;
    els.panel.classList.remove('is-open');
    els.panel.setAttribute('aria-hidden', 'true');
    els.launchers.forEach((launcher) => {
      launcher.classList.remove('is-open');
      launcher.setAttribute('aria-expanded', 'false');
    });
    stopPanelPolling();
    stopThreadPolling();
    refreshUnread();
  }

  function togglePanel() {
    if (state.open) closePanel();
    else openPanel();
  }

  // ── Deep link from other parts of the dashboard ───────────────────────────

  /**
   * Open the panel straight into the conversation with `userId`. Used by the
   * supervisor "My Trainees" Message buttons. Returns true when a thread was
   * opened, false when the id could not be used (the panel still opens on the
   * contact list so the user can pick the person manually).
   */
  async function openWith(userId) {
    if (!els.panel) init();
    if (!els.panel) return false;

    const id = String(userId || '').trim();
    if (!id) return false;

    // The button that calls this lives outside the panel, so opening here
    // synchronously would let the same click bubble into the document-level
    // "click outside closes the panel" listener. Let the event finish first.
    await new Promise((resolve) => setTimeout(resolve, 0));

    openPanel();

    // The static demo cards in the HTML fall back to ids like "trainee-1"
    // when the trainee API is unavailable; those are not real users.
    if (!/^[a-fA-F0-9]{24}$/.test(id)) {
      setStatus('Choose the person from the list to start a conversation.');
      return false;
    }

    let contact = state.contacts.find((item) => item.id === id);
    if (!contact) {
      // The contact list may still be in flight from openPanel().
      const started = Date.now();
      while (state.loadingContacts && Date.now() - started < 4000) {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      contact = state.contacts.find((item) => item.id === id);
    }

    if (contact) {
      selectContact(contact);
      return true;
    }

    // No conversation yet: open a placeholder and let the thread endpoint fill
    // in the real name and role.
    selectContact({
      id,
      fullName: 'New conversation',
      role: 'student',
      roleLabel: 'Trainee',
      companyName: '',
      department: '',
      unread: 0,
      lastMessage: '',
      lastMessageAt: null,
    });
    return true;
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  function startPanelPolling() {
    stopPanelPolling();
    // Inbox list: previews, unread counts, ordering. 3s is plenty here — the
    // open conversation has its own much faster delta poll below.
    contactsTimer = setInterval(() => {
      if (document.hidden) return;
      refreshContacts({ silent: true });
    }, 3000);
  }

  function stopPanelPolling() {
    if (contactsTimer) {
      clearInterval(contactsTimer);
      contactsTimer = null;
    }
  }

  /**
   * Delta poll for the open conversation, replacing two slower loops (the 6s
   * contacts poll noticing a changed preview, plus a separate typing poll).
   * Every ~900ms the client asks only for messages newer than the newest one
   * it already has, and the same response carries the typing flag — one cheap
   * indexed query per tick instead of re-downloading the whole thread. This
   * is what makes delivery feel instant without a push channel.
   */
  function startThreadPolling() {
    stopThreadPolling();
    updatesTimer = setInterval(() => {
      if (document.hidden) return;
      pollUpdates();
    }, 900);
    pollUpdates();
  }

  function stopThreadPolling() {
    if (updatesTimer) {
      clearInterval(updatesTimer);
      updatesTimer = null;
    }
    updatesInFlight = false;
  }

  async function pollUpdates() {
    if (!state.open || state.view !== 'thread' || !state.activeId || document.hidden) return;
    if (state.sending || updatesInFlight) return;

    const contactId = state.activeId;
    const after = state.messages.length
      ? state.messages[state.messages.length - 1].id
      : '';

    updatesInFlight = true;
    try {
      const query = after ? `?after=${encodeURIComponent(after)}` : '';
      const result = await api(`/messages/${encodeURIComponent(contactId)}/updates${query}`);
      if (!result || !result.success) return;
      if (state.activeId !== contactId || state.view !== 'thread') return;

      const incoming = Array.isArray(result.data) ? result.data : [];

      // A full batch means the delta window (60) overflowed — the client was
      // away for a while. Re-download the whole thread once and carry on.
      if (incoming.length >= 60) {
        await refreshThreadSilently();
        return;
      }

      if (incoming.length) {
        for (const message of incoming) {
          if (!state.messages.some((existing) => existing.id === message.id)) {
            state.messages.push(message);
          }
        }
        const newest = state.messages[state.messages.length - 1];
        state.activeLastMessageAt = newest ? newest.createdAt : null;

        // Mirror the arrival into the inbox row so the preview and ordering
        // keep up even between contacts polls. The server marked the batch as
        // read, so the row's unread count clears too.
        const contact = state.contacts.find((item) => item.id === contactId);
        if (contact) {
          contact.unread = 0;
          contact.lastMessage = newest ? newest.body : contact.lastMessage;
          contact.lastMessageAt = state.activeLastMessageAt;
          contact.lastMessageMine = false;
          state.contactsSignature = contactsSignature();
          renderContacts();
        }

        renderThread();
        refreshUnread();
      }

      // The same response carries the typing flag, so the indicator now
      // updates every tick instead of on its own slower poll. It also clears
      // the moment a message actually lands (the server clears typing on
      // send), so "typing…" never lingers under a fresh message.
      setOtherTyping(Boolean(result.typing));
    } finally {
      updatesInFlight = false;
    }
  }

  function startBadgePolling() {
    if (badgeTimer) clearInterval(badgeTimer);
    badgeTimer = setInterval(() => {
      if (document.hidden || state.open) return;
      refreshUnread();
    }, 30000);
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  function autoGrowInput() {
    if (!els.input) return;
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 96)}px`;
    if (els.send) els.send.disabled = !els.input.value.trim() || state.sending;
  }

  async function sendMessage() {
    if (!els.input || !state.activeId || state.sending) return;
    const body = els.input.value.trim();
    if (!body) return;

    stopTyping();
    state.sending = true;
    if (els.send) els.send.disabled = true;
    setStatus('');

    const result = await api(`/messages/${encodeURIComponent(state.activeId)}`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });

    state.sending = false;

    if (!result || !result.success || !result.data) {
      setStatus((result && result.message) || 'Message was not sent. Please try again.');
      if (els.send) els.send.disabled = false;
      return;
    }

    els.input.value = '';
    autoGrowInput();
    state.messages.push(result.data);
    state.activeLastMessageAt = result.data.createdAt;
    state.forceScroll = true;
    renderThread();
    if (els.input) els.input.focus();
    refreshContacts({ silent: true });
  }

  // ── Markup ────────────────────────────────────────────────────────────────

  function chatIcon(size) {
    return (
      `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>' +
      '</svg>'
    );
  }

  function buildLauncher(floating) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tk-msg-launcher${floating ? ' tk-msg-launcher--floating' : ''}`;
    button.setAttribute('aria-label', 'Open messages');
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML =
      chatIcon(18) +
      '<span class="tk-msg-launcher__label">Messages</span>' +
      '<span class="tk-msg-launcher__badge" hidden>0</span>';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      togglePanel();
    });
    els.launchers.push(button);
    els.launcherBadges.push(button.querySelector('.tk-msg-launcher__badge'));
    return button;
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.className = 'tk-msg-panel';
    panel.id = 'tk-msg-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Messages');
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML =
      '<div class="tk-msg-panel__head">' +
      '<div class="tk-msg-panel__title">' +
      chatIcon(17) +
      '<span>Messages</span>' +
      '<span class="tk-msg-panel__badge" hidden>0</span>' +
      '</div>' +
      '<button type="button" class="tk-msg-iconbtn" data-msg-action="close" aria-label="Close messages">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
      '</button>' +
      '</div>' +
      '<div class="tk-msg-panel__body">' +
      '<section class="tk-msg-listview">' +
      '<div class="tk-msg-search">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>' +
      '<input type="search" id="tk-msg-search" placeholder="Search people" autocomplete="off" aria-label="Search people">' +
      '</div>' +
      '<div class="tk-msg-contacts" id="tk-msg-contacts"></div>' +
      '</section>' +
      '<section class="tk-msg-threadview" hidden>' +
      '<div class="tk-msg-thread__head">' +
      '<button type="button" class="tk-msg-iconbtn" data-msg-action="back" aria-label="Back to conversations">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>' +
      '</button>' +
      '<span class="tk-msg-avatar tk-msg-avatar--lg" id="tk-msg-thread-avatar">?</span>' +
      '<div class="tk-msg-thread__who">' +
      '<div class="tk-msg-thread__name" id="tk-msg-thread-name">Conversation</div>' +
      '<div class="tk-msg-thread__sub" id="tk-msg-thread-sub"></div>' +
      '</div>' +
      '</div>' +
      '<div class="tk-msg-thread" id="tk-msg-thread"></div>' +
      '<p class="tk-msg-status" id="tk-msg-status" hidden></p>' +
      '<form class="tk-msg-composer" id="tk-msg-composer">' +
      '<textarea id="tk-msg-input" rows="1" maxlength="2000" placeholder="Write a message…" aria-label="Message"></textarea>' +
      '<button type="submit" class="tk-msg-send" id="tk-msg-send" aria-label="Send message" disabled>' +
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>' +
      '</button>' +
      '</form>' +
      '</section>' +
      '</div>';

    els.panel = panel;
    els.listView = panel.querySelector('.tk-msg-listview');
    els.threadView = panel.querySelector('.tk-msg-threadview');
    els.contacts = panel.querySelector('#tk-msg-contacts');
    els.search = panel.querySelector('#tk-msg-search');
    els.headerBadge = panel.querySelector('.tk-msg-panel__badge');
    els.thread = panel.querySelector('#tk-msg-thread');
    els.threadName = panel.querySelector('#tk-msg-thread-name');
    els.threadSub = panel.querySelector('#tk-msg-thread-sub');
    els.threadAvatar = panel.querySelector('#tk-msg-thread-avatar');
    els.composer = panel.querySelector('#tk-msg-composer');
    els.input = panel.querySelector('#tk-msg-input');
    els.send = panel.querySelector('#tk-msg-send');
    els.status = panel.querySelector('#tk-msg-status');

    return panel;
  }

  function bindEvents() {
    els.panel.addEventListener('click', (event) => {
      const action = event.target.closest('[data-msg-action]');
      if (action) {
        const name = action.getAttribute('data-msg-action');
        if (name === 'close') closePanel();
        if (name === 'back') showList();
        if (name === 'retry') {
          state.contactsView = '';
          refreshContacts();
        }
        return;
      }

      const contactButton = event.target.closest('[data-contact-id]');
      if (contactButton) {
        const id = contactButton.getAttribute('data-contact-id');
        const contact = state.contacts.find((item) => item.id === id);
        if (contact) selectContact(contact);
      }
    });

    els.search.addEventListener('input', () => {
      state.search = els.search.value.trim();
      renderContacts();
    });

    els.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      sendMessage();
    });

    els.input.addEventListener('input', () => {
      autoGrowInput();
      noteTyping();
    });

    els.input.addEventListener('blur', stopTyping);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopTyping();
      } else if (state.open && state.view === 'thread') {
        // Returning to the tab: catch up immediately instead of waiting for
        // the next tick of the interval.
        pollUpdates();
      }
    });

    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !state.open) return;
      if (state.view === 'thread') showList();
      else closePanel();
    });

    document.addEventListener('click', (event) => {
      if (!state.open) return;
      if (els.panel.contains(event.target)) return;
      if (els.launchers.some((launcher) => launcher.contains(event.target))) return;
      closePanel();
    });

    window.addEventListener('focus', () => {
      if (!state.open) refreshUnread();
    });
  }

  function init() {
    if (document.getElementById('tk-msg-panel')) return;

    const sidebar = document.querySelector('.sidebar');
    const panel = buildPanel();
    const sidebarLauncher = buildLauncher(false);
    const floatingLauncher = buildLauncher(true);

    if (sidebar) {
      sidebar.classList.add('has-tk-msg');
      sidebar.appendChild(sidebarLauncher);
    } else {
      sidebarLauncher.classList.add('tk-msg-launcher--floating');
    }
    document.body.appendChild(floatingLauncher);
    document.body.appendChild(panel);

    bindEvents();
    refreshUnread();
    startBadgePolling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // Public hook: the dashboards use `openWith(traineeId)` from their own
  // "Message" buttons; the rest is available for debugging.
  window.TrackITMessenger = {
    open: openPanel,
    close: closePanel,
    openWith,
    refresh: refreshUnread,
    isOpen: () => state.open,
  };
})();
