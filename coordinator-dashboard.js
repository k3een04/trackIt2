const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port !== '5000' && window.location.port !== ''
  ? 'http://localhost:5000/api'
  : '/api';

/**
 * Show notification to user
 */
function showNotification(title, message, type = 'info') {
  let notificationContainer = document.getElementById('notification-container');
  if (!notificationContainer) {
    notificationContainer = document.createElement('div');
    notificationContainer.id = 'notification-container';
    notificationContainer.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999; max-width: 400px;';
    document.body.appendChild(notificationContainer);
  }

  const notificationEl = document.createElement('div');
  const toastType = type === 'success' || type === 'error' ? type : 'info';
  notificationEl.className = `trackit-toast trackit-toast-${toastType}`;
  notificationEl.style.cssText = `
    padding: 16px;
    border-radius: 8px;
    margin-bottom: 10px;
    animation: slideIn 0.3s ease-out;
  `;

  notificationEl.innerHTML = `
    <p style="margin: 0; font-weight: 600; font-size: 14px;">${title}</p>
    <p style="margin: 5px 0 0 0; font-size: 12px;">${message}</p>
  `;

  notificationContainer.appendChild(notificationEl);

  // Auto-remove after 5 seconds
  setTimeout(() => {
    notificationEl.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => notificationEl.remove(), 300);
  }, 5000);
}

// Add CSS animations for notifications
if (!document.querySelector('style[data-notifications]')) {
  const style = document.createElement('style');
  style.setAttribute('data-notifications', 'true');
  style.textContent = `
    @keyframes slideIn {
      from {
        transform: translateX(400px);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }
    @keyframes slideOut {
      from {
        transform: translateX(0);
        opacity: 1;
      }
      to {
        transform: translateX(400px);
        opacity: 0;
      }
    }
  `;
  document.head.appendChild(style);
}

// ────────────────────────────────────────────────────────────────────────────
// THEME TOGGLE
// ────────────────────────────────────────────────────────────────────────────

function initializeTheme() {
  const savedTheme = localStorage.getItem('trackit_theme') || 'dark';
  applyTheme(savedTheme);
  const themeToggleBtn = document.getElementById('theme-toggle');
  if (themeToggleBtn) {
    if (savedTheme === 'light') themeToggleBtn.classList.add('light-mode');
    else themeToggleBtn.classList.remove('light-mode');
  }
}

function toggleTheme() {
  const body = document.body;
  const themeToggleBtn = document.getElementById('theme-toggle');
  const currentTheme = body.classList.contains('light-mode') ? 'light' : 'dark';
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';

  body.classList.add('theme-fade');

  if (themeToggleBtn) {
    themeToggleBtn.classList.add('rotating');
    setTimeout(() => {
      themeToggleBtn.classList.remove('rotating');
    }, 400);
  }

  applyTheme(newTheme);
  localStorage.setItem('trackit_theme', newTheme);

  if (themeToggleBtn) {
    if (newTheme === 'light') themeToggleBtn.classList.add('light-mode');
    else themeToggleBtn.classList.remove('light-mode');
  }

  setTimeout(() => {
    body.classList.remove('theme-fade');
  }, 350);
}

// ────────────────────────────────────────────────────────────────────────────
// NOTIFICATION BELL POPUP
// ────────────────────────────────────────────────────────────────────────────

let coordinatorNotifications = [];
let notifPopupOpen = false;
let notifLoading = false;
let notifError = '';
let notifUnreadCount = 0;
let notifPollTimer = null;

function toggleNotifications() {
  const popup = document.getElementById('notif-popup');
  if (!popup) return;
  
  if (notifPopupOpen) {
    popup.style.display = 'none';
    notifPopupOpen = false;
  } else {
    popup.style.display = 'flex';
    notifPopupOpen = true;
    // Always refetch on open so a notification created while the dashboard was
    // already loaded shows up without a full page refresh.
    loadCoordinatorNotifications();
  }
}

function closeNotifications() {
  const popup = document.getElementById('notif-popup');
  if (popup) popup.style.display = 'none';
  notifPopupOpen = false;
}

/** "Mark all read" - marks every notification read on the server. */
async function clearAllNotifications() {
  if (coordinatorNotifications.length === 0) return;
  try {
    await fetchAPI('/notifications/read-all', { method: 'PATCH' });
  } catch (error) {
    console.error('Error marking all notifications read:', error);
  }
  coordinatorNotifications = coordinatorNotifications.map(n => ({ ...n, unread: false, read: true }));
  notifUnreadCount = 0;
  renderNotificationList();
  updateNotifBadge();
}

/** Dismisses one notification: persisted as read, then hidden locally. */
async function dismissNotification(id) {
  const target = coordinatorNotifications.find(n => n.id === id);
  if (target && target.unread) {
    try {
      await fetchAPI(`/notifications/${id}/read`, { method: 'PATCH' });
    } catch (error) {
      console.error('Error marking notification read:', error);
    }
    notifUnreadCount = Math.max(0, notifUnreadCount - 1);
  }
  coordinatorNotifications = coordinatorNotifications.filter(n => n.id !== id);
  renderNotificationList();
  updateNotifBadge();
}

/** "Clear all" - permanently deletes every notification for this user. */
function deleteAllNotifications() {
  if (coordinatorNotifications.length === 0) return;

  VerificationModal.open({
    type: 'confirm',
    title: 'Clear All Notifications',
    description: 'Every notification for this account will be permanently removed.',
    warning: 'This cannot be undone.',
    confirmLabel: 'Clear Notifications',
    onConfirm: async () => {
      try {
        await fetchAPI('/notifications', { method: 'DELETE' });
      } catch (error) {
        console.error('Error clearing notifications:', error);
      }
      coordinatorNotifications = [];
      notifUnreadCount = 0;
      renderNotificationList();
      updateNotifBadge();
    },
  });
}

function updateNotifBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  
  if (notifUnreadCount > 0) {
    badge.style.display = 'flex';
    badge.textContent = notifUnreadCount > 9 ? '9+' : notifUnreadCount;
  } else {
    badge.style.display = 'none';
  }
}

/**
 * Loads the notifications that belong to the logged-in coordinator.
 * The backend scopes every query to the JWT user id, so a coordinator only ever
 * sees their own notifications and never another user's.
 */
async function loadCoordinatorNotifications(options = {}) {
  const { silent = false } = options;
  if (notifLoading) return;
  notifLoading = true;
  if (!silent) {
    notifError = '';
    renderNotificationList();
  }
  const signatureBefore = notificationSignature();

  try {
    const result = await fetchAPI('/notifications?limit=20');
    if (result && result.success) {
      coordinatorNotifications = result.data || [];
      notifUnreadCount = Number(result.unreadCount) || 0;
      notifError = '';
    } else {
      notifError = (result && result.message) || 'Could not load notifications';
      coordinatorNotifications = [];
      notifUnreadCount = 0;
    }
  } catch (error) {
    console.error('Error loading notifications:', error);
    notifError = 'Could not load notifications';
    coordinatorNotifications = [];
    notifUnreadCount = 0;
  } finally {
    notifLoading = false;
    // Rebuilding an unchanged list while the bell popup is open resets its
    // scroll position for nothing, so a silent poll that found nothing new
    // leaves it alone. With the popup closed the redraw is invisible, so it
    // still runs and keeps the relative timestamps fresh for the next open.
    const unchanged = notificationSignature() === signatureBefore;
    if (!(silent && unchanged && notifPopupOpen)) {
      renderNotificationList();
    }
    updateNotifBadge();
  }
}

/**
 * Just enough of the list to tell "nothing arrived" from "something did".
 * The relative timestamps are deliberately excluded - they always differ.
 */
function notificationSignature() {
  return JSON.stringify({
    error: notifError,
    items: coordinatorNotifications.map(n => `${n.id}|${n.unread ? 1 : 0}`),
  });
}

function renderNotificationList() {
  const list = document.getElementById('notif-list');
  if (!list) return;

  if (notifLoading) {
    list.innerHTML = '<div class="notif-empty">Loading notifications…</div>';
    return;
  }

  if (notifError) {
    list.innerHTML = `
      <div class="notif-empty">
        <p>${escapeHtml(notifError)}</p>
        <button onclick="loadCoordinatorNotifications()" class="text-xs text-blue-400 hover:underline mt-2">Retry</button>
      </div>`;
    return;
  }
  
  if (coordinatorNotifications.length === 0) {
    list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
    return;
  }
  
  list.innerHTML = coordinatorNotifications.map(n => `
    <div class="notif-item ${n.unread ? 'unread' : ''}" data-id="${n.id}">
      <div class="notif-icon ${escapeHtml(n.type || 'system')}">
        ${getNotifIcon(n.type)}
      </div>
      <div class="notif-content">
        <p class="notif-text font-semibold">${escapeHtml(n.title || 'Notification')}</p>
        <p class="notif-text">${escapeHtml(n.message || n.text || '')}</p>
        <p class="notif-time">${timeAgo(n.createdAt || n.time)}</p>
      </div>
      <button class="notif-close" onclick="event.stopPropagation(); dismissNotification('${n.id}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  `).join('');
  
  // Click to mark as read (persisted on the server, not just locally).
  list.querySelectorAll('.notif-item').forEach(item => {
    item.addEventListener('click', function() {
      const id = this.dataset.id;
      const notif = coordinatorNotifications.find(n => n.id === id);
      if (notif && notif.unread) {
        fetchAPI(`/notifications/${id}/read`, { method: 'PATCH' })
          .then(() => {
            notif.unread = false;
            notif.read = true;
            notifUnreadCount = Math.max(0, notifUnreadCount - 1);
            updateNotifBadge();
            renderNotificationList();
          })
          .catch(err => console.error('Error marking notification read:', err));
      }
    });
  });
}

/**
 * Lightweight refresh. The project has no live push channel (Socket.io is
 * disabled in the backend), so the bell is polled on a timer and refetched
 * whenever the tab regains focus.
 */
function startNotificationPolling() {
  if (notifPollTimer) clearInterval(notifPollTimer);
  notifPollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      loadCoordinatorNotifications({ silent: true });
    }
  }, 60000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadCoordinatorNotifications({ silent: true });
    }
  });
}

function getNotifIcon(type) {
  const icons = {
    journal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
    attendance: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
    dtr: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>',
    system: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
    inactivity: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    activity: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 11.08 12 1 2 11.08"></polyline><polyline points="5 19 12 12 19 19"></polyline></svg>'
  };
  return icons[type] || icons.system;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);
  
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Close popup when clicking outside
document.addEventListener('click', function(e) {
  const notifBtn = document.getElementById('notif-btn');
  const notifPopup = document.getElementById('notif-popup');
  if (notifBtn && notifPopup && notifPopupOpen) {
    if (!notifBtn.contains(e.target) && !notifPopup.contains(e.target)) {
      closeNotifications();
    }
  }
});

function applyTheme(theme) {
  const body = document.body;
  const themeIcon = document.getElementById('theme-icon');

  // The charts read their colours from the theme's CSS custom properties, so
  // everything must be repainted *after* the class change lands. Chart.js also
  // sizes its canvas from the container, so this runs on the next frame.
  const repaintCharts = () => {
    if (window.TrackITCharts && typeof window.TrackITCharts.refreshAll === 'function') {
      window.TrackITCharts.refreshAll();
    }
  };

  if (theme === 'light') {
    body.classList.add('light-mode');
    repaintCharts();
    if (themeIcon) {
      const moonIcon = themeIcon.querySelector('.moon-icon');
      const sunIcons = themeIcon.querySelectorAll('.sun-icon');
      if (moonIcon) {
        moonIcon.style.display = 'block';
        moonIcon.style.opacity = '0';
        requestAnimationFrame(() => { moonIcon.style.opacity = '1'; });
      }
      sunIcons.forEach(icon => {
        icon.style.opacity = '0';
        setTimeout(() => { icon.style.display = 'none'; }, 250);
      });
    }
  } else {
    body.classList.remove('light-mode');
    repaintCharts();
    if (themeIcon) {
      const moonIcon = themeIcon.querySelector('.moon-icon');
      const sunIcons = themeIcon.querySelectorAll('.sun-icon');
      if (moonIcon) {
        moonIcon.style.opacity = '0';
        setTimeout(() => { moonIcon.style.display = 'none'; }, 250);
      }
      sunIcons.forEach(icon => {
        icon.style.display = 'block';
        icon.style.opacity = '0';
        requestAnimationFrame(() => { icon.style.opacity = '1'; });
      });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION & API UTILITIES
// ────────────────────────────────────────────────────────────────────────────

function getAuthHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${window.authToken}`
  };
}

async function fetchAPI(endpoint, options = {}) {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: getAuthHeaders()
    });

    if (response.status === 401) {
      localStorage.removeItem('trackit_token');
      localStorage.removeItem('trackit_user');
      window.location.href = 'loginpage.html';
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('API Error:', error);
    return null;
  }
}

// Helper function to get elements by ID
function el(id) {
  return document.getElementById(id);
}

// ────────────────────────────────────────────────────────────────────────────
// BACKGROUND REFRESH
// ────────────────────────────────────────────────────────────────────────────
// The dashboard repaints itself on a timer, and that repaint has to be
// invisible: it never blanks a panel the coordinator is reading, never rebuilds
// DOM that did not change, and never lands while they are actively working.

// Minimum gap between automatic refreshes. Nothing in TrackIT moves faster
// than this, and the scheduler only fires while the tab is visible.
const REFRESH_MIN_GAP_MS = 45000;

// How often the scheduler wakes up to check whether a refresh is due. Kept
// short so a refresh postponed by user input is retried rather than dropped.
const REFRESH_TICK_MS = 10000;

// How long after the last real user input an automatic refresh waits.
const REFRESH_GRACE_MS = 1200;

let lastInteractionAt = 0;
let lastRefreshAt = 0;

/** Records genuine user input so refreshes can stay out of its way. */
function markInteraction() {
  lastInteractionAt = Date.now();
}

/** True once the coordinator has stopped interacting long enough. */
function interactionSettled() {
  return Date.now() - lastInteractionAt >= REFRESH_GRACE_MS;
}

// JSON of what each section currently displays, keyed by section. Absent until
// that section has painted its first payload, so a first load always renders.
const paintedPayloads = Object.create(null);

/**
 * Compares `next` with what a section already shows and records it as the
 * newly shown payload. Returns false when the section is up to date, letting
 * the caller skip the DOM write entirely.
 */
function paintOnce(key, next) {
  const serialized = JSON.stringify(next);
  if (paintedPayloads[key] === serialized) return false;
  paintedPayloads[key] = serialized;
  return true;
}

/** Marks a section stale so the next result repaints it no matter what. */
function forgetPainted(key) {
  delete paintedPayloads[key];
}

/** Fills a profile field only while nobody is typing into it. */
function fillInputIfIdle(id, value) {
  const input = document.getElementById(id);
  if (!input) return;
  // Writing .value on a focused field jumps the caret and eats characters, so
  // an automatic pass always leaves whatever is being edited alone.
  if (document.activeElement === input) return;
  if (input.value !== value) input.value = value;
}

/** True while the paginated "All Students" modal is on screen. */
function allTraineesModalOpen() {
  const modal = document.getElementById('all-trainees-modal');
  return Boolean(modal) && !modal.classList.contains('hidden');
}

/** Starts the listeners that tell the refresh loop when to hold off. */
function startInteractionTracking() {
  const mark = () => markInteraction();
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(type => {
    document.addEventListener(type, mark, { passive: true, capture: true });
  });
}

async function loadDashboardData(options = {}) {
  const background = options.background === true;

  // Update profile info from stored user
  if (window.currentUser) {
    fillInputIfIdle('coord-name', window.currentUser.fullName || '');
    fillInputIfIdle('coord-email', window.currentUser.email || '');
    fillInputIfIdle('coord-dept', window.currentUser.department || '');
  }

  // Fetch the chart stats and the Overview card data together. They are
  // independent calls: one failing must not blank out the other.
  const [result] = await Promise.all([
    fetchAPI('/stats/coordinator'),
    loadOverviewWidgets({ background }),
  ]);

  if (!result || !result.success) return;

  const { stats, departmentBreakdown, trainees } = result.data;

  // The charts are built once and the settings summary only moves when the
  // roster does, so an unchanged payload costs nothing to skip.
  if (!paintOnce('overview', { stats, departmentBreakdown, trainees })) return;

  // Store stats for chart rendering
  window.overviewStats = stats;
  overviewStatsPayload = { stats, departmentBreakdown, trainees };
  renderOverviewSummary();

  // Update account summary in settings
  const settingsTraineeCount = document.querySelector('#settings .space-y-3');
  if (settingsTraineeCount) {
    const spans = settingsTraineeCount.querySelectorAll('.font-semibold');
    if (spans.length >= 5) {
      spans[3].textContent = stats.totalStudents;
      spans[4].textContent = stats.companyCount;
    }
  }

  // Store department data for charts
  window.deptData = departmentBreakdown;
}

// ────────────────────────────────────────────────────────────────────────────
// OVERVIEW: PENDING ACTIONS & DATA CARDS
// ────────────────────────────────────────────────────────────────────────────

// Defaults every payload is spread over, so a partial response can never leave
// a counter undefined.
const PENDING_ACTION_DEFAULTS = {
  journalReviews: 0,
  attendanceIssues: 0,
  inactiveTrainees: 0,
  missingJournals: 0,
};

const ATTENTION_TRAINEE_DEFAULTS = { late: [], inactive: [], missingJournal: [] };

// Latest counters from /stats/coordinator/overview. Held in memory so a local
// action (approving or returning a journal) can move the number immediately,
// without waiting for the next fetch to agree with the server.
let pendingActionCounts = { ...PENDING_ACTION_DEFAULTS };

// Trainee ids behind each attention counter. The Trainees tab filters against
// these, so clicking a counter lands on exactly the trainees it counted instead
// of re-deriving "late" / "inactive" / "missing" a second time.
let attentionTraineeIds = { ...ATTENTION_TRAINEE_DEFAULTS };

// Set once the cards have actually painted, so an empty first payload still
// renders instead of being mistaken for "nothing has changed".
let widgetsPainted = false;

// JSON of the three data-card blocks currently on screen (snapshot /
// attendance / journal tracker). Compared before repainting so an unchanged
// payload costs no DOM writes.
let paintedWidgetBlocks = null;

// Which sort the Trainee Progress Snapshot is showing. Kept across repaints so
// a background refresh never throws the coordinator back to the default order.
let snapshotSort = 'lowest';

// How many rows the snapshot previews before the "View All Trainees" link.
// Five keeps the panel a snapshot: the Overview should not turn into a table
// view, and the full roster is one click away on the Trainees tab.
const SNAPSHOT_PREVIEW_LIMIT = 5;

// Latest payloads behind the Overview summary row. The two endpoints load
// independently, so each card renders from whatever has actually arrived and
// keeps its skeleton until its own source lands.
let overviewStatsPayload = null;
let overviewWidgetsPayload = null;

/** Fills one KPI card, or leaves it in its skeleton state when `value` is null. */
function setKpiCard(id, value, note) {
  const card = document.getElementById(id);
  if (!card) return;

  const loading = value === null || value === undefined;
  card.classList.toggle('is-loading', loading);
  card.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (loading) return;

  const num = card.querySelector('.ov-kpi__num');
  if (num) num.textContent = String(value);

  const noteEl = card.querySelector('.ov-kpi__note-text');
  if (noteEl) noteEl.textContent = note || '';
}

/** Whole numbers keep the aggregate hours line readable: "1,240 of 4,860 hrs". */
function formatAggregateHours(value) {
  return Math.round(Number(value) || 0).toLocaleString();
}

function renderOverviewKpis() {
  const stats = overviewStatsPayload && overviewStatsPayload.stats;
  const pending = overviewWidgetsPayload && overviewWidgetsPayload.pendingActions;

  if (stats) {
    const departments = (overviewStatsPayload.departmentBreakdown || [])
      .filter(entry => entry && entry._id);
    setKpiCard('kpi-total', stats.totalStudents,
      departments.length
        ? `${departments.length} department${departments.length === 1 ? '' : 's'}`
        : 'Enrolled trainees');
  }

  // Active and Inactive are one arithmetic pair off the same 3-day rule:
  // Active = Total - Inactive, so the three KPIs can never contradict each
  // other the way the old account-flag based Active count did.
  if (pending) {
    const inactive = Number(pending.inactiveTrainees) || 0;
    setKpiCard('kpi-inactive', inactive,
      inactive > 0 ? 'No time-in for 3 consecutive days' : 'All trainees checked in');

    if (stats) {
      const total = Number(stats.totalStudents) || 0;
      const active = Math.max(0, total - inactive);
      setKpiCard('kpi-active', active, `Of ${total} enrolled`);
    }
  }
}

/** Paints whichever half of the Overview summary has data right now. */
function renderOverviewSummary() {
  renderOverviewKpis();
}

const PENDING_ACTION_ICONS = {
  journalReviews: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>',
  attendanceIssues: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
  inactiveTrainees: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><line x1="17" y1="8" x2="22" y2="13"></line><line x1="22" y1="8" x2="17" y2="13"></line></svg>',
  missingJournals: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>',
};

// Severity vocabulary, lifted straight from the Analytics attention list so the
// two views say the same thing about the same situation.
const PENDING_ACTION_LEVELS = {
  high: { cls: 'pending-action--high', label: 'Urgent' },
  medium: { cls: 'pending-action--medium', label: 'Warning' },
  low: { cls: 'pending-action--low', label: 'Notice' },
  info: { cls: 'pending-action--info', label: 'All clear' },
};

// The four categories the coordinator can act on. Deliberately closed: things
// the system does not actually track (evaluations, drafts, notifications) are
// not offered here.
//
// `level` is the severity Analytics already assigns that same situation:
//   journalReviews   -> "N journals awaiting your approval"      high
//   inactiveTrainees -> "N trainees missed 3 consecutive days"   high
//   missingJournals  -> close cousin of "journals still in draft" medium
//   attendanceIssues -> close cousin of "absent records"          low
// A count of 0 overrides the level to `info` (All clear), because the
// situation is that there is nothing to do.
const PENDING_ACTIONS = [
  { key: 'journalReviews', label: 'Journal Reviews', description: 'Journals waiting for coordinator review.', level: 'high' },
  { key: 'attendanceIssues', label: 'Attendance Issues', description: 'Trainees with a late attendance record in the last 30 days.', level: 'low' },
  { key: 'inactiveTrainees', label: 'Inactive Trainees', description: 'No time-in recorded for 3 consecutive OJT days.', level: 'high' },
  { key: 'missingJournals', label: 'Missing Journals', description: 'No journal submitted for the current OJT week.', level: 'medium' },
];

/**
 * Fetches the data behind the Overview's data cards (Pending Actions,
 * Trainee Progress Snapshot, Attendance This Week, Journal Submission Tracker).
 * Called alongside the regular Overview load, so the Overview refresh keeps
 * them all current without a dedicated timer of their own.
 *
 * Pass `{ background: true }` from the refresh loop: a background pass reports
 * failures by leaving the cards alone rather than swapping them for an error.
 */
async function loadOverviewWidgets(options = {}) {
  const background = options.background === true;
  const result = await fetchAPI('/stats/coordinator/overview');
  renderOverviewWidgets(result, { background });
  return result;
}

function renderOverviewWidgets(result, options = {}) {
  const background = options.background === true;

  if (!result || !result.success) {
    // A background blip must not turn working cards into an error panel; the
    // next successful pass paints them again either way.
    if (background) return;
    widgetsPainted = false;
    paintedWidgetBlocks = null;
    overviewWidgetsPayload = null;
    renderPendingActionsError();
    renderSnapshotError();
    renderAttendanceError();
    renderTrackerError();
    return;
  }

  const data = result.data || {};
  const nextCounts = { ...PENDING_ACTION_DEFAULTS, ...(data.pendingActions || {}) };
  const nextAttention = { ...ATTENTION_TRAINEE_DEFAULTS, ...(data.attentionTrainees || {}) };
  const nextBlocks = JSON.stringify({
    snapshot: data.snapshot || null,
    attendanceThisWeek: data.attendanceThisWeek || null,
    journalTracker: data.journalTracker || null,
  });

  // Summary cards read from this too, so store it before any early return.
  overviewWidgetsPayload = data;
  renderOverviewSummary();

  // Compared against what is on screen rather than what was last fetched:
  // adjustPendingAction() moves a counter locally, and the server's next
  // answer has to be able to win that argument.
  const alreadyShown =
    widgetsPainted &&
    JSON.stringify(nextCounts) === JSON.stringify(pendingActionCounts) &&
    JSON.stringify(nextAttention) === JSON.stringify(attentionTraineeIds) &&
    nextBlocks === paintedWidgetBlocks;

  if (alreadyShown) return;

  widgetsPainted = true;
  pendingActionCounts = nextCounts;
  attentionTraineeIds = nextAttention;
  paintedWidgetBlocks = nextBlocks;

  renderPendingActions();

  // A section whose block came back null (its own query failed) shows its
  // error state - but only on a foreground load, so a background blip never
  // wipes a card the coordinator is reading.
  if (data.snapshot || !background) renderSnapshot();
  if (data.attendanceThisWeek || !background) renderWeeklyAttendanceChart();
  if (data.journalTracker || !background) renderJournalTracker();

  // The trainee rows carry status chips derived from these ids, so repaint the
  // table whenever the attention sets move.
  if (traineesCache.length) renderTraineeViews();

  // A Pending Action may already have put the coordinator on the filtered
  // Trainees list before these ids arrived - re-run that filter now so the
  // table shows the trainees rather than an empty result.
  const attentionSelect = el('attention-filter');
  if (attentionSelect && attentionSelect.value && currentTab === 'trainees') {
    applyTraineeFilters();
  }
}

function renderPendingActions() {
  const container = el('pending-actions');
  if (!container) return;

  container.innerHTML = PENDING_ACTIONS.map(action => {
    const count = Number(pendingActionCounts[action.key]) || 0;
    // Nothing to do about a zero, so the row drops to "All clear" no matter how
    // serious the category normally is.
    const level = PENDING_ACTION_LEVELS[count > 0 ? action.level : 'info'];

    return `
      <button type="button" class="pending-action ${level.cls}" onclick="openPendingAction('${action.key}')"
        aria-label="${escapeHtml(action.label)}: ${count}. ${escapeHtml(level.label)}. ${escapeHtml(action.description)}">
        <span class="pending-action__icon" aria-hidden="true">${PENDING_ACTION_ICONS[action.key]}</span>
        <span class="pending-action__body">
          <span class="pending-action__label">${escapeHtml(action.label)}</span>
          <span class="pending-action__desc">${escapeHtml(action.description)}</span>
        </span>
        <span class="pending-action__count">${count}</span>
      </button>
    `;
  }).join('');
}

function renderPendingActionsError() {
  const container = el('pending-actions');
  if (!container) return;

  container.innerHTML =
    '<div class="empty-state">' +
    '<p class="empty-state__title">Pending actions unavailable</p>' +
    '<p class="empty-state__text">The latest counters could not be loaded.</p>' +
    '<button type="button" class="link-btn" onclick="loadOverviewWidgets()">Retry</button>' +
    '</div>';
}

/**
 * Trainee Progress Snapshot: sorted preview of verified hours, last time-in
 * and journal status. The select in the panel header drives this through the
 * inline `setSnapshotSort` handler.
 */
function setSnapshotSort(value) {
  snapshotSort = value || 'lowest';
  renderSnapshot();
}

function snapshotRowRate(row) {
  const required = Number(row && row.requiredHours) || 486;
  const completed = Number(row && row.completedHours) || 0;
  return required > 0 ? completed / required : 0;
}

function snapshotComparator(a, b) {
  switch (snapshotSort) {
    case 'highest':
      return snapshotRowRate(b) - snapshotRowRate(a);
    case 'least-recent': {
      const ta = a.lastTimeIn ? new Date(a.lastTimeIn).getTime() : null;
      const tb = b.lastTimeIn ? new Date(b.lastTimeIn).getTime() : null;
      if (ta === null && tb === null) return 0;
      if (ta === null) return -1;
      if (tb === null) return 1;
      return ta - tb;
    }
    case 'most-recent': {
      const ta = a.lastTimeIn ? new Date(a.lastTimeIn).getTime() : null;
      const tb = b.lastTimeIn ? new Date(b.lastTimeIn).getTime() : null;
      if (ta === null && tb === null) return 0;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    }
    case 'name':
      return String(a.fullName || '').localeCompare(String(b.fullName || ''));
    case 'lowest':
    default:
      return snapshotRowRate(a) - snapshotRowRate(b);
  }
}

/** Initials avatar - "Maria Santos" -> "MS". */
function traineeInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Journal chip for the snapshot table - same colours as the tracker cells. */
function snapshotJournalChip(status) {
  switch (status) {
    case 'submitted':
      return '<span class="chip chip--submitted">Submitted</span>';
    case 'reviewed':
      return '<span class="chip chip--reviewed">Reviewed</span>';
    case 'pending':
      return '<span class="chip chip--pending">Pending</span>';
    case 'missing':
      return '<span class="chip chip--missing">Missing</span>';
    default:
      return '<span class="cell-muted" title="OJT journal not due yet">—</span>';
  }
}

/** "Oct 8, 2026 · 4:02 PM", or null when there is no time-in yet. */
function formatTimeIn(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

function snapshotRowHtml(row) {
  const traineeId = jsStringArg(row.id);
  const name = row.fullName || 'Unnamed trainee';
  const completed = Number(row.completedHours) || 0;
  const required = Number(row.requiredHours) || 486;
  const percent = required > 0 ? Math.min(100, (completed / required) * 100) : 0;
  const timeIn = formatTimeIn(row.lastTimeIn);
  const hoursText = `${completed.toLocaleString('en-US', { maximumFractionDigits: 1 })} / ${required} hrs`;
  const inactiveChip = row.inactive ? '<span class="chip chip--inactive">Inactive</span>' : '';

  return `
    <tr>
      <td class="cell cell--trainee">
        <span class="snap-trainee">
          <span class="snap-avatar" aria-hidden="true">${escapeHtml(traineeInitials(name))}</span>
          <span class="snap-trainee__meta">
            <span class="cell__name">${escapeHtml(name)}</span>
            ${inactiveChip}
          </span>
        </span>
      </td>
      <td class="cell"><span class="snap-hours">${hoursText}</span></td>
      <td class="cell">
        <div class="snap-progress">
          <span class="progress-track snap-progress__track">
            <span class="progress-fill" style="width: ${percent}%"></span>
          </span>
          <span class="snap-progress__pct">${percent.toFixed(1)}%</span>
        </div>
      </td>
      <td class="cell snap-time ${timeIn ? '' : 'cell--muted'}">${timeIn ? escapeHtml(timeIn) : 'No time-in yet'}</td>
      <td class="cell">${snapshotJournalChip(row.journalStatus)}</td>
      <td class="cell">
        <button type="button" class="btn-ghost btn-ghost--sm"
          onclick="openSnapshotTrainee('${traineeId}')">View</button>
      </td>
    </tr>
  `;
}

function renderSnapshot() {
  const body = el('snapshot-body');
  if (!body) return;

  const snapshot = overviewWidgetsPayload && overviewWidgetsPayload.snapshot;
  if (!snapshot) {
    renderSnapshotError();
    return;
  }

  const rows = snapshot.trainees || [];
  if (rows.length === 0) {
    body.innerHTML = tableStateHtml(
      'No trainees found',
      'Enrolled trainees will appear here with their hours and journal status.',
      "switchTab('trainees')",
      'Manage Trainees',
      6
    );
    return;
  }

  const sorted = rows.slice().sort(snapshotComparator);
  body.innerHTML = sorted.slice(0, SNAPSHOT_PREVIEW_LIMIT).map(snapshotRowHtml).join('');
}

function renderSnapshotError() {
  const body = el('snapshot-body');
  if (!body) return;
  body.innerHTML = tableStateHtml(
    'Unable to load trainee snapshot',
    'The verified-hours summary could not be loaded.',
    'loadOverviewWidgets()',
    'Try again',
    6
  );
}

function renderAttendanceError() {
  const container = el('attendance-chart-container');
  const overlay = el('attendance-chart-overlay');
  if (!container) return;
  container.style.display = 'none';
  if (!overlay) return;
  overlay.hidden = false;
  const title = overlay.querySelector('.empty-state__title');
  const text = overlay.querySelector('.empty-state__text');
  if (title) title.textContent = 'Unable to load attendance';
  if (text) text.textContent = 'The weekly attendance chart could not be loaded. Try again.';
}

let weeklyAttendanceChart = null;
let currentAttendanceWeekStart = null;

/**
 * Weekly Attendance: grouped horizontal bar chart with per-day breakdown.
 * Shows Present, Late, Absent as separate bars for each weekday.
 */
function renderWeeklyAttendanceChart() {
  const container = el('attendance-chart-container');
  const overlay = el('attendance-chart-overlay');
  const canvas = el('weeklyAttendanceChart');
  const weekSelect = el('attendance-week-select');
  if (!container || !canvas) return;

  const data = overviewWidgetsPayload && overviewWidgetsPayload.attendanceThisWeek;
  if (!data || !data.days || data.days.length === 0) {
    container.style.display = 'none';
    if (overlay) {
      overlay.hidden = false;
      // Reset the copy in case the error state swapped it earlier.
      const title = overlay.querySelector('.empty-state__title');
      const text = overlay.querySelector('.empty-state__text');
      if (title) title.textContent = 'No attendance data';
      if (text) text.textContent = 'Attendance records will appear here once trainees time in.';
    }
    if (weekSelect) weekSelect.innerHTML = '<option value="">Current Week</option>';
    return;
  }

  container.style.display = 'flex';
  if (overlay) overlay.hidden = true;

  // Populate week selector with available weeks (current + past weeks with data)
  populateWeekSelector(data.weekStart);

  // Prepare chart data
  const days = data.days;
  const labels = days.map(d => d.dayLabel);
  const presentData = days.map(d => d.present.count);
  const lateData = days.map(d => d.late.count);
  const absentData = days.map(d => d.absent.count);

  // Store day details for tooltip callbacks
  const dayDetails = days.map(d => ({
    dayLabel: d.dayLabel,
    date: d.date,
    present: { count: d.present.count, trainees: d.present.trainees },
    late: { count: d.late.count, trainees: d.late.trainees },
    absent: { count: d.absent.count, trainees: d.absent.trainees },
  }));

  // Calculate max value for axis
  const maxValue = Math.max(
    ...presentData,
    ...lateData,
    ...absentData
  );
  const suggestedMax = Math.max(5, Math.ceil(maxValue * 1.2 / 5) * 5);

  const chartData = {
    labels,
    datasets: [
      window.TrackITCharts.styleDataset({
        label: 'Present',
        data: presentData,
        key: 'present',
      }, { accent: window.TrackITCharts.accent.green, fill: 'flat' }),
      window.TrackITCharts.styleDataset({
        label: 'Late',
        data: lateData,
        key: 'late',
      }, { accent: window.TrackITCharts.accent.gold, fill: 'flat' }),
      window.TrackITCharts.styleDataset({
        label: 'Absent',
        data: absentData,
        key: 'absent',
      }, { accent: window.TrackITCharts.accent.red, fill: 'flat' }),
    ],
    dayDetails,
  };

  const ctx = canvas.getContext('2d');

  if (weeklyAttendanceChart) {
    weeklyAttendanceChart.data = chartData;
    weeklyAttendanceChart.options.scales.y.suggestedMax = suggestedMax;
    weeklyAttendanceChart.update();
    return;
  }

  const options = TrackITCharts.barOptions({
    vertical: true,
    grouped: true,
    categoryCount: labels.length,
    datasetCount: 3,
    legend: true,
    legendPosition: 'bottom',
    xTitle: 'Day of Week',
    yTitle: 'Number of Trainees',
    valueFormatter: (value) => Math.round(value),
    showValues: true,
    valueMax: 15,
  });

  weeklyAttendanceChart = TrackITCharts.createBar(ctx, {
    data: chartData,
    options: options,
  });

  TrackITCharts.register(weeklyAttendanceChart);
}

function populateWeekSelector(selectedWeekStart) {
  const nativeSelect = el('attendance-week-select');
  const dropdown = el('attendance-week-dropdown');
  const trigger = el('attendance-week-trigger');
  const valueEl = el('attendance-week-value');
  if (!nativeSelect || !dropdown) return;

  const now = new Date();
  // Always use actual current week as base for generating options
  const actualCurrentWeekStart = startOfDay(addDays(now, now.getDay() === 0 ? -6 : 1 - now.getDay()));
  const nativeOptions = [];
  const customOptions = [];

  // Generate past 8 weeks including current (always from actual current week)
  for (let i = 0; i < 8; i += 1) {
    const weekStart = addDays(actualCurrentWeekStart, -i * 7);
    const weekEnd = addDays(weekStart, 4);
    const isCurrent = i === 0;
    const label = isCurrent
      ? `This Week (${formatShortDate(weekStart)} – ${formatShortDate(weekEnd)})`
      : `${formatShortDate(weekStart)} – ${formatShortDate(weekEnd)}`;
    const value = dayKey(weekStart);
    const isSelected = selectedWeekStart && dayKey(selectedWeekStart) === value;

    // Native select option
    nativeOptions.push(`<option value="${value}" ${isSelected ? 'selected' : ''}>${label}</option>`);

    // Custom dropdown option
    customOptions.push(`
      <button type="button"
        class="week-picker__option ${isSelected ? 'week-picker__option--selected' : ''}"
        data-value="${value}"
        role="option"
        aria-selected="${isSelected}"
        onclick="selectWeekPickerOption(this, '${value}')">
        <span class="week-picker__option-dot" aria-hidden="true"></span>
        <span class="week-picker__option-text">${escapeHtml(label)}</span>
        ${isCurrent ? '<span class="week-picker__option-current">Current</span>' : ''}
      </button>
    `);
  }

  // If selected week is older than 8 weeks, add it as an option
  if (selectedWeekStart) {
    const selectedKey = dayKey(selectedWeekStart);
    const exists = nativeOptions.some(opt => opt.includes(`value="${selectedKey}"`));
    if (!exists) {
      const weekStart = new Date(selectedWeekStart);
      const weekEnd = addDays(weekStart, 4);
      const label = `${formatShortDate(weekStart)} – ${formatShortDate(weekEnd)}`;
      nativeOptions.unshift(`<option value="${selectedKey}" selected>${label}</option>`);
      customOptions.unshift(`
        <button type="button"
          class="week-picker__option week-picker__option--selected"
          data-value="${selectedKey}"
          role="option"
          aria-selected="true"
          onclick="selectWeekPickerOption(this, '${selectedKey}')">
          <span class="week-picker__option-dot" aria-hidden="true"></span>
          <span class="week-picker__option-text">${escapeHtml(label)}</span>
        </button>
      `);
    }
  }

  nativeSelect.innerHTML = nativeOptions.join('');
  dropdown.innerHTML = customOptions.join('');

  // Update trigger display
  if (valueEl) {
    const selectedOpt = nativeOptions.find(opt => opt.includes('selected'));
    if (selectedOpt) {
      const match = selectedOpt.match(/>([^<]+)</);
      if (match) valueEl.textContent = match[1];
    } else if (nativeOptions.length > 0) {
      const match = nativeOptions[0].match(/>([^<]+)</);
      if (match) valueEl.textContent = match[1];
    }
  }

  // Set initial aria-expanded
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function selectWeekPickerOption(button, value) {
  const nativeSelect = el('attendance-week-select');
  const dropdown = el('attendance-week-dropdown');
  const trigger = el('attendance-week-trigger');
  const valueEl = el('attendance-week-value');

  // Update native select
  if (nativeSelect) nativeSelect.value = value;

  // Update custom dropdown selection
  if (dropdown) {
    dropdown.querySelectorAll('.week-picker__option').forEach(opt => {
      const isSelected = opt.dataset.value === value;
      opt.classList.toggle('week-picker__option--selected', isSelected);
      opt.setAttribute('aria-selected', isSelected);
    });
  }

  // Update trigger display
  if (valueEl) valueEl.textContent = button.querySelector('.week-picker__option-text').textContent;

  // Close dropdown
  closeWeekPicker();

  // Load chart for selected week
  loadAttendanceChart(value);
}

function toggleWeekPicker() {
  const dropdown = el('attendance-week-dropdown');
  const trigger = el('attendance-week-trigger');
  if (!dropdown || !trigger) return;

  const isOpen = !dropdown.classList.contains('is-hidden');
  if (isOpen) {
    closeWeekPicker();
  } else {
    openWeekPicker();
  }
}

function openWeekPicker() {
  const dropdown = el('attendance-week-dropdown');
  const trigger = el('attendance-week-trigger');
  if (!dropdown || !trigger) return;

  dropdown.classList.remove('is-hidden');
  trigger.setAttribute('aria-expanded', 'true');

  // Focus the selected option
  const selected = dropdown.querySelector('[aria-selected="true"]');
  if (selected) selected.focus();
}

function closeWeekPicker() {
  const dropdown = el('attendance-week-dropdown');
  const trigger = el('attendance-week-trigger');
  if (!dropdown || !trigger) return;

  dropdown.classList.add('is-hidden');
  trigger.setAttribute('aria-expanded', 'false');
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const picker = document.getElementById('attendance-week-picker');
  if (picker && !picker.contains(e.target)) {
    closeWeekPicker();
  }
});

// Keyboard navigation for dropdown
document.addEventListener('keydown', (e) => {
  const dropdown = el('attendance-week-dropdown');
  const trigger = el('attendance-week-trigger');
  if (!dropdown || !trigger) return;

  if (dropdown.classList.contains('is-hidden')) {
    if (trigger === document.activeElement && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openWeekPicker();
    }
    return;
  }

  const options = dropdown.querySelectorAll('.week-picker__option');
  const currentIndex = Array.from(options).findIndex(opt => opt === document.activeElement);

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const nextIndex = currentIndex < options.length - 1 ? currentIndex + 1 : 0;
    options[nextIndex]?.focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : options.length - 1;
    options[prevIndex]?.focus();
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (document.activeElement.classList.contains('week-picker__option')) {
      selectWeekPickerOption(document.activeElement, document.activeElement.dataset.value);
    }
  } else if (e.key === 'Escape') {
    closeWeekPicker();
    trigger?.focus();
  } else if (e.key === 'Tab') {
    closeWeekPicker();
  }
});

/**
 * Load attendance chart for a specific week
 */
async function loadAttendanceChart(weekStart) {
  if (!weekStart) {
    // Reload current week from overview widgets
    await loadOverviewWidgets({ background: false });
    renderWeeklyAttendanceChart();
    return;
  }

  const container = el('attendance-chart-container');
  const overlay = el('attendance-chart-overlay');
  const canvas = el('weeklyAttendanceChart');
  if (!container || !canvas) return;

  // Show loading state
  container.style.display = 'flex';
  if (overlay) {
    overlay.hidden = false;
    overlay.innerHTML = '<div class="flex items-center justify-center gap-2"><div class="skel skel--chart" style="width: 200px; height: 100px;"></div></div>';
  }

  try {
    const result = await fetchAPI(`/stats/coordinator/overview?weekStart=${weekStart}`);
    if (result && result.success && result.data.attendanceThisWeek) {
      overviewWidgetsPayload.attendanceThisWeek = result.data.attendanceThisWeek;
      renderWeeklyAttendanceChart();
    } else {
      throw new Error('Failed to load attendance data');
    }
  } catch (error) {
    console.error('Error loading attendance chart:', error);
    if (overlay) {
      overlay.hidden = false;
      overlay.innerHTML = '<p class="empty-state__title">Unable to load attendance</p><p class="empty-state__text">Could not load data for the selected week.</p><button class="link-btn" onclick="loadAttendanceChart(\'' + weekStart + '\')">Retry</button>';
    }
  }
}

/**
 * Format date as YYYY-MM-DD for weekStart parameter
 */
function dayKey(date) {
  const d = new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function startOfDay(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function addDays(date, days) {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
}

const JOURNAL_STATUS_LABELS = {
  submitted: 'Submitted',
  reviewed: 'Reviewed',
  pending: 'Pending',
  missing: 'Missing',
  'not-due': 'Not Yet Due',
};

/**
 * Journal Submission Tracker: trainees × weeks grid up to the current OJT
 * week. Only cells backed by a real journal are clickable, and they deep-link
 * into the Journal Review tab where that journal can actually be reviewed.
 */
function renderJournalTracker() {
  const head = el('journal-tracker-head');
  const body = el('journal-tracker-body');
  if (!head || !body) return;

  const tracker = overviewWidgetsPayload && overviewWidgetsPayload.journalTracker;
  if (!tracker) {
    renderTrackerError();
    return;
  }

  const maxWeek = Number(tracker.maxWeek) || 0;
  const rows = tracker.trainees || [];
  const colspan = 1 + Math.max(maxWeek, 1);

  if (maxWeek < 1 || rows.length === 0) {
    head.innerHTML = '';
    body.innerHTML = tableStateHtml(
      'Nothing to track yet',
      'Weekly journal status appears here once trainees reach their first OJT week.',
      null,
      null,
      colspan
    );
    return;
  }

  let headerCells = '<th class="jt-name" scope="col">Trainee</th>';
  for (let week = 1; week <= maxWeek; week += 1) {
    headerCells += `<th scope="col" title="Week ${week}">W${week}</th>`;
  }
  head.innerHTML = `<tr>${headerCells}</tr>`;

  body.innerHTML = rows.map(row => {
    const cells = (row.cells || []).map(journalCellHtml).join('');
    return `
      <tr>
        <td class="jt-name"><span class="cell__name">${escapeHtml(row.fullName || 'Unnamed trainee')}</span></td>
        ${cells}
      </tr>
    `;
  }).join('');
}

function journalCellHtml(cell) {
  const status = cell.status || 'not-due';
  const label = JOURNAL_STATUS_LABELS[status] || status;
  const lines = [`Week ${cell.week}`, label];
  if (cell.submittedAt) lines.push(`Submitted: ${formatShortDate(cell.submittedAt)}`);
  if (cell.reviewedAt) lines.push(`Reviewed: ${formatShortDate(cell.reviewedAt)}`);
  const title = lines.map(escapeHtml).join('&#10;');
  const aria = lines.join(', ');

  const clickable = cell.journalId && (status === 'submitted' || status === 'pending' || status === 'reviewed');
  if (clickable) {
    return `
      <td class="jt-cell jt-cell--${status}">
        <button type="button" class="jt-dot" title="${title}" aria-label="${escapeHtml(aria)}"
          onclick="openJournalFromTracker('${jsStringArg(cell.journalId)}', '${status}')"></button>
      </td>
    `;
  }
  return `<td class="jt-cell jt-cell--${status}"><span class="jt-dot" title="${title}"></span></td>`;
}

function renderTrackerError() {
  const head = el('journal-tracker-head');
  const body = el('journal-tracker-body');
  if (!body) return;
  if (head) head.innerHTML = '';
  body.innerHTML = tableStateHtml(
    'Unable to load journal tracker',
    'The weekly submission grid could not be loaded.',
    'loadOverviewWidgets()',
    'Try again',
    2
  );
}

/**
 * Tracker cell click -> the Journal Review tab with that journal selected.
 * The list loads asynchronously, and its finishing filterJournals() clears any
 * selection made before it landed - so keep re-selecting until the selection
 * survives two passes. Give up quietly if the journal is not in the queue.
 */
function openJournalFromTracker(journalId, status) {
  const queue = status === 'reviewed' ? 'approved' : 'pending';
  markInteraction();
  switchTab('journal-review');

  let tries = 24;
  let stable = 0;
  const attempt = () => {
    const cache = journalDataCache[queue] || [];
    const found = cache.find(journal => String(journal._id) === String(journalId));
    if (!found) {
      if (--tries > 0) setTimeout(attempt, 250);
      return;
    }
    if (String(selectedJournalId || '') !== String(journalId)) {
      filterJournals(null, queue);
      const item = document.querySelector(`#journal-review .journal-item[onclick*="${journalId}"]`);
      if (item) selectJournal(item, journalId, queue);
    }
    stable = String(selectedJournalId || '') === String(journalId) ? stable + 1 : 0;
    if (stable >= 2 || --tries <= 0) return;
    setTimeout(attempt, 250);
  };
  setTimeout(attempt, 0);
}

/**
 * Snapshot View -> the Trainees tab with that row highlighted. Rows arrive
 * asynchronously (and may sit on another page), so the poll gives up quietly.
 */
function openSnapshotTrainee(traineeId) {
  markInteraction();
  switchTab('trainees');

  let tries = 24;
  const timer = setInterval(() => {
    const row = document.querySelector(`#trainees-table-body tr[data-trainee-id="${traineeId}"]`);
    if (row) {
      clearInterval(timer);
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('row-flash');
      setTimeout(() => row.classList.remove('row-flash'), 2400);
      return;
    }
    if (--tries <= 0) clearInterval(timer);
  }, 250);
}

/** Moves one counter locally (used right after the server confirms an action). */
function adjustPendingAction(key, delta) {
  if (!(key in pendingActionCounts)) return;
  pendingActionCounts[key] = Math.max(0, (Number(pendingActionCounts[key]) || 0) + delta);
  renderPendingActions();
}

/**
 * Each Pending Action jumps to where the coordinator can actually act on it.
 *
 * Journal Reviews go to the review queue, because that is exactly where those
 * journals sit. The other three go to the Trainees tab pre-filtered to the
 * trainees the counter counted: a missing journal cannot be fixed from the
 * review queue (nothing was submitted), so the useful destination is the list
 * of names to follow up on.
 */
function openPendingAction(action) {
  switch (action) {
    case 'journalReviews':
      switchTab('journal-review');
      filterJournals(null, 'pending');
      break;
    case 'attendanceIssues':
      openTraineesWithAttention('late');
      break;
    case 'inactiveTrainees':
      openTraineesWithAttention('inactive');
      break;
    case 'missingJournals':
      openTraineesWithAttention('missingJournal');
      break;
    default:
      break;
  }
}

/** Switch to the Trainees tab with an Attention preset already applied. */
function openTraineesWithAttention(preset) {
  const select = el('attention-filter');
  if (select) select.value = preset;
  switchTab('trainees');
  applyTraineeFilters();
}

// ────────────────────────────────────────────────────────────────────────────
// TAB SWITCHING
// ────────────────────────────────────────────────────────────────────────────

let tabHistory = [];
let currentTab = null;

function switchTab(tabName, options = {}) {
  const { fromHistory = false, direction = 'forward' } = options;

  // Moving around the dashboard counts as using it, so the refresh loop holds
  // off for a moment instead of repainting under the new view.
  markInteraction();

  const tabs = document.querySelectorAll('.tab-content');
  tabs.forEach(tab => tab.classList.remove('active'));

  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => link.classList.remove('active'));

  if (!fromHistory && currentTab && currentTab !== tabName) {
    tabHistory.push(currentTab);
  }
  currentTab = tabName;
  updateTabBackButton();

  const selectedTab = document.getElementById(tabName);
  if (selectedTab) {
    selectedTab.classList.add('active');
    selectedTab.classList.add(direction === 'back' ? 'is-entering-back' : 'is-entering');
    selectedTab.addEventListener('animationend', () => {
      selectedTab.classList.remove('is-entering', 'is-entering-back');
    }, { once: true });
    window.scrollTo(0, 0);
  }

  const activeNavLink = document.querySelector(`.nav-link[href="#${tabName}"]`);
  if (activeNavLink) {
    activeNavLink.classList.add('active');
  }

  // Opening a view pulls it up to date straight away, so freshness comes from
  // navigating rather than from a timer firing while the view is being read.
  // Both are silent no-ops when the data has not moved.
  if (tabName === 'overview') {
    loadDashboardData();
  }

  if (tabName === 'trainees') {
    loadTrainees();
  }

  // Initialize charts if on analytics tab
  if (tabName === 'analytics') {
    setTimeout(() => {
      loadAnalyticsData();
    }, 100);
  }

  if (tabName === 'journal-review') {
    loadCoordinatorJournals(currentJournalFilter);
  }

  // Close sidebar on mobile
  closeSidebarOnMobile();
}

function updateTabBackButton() {
  const backButton = document.getElementById('tab-back');
  if (!backButton) return;
  const hasHistory = tabHistory.length > 0;
  backButton.disabled = !hasHistory;
  backButton.classList.toggle('is-disabled', !hasHistory);

  // Overview is this dashboard's home, so a Back button there has nowhere to
  // go - the toolbar collapses instead of showing a dead control.
  const toolbar = backButton.closest('.tab-toolbar');
  if (toolbar) toolbar.classList.toggle('is-hidden', currentTab === 'overview');
}

function goBackTab() {
  if (tabHistory.length === 0) return;
  const previousTab = tabHistory.pop();
  switchTab(previousTab, { fromHistory: true, direction: 'back' });
}

// ────────────────────────────────────────────────────────────────────────────
// TRAINEES MANAGEMENT
// ────────────────────────────────────────────────────────────────────────────

// Cache for supervisors list
let supervisorsCache = [];

// Trainee list returned by the API — every render below reads from this cache
let traineesCache = [];

// How many trainees the Trainees tab previews before "See all students"
const TRAINEES_PREVIEW_LIMIT = 5;

// How many trainees are listed per page inside the "All Students" modal
const ALL_TRAINEES_PAGE_SIZE = 10;

// Shared sort state, so the Trainees tab and the "All Students" modal always
// show the same ordering (clicking a header in either place updates both)
let traineeSort = { key: 'name', dir: 'asc' };

// Current page of the "All Students" modal
let allTraineesPage = 1;

/** Shape-matched loading rows so the table never flashes an empty shell. */
function traineeTableSkeletonHtml(rows = 5, cols = 8) {
  const cell = '<td class="cell"><span class="skel skel--cell"></span></td>';
  return Array.from({ length: rows }, () => `<tr class="skel-row">${cell.repeat(cols)}</tr>`).join('');
}

/** Centered empty / error block that lives inside a table body. */
function tableStateHtml(title, text, retryAction, actionLabel = 'Retry', colspan = 8) {
  return `
    <tr class="state-row">
      <td colspan="${colspan}">
        <div class="empty-state">
          <p class="empty-state__title">${escapeHtml(title)}</p>
          <p class="empty-state__text">${escapeHtml(text)}</p>
          ${retryAction ? `<button type="button" class="link-btn" onclick="${escapeHtml(retryAction)}">${escapeHtml(actionLabel)}</button>` : ''}
        </div>
      </td>
    </tr>
  `;
}

async function loadTrainees(options = {}) {
  const background = options.background === true;
  const tbody = document.getElementById('trainees-table-body');
  if (!tbody) return;

  // The placeholder only appears while nothing has been painted yet. Swapping
  // visible rows for a loading state on every pass is what made the old
  // loop feel like it was fighting the reader.
  if (paintedPayloads.trainees === undefined) {
    tbody.innerHTML = traineeTableSkeletonHtml(5);
  }

  const result = await fetchAPI('/coordinator/trainees');

  if (!result || !result.success) {
    // Best-effort in the background: a blip keeps whatever is on screen and the
    // next pass tries again. A deliberate refresh still reports the failure,
    // and has to clear the painted payload because it just overwrote the table.
    if (background) return;

    traineesCache = [];
    forgetPainted('trainees');
    tbody.innerHTML = tableStateHtml(
      'Trainees could not be loaded',
      'Check that the server is running, then try again.',
      'loadTrainees()'
    );
    updateTraineesCountLabel(0, 0);
    return;
  }

  // The "All Students" modal repaginates off this list, so leave it alone until
  // it is closed rather than throwing the coordinator back to page one.
  if (background && allTraineesModalOpen()) return;

  const data = Array.isArray(result.data) ? result.data : [];
  if (!paintOnce('trainees', data)) return;

  traineesCache = data;
  addMissingFilterOptions();
  applyTraineeFilters();
}

// Escape a value so it can be safely embedded inside an inline onclick="" argument
function jsStringArg(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

/**
 * Active / inactive / late for a table row - the same three states the
 * Attention filter offers, so no new trainee category is introduced.
 */
function traineeStatusChip(trainee) {
  const id = String(trainee._id);
  const inactiveIds = attentionTraineeIds.inactive;
  const lateIds = attentionTraineeIds.late;

  if ((Array.isArray(inactiveIds) && inactiveIds.includes(id)) || trainee.isActive === false) {
    return '<span class="chip chip--inactive">Inactive</span>';
  }
  if (Array.isArray(lateIds) && lateIds.includes(id)) {
    return '<span class="chip chip--late">Late</span>';
  }
  return '<span class="chip chip--active">Active</span>';
}

// Build one trainee row — shared by the Trainees tab and the "All Trainees" modal
function buildTraineeRowHtml(trainee) {
  // The supervisor value is one unit (name + company) rather than loose inline
  // text: the stacked mobile card makes the cell a flex row, where a bare <br>
  // is not a line break but a zero-width flex item, so name and company were
  // squeezed into two side-by-side columns. Wrapping the pair in a block keeps
  // them together on mobile; on desktop the block holds the same inline flow
  // the cell used to hold directly, so nothing moves.
  const supervisorName = trainee.supervisorId
    ? `<span class="cell__sup"><span class="text-blue-400 font-semibold">${escapeHtml(trainee.supervisorId.fullName)}</span><br><span class="text-xs text-slate-500">${escapeHtml(trainee.supervisorId.companyName || '')}</span></span>`
    : '<span class="cell__sup"><span class="text-yellow-400/70 text-xs">Unassigned</span></span>';

  const completedHours = trainee.completedHours || 0;
  const requiredHours = trainee.requiredHours || 486;
  const remainingHours = Math.max(0, requiredHours - completedHours);
  const hoursPercentage = requiredHours > 0
    ? Math.min(100, Math.round((completedHours / requiredHours) * 100))
    : 0;

  return `
    <tr data-trainee-id="${trainee._id}">
      <td class="cell cell--trainee cell--stack-head">
        <button type="button" class="link-btn cell__name cell__name--link"
          onclick="openTraineeProfileModal('${jsStringArg(trainee._id)}')"
          title="Open the full OJT progress profile for ${jsStringArg(trainee.fullName)}"
          aria-label="View OJT profile of ${escapeHtml(trainee.fullName)}">${escapeHtml(trainee.fullName)}</button>
        ${traineeStatusChip(trainee)}
      </td>
      <td class="cell">${escapeHtml(trainee.studentId) || '—'}</td>
      <td class="cell">${escapeHtml(trainee.department) || '—'}</td>
      <td class="cell">${escapeHtml(trainee.section) || '—'}</td>
      <td class="cell cell--stack-hide">${escapeHtml(trainee.companyName) || '—'}</td>
      <td class="cell cell--muted">${supervisorName}</td>
      <td class="cell cell--stack-hide">
        <div class="hours-cell">
          <div class="hours-cell__value">${completedHours.toFixed(1)}/${requiredHours} hrs</div>
          <div class="hours-cell__left">${remainingHours.toFixed(1)} hrs left</div>
          <div class="progress-track hours-cell__track">
            <span class="progress-fill" style="width: ${hoursPercentage}%"></span>
          </div>
        </div>
      </td>
      <td class="cell cell--stack-actions">
        <div class="cell-actions">
          <button type="button" onclick="openTraineeProfileModal('${jsStringArg(trainee._id)}')"
            class="link-btn" title="View OJT progress, journals and DTR records">View</button>
          <button type="button" onclick="openAssignModal('${trainee._id}', '${jsStringArg(trainee.fullName)}')"
            class="link-btn">
            ${trainee.supervisorId ? 'Reassign' : 'Assign Supervisor'}
          </button>
        </div>
      </td>
    </tr>
  `;
}

async function loadSupervisors() {
  const result = await fetchAPI('/coordinator/supervisors');
  if (result && result.success) {
    supervisorsCache = result.data;
  }
}

function openAssignModal(traineeId, traineeName) {
  document.getElementById('assign-trainee-id').value = traineeId;
  document.getElementById('assign-trainee-name').textContent = traineeName;

  // Populate supervisor dropdown
  const select = document.getElementById('supervisor-select');
  if (supervisorsCache.length === 0) {
    select.innerHTML = '<option value="">No supervisors registered</option>';
  } else {
    select.innerHTML = '<option value="">— Select a Supervisor —</option>' +
      supervisorsCache.map(sup =>
        `<option value="${sup._id}">${sup.fullName} — ${sup.companyName || 'N/A'}</option>`
      ).join('');
  }

  // Reset supervisor info panel
  document.getElementById('supervisor-info').classList.add('hidden');

  // Show modal (lift to body level first so it isn't trapped in a hidden tab)
  const assignModal = document.getElementById('assign-supervisor-modal');
  if (assignModal && assignModal.parentElement !== document.body) document.body.appendChild(assignModal);
  assignModal?.classList.remove('hidden');

  // Listen for dropdown change to show supervisor details
  select.onchange = () => showSupervisorInfo(select.value);
}

function showSupervisorInfo(supervisorId) {
  const infoPanel = document.getElementById('supervisor-info');
  if (!supervisorId) {
    infoPanel.classList.add('hidden');
    return;
  }

  const sup = supervisorsCache.find(s => s._id === supervisorId);
  if (sup) {
    document.getElementById('sup-info-name').textContent = sup.fullName;
    document.getElementById('sup-info-company').textContent = sup.companyName || 'No company';
    document.getElementById('sup-info-position').textContent = sup.companyPosition || 'No position';
    infoPanel.classList.remove('hidden');
  }
}

async function confirmAssignSupervisor() {
  const traineeId = document.getElementById('assign-trainee-id').value;
  const supervisorId = document.getElementById('supervisor-select').value;

  if (!supervisorId) {
    showNotification('Error', 'Please select a supervisor', 'error');
    return;
  }

  const btn = document.getElementById('confirm-assign-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="animate-pulse">Assigning...</span>';

  const result = await fetchAPI('/coordinator/assign-supervisor', {
    method: 'POST',
    body: JSON.stringify({ traineeId, supervisorId }),
  });

  btn.disabled = false;
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Assign`;

  if (result && result.success) {
    showNotification('Error', result.message, 'error');
    closeAssignModal();
    loadTrainees(); // Refresh the table

    // If the profile modal is open for this trainee, refresh it in place so
    // the new supervisor appears without reopening the card.
    if (currentTraineeProfileId && String(currentTraineeProfileId) === String(traineeId)) {
      loadTraineeProfileData(traineeId);
    }
  } else {
    showNotification('Error', result?.message || 'Failed to assign supervisor', 'error');
  }
}

function closeAssignModal() {
  document.getElementById('assign-supervisor-modal').classList.add('hidden');
}

// Trainees matching the current search + department/section filters, ordered
// by the shared sort state (used by both the tab and the modal)
function getFilteredTrainees() {
  const search = (document.getElementById('trainee-search')?.value || '').trim().toLowerCase();
  const department = document.getElementById('dept-filter')?.value || '';
  const section = document.getElementById('section-filter')?.value || '';
  const attention = document.getElementById('attention-filter')?.value || '';

  const filtered = traineesCache.filter(trainee => {
    if (search) {
      const name = (trainee.fullName || '').toLowerCase();
      const studentId = (trainee.studentId || '').toLowerCase();
      if (!name.includes(search) && !studentId.includes(search)) return false;
    }
    if (department && (trainee.department || '') !== department) return false;
    if (section && (trainee.section || '') !== section) return false;
    if (attention && !matchesAttentionFilter(trainee, attention)) return false;
    return true;
  });

  return sortTraineeList(filtered);
}

/**
 * Attendance / inactivity / missing-journal membership. The ids come straight
 * from the Overview counters, so this filter shows exactly the trainees the
 * Pending Actions number counted - it never recomputes the rule itself.
 */
function matchesAttentionFilter(trainee, attention) {
  const ids = attentionTraineeIds[attention];
  if (!Array.isArray(ids) || ids.length === 0) return false;
  return ids.includes(String(trainee._id));
}

function getTraineeSortValue(trainee, key) {
  switch (key) {
    case 'studentId': return trainee.studentId || '';
    case 'department': return trainee.department || '';
    case 'section': return trainee.section || '';
    case 'hours': return Number(trainee.completedHours) || 0;
    case 'name':
    default: return trainee.fullName || '';
  }
}

function sortTraineeList(list) {
  const { key, dir } = traineeSort;
  const factor = dir === 'desc' ? -1 : 1;

  return list.slice().sort((a, b) => {
    const aValue = getTraineeSortValue(a, key);
    const bValue = getTraineeSortValue(b, key);

    if (typeof aValue === 'number' && typeof bValue === 'number') {
      return (aValue - bValue) * factor;
    }

    const compare = String(aValue).localeCompare(String(bValue), undefined, { numeric: true, sensitivity: 'base' });
    if (compare !== 0) return compare * factor;

    // Stable tie-breaker so equal values keep a predictable order
    return String(a.fullName || '').localeCompare(String(b.fullName || ''), undefined, { sensitivity: 'base' });
  });
}

// Clicking a sortable header in the tab OR in the modal updates the same state
function sortTrainees(key) {
  if (traineeSort.key === key) {
    traineeSort = { key, dir: traineeSort.dir === 'asc' ? 'desc' : 'asc' };
  } else {
    traineeSort = { key, dir: 'asc' };
  }

  allTraineesPage = 1;
  renderTraineeViews();
}

function updateTraineeSortIndicators() {
  document.querySelectorAll('[data-sort-indicator]').forEach(indicator => {
    const key = indicator.getAttribute('data-sort-indicator');
    indicator.textContent = key === traineeSort.key
      ? (traineeSort.dir === 'asc' ? '▲' : '▼')
      : '';
  });
}

function updateTraineesCountLabel(shown, total) {
  const label = document.getElementById('trainees-count-label');
  if (!label) return;

  const totalCount = Number.isFinite(total) ? total : shown;
  label.textContent = totalCount === 0
    ? 'Showing 0 of 0 trainees'
    : `Showing ${shown} of ${totalCount} trainee${totalCount === 1 ? '' : 's'}`;
}

// Re-render everything that depends on the trainee list, filters or sort
function renderTraineeViews() {
  renderTraineesTable();
  renderAllTraineesTable();
  updateTraineeSortIndicators();
}

// Trainees tab: only the first TRAINEES_PREVIEW_LIMIT matches are listed
function renderTraineesTable() {
  const tbody = document.getElementById('trainees-table-body');
  if (!tbody) return;

  const filtered = getFilteredTrainees();
  const seeAllLink = document.getElementById('see-all-trainees-link');

  if (filtered.length === 0) {
    const emptyMessage = traineesCache.length === 0
      ? tableStateHtml('No trainees yet', 'Registered trainees will appear here as soon as they are enrolled.')
      : tableStateHtml('No trainees match', 'Try a different search term or clear one of the filters.');
    tbody.innerHTML = emptyMessage;
    updateTraineesCountLabel(0, 0);
    if (seeAllLink) seeAllLink.classList.add('hidden');
    return;
  }

  const preview = filtered.slice(0, TRAINEES_PREVIEW_LIMIT);
  tbody.innerHTML = preview.map(buildTraineeRowHtml).join('');

  updateTraineesCountLabel(preview.length, filtered.length);

  if (seeAllLink) {
    seeAllLink.classList.toggle('hidden', filtered.length <= TRAINEES_PREVIEW_LIMIT);
  }
}

function applyTraineeFilters() {
  allTraineesPage = 1;
  renderTraineeViews();
}

// "All Students" modal: paginated, ALL_TRAINEES_PAGE_SIZE students per page
function renderAllTraineesTable() {
  const modal = document.getElementById('all-trainees-modal');
  if (!modal || modal.classList.contains('hidden')) return;

  const tbody = document.getElementById('all-trainees-table-body');
  const label = document.getElementById('all-trainees-count-label');
  const pagination = document.getElementById('all-trainees-pagination');
  const subtitle = document.getElementById('all-trainees-subtitle');
  if (!tbody) return;

  const filtered = getFilteredTrainees();
  const totalPages = Math.max(1, Math.ceil(filtered.length / ALL_TRAINEES_PAGE_SIZE));

  if (allTraineesPage > totalPages) allTraineesPage = totalPages;
  if (allTraineesPage < 1) allTraineesPage = 1;

  const start = (allTraineesPage - 1) * ALL_TRAINEES_PAGE_SIZE;
  const pageItems = filtered.slice(start, start + ALL_TRAINEES_PAGE_SIZE);

  tbody.innerHTML = pageItems.length === 0
    ? tableStateHtml('No trainees match', 'Try a different search term or clear one of the filters.')
    : pageItems.map(buildTraineeRowHtml).join('');

  if (label) {
    label.textContent = filtered.length === 0
      ? 'No trainees to show'
      : `Showing ${start + 1}-${start + pageItems.length} of ${filtered.length} trainee${filtered.length === 1 ? '' : 's'}`;
  }

  if (subtitle) {
    subtitle.textContent = `${filtered.length} trainee${filtered.length === 1 ? '' : 's'} · page ${allTraineesPage} of ${totalPages} · ${ALL_TRAINEES_PAGE_SIZE} per page`;
  }

  if (pagination) {
    pagination.innerHTML = buildTraineesPaginationHtml(allTraineesPage, totalPages);
  }
}

function buildTraineesPaginationHtml(currentPage, totalPages) {
  if (totalPages <= 1) return '';

  const parts = [];

  parts.push(currentPage === 1
    ? `<button type="button" disabled class="pager__btn">Prev</button>`
    : `<button type="button" onclick="goAllTraineesPage(${currentPage - 1})" class="pager__btn">Prev</button>`);

  const windowSize = 2;
  const firstPage = Math.max(1, currentPage - windowSize);
  const lastPage = Math.min(totalPages, currentPage + windowSize);
  const pageNumbers = [];

  if (firstPage > 1) {
    pageNumbers.push(1);
    if (firstPage > 2) pageNumbers.push('ellipsis');
  }
  for (let page = firstPage; page <= lastPage; page++) pageNumbers.push(page);
  if (lastPage < totalPages) {
    if (lastPage < totalPages - 1) pageNumbers.push('ellipsis');
    pageNumbers.push(totalPages);
  }

  pageNumbers.forEach(page => {
    if (page === 'ellipsis') {
      parts.push('<span class="pager__ellipsis">…</span>');
      return;
    }
    parts.push(page === currentPage
      ? `<button type="button" class="pager__btn pager__btn--current" aria-current="page">${page}</button>`
      : `<button type="button" onclick="goAllTraineesPage(${page})" class="pager__btn">${page}</button>`);
  });

  parts.push(currentPage === totalPages
    ? `<button type="button" disabled class="pager__btn">Next</button>`
    : `<button type="button" onclick="goAllTraineesPage(${currentPage + 1})" class="pager__btn">Next</button>`);

  return parts.join('');
}

function goAllTraineesPage(page) {
  allTraineesPage = page;
  renderAllTraineesTable();
}

// Opens with the exact same search, filters and sort as the Trainees tab
function openAllTraineesModal() {
  const modal = document.getElementById('all-trainees-modal');
  if (!modal) return;

  allTraineesPage = 1;
  modal.classList.remove('hidden');
  renderAllTraineesTable();
  updateTraineeSortIndicators();
}

function closeAllTraineesModal() {
  const modal = document.getElementById('all-trainees-modal');
  if (modal) modal.classList.add('hidden');
}

// Adds dropdown options for values that exist in the data but not in the markup
// (e.g. legacy departments on older student records)
function addMissingFilterOptions() {
  addMissingSelectOptions('dept-filter', traineesCache.map(trainee => trainee.department));
  addMissingSelectOptions('section-filter', traineesCache.map(trainee => trainee.section));
}

function addMissingSelectOptions(selectId, values) {
  const select = document.getElementById(selectId);
  if (!select) return;

  const existingValues = Array.from(select.options).map(option => option.value);
  const missingValues = [...new Set(
    values
      .filter(value => value !== null && value !== undefined && String(value).trim() !== '')
      .map(value => String(value))
  )].filter(value => !existingValues.includes(value));

  if (missingValues.length === 0) return;

  missingValues
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .forEach(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
}

function setupFilterListeners() {
  const searchInput = document.getElementById('trainee-search');
  const deptFilter = document.getElementById('dept-filter');
  const sectionFilter = document.getElementById('section-filter');
  const attentionFilter = document.getElementById('attention-filter');
  const allTraineesModal = document.getElementById('all-trainees-modal');

  if (searchInput) {
    searchInput.addEventListener('input', applyTraineeFilters);
  }
  if (deptFilter) {
    deptFilter.addEventListener('change', applyTraineeFilters);
  }
  if (sectionFilter) {
    sectionFilter.addEventListener('change', applyTraineeFilters);
  }
  if (attentionFilter) {
    attentionFilter.addEventListener('change', applyTraineeFilters);
  }

  // Close the "All Students" modal on backdrop click
  if (allTraineesModal) {
    allTraineesModal.addEventListener('click', (event) => {
      if (event.target === allTraineesModal) closeAllTraineesModal();
    });
  }
}

function viewTraineeProfile(traineeId) {
  showNotification('Notice', `Viewing profile for trainee: ${traineeId}`, 'info');
}

// ────────────────────────────────────────────────────────────────────────────
// JOURNAL REVIEW
// ────────────────────────────────────────────────────────────────────────────

let currentJournalFilter = 'pending';
let journalDataCache = {
  pending: [],
  approved: [],
  returned: []
};
let selectedJournalId = null;

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatShortDate(dateValue) {
  if (!dateValue) return 'N/A';
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function getStatusClass(status) {
  if (status === 'approved') return 'status-approved';
  if (status === 'returned') return 'status-returned';
  return 'status-pending';
}

function getStatusLabel(status, journal) {
  if (status === 'pending' && journal && journal.supervisorSigned !== true) return 'Awaiting Supervisor';
  if (status === 'approved') return 'Approved';
  if (status === 'returned') return 'Returned';
  return 'Pending';
}

function getJournalDate(journal, status) {
  if (status === 'pending') return journal.supervisorSignedAt || journal.submittedAt;
  if (status === 'approved') return journal.coordinatorApprovedAt || journal.updatedAt;
  return journal.updatedAt || journal.submittedAt;
}

async function loadCoordinatorJournals(defaultFilter = 'pending', options = {}) {
  const background = options.background === true;
  const journalList = document.getElementById('journal-list');

  // The placeholder only appears while nothing has been painted yet, so opening
  // the tab no longer blanks a list the coordinator was already reading.
  if (journalList && paintedPayloads.journals === undefined) {
    journalList.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">Loading journals...</p>';
  }

  const [pendingResult, approvedResult, returnedResult] = await Promise.all([
    fetchAPI('/coordinator/journals'),
    fetchAPI('/coordinator/journals/approved'),
    fetchAPI('/coordinator/journals/returned')
  ]);

  // Best-effort in the background: a failed call must not empty a list that is
  // already showing the right journals.
  if (background && (
    !pendingResult?.success || !approvedResult?.success || !returnedResult?.success
  )) return;

  const next = {
    pending: pendingResult?.success ? (pendingResult.data || []) : [],
    approved: approvedResult?.success ? (approvedResult.data || []) : [],
    returned: returnedResult?.success ? (returnedResult.data || []) : [],
  };

  // Recorded on every pass, foreground included, so a deliberate refresh that
  // found nothing new still tells the next background pass what is on screen.
  const changed = paintOnce('journals', next);
  if (background && !changed) return;

  journalDataCache.pending = next.pending;
  journalDataCache.approved = next.approved;
  journalDataCache.returned = next.returned;

  updateJournalCounts();

  // A deliberate load keeps its old behaviour of switching queue and starting
  // fresh. A background pass may not do that: re-running filterJournals() would
  // close the journal being read, every ten seconds if it had its way.
  if (!background) {
    filterJournals(null, defaultFilter);
    return;
  }

  // Repaint the list only - tab, selection and the open journal stay put.
  renderJournalList(currentJournalFilter);

  // The journal under review can leave its list when somebody else acts on it;
  // only then does the viewer get cleared.
  const stillOpen = (journalDataCache[currentJournalFilter] || [])
    .some(journal => journal._id === selectedJournalId);
  if (selectedJournalId && !stillOpen) {
    selectedJournalId = null;
    clearJournalViewer(currentJournalFilter);
  }
}

function updateJournalCounts() {
  const pendingCount = document.getElementById('pending-count');
  const approvedCount = document.getElementById('approved-count');
  const returnedCount = document.getElementById('returned-count');

  if (pendingCount) pendingCount.textContent = journalDataCache.pending.length;
  if (approvedCount) approvedCount.textContent = journalDataCache.approved.length;
  if (returnedCount) returnedCount.textContent = journalDataCache.returned.length;
}

function renderJournalList(status) {
  const journalList = document.getElementById('journal-list');
  if (!journalList) return;

  const journals = journalDataCache[status] || [];
  if (journals.length === 0) {
    journalList.innerHTML = `<p class="text-slate-500 text-sm text-center py-4">No ${status} journals found</p>`;
    return;
  }

  journalList.innerHTML = journals.map((journal) => {
    const traineeName = journal.studentId?.fullName || 'Unknown Trainee';
    const displayDate = formatShortDate(getJournalDate(journal, status));
    const statusClass = getStatusClass(status);
    const statusLabel = getStatusLabel(status, journal);
    const identifiedTheories = Array.isArray(journal.identifiedTheories) ? journal.identifiedTheories : [];

    return `
      <div class="journal-item cursor-pointer ${selectedJournalId === journal._id ? 'selected' : ''}" onclick="selectJournal(this, '${journal._id}', '${status}')">
        <div class="flex items-start justify-between mb-2">
          <div>
            <p class="text-sm font-semibold text-white">${escapeHtml(traineeName)}</p>
            <p class="text-xs text-slate-500">${escapeHtml(journal.week || 'Week N/A')}</p>
          </div>
          <span class="status-badge ${statusClass}">${statusLabel}</span>
        </div>
        <p class="text-xs text-slate-400">${status === 'approved' ? 'Approved' : status === 'returned' ? 'Updated' : 'Submitted'}: ${displayDate}</p>
        ${identifiedTheories.length > 0
          ? `<p class="text-xs text-blue-300 mt-1">💡 ${identifiedTheories.length} theory${identifiedTheories.length === 1 ? '' : 's'} identified</p>`
          : ''
        }
      </div>
    `;
  }).join('');
}

function filterJournals(evt, status) {
  currentJournalFilter = status;

  const buttons = document.querySelectorAll('#journal-review .tab-btn');
  buttons.forEach(btn => btn.classList.remove('active'));
  if (evt?.target) {
    evt.target.classList.add('active');
  } else {
    const buttonMap = {
      pending: buttons[0],
      approved: buttons[1],
      returned: buttons[2]
    };
    buttonMap[status]?.classList.add('active');
  }

  selectedJournalId = null;
  renderJournalList(status);
  clearJournalViewer(status);
}

function clearJournalViewer(status) {
  const viewer = document.getElementById('journal-viewer');
  if (!viewer) return;
  viewer.innerHTML = `<div class="text-center py-12"><p class="text-slate-400">Select a ${status} journal to review</p></div>`;
}

function closeJournalReviewer() {
  selectedJournalId = null;
  const items = document.querySelectorAll('#journal-review .journal-item');
  items.forEach(item => item.classList.remove('selected'));
  clearJournalViewer(currentJournalFilter);
}

function selectJournal(element, journalId, status = currentJournalFilter) {
  const items = document.querySelectorAll('#journal-review .journal-item');
  items.forEach(item => item.classList.remove('selected'));
  element.classList.add('selected');
  selectedJournalId = journalId;

  const journal = (journalDataCache[status] || []).find(item => item._id === journalId);
  if (!journal) {
    clearJournalViewer(status);
    return;
  }

  const traineeName = journal.studentId?.fullName || 'Unknown Trainee';
  const submittedDate = formatShortDate(journal.submittedAt);
  const signedDate = formatShortDate(journal.supervisorSignedAt);
  const approvedDate = formatShortDate(journal.coordinatorApprovedAt);
  const statusClass = getStatusClass(status);
  const statusLabel = getStatusLabel(status, journal);
  const concepts = Array.isArray(journal.concepts) ? journal.concepts.filter(Boolean) : [];
  const identifiedTheories = Array.isArray(journal.identifiedTheories) ? journal.identifiedTheories : [];
  const canReview = status === 'pending' && journal.supervisorSigned === true;

  const viewer = document.getElementById('journal-viewer');
  viewer.innerHTML = `
    <div>
      <div class="flex items-start justify-between mb-6 gap-4">
        <div>
          <h3 class="font-display font-700 text-xl">${escapeHtml(journal.week || 'Journal Entry')}</h3>
          <p class="text-slate-400 text-sm">Submitted by: ${escapeHtml(traineeName)}</p>
          <p class="text-slate-500 text-xs mt-1">Submitted: ${submittedDate}</p>
          <p class="text-slate-500 text-xs mt-1">Supervisor Signed: ${signedDate}</p>
          ${status === 'pending' && !journal.supervisorSigned ? '<p class="text-amber-400 text-xs mt-2">Awaiting supervisor review and signature</p>' : ''}
          ${status === 'approved' ? `<p class="text-slate-500 text-xs mt-1">Coordinator Approved: ${approvedDate}</p>` : ''}
        </div>
        <div class="flex items-center gap-2">
          <span class="status-badge ${statusClass}">${statusLabel}</span>
          <button onclick="closeJournalReviewer()" class="btn-ghost text-sm px-3 py-1.5 leading-none" title="Close reviewer" aria-label="Close reviewer">X</button>
        </div>
      </div>

      <div class="mb-6">
        <h4 class="font-semibold mb-3">Theories/Concepts Applied</h4>
        <div class="space-y-2">
          ${concepts.length > 0
            ? concepts.map(concept => `
              <label class="flex items-center gap-2">
                <input type="checkbox" checked disabled class="w-4 h-4 accent-blue-400">
                <span class="text-sm">${escapeHtml(concept)}</span>
              </label>
            `).join('')
            : '<p class="text-sm text-slate-500">No concepts provided</p>'
          }
        </div>
      </div>

      <div class="mb-6">
        <h4 class="font-semibold mb-3">Journal Entry</h4>
        <div class="p-4 rounded-lg bg-white/5 border border-white/10">
          ${journal.narrative && journal.narrative.trim()
            ? `<p class="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">${escapeHtml(journal.narrative)}</p>`
            : '<p class="text-sm text-slate-500">No entry content</p>'
          }
        </div>
      </div>

      <div class="mb-6">
        <h4 class="font-semibold mb-3">Identified Theories</h4>
        <div class="space-y-2">
          ${identifiedTheories.length > 0
            ? identifiedTheories.map((theory, index) => {
                return `
                <div class="theory-card" style="padding: 10px 14px; border-radius: 8px;">
                  <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                    <span class="theory-card__title" style="font-weight: 600; font-size: 12px;">${escapeHtml(theory.course || '')} – ${escapeHtml(theory.courseName || '')}</span>
                    <span class="theory-card__tag" style="font-size: 10px; padding: 2px 8px; border-radius: 999px;">${escapeHtml(theory.category || '')}</span>
                  </div>
                  <p class="theory-card__text" style="margin: 5px 0 0 0; font-size: 13px; line-height: 1.5; font-style: italic;">${escapeHtml(theory.theory || '')}</p>
                </div>
                `;
              }).join('')
            : '<p class="text-sm text-slate-500">No theories identified for this entry</p>'
          }
        </div>
      </div>

      ${journal.coordinatorRemarks
        ? `<div class="glass-card p-4 bg-white/5 border-l-4 border-amber-400 mb-6">
            <p class="text-xs text-slate-400 mb-2">COORDINATOR REMARKS</p>
            <p class="text-sm text-slate-200">${escapeHtml(journal.coordinatorRemarks)}</p>
          </div>`
        : ''
      }

      <div class="flex gap-3">
        ${canReview
          ? `<button onclick="approveJournal('${journal._id}')" class="btn-primary">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
              Approve
            </button>
            <button onclick="returnJournal('${journal._id}')" class="btn-ghost">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"></path><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"></path></svg>
              Return
            </button>`
          : ''
        }
        <button onclick="downloadJournal('${journal._id}')" class="btn-ghost">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>
      </div>
    </div>
  `;
}

function approveJournal(journalId) {
  VerificationModal.open({
    type: 'prompt',
    title: 'Approve Journal',
    description: 'Approve this journal. You can add optional remarks for the record.',
    input: {
      label: 'Approval remarks (optional)',
      placeholder: 'Add a note about this approval...',
      required: false,
      multiline: false,
      hint: 'Leave blank to approve without remarks.',
    },
    confirmLabel: 'Approve Journal',
    onConfirm: (remarks) => runApproveJournal(journalId, remarks || ''),
  });
}

async function runApproveJournal(journalId, remarks) {
  const result = await fetchAPI(`/coordinator/journals/${journalId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ remarks })
  });

  if (!result || !result.success) {
    showNotification('Error', result?.message || 'Failed to approve journal', 'error');
    return;
  }

  showNotification('Success', 'Journal approved successfully', 'success');
  // One fewer journal waiting on the coordinator - move the counter now, the
  // next Overview refresh confirms it against the server.
  adjustPendingAction('journalReviews', -1);
  await loadCoordinatorJournals('pending');
}

function returnJournal(journalId) {
  VerificationModal.open({
    type: 'prompt',
    title: 'Return Journal',
    description: 'Send this journal back to the supervisor with feedback.',
    input: {
      label: 'Feedback for the supervisor',
      placeholder: 'Describe what needs to change...',
      required: true,
      requiredMessage: 'Please enter feedback for the supervisor.',
      hint: 'The supervisor sees this feedback with the returned journal.',
    },
    confirmLabel: 'Return Journal',
    onConfirm: (feedback) => runReturnJournal(journalId, feedback),
  });
}

async function runReturnJournal(journalId, feedback) {
  const trimmed = (feedback || '').trim();
  if (!trimmed) return;

  const result = await fetchAPI(`/coordinator/journals/${journalId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ remarks: trimmed })
  });

  if (!result || !result.success) {
    showNotification('Error', result?.message || 'Failed to return journal', 'error');
    return;
  }

  showNotification('Success', 'Journal returned to supervisor', 'success');
  adjustPendingAction('journalReviews', -1);
  await loadCoordinatorJournals('pending');
}

function downloadJournal(journalId) {
  showNotification('Notice', `Downloading journal: ${journalId}.pdf`, 'info');
}

// ────────────────────────────────────────────────────────────────────────────
// ANALYTICS & CHARTS
// ────────────────────────────────────────────────────────────────────────────

function initCharts() {
  loadAnalyticsData();
}

// ────────────────────────────────────────────────────────────────────────────
// DESCRIPTIVE ANALYTICS HELPERS
// ────────────────────────────────────────────────────────────────────────────

function analyticsHours(value) {
  const numeric = Number(value) || 0;
  return `${numeric.toLocaleString('en-US', { maximumFractionDigits: 1 })} h`;
}

function analyticsCount(value) {
  return (Number(value) || 0).toLocaleString('en-US');
}

function analyticsPercent(value) {
  return `${(Number(value) || 0).toFixed(1)}%`;
}

function setAnalyticsText(elementId, value) {
  const element = document.getElementById(elementId);
  if (element) element.textContent = value;
}

function analyticsDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function progressFillClass(rate) {
  if (rate >= 100) return 'progress-fill progress-fill-complete';
  if (rate >= 50) return 'progress-fill progress-fill-ontrack';
  return 'progress-fill progress-fill-behind';
}

function traineeStatusBadge(status) {
  if (status === 'Completed') return 'status-completed';
  if (status === 'Inactive') return 'status-inactive';
  return 'status-on-track';
}

/** ACTIVE / INACTIVE badge, driven by the centralized attendance logic. */
function activityStatusBadge(activityStatus) {
  return activityStatus === 'INACTIVE' ? 'status-inactive' : 'status-active';
}

/** "Last time in" cell - never recorded, or a readable date/time. */
function lastTimeInCell(isoString) {
  if (!isoString) return '<span class="text-xs text-slate-500">Never</span>';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '<span class="text-xs text-slate-500">—</span>';
  return `<span class="text-slate-300">${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>`;
}

/** "Days since last attendance" cell. */
function daysSinceAttendanceCell(days) {
  if (days === null || days === undefined) return '<span class="text-xs text-slate-500">—</span>';
  const label = `${days} day${days === 1 ? '' : 's'}`;
  if (days === 0) return '<span class="text-xs text-blue-400">Today</span>';
  if (days >= 3) return `<span class="text-xs text-red-400 font-semibold">${label}</span>`;
  return `<span class="text-slate-300">${label}</span>`;
}

function updateAnalyticsSummary(summary, windows, analytics = {}) {
  const attendance = analytics.attendance || {};
  const statusBreakdown = attendance.statusBreakdown || { present: 0, late: 0, absent: 0, excused: 0 };

  // ── Overall statistics tiles ───────────────────────────────────────────
  setAnalyticsText('analytics-total-trainees', analyticsCount(summary.studentCount));
  setAnalyticsText('analytics-total-trainees-note',
    `${analyticsCount(summary.activeTrainees)} active • ${analyticsCount(summary.behindTrainees)} below 50%`);
  setAnalyticsText('analytics-active-trainees', analyticsCount(summary.activeTrainees));
  setAnalyticsText('analytics-active-trainees-note', `${analyticsCount(summary.onTrackTrainees)} on track`);
  setAnalyticsText('analytics-completed-trainees', analyticsCount(summary.completedTrainees));
  setAnalyticsText('analytics-completed-trainees-note', `of ${analyticsCount(summary.studentCount)} enrolled trainees`);
  setAnalyticsText('analytics-pending-submissions', analyticsCount(summary.pendingSubmissions));
  setAnalyticsText('analytics-pending-submissions-note',
    `${analyticsCount(summary.pendingDTRs)} DTR • ${analyticsCount(summary.pendingJournals)} journals`);
  setAnalyticsText('analytics-avg-completion', analyticsPercent(summary.avgCompletionRate));
  setAnalyticsText('analytics-avg-completion-note', summary.studentCount > 0
    ? `Across ${analyticsCount(summary.studentCount)} trainees (verified hours)`
    : 'No trainee data available');
  setAnalyticsText('analytics-avg-performance', summary.ratedCount > 0 ? analyticsPercent(summary.avgPerformancePercent) : '—');
  setAnalyticsText('analytics-avg-performance-note', summary.ratedCount > 0
    ? `${summary.avgPerformance} of 5 average rating`
    : 'No appraisal recorded yet');

  // ── Attendance highlight ──────────────────────────────────────────────
  setAnalyticsText('analytics-attendance-rate', analyticsPercent(attendance.attendanceRate));
  setAnalyticsText('analytics-attendance-rate-note',
    `Present ${analyticsCount(statusBreakdown.present)} • Late ${analyticsCount(statusBreakdown.late)} • Absent ${analyticsCount(statusBreakdown.absent)}`);

  // ── Most applied theory / top company ─────────────────────────────────
  setAnalyticsText('analytics-top-concept', summary.topConcept?.name || 'No concept data');
  const conceptTraineeCount = summary.topConcept?.traineeCount || 0;
  const conceptWindowDays = windows.conceptWindowDays || 30;
  setAnalyticsText('analytics-top-concept-note', conceptTraineeCount > 0
    ? `${analyticsCount(conceptTraineeCount)} trainees in the last ${conceptWindowDays} days`
    : `No journal concepts in the last ${conceptWindowDays} days`);

  setAnalyticsText('analytics-top-company', summary.topCompany?.name || 'No company data');
  const topCompanyCount = summary.topCompany?.count || 0;
  setAnalyticsText('analytics-top-company-note', topCompanyCount > 0
    ? `${analyticsCount(topCompanyCount)} trainee(s) deployed`
    : 'No active trainees yet');
}


function renderHoursChart(hoursByTrainee) {
  const hoursCtx = document.getElementById('hoursChart');
  if (!hoursCtx) return;

  const chartData = Array.isArray(hoursByTrainee) ? hoursByTrainee : [];
  const labels = chartData.length > 0
    ? chartData.map(item => (item.name || 'Unknown').split(' ')[0])
    : ['No data'];
  const values = chartData.length > 0
    ? chartData.map(item => item.hours || 0)
    : [0];

  const dataset = {
    label: 'Hours Completed',
    data: values,
  };
  window.TrackITCharts.styleDataset(dataset, {
    accent: TrackITCharts.accent.teal,
    maxBarThickness: 26,
  });

  if (window.analyticsCharts?.hoursChart) {
    window.analyticsCharts.hoursChart.data.labels = labels;
    window.analyticsCharts.hoursChart.data.datasets = [dataset];
    window.analyticsCharts.hoursChart.update();
    return;
  }

  window.analyticsCharts = window.analyticsCharts || {};
  window.analyticsCharts.hoursChart = window.TrackITCharts.createBar(hoursCtx, {
    data: { labels, datasets: [dataset] },
    options: window.TrackITCharts.barOptions({
      horizontal: true,
      legend: false,
      categoryCount: labels.length,
      datasetCount: 1,
      xTitle: 'Verified Hours',
      valueFormatter: (value) => `${Math.round(value * 10) / 10} h`,
    }),
  });
}

function renderJournalStatusChart(statusData, windowDays = 90) {
  const journalCtx = document.getElementById('journalStatusChart');
  if (!journalCtx) return;

  const data = {
    labels: [
      'Awaiting Supervisor',
      'Returned to Supervisor',
      'Awaiting Coordinator',
      'Approved',
    ],
    values: [
      statusData?.awaitingSupervisor || 0,
      statusData?.returnedToSupervisor || 0,
      statusData?.awaitingCoordinator || 0,
      statusData?.approved || 0,
    ],
  };

  const statusTokens = () => window.TrackITCharts.tokens();
  const dataset = {
    data: data.values,
    backgroundColor: ['warning', 'negative', 'info', 'positive'].map((key) => TrackITCharts.alpha(statusTokens()[key], 0.8)),
    borderColor: ['warning', 'negative', 'info', 'positive'].map((key) => TrackITCharts.alpha(statusTokens()[key], 1)),
    borderWidth: 2,
    trackitPalette: ['warning', 'negative', 'info', 'positive'],
  };

  if (window.analyticsCharts?.journalStatusChart) {
    window.analyticsCharts.journalStatusChart.data.labels = data.labels;
    window.analyticsCharts.journalStatusChart.data.datasets = [dataset];
    window.analyticsCharts.journalStatusChart.update();
    return;
  }

  window.analyticsCharts = window.analyticsCharts || {};
  window.analyticsCharts.journalStatusChart = window.TrackITCharts.register(new Chart(journalCtx, {
    type: 'doughnut',
    data: {
      labels: data.labels,
      datasets: [dataset],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: window.TrackITCharts.tokens().legend },
        },
        tooltip: {
          callbacks: {
            title: (context) => `${context[0].label} (last ${windowDays} days)`,
          },
        },
      },
    },
  }));
}

function renderDepartmentChart() {
  const deptCtx = document.getElementById('deptChart');
  if (!deptCtx || window.deptChartInit) return;

  const deptKeyList = ['teal', 'warning', 'positive', 'secondary', 'supportingBlue'];
  const deptTheme = () => window.TrackITCharts.tokens();
  const deptColors = deptKeyList.map((key) =>
    TrackITCharts.alpha(deptTheme()[key], 0.8)
  );
  const deptBorders = deptKeyList.map((key) =>
    TrackITCharts.alpha(deptTheme()[key], 1)
  );

  const deptLabels = (window.deptData || []).map(d => d._id || 'Unknown');
  const deptValues = (window.deptData || []).map(d => d.count);

  window.TrackITCharts.register(new Chart(deptCtx, {
    type: 'doughnut',
    data: {
      labels: deptLabels.length > 0 ? deptLabels : ['No data'],
      datasets: [{
        data: deptValues.length > 0 ? deptValues : [1],
        backgroundColor: deptLabels.length > 0 ? deptColors.slice(0, deptLabels.length) : ['rgba(100,100,100,0.3)'],
        borderColor: deptLabels.length > 0 ? deptBorders.slice(0, deptLabels.length) : ['rgba(100,100,100,0.5)'],
        borderWidth: 2,
        trackitPalette: ['teal', 'warning', 'positive', 'secondary', 'supportingBlue']
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: window.TrackITCharts.tokens().legend }
        }
      }
    }
  }));
  window.deptChartInit = true;
}

function analyticsTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function renderAttendancePanel(attendance) {
  const data = attendance || {};
  const statusBreakdown = data.statusBreakdown || { present: 0, late: 0, absent: 0, excused: 0 };

  setAnalyticsText('analytics-today-present', analyticsCount(data.todayPresent));
  setAnalyticsText('analytics-today-absent', analyticsCount(data.todayAbsent));
  setAnalyticsText('analytics-punctuality', analyticsPercent(data.punctualityRate));
  setAnalyticsText('analytics-avg-daily-hours', analyticsHours(data.avgDailyHours));
  setAnalyticsText('analytics-avg-daily-hours-note',
    `${analyticsCount(data.activeDays)} active day(s) with verified records`);
  setAnalyticsText('analytics-dtr-records', analyticsCount(data.records));
  setAnalyticsText('analytics-dtr-records-note',
    `${analyticsCount(data.verifiedRecords)} verified • ${analyticsCount(data.recordsWithHours)} with hours`);
  setAnalyticsText('analytics-pending-dtrs', analyticsCount(data.pendingVerification));
  setAnalyticsText('analytics-pending-dtrs-note',
    `${analyticsCount(data.unverifiedRecords)} unverified record(s)`);

  // Attendance status mix (last 30 days)
  const statusCanvas = document.getElementById('attendanceStatusChart');
  if (statusCanvas) {
    const statusDataset = {
      data: [
        statusBreakdown.present || 0,
        statusBreakdown.late || 0,
        statusBreakdown.absent || 0,
        statusBreakdown.excused || 0,
      ],
      backgroundColor: [
        'rgba(34, 197, 94, 0.8)',
        'rgba(245, 158, 11, 0.8)',
        'rgba(239, 68, 68, 0.8)',
        'rgba(148, 163, 184, 0.8)',
      ],
      borderColor: [
        'rgba(34, 197, 94, 1)',
        'rgba(245, 158, 11, 1)',
        'rgba(239, 68, 68, 1)',
        'rgba(148, 163, 184, 1)',
      ],
      borderWidth: 2,
      trackitPalette: ['positive', 'warning', 'negative', 'info'],
    };
    const statusLabels = ['Present', 'Late', 'Absent', 'Excused'];

    if (window.analyticsCharts?.attendanceStatusChart) {
      window.analyticsCharts.attendanceStatusChart.data.labels = statusLabels;
      window.analyticsCharts.attendanceStatusChart.data.datasets = [statusDataset];
      window.analyticsCharts.attendanceStatusChart.update();
    } else {
      window.analyticsCharts = window.analyticsCharts || {};
      window.analyticsCharts.attendanceStatusChart = window.TrackITCharts.register(new Chart(statusCanvas, {
        type: 'doughnut',
        data: { labels: statusLabels, datasets: [statusDataset] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'right',
              labels: { color: window.TrackITCharts.tokens().legend },
            },
          },
        },
      }));
    }
  }

  // Weekly verified hours + present records trend
  const trendCanvas = document.getElementById('attendanceTrendChart');
  if (trendCanvas) {
    const weeks = Array.isArray(data.weeklyHours) ? data.weeklyHours : [];
    const labels = weeks.length > 0 ? weeks.map(week => week.label) : ['No data'];
    const hoursDataset = window.TrackITCharts.styleDataset({
      type: 'bar',
      label: 'Verified Hours',
      data: weeks.length > 0 ? weeks.map(week => week.hours) : [0],
      yAxisID: 'y',
      borderRadius: 5,
    }, {
      accent: TrackITCharts.accent.teal,
      maxBarThickness: 30,
      showValues: false, // 8 weeks x 2 series: labels on hover only
    });
    // The line overlay keeps its existing gold and shape - only the styling of
    // its stroke/points is tidied so it reads as part of the same system.
    const presentDataset = {
      type: 'line',
      label: 'Present Records',
      data: weeks.length > 0 ? weeks.map(week => week.present) : [0],
      borderColor: window.TrackITCharts.alpha(TrackITCharts.accent.gold, 1),
      backgroundColor: window.TrackITCharts.alpha(TrackITCharts.accent.gold, 0.2),
      borderWidth: 2,
      tension: 0.35,
      pointRadius: 3,
      pointHoverRadius: 5,
      pointBackgroundColor: window.TrackITCharts.alpha(TrackITCharts.accent.gold, 1),
      pointBorderWidth: 0,
      fill: false,
      yAxisID: 'y1',
    };

    if (window.analyticsCharts?.attendanceTrendChart) {
      window.analyticsCharts.attendanceTrendChart.data.labels = labels;
      window.analyticsCharts.attendanceTrendChart.data.datasets = [hoursDataset, presentDataset];
      window.analyticsCharts.attendanceTrendChart.update();
    } else {
      window.analyticsCharts = window.analyticsCharts || {};
      window.analyticsCharts.attendanceTrendChart = window.TrackITCharts.createBar(trendCanvas, {
        data: { labels, datasets: [hoursDataset, presentDataset] },
        options: window.TrackITCharts.barOptions({
          vertical: true,
          timeSeries: true,
          dualAxis: true,
          legend: true,
          categoryCount: labels.length,
          datasetCount: 2,
          yTitle: 'Hours',
          secondaryTitle: 'Records',
          // Existing tooltip augmentation, preserved verbatim.
          tooltipAfterLabel: (context) => {
            const week = weeks[context.dataIndex];
            return week ? week.range : '';
          },
        }),
      });
    }
  }
}

function renderRecentDTRs(records) {
  const tbody = document.getElementById('recent-dtr-body');
  if (!tbody) return;

  const items = Array.isArray(records) ? records : [];
  if (items.length === 0) {
    tbody.innerHTML = '<tr class="state-row"><td colspan="7" class="py-6 px-4"><div class="empty-state">' +
      '<p class="empty-state__title">No DTR records yet</p>' +
      '<p class="empty-state__text">Time in and time out entries will appear here once trainees start logging.</p>' +
      '</div></td></tr>';
    return;
  }

  tbody.innerHTML = items.map(record => {
    const statusClass = record.status === 'absent'
      ? 'status-absent'
      : record.status === 'late'
        ? 'status-behind'
        : record.status === 'excused'
          ? 'status-inactive'
          : 'status-present';

    return `
      <tr class="border-b border-white/5">
        <td class="py-3 px-4">
          <span class="block text-white">${escapeHtml(record.traineeName)}</span>
          <span class="block text-xs text-slate-500">${escapeHtml(record.company)}</span>
        </td>
        <td class="py-3 px-4 text-slate-300">${formatShortDate(record.date)}</td>
        <td class="py-3 px-4 text-slate-300">${analyticsTime(record.timeIn)}</td>
        <td class="py-3 px-4 text-slate-300">${analyticsTime(record.timeOut)}</td>
        <td class="py-3 px-4 text-slate-300">${analyticsHours(record.hoursRendered)}</td>
        <td class="py-3 px-4"><span class="status-badge ${statusClass}">${escapeHtml(record.status)}</span></td>
        <td class="py-3 px-4">${record.verified
          ? '<span class="status-badge status-verified">Verified</span>'
          : '<span class="status-badge status-pending">Pending</span>'}</td>
      </tr>
    `;
  }).join('');
}

function renderTraineeProgress(progress) {
  const items = Array.isArray(progress) ? progress : [];
  const tbody = document.getElementById('trainee-progress-body');

  if (tbody) {
    if (items.length === 0) {
      tbody.innerHTML = '<tr class="state-row"><td colspan="12" class="py-6 px-4"><div class="empty-state">' +
        '<p class="empty-state__title">No trainee records yet</p>' +
        '<p class="empty-state__text">Progress, hours and status will be listed here once trainees are enrolled.</p>' +
        '</div></td></tr>';
    } else {
      tbody.innerHTML = items.map(trainee => {
        const rate = Number(trainee.completionRate) || 0;
        const width = Math.min(rate, 100);
        const activityStatus = trainee.activityStatus === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
        return `
          <tr class="border-b border-white/5">
            <td class="py-3 px-4">
              <span class="block text-white">${escapeHtml(trainee.name)}</span>
              <span class="block text-xs text-slate-500">${escapeHtml(trainee.department)}</span>
            </td>
            <td class="py-3 px-4 text-slate-300">${escapeHtml(trainee.studentId)}</td>
            <td class="py-3 px-4 text-slate-300">${escapeHtml(trainee.department || '—')}</td>
            <td class="py-3 px-4 text-slate-300">${escapeHtml(trainee.section || '—')}</td>
            <td class="py-3 px-4 text-slate-300">${escapeHtml(trainee.company)}</td>
            <td class="py-3 px-4 text-slate-300">${analyticsHours(trainee.completedHours)}</td>
            <td class="py-3 px-4 text-slate-300">${analyticsHours(trainee.remainingHours)}</td>
            <td class="py-3 px-4">
              <div class="progress-track">
                <div class="${progressFillClass(rate)}" style="width: ${width}%"></div>
              </div>
              <span class="text-xs text-slate-500">${analyticsPercent(rate)} of ${analyticsCount(trainee.requiredHours)} h</span>
            </td>
            <td class="py-3 px-4"><span class="status-badge ${activityStatusBadge(activityStatus)}">${activityStatus}</span></td>
            <td class="py-3 px-4">${lastTimeInCell(trainee.lastTimeIn)}</td>
            <td class="py-3 px-4">${daysSinceAttendanceCell(trainee.daysSinceLastAttendance)}</td>
            <td class="py-3 px-4"><span class="status-badge ${traineeStatusBadge(trainee.status)}">${escapeHtml(trainee.status)}</span></td>
          </tr>
        `;
      }).join('');
    }
  }

  // Completed vs remaining hours per trainee (top 8 by verified hours)
  const canvas = document.getElementById('traineeProgressChart');
  if (!canvas) return;

  const topTrainees = items.slice(0, 8);
  const labels = topTrainees.length > 0 ? topTrainees.map(trainee => trainee.name.split(' ')[0]) : ['No data'];
  const completedDatasets = window.TrackITCharts.styleDataset({
    label: 'Completed Hours',
    data: topTrainees.length > 0 ? topTrainees.map(trainee => trainee.completedHours) : [0],
    stack: 'hours',
    // Stacked: rounding every segment would look broken, so only the outer end
    // of each stack is rounded.
    borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 6, bottomRight: 6 },
    borderSkipped: 'start',
  }, {
    accent: TrackITCharts.accent.teal,
    strong: true,
    maxBarThickness: 24,
    showValues: false, // stacked segments: label on hover only
  });
  const remainingDatasets = window.TrackITCharts.styleDataset({
    label: 'Remaining Hours',
    data: topTrainees.length > 0 ? topTrainees.map(trainee => trainee.remainingHours) : [0],
    stack: 'hours',
    borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 6, bottomRight: 6 },
    borderSkipped: 'start',
  }, {
    // The existing muted slate used for "remaining", unchanged in hue.
    accent: TrackITCharts.accent.slate,
    maxBarThickness: 24,
    showValues: false,
  });

  if (window.analyticsCharts?.traineeProgressChart) {
    window.analyticsCharts.traineeProgressChart.data.labels = labels;
    window.analyticsCharts.traineeProgressChart.data.datasets = [completedDatasets, remainingDatasets];
    window.analyticsCharts.traineeProgressChart.update();
    return;
  }

  window.analyticsCharts = window.analyticsCharts || {};
  window.analyticsCharts.traineeProgressChart = window.TrackITCharts.createBar(canvas, {
    data: { labels, datasets: [completedDatasets, remainingDatasets] },
    options: window.TrackITCharts.barOptions({
      horizontal: true,
      stacked: true,
      legend: true,
      categoryCount: labels.length,
      datasetCount: 2,
      xTitle: 'Hours',
      valueFormatter: (value) => `${Math.round(value * 10) / 10} h`,
    }),
  });
}

function renderPerformancePanel(performance) {
  const data = performance || {};
  const distribution = data.distribution || { excellent: 0, good: 0, satisfactory: 0, needsImprovement: 0, unrated: 0 };

  setAnalyticsText('analytics-performance-avg', data.ratedCount > 0 ? analyticsPercent(data.averagePercent) : '—');
  setAnalyticsText('analytics-performance-rating', data.ratedCount > 0 ? `${data.average} / 5` : 'No appraisals');
  setAnalyticsText('analytics-performance-rated', analyticsCount(data.ratedCount));
  setAnalyticsText('analytics-performance-unrated', analyticsCount(data.unratedCount));
  setAnalyticsText('analytics-performance-last', data.lastAppraisalLabel || 'No appraisals yet');

  // Rating distribution doughnut
  const canvas = document.getElementById('performanceChart');
  if (canvas) {
    const labels = ['Excellent', 'Good', 'Satisfactory', 'Needs Improvement', 'Unrated'];
    const perfKeyList = ['positive', 'teal', 'warning', 'negative', 'secondary'];
    const perfTheme = () => window.TrackITCharts.tokens();
    const dataset = {
      data: [
        distribution.excellent || 0,
        distribution.good || 0,
        distribution.satisfactory || 0,
        distribution.needsImprovement || 0,
        distribution.unrated || 0,
      ],
      backgroundColor: perfKeyList.map((key) => TrackITCharts.alpha(perfTheme()[key], 0.8)),
      borderColor: perfKeyList.map((key) => TrackITCharts.alpha(perfTheme()[key], 1)),
      borderWidth: 2,
      trackitPalette: ['positive', 'teal', 'warning', 'negative', 'secondary'],
    };

    if (window.analyticsCharts?.performanceChart) {
      window.analyticsCharts.performanceChart.data.labels = labels;
      window.analyticsCharts.performanceChart.data.datasets = [dataset];
      window.analyticsCharts.performanceChart.update();
    } else {
      window.analyticsCharts = window.analyticsCharts || {};
      window.analyticsCharts.performanceChart = window.TrackITCharts.register(new Chart(canvas, {
        type: 'doughnut',
        data: { labels, datasets: [dataset] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'right',
              labels: { color: window.TrackITCharts.tokens().legend },
            },
          },
        },
      }));
    }
  }

  // Top performers list
  const list = document.getElementById('top-performers-list');
  if (!list) return;

  const performers = Array.isArray(data.topPerformers) ? data.topPerformers : [];
  if (performers.length === 0) {
    list.innerHTML = '<div class="empty-state">' +
      '<p class="empty-state__title">No performance appraisals recorded yet</p>' +
      '<p class="empty-state__text">Top rated trainees will appear here after the first appraisal cycle.</p>' +
      '</div>';
    return;
  }

  list.innerHTML = performers.map(performer => {
    const rating = Number(performer.rating) || 0;
    const percent = Math.min((rating / 5) * 100, 100);
    return `
      <div class="trainee-progress-item">
        <div class="flex items-center justify-between mb-2">
          <div>
            <p class="text-sm font-semibold text-white">${escapeHtml(performer.name)}</p>
            <p class="text-xs text-slate-500">${escapeHtml(performer.company)} • ${analyticsHours(performer.completedHours)} completed</p>
          </div>
          <span class="text-sm font-semibold text-blue-400">${rating} / 5</span>
        </div>
        <div class="progress-track">
          <div class="${progressFillClass(percent)}" style="width: ${percent}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderJournalPanel(journals) {
  const data = journals || {};
  const byStatus = data.byStatus || { submitted: 0, pending: 0, reviewed: 0, incomplete: 0 };

  setAnalyticsText('analytics-journals-submitted', analyticsCount(byStatus.submitted));
  setAnalyticsText('analytics-journals-pending', analyticsCount(byStatus.pending));
  setAnalyticsText('analytics-journals-reviewed', analyticsCount(byStatus.reviewed));
  setAnalyticsText('analytics-journals-incomplete', analyticsCount(byStatus.incomplete));
  setAnalyticsText('analytics-journal-completion', analyticsPercent(data.completionRate));
  setAnalyticsText('analytics-journal-completion-note',
    `${analyticsCount(data.submittedTotal)} of ${analyticsCount(data.expectedSubmissions)} expected`);

  // Weekly submissions trend
  const canvas = document.getElementById('journalTrendChart');
  if (!canvas) return;

  const trend = Array.isArray(data.weeklyTrend) ? data.weeklyTrend : [];
  const labels = trend.length > 0 ? trend.map(row => row.label) : ['No data'];
  const submittedDataset = window.TrackITCharts.styleDataset({
    label: 'Submitted',
    data: trend.length > 0 ? trend.map(row => row.submitted) : [0],
  }, {
    accent: TrackITCharts.accent.blue,
    maxBarThickness: 26,
    showValues: false, // grouped: labels on hover only
  });
  const approvedDataset = window.TrackITCharts.styleDataset({
    label: 'Coordinator Approved',
    data: trend.length > 0 ? trend.map(row => row.approved) : [0],
  }, {
    accent: TrackITCharts.accent.green,
    maxBarThickness: 26,
    showValues: false,
  });

  if (window.analyticsCharts?.journalTrendChart) {
    window.analyticsCharts.journalTrendChart.data.labels = labels;
    window.analyticsCharts.journalTrendChart.data.datasets = [submittedDataset, approvedDataset];
    window.analyticsCharts.journalTrendChart.update();
    return;
  }

  window.analyticsCharts = window.analyticsCharts || {};
  window.analyticsCharts.journalTrendChart = window.TrackITCharts.createBar(canvas, {
    data: { labels, datasets: [submittedDataset, approvedDataset] },
    options: window.TrackITCharts.barOptions({
      vertical: true,
      timeSeries: true,
      legend: true,
      categoryCount: labels.length,
      datasetCount: 2,
      yTitle: 'Journals',
    }),
  });
}

function renderDepartmentAnalytics(departments) {
  const tbody = document.getElementById('department-analytics-body');
  if (!tbody) return;

  const items = Array.isArray(departments) ? departments : [];
  if (items.length === 0) {
    tbody.innerHTML = '<tr class="state-row"><td colspan="6" class="py-6 px-4"><div class="empty-state">' +
      '<p class="empty-state__title">No department data yet</p>' +
      '<p class="empty-state__text">Per-department totals will appear once trainees are assigned.</p>' +
      '</div></td></tr>';
    return;
  }

  tbody.innerHTML = items.map(entry => `
    <tr class="border-b border-white/5">
      <td class="py-3 px-4 text-white">${escapeHtml(entry.department)}</td>
      <td class="py-3 px-4 text-slate-300">${analyticsCount(entry.trainees)}</td>
      <td class="py-3 px-4 text-slate-300">${analyticsCount(entry.active)}</td>
      <td class="py-3 px-4 text-slate-300">${analyticsPercent(entry.avgCompletionRate)}</td>
      <td class="py-3 px-4 text-slate-300">${entry.avgRating === null || entry.avgRating === undefined
        ? '<span class="text-xs text-slate-500">Not rated</span>'
        : `${entry.avgRating} / 5`}</td>
      <td class="py-3 px-4 text-slate-300">${analyticsHours(entry.completedHours)}</td>
    </tr>
  `).join('');
}

function renderAttentionList(attention) {
  const container = document.getElementById('analytics-attention-list');
  if (!container) return;

  const items = Array.isArray(attention) ? attention : [];
  if (items.length === 0) {
    container.innerHTML = '<div class="empty-state">' +
      '<p class="empty-state__title">Nothing needs attention right now</p>' +
      '<p class="empty-state__text">Inactive trainees, pending journals and unverified DTR records will be listed here.</p>' +
      '</div>';
    return;
  }

  const levelMeta = {
    high: { cls: 'attention-high', label: 'Urgent' },
    medium: { cls: 'attention-medium', label: 'Warning' },
    low: { cls: 'attention-low', label: 'Notice' },
    info: { cls: 'attention-info', label: 'All clear' },
  };

  container.innerHTML = items.map(item => {
    const meta = levelMeta[item.level] || levelMeta.info;
    const action = item.action
      ? `<button onclick="switchTab('${item.action}')" class="text-xs text-blue-400 hover:underline mt-1">Open ${item.action === 'journal-review' ? 'Journal Review' : 'Trainees'}</button>`
      : '';
    return `
      <div class="attention-item ${meta.cls}">
        <span class="attention-level">${escapeHtml(meta.label)}</span>
        <p class="text-sm font-semibold text-white">${escapeHtml(item.title)}</p>
        <p class="text-xs text-slate-400 mt-1">${escapeHtml(item.detail)}</p>
        ${action}
      </div>
    `;
  }).join('');
}

function renderNarrative(narrative) {
  const container = document.getElementById('analytics-narrative');
  if (!container) return;

  const lines = Array.isArray(narrative) ? narrative : [];
  if (lines.length === 0) {
    container.innerHTML = '<div class="empty-state">' +
      '<p class="empty-state__title">Nothing to summarize yet</p>' +
      '<p class="empty-state__text">The automated summary will appear once attendance, journal and appraisal data is recorded.</p>' +
      '</div>';
    return;
  }

  container.innerHTML = lines.map((line, index) => `
    <div class="narrative-item">
      <span class="narrative-index">${index + 1}</span>
      <p class="text-sm text-slate-300">${escapeHtml(line)}</p>
    </div>
  `).join('');
}

/**
 * Analytics is regenerated on every request, so two fields are timestamps
 * rather than data: `generatedAt` and `programPeriod.to`. Stripping them keeps
 * an unchanged report from looking new. `programPeriod.label` is day-granular
 * and still changes at midnight, which is a change worth repainting for.
 */
function analyticsSignature(analytics) {
  const { generatedAt, ...rest } = analytics;
  if (rest.programPeriod) {
    rest.programPeriod = { ...rest.programPeriod, to: null };
  }
  return rest;
}

async function loadAnalyticsData(options = {}) {
  const background = options.background === true;
  const refreshBtn = document.querySelector('#analytics .btn-ghost');

  // Background passes never grab the refresh button - disabling it on every
  // cycle made the control flicker and blocked deliberate clicks.
  if (refreshBtn && !background) refreshBtn.disabled = true;

  const result = await fetchAPI('/stats/coordinator/analytics');

  if (refreshBtn) refreshBtn.disabled = false;

  if (!result || !result.success) {
    // Silent in the background: a toast on every blip is worse than stale
    // numbers, and the panels keep showing the last good data. A deliberate
    // refresh reports the failure and has to clear the painted payload,
    // because it is about to overwrite the panels.
    if (background) return;

    forgetPainted('analytics');
    updateAnalyticsSummary({}, { conceptWindowDays: 30 }, {});
    renderAttentionList([]);
    renderNarrative([]);
    showNotification('Analytics', 'Unable to load analytics data right now', 'error');
    return;
  }

  const analytics = result.data || {};
  const changed = paintOnce('analytics', analyticsSignature(analytics));
  if (background && !changed) return;

  window.analyticsData = analytics;

  setAnalyticsText('analytics-generated-at', `Generated ${analyticsDateTime(analytics.generatedAt)}`);

  updateAnalyticsSummary(analytics.summary || {}, {
    conceptWindowDays: analytics.conceptWindowDays || 30,
  }, analytics);

  renderAttendancePanel(analytics.attendance || {});
  renderRecentDTRs(analytics.attendance?.recentRecords || []);
  renderTraineeProgress(analytics.traineeProgress || []);
  renderPerformancePanel(analytics.performance || {});
  renderJournalPanel(analytics.journals || {});
  renderDepartmentAnalytics(analytics.departments || []);
  renderAttentionList(analytics.attention || []);
  renderNarrative(analytics.narrative || []);

  // Legacy charts kept from the previous dashboard version
  renderHoursChart(analytics.hoursByTrainee || []);
  renderJournalStatusChart(analytics.journalStatusBreakdown || {}, analytics.journalWindowDays || 90);
  renderDepartmentChart();
}

// ────────────────────────────────────────────────────────────────────────────
// REPORT GENERATION
// ────────────────────────────────────────────────────────────────────────────

let currentReport = null;

const REPORT_LABELS = {
  summary: 'semester summary',
  trainees: 'trainee data',
  attendance: 'attendance log',
  journals: 'journal analytics',
};

async function generateReport(type, mode = 'preview') {
  showNotification('Reports', `Generating ${REPORT_LABELS[type] || type} report from recorded data...`, 'info');

  const result = await fetchAPI(`/stats/coordinator/report?type=${encodeURIComponent(type)}`);
  if (!result || !result.success) {
    showNotification('Error', result?.message || 'Failed to generate the report', 'error');
    return null;
  }

  currentReport = result.data;
  markReportGenerated(type, currentReport.generatedAt);

  if (mode === 'csv') {
    downloadReportCSV();
  }

  openReportPreview();
  return currentReport;
}

function markReportGenerated(type, generatedAt) {
  const note = document.getElementById(`report-note-${type}`);
  if (note) note.textContent = `Last generated ${analyticsDateTime(generatedAt)}`;
  setAnalyticsText('analytics-report-generated-at', `Last report ${analyticsDateTime(generatedAt)}`);
}

function openReportPreview() {
  const report = currentReport;
  const modal = document.getElementById('report-modal');
  const body = document.getElementById('report-modal-body');
  if (!report || !modal || !body) return;

  setAnalyticsText('report-modal-title', report.title);
  setAnalyticsText('report-modal-subtitle', report.subtitle || '');

  const highlights = (report.highlights || []).map(item => `
    <div class="analytics-mini">
      <p class="kpi-label">${escapeHtml(item.label)}</p>
      <p class="analytics-mini-value">${escapeHtml(item.value)}</p>
      <p class="kpi-note">${escapeHtml(item.hint)}</p>
    </div>
  `).join('');

  const narrative = (report.narrative || []).map(line => `
    <div class="narrative-item">
      <p class="text-sm text-slate-300">${escapeHtml(line)}</p>
    </div>
  `).join('');

  const sections = (report.sections || []).map(section => {
    const columns = section.columns || [];
    const head = columns.map(column => `<th class="text-left py-2 px-3 text-slate-400 font-semibold">${escapeHtml(column)}</th>`).join('');
    const rows = (section.rows || []).length > 0
      ? section.rows.map(row => `<tr class="border-b border-white/5">${row.map(cell => `<td class="py-2 px-3 text-slate-300">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${columns.length}" class="py-4 text-center text-slate-500">${escapeHtml(section.emptyText || 'No data')}</td></tr>`;

    return `
      <div class="report-section">
        <h4 class="font-display font-700 mb-1">${escapeHtml(section.title)}</h4>
        <p class="text-xs text-slate-500 mb-3">${escapeHtml(section.description || '')}</p>
        <div class="analytics-table-wrap">
          <table class="w-full text-sm report-table">
            <thead><tr class="border-b border-white/10">${head}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');

  const generatedBy = report.generatedBy || {};
  body.innerHTML = `
    <div class="report-meta">
      <p class="text-xs text-slate-400">Generated by ${escapeHtml(generatedBy.fullName || 'Coordinator')}${generatedBy.email ? ` (${escapeHtml(generatedBy.email)})` : ''}</p>
      <p class="text-xs text-slate-400">Program period: ${escapeHtml(report.period?.label || '—')}</p>
      <p class="text-xs text-slate-400">Generated at: ${escapeHtml(analyticsDateTime(report.generatedAt))}</p>
    </div>
    <div class="kpi-grid">${highlights}</div>
    <div class="report-section">
      <h4 class="font-display font-700 mb-3">Automated Findings</h4>
      ${narrative || '<p class="text-slate-500 text-sm">No findings available.</p>'}
    </div>
    ${sections}
  `;

  modal.classList.remove('hidden');
}

function closeReportModal() {
  const modal = document.getElementById('report-modal');
  if (modal) modal.classList.add('hidden');
}

function printReportPreview() {
  const report = currentReport;
  if (!report) {
    showNotification('Reports', 'Generate a report first', 'error');
    return;
  }

  const printWindow = window.open('', '_blank', 'width=1024,height=768');
  if (!printWindow) {
    showNotification('Reports', 'Allow pop-ups to print or save the report as PDF', 'error');
    return;
  }

  const sectionsHtml = (report.sections || []).map(section => `
    <h2>${escapeHtml(section.title)}</h2>
    <table>
      <thead><tr>${(section.columns || []).map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>
      <tbody>${(section.rows || []).map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
  `).join('');

  printWindow.document.write(`<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${escapeHtml(report.title)}</title>
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; padding: 32px; }
          h1 { font-size: 22px; margin: 0 0 4px; }
          h2 { font-size: 15px; margin: 22px 0 6px; }
          p { font-size: 12px; margin: 2px 0; line-height: 1.5; }
          .meta { color: #475569; }
          table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 11px; }
          th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; vertical-align: top; }
          th { background: #f1f5f9; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(report.title)}</h1>
        <p class="meta">${escapeHtml(report.subtitle || '')}</p>
        <p class="meta">Generated by ${escapeHtml(report.generatedBy?.fullName || 'Coordinator')} • Program period: ${escapeHtml(report.period?.label || '—')}</p>
        <h2>Automated Findings</h2>
        ${(report.narrative || []).map(line => `<p>• ${escapeHtml(line)}</p>`).join('')}
        ${sectionsHtml}
      </body>
    </html>`);

  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}

function downloadReportCSV() {
  const report = currentReport;
  if (!report || !report.csv) {
    showNotification('Reports', 'No report generated yet', 'error');
    return;
  }

  const csvEscape = (value) => `"${String(value === null || value === undefined ? '' : value).replace(/"/g, '""')}"`;
  const lines = [report.csv.headers.map(csvEscape).join(',')];
  report.csv.rows.forEach(row => lines.push(row.map(csvEscape).join(',')));

  const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = report.csv.filename || 'TrackIT_Report.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showNotification('Reports', `${link.download} downloaded`, 'success');
}

function generateSemesterReport() {
  generateReport('summary', 'preview');
}

function exportTraineeData() {
  generateReport('trainees', 'csv');
}

function exportAttendanceLogs() {
  generateReport('attendance', 'csv');
}

function exportJournalAnalytics() {
  generateReport('journals', 'preview');
}

// ────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ────────────────────────────────────────────────────────────────────────────

function markAllRead() {
  document.querySelectorAll('.notification-item').forEach(item => {
    item.classList.remove('unread');
    const dot = item.querySelector('.unread-dot');
    if (dot) dot.remove();
  });
  showNotification('Success', 'All notifications marked as read', 'success');
}

function filterNotifications(type) {
  const tabs = document.querySelectorAll('.filter-tab');
  tabs.forEach(tab => tab.classList.remove('active'));
  event.target.classList.add('active');
  showNotification('Notice', `Filtering notifications: ${type}`, 'info');
}

// ────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ────────────────────────────────────────────────────────────────────────────

function saveCoordinatorProfile(event) {
  event.preventDefault();
  const name = document.getElementById('coord-name').value;
  showNotification('Success', `Profile updated!\nName: ${name}`, 'success');
}

async function changeCoordinatorPassword(event) {
  event.preventDefault();
  const current = document.getElementById('coord-current-pass').value;
  const newPass = document.getElementById('coord-new-pass').value;
  const confirm = document.getElementById('coord-confirm-pass').value;

  if (!current || !newPass || !confirm) {
    showNotification('Error', 'Please fill all password fields', 'error');
    return;
  }

  if (newPass !== confirm) {
    showNotification('Error', 'Passwords do not match', 'error');
    return;
  }

  if (newPass.length < 6) {
    showNotification('Error', 'New password must be at least 6 characters', 'error');
    return;
  }

  const btn = event.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Updating...';

  const result = await fetchAPI('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: current, newPassword: newPass })
  });

  btn.disabled = false;
  btn.textContent = 'Update Password';

  if (result && result.success) {
    showNotification('Success', 'Password changed successfully!', 'success');
    document.getElementById('coord-password-form').reset();
  } else {
    showNotification('Error', result?.message || 'Failed to change password. Please try again.', 'error');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// MOBILE MENU TOGGLE
// ────────────────────────────────────────────────────────────────────────────

function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const isOpen = sidebar.classList.toggle('open');
  if (overlay) overlay.classList.toggle('visible', isOpen);
}

function closeSidebarOnMobile() {
  if (window.innerWidth <= 768) {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('visible');
  }
}

let coordinatorRealtimeTimer = null;

/**
 * Keeps whatever tab is on screen current.
 *
 * The loop wakes every REFRESH_TICK_MS but only does work once REFRESH_MIN_GAP_MS
 * has passed AND the coordinator has stopped interacting. A refresh postponed
 * by a click or a scroll is retried on a later tick rather than lost, so the
 * view stays fresh without anything repainting while it is being read.
 */
function startCoordinatorRealtimeUpdates() {
  if (coordinatorRealtimeTimer) clearInterval(coordinatorRealtimeTimer);

  lastRefreshAt = Date.now();

  coordinatorRealtimeTimer = setInterval(async () => {
    if (document.hidden) return;
    if (Date.now() - lastRefreshAt < REFRESH_MIN_GAP_MS) return;
    if (!interactionSettled()) return;

    const activeTab = document.querySelector('.tab-content.active')?.id;

    // The "All Students" modal paginates off this same list, so a refresh under
    // it would throw the coordinator back to page one. Wait until it closes.
    if (activeTab === 'trainees' && allTraineesModalOpen()) return;

    lastRefreshAt = Date.now();

    try {
      if (activeTab === 'overview') {
        await loadDashboardData({ background: true });
      } else if (activeTab === 'trainees') {
        await loadTrainees({ background: true });
      } else if (activeTab === 'journal-review') {
        await loadCoordinatorJournals(currentJournalFilter, { background: true });
      } else if (activeTab === 'analytics') {
        await loadAnalyticsData({ background: true });
      }
    } catch (error) {
      console.error('Coordinator real-time update failed:', error);
    }
  }, REFRESH_TICK_MS);
}

// ────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION & LOGOUT
// ────────────────────────────────────────────────────────────────────────────

function logout() {
  VerificationModal.open({
    type: 'confirm',
    title: 'Log Out',
    description: 'You will be signed out of TrackIT on this device.',
    confirmLabel: 'Log Out',
    onConfirm: () => {
      localStorage.removeItem('trackit_token');
      localStorage.removeItem('trackit_user');
      localStorage.removeItem('trackit_current_tab');
      window.location.href = 'loginpage.html';
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// GLOBAL SEARCH
// ────────────────────────────────────────────────────────────────────────────

let globalSearchDebounceTimer = null;
let globalSearchSelectedIndex = -1;
let globalSearchResults = [];
let isGlobalSearchOpen = false;
let isMobileSearchOpen = false;

/** Initialize global search event listeners */
function initGlobalSearch() {
  const desktopInput = document.getElementById('global-search-input');
  const mobileInput = document.getElementById('mobile-search-input');
  const desktopResults = document.getElementById('global-search-results');
  const mobileResults = document.getElementById('mobile-search-results');
  const desktopLoading = document.getElementById('global-search-loading');
  const mobileSearchOverlay = document.getElementById('mobile-search-overlay');
  const mobileSearchPanel = document.getElementById('mobile-search-panel');

  // Desktop search input
  if (desktopInput) {
    desktopInput.addEventListener('input', (e) => handleGlobalSearchInput(e.target.value));
    desktopInput.addEventListener('focus', () => {
      if (desktopInput.value.trim().length >= 2) {
        showGlobalSearchResults();
      }
    });
    desktopInput.addEventListener('keydown', (e) => handleGlobalSearchKeydown(e, 'desktop'));
    desktopInput.addEventListener('blur', () => {
      // Delay to allow click on results
      setTimeout(() => hideGlobalSearchResults(), 200);
    });
  }

  // Mobile search input
  if (mobileInput) {
    mobileInput.addEventListener('input', (e) => handleGlobalSearchInput(e.target.value, 'mobile'));
    mobileInput.addEventListener('keydown', (e) => handleGlobalSearchKeydown(e, 'mobile'));
  }

  // Close on click outside (desktop)
  document.addEventListener('click', (e) => {
    const container = document.getElementById('global-search-container');
    const resultsEl = document.getElementById('global-search-results');
    const loadingEl = document.getElementById('global-search-loading');
    const input = document.getElementById('global-search-input');

    if (container && !container.contains(e.target) &&
        resultsEl && !resultsEl.contains(e.target) &&
        loadingEl && !loadingEl.contains(e.target) &&
        input && !input.contains(e.target)) {
      hideGlobalSearchResults();
    }
  });

  // Mobile search toggle. #mobile-search-btn is wired from the markup with
  // onclick="toggleMobileSearch()" — do NOT also add a listener here. Both fire
  // on one tap, the second call sees isMobileSearchOpen === true and closes the
  // panel again, so the button appeared dead on phones.
  if (mobileSearchOverlay) {
    mobileSearchOverlay.addEventListener('click', closeMobileSearch);
  }

  // Keyboard shortcuts: Ctrl+K or / to focus search
  document.addEventListener('keydown', (e) => {
    // Don't trigger if user is typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      return;
    }

    // Ctrl+K (or Cmd+K on Mac)
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      focusGlobalSearch();
    }

    // Forward slash / to focus search (only if not in an input)
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      focusGlobalSearch();
    }

    // Escape to close search
    if (e.key === 'Escape') {
      hideGlobalSearchResults();
      closeMobileSearch();
      closeTraineeProfileModal();
    }
  });

  // Reposition dropdown on window resize/scroll
  let repositionTimeout = null;
  const reposition = () => {
    if (isGlobalSearchOpen) {
      positionGlobalSearchDropdown();
    }
  };
  window.addEventListener('resize', () => {
    clearTimeout(repositionTimeout);
    repositionTimeout = setTimeout(reposition, 50);
  }, { passive: true });
  window.addEventListener('scroll', () => {
    clearTimeout(repositionTimeout);
    repositionTimeout = setTimeout(reposition, 50);
  }, { passive: true });
}

/** Focus the global search input (desktop or mobile) */
function focusGlobalSearch() {
  if (window.innerWidth >= 768) {
    const input = document.getElementById('global-search-input');
    if (input) {
      input.focus();
      input.select();
    }
  } else {
    toggleMobileSearch();
    setTimeout(() => {
      const input = document.getElementById('mobile-search-input');
      if (input) input.focus();
    }, 100);
  }
}

/** Handle search input with debounce */
function handleGlobalSearchInput(query, platform = 'desktop') {
  const resultsEl = platform === 'desktop'
    ? document.getElementById('global-search-results')
    : document.getElementById('mobile-search-results');
  const loadingEl = platform === 'desktop'
    ? document.getElementById('global-search-loading')
    : null;

  clearTimeout(globalSearchDebounceTimer);

  if (query.trim().length < 2) {
    hideGlobalSearchResults(platform);
    return;
  }

  // Show loading state (position it first — it's position:fixed with no offsets by default)
  if (loadingEl) {
    if (platform === 'desktop') positionGlobalSearchDropdown();
    loadingEl.classList.remove('hidden');
  }

  globalSearchDebounceTimer = setTimeout(() => {
    performGlobalSearch(query.trim(), platform);
  }, 300); // 300ms debounce
}

/** Perform the actual search against traineesCache */
function performGlobalSearch(query, platform = 'desktop') {
  const resultsEl = platform === 'desktop'
    ? document.getElementById('global-search-results')
    : document.getElementById('mobile-search-results');
  const loadingEl = platform === 'desktop'
    ? document.getElementById('global-search-loading')
    : null;

  if (loadingEl) {
    loadingEl.classList.add('hidden');
  }

  if (!traineesCache || traineesCache.length === 0) {
    renderGlobalSearchResults([], platform, 'no-trainees');
    return;
  }

  const lowerQuery = query.toLowerCase();

  // Search across multiple fields
  const matches = traineesCache.filter(trainee => {
    const name = (trainee.fullName || '').toLowerCase();
    const studentId = (trainee.studentId || '').toLowerCase();
    const department = (trainee.department || '').toLowerCase();
    const section = (trainee.section || '').toLowerCase();
    const company = (trainee.companyName || '').toLowerCase();
    const status = trainee.activityStatus || (trainee.isActive === false ? 'INACTIVE' : 'ACTIVE');

    return name.includes(lowerQuery) ||
      studentId.includes(lowerQuery) ||
      department.includes(lowerQuery) ||
      section.includes(lowerQuery) ||
      company.includes(lowerQuery) ||
      status.toLowerCase().includes(lowerQuery);
  });

  // Limit to 8 results
  globalSearchResults = matches.slice(0, 8);
  globalSearchSelectedIndex = -1;

  renderGlobalSearchResults(globalSearchResults, platform);
}

/** Render search results */
function renderGlobalSearchResults(results, platform = 'desktop', state = 'results') {
  const resultsEl = platform === 'desktop'
    ? document.getElementById('global-search-results')
    : document.getElementById('mobile-search-results');

  if (!resultsEl) return;

  if (state === 'no-trainees') {
    resultsEl.innerHTML = `
      <div class="search-empty-state">
        <svg class="search-empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
          <circle cx="9" cy="7" r="4"></circle>
          <line x1="12" y1="2" x2="12" y2="6"></line>
        </svg>
        <p class="search-empty-state__title">No trainees yet</p>
        <p class="search-empty-state__text">Registered trainees will appear here as soon as they are enrolled.</p>
      </div>
    `;
    showGlobalSearchResults(platform);
    return;
  }

  if (results.length === 0) {
    resultsEl.innerHTML = `
      <div class="search-empty-state">
        <svg class="search-empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <p class="search-empty-state__title">No trainees found</p>
        <p class="search-empty-state__text">Try searching by name, student ID, section, course, or company.</p>
      </div>
      <a href="#" class="search-view-all" onclick="event.preventDefault(); closeGlobalSearch(); switchTab('trainees'); document.getElementById('trainee-search').value = document.getElementById('global-search-input').value; applyTraineeFilters();">View all results →</a>
    `;
    showGlobalSearchResults(platform);
    return;
  }

  const html = results.map((trainee, index) => {
    const initials = getInitials(trainee.fullName);
    const status = getTraineeDisplayStatus(trainee);
    const statusClass = getStatusClassName(status);
    const courseSection = `${trainee.department || ''} ${trainee.section ? '• ' + trainee.section : ''}`.trim();
    const studentId = trainee.studentId ? `ID: ${trainee.studentId}` : '';

    if (platform === 'desktop') {
      return `
        <button type="button" class="search-result-item w-full text-left" tabindex="-1" data-index="${index}" data-trainee-id="${trainee._id}" onclick="selectGlobalSearchResult('${trainee._id}')" onmouseenter="highlightGlobalSearchResult(${index})" onfocus="highlightGlobalSearchResult(${index})">
          <span class="search-result-avatar" aria-hidden="true">${escapeHtml(initials)}</span>
          <div class="search-result-info">
            <span class="search-result-name">${escapeHtml(trainee.fullName || 'Unknown Trainee')}</span>
            <div class="search-result-meta">
              ${courseSection ? `<span class="search-result-course-section">${escapeHtml(courseSection)}</span>` : ''}
              ${studentId ? `<span class="search-result-course-section">${escapeHtml(studentId)}</span>` : ''}
              ${trainee.companyName ? `<span class="search-result-course-section">${escapeHtml(trainee.companyName)}</span>` : ''}
              <span class="search-result-status ${statusClass}">${escapeHtml(status)}</span>
            </div>
          </div>
        </button>
      `;
    } else {
      return `
        <div class="mobile-search-result" data-index="${index}" data-trainee-id="${trainee._id}" onclick="selectGlobalSearchResult('${trainee._id}')" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' ')selectGlobalSearchResult('${trainee._id}')">
          <div class="mobile-search-result-header">
            <span class="mobile-search-result-avatar" aria-hidden="true">${escapeHtml(initials)}</span>
            <span class="mobile-search-result-name">${escapeHtml(trainee.fullName || 'Unknown Trainee')}</span>
            <span class="mobile-search-result-status ${statusClass}">${escapeHtml(status)}</span>
          </div>
          <div class="mobile-search-result-meta">
            ${courseSection ? `<span>${escapeHtml(courseSection)}</span>` : ''}
            ${studentId ? `<span>${escapeHtml(studentId)}</span>` : ''}
            ${trainee.companyName ? `<span>${escapeHtml(trainee.companyName)}</span>` : ''}
          </div>
        </div>
      `;
    }
  }).join('');

  // Add "View all results" link for desktop
  const viewAllHtml = platform === 'desktop' ? `
    <a href="#" class="search-view-all" onclick="event.preventDefault(); closeGlobalSearch(); switchTab('trainees'); document.getElementById('trainee-search').value = document.getElementById('global-search-input').value; applyTraineeFilters();">View all results →</a>
  ` : '';

  resultsEl.innerHTML = html + viewAllHtml;
  showGlobalSearchResults(platform);
}

/** Position the desktop search dropdown below the input */
function positionGlobalSearchDropdown() {
  const input = document.getElementById('global-search-input');
  const resultsEl = document.getElementById('global-search-results');
  const loadingEl = document.getElementById('global-search-loading');

  if (!input || (!resultsEl && !loadingEl)) return;

  const rect = input.getBoundingClientRect();
  const top = rect.bottom + 6; // 6px gap (fixed is viewport-relative: no scroll offsets)
  const left = rect.left;
  const width = rect.width;

  [resultsEl, loadingEl].forEach(el => {
    if (el) {
      el.style.top = `${top}px`;
      el.style.left = `${left}px`;
      el.style.width = `${width}px`;
    }
  });
}

/** Show search results dropdown */
function showGlobalSearchResults(platform = 'desktop') {
  const resultsEl = platform === 'desktop'
    ? document.getElementById('global-search-results')
    : document.getElementById('mobile-search-results');
  const loadingEl = platform === 'desktop'
    ? document.getElementById('global-search-loading')
    : null;

  if (platform === 'desktop') {
    positionGlobalSearchDropdown();
  }

  if (resultsEl) {
    resultsEl.classList.remove('hidden');
  }
  // Results replace the loading indicator — never show both at once
  if (loadingEl) {
    loadingEl.classList.add('hidden');
  }

  // isMobileSearchOpen tracks the full-screen panel, which toggleMobileSearch
  // owns. Showing results must not claim the panel is open (or that it closed).
  if (platform === 'desktop') isGlobalSearchOpen = true;
}

/** Hide search results dropdown */
function hideGlobalSearchResults(platform = 'desktop') {
  const desktopResults = document.getElementById('global-search-results');
  const mobileResults = document.getElementById('mobile-search-results');

  if (platform === 'desktop' || platform === 'both') {
    if (desktopResults) desktopResults.classList.add('hidden');
    const desktopLoading = document.getElementById('global-search-loading');
    if (desktopLoading) desktopLoading.classList.add('hidden');
    isGlobalSearchOpen = false;
    globalSearchSelectedIndex = -1;
  }
  if (platform === 'mobile' || platform === 'both') {
    if (mobileResults) mobileResults.classList.add('hidden');
    // isMobileSearchOpen belongs to toggleMobileSearch/closeMobileSearch: the
    // panel can stay open with no results (query too short), so hiding the
    // results list must not mark the panel as closed.
    globalSearchSelectedIndex = -1;
  }
}

/** Close all search interfaces */
function closeGlobalSearch() {
  hideGlobalSearchResults('both');
  const desktopInput = document.getElementById('global-search-input');
  const mobileInput = document.getElementById('mobile-search-input');
  if (desktopInput) desktopInput.value = '';
  if (mobileInput) mobileInput.value = '';
}

/** Highlight a search result (keyboard navigation) */
function highlightGlobalSearchResult(index) {
  const resultsEl = document.getElementById('global-search-results');
  if (!resultsEl) return;

  const items = resultsEl.querySelectorAll('.search-result-item');
  items.forEach((item, i) => {
    if (i === index) {
      item.classList.add('bg-blue-500/10');
      globalSearchSelectedIndex = index;
    } else {
      item.classList.remove('bg-blue-500/10');
    }
  });
}

/** Handle keyboard navigation in search results */
function handleGlobalSearchKeydown(e, platform = 'desktop') {
  const resultsEl = platform === 'desktop'
    ? document.getElementById('global-search-results')
    : document.getElementById('mobile-search-results');

  if (!resultsEl || resultsEl.classList.contains('hidden')) return;

  const items = resultsEl.querySelectorAll(platform === 'desktop' ? '.search-result-item' : '.mobile-search-result');
  if (items.length === 0) return;

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      globalSearchSelectedIndex = Math.min(globalSearchSelectedIndex + 1, items.length - 1);
      highlightGlobalSearchResult(globalSearchSelectedIndex);
      items[globalSearchSelectedIndex]?.focus();
      break;
    case 'ArrowUp':
      e.preventDefault();
      globalSearchSelectedIndex = Math.max(globalSearchSelectedIndex - 1, 0);
      highlightGlobalSearchResult(globalSearchSelectedIndex);
      items[globalSearchSelectedIndex]?.focus();
      break;
    case 'Enter':
      e.preventDefault();
      if (globalSearchSelectedIndex >= 0 && globalSearchSelectedIndex < items.length) {
        const traineeId = items[globalSearchSelectedIndex].dataset.traineeId;
        selectGlobalSearchResult(traineeId);
      }
      break;
    case 'Escape':
      closeGlobalSearch();
      break;
  }
}

/** Select a search result and open trainee profile modal */
function selectGlobalSearchResult(traineeId) {
  closeGlobalSearch();
  // On phones the search UI is a full-screen panel. closeGlobalSearch() only
  // hides the result list, so without this the profile modal would close back
  // onto an empty search screen. Read the DOM rather than the flag so this is
  // correct no matter how the panel was opened.
  const mobilePanel = document.getElementById('mobile-search-panel');
  if (mobilePanel && !mobilePanel.classList.contains('hidden')) {
    closeMobileSearch();
  }
  openTraineeProfileModal(traineeId);
}

/** Get trainee initials for avatar */
function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Get display status for trainee */
function getTraineeDisplayStatus(trainee) {
  if (trainee.activityStatus === 'INACTIVE' || trainee.isActive === false) return 'Inactive';
  const lateIds = attentionTraineeIds.late || [];
  if (lateIds.includes(String(trainee._id))) return 'Late';
  return 'Active';
}

/** Get CSS class for status */
function getStatusClassName(status) {
  switch (status) {
    case 'Active': return 'search-result-status--active';
    case 'Inactive': return 'search-result-status--inactive';
    case 'Late': return 'search-result-status--late';
    default: return 'search-result-status--active';
  }
}

/** Toggle mobile search panel */
function toggleMobileSearch() {
  const overlay = document.getElementById('mobile-search-overlay');
  const panel = document.getElementById('mobile-search-panel');
  const input = document.getElementById('mobile-search-input');

  if (isMobileSearchOpen) {
    closeMobileSearch();
  } else {
    overlay?.classList.remove('hidden');
    panel?.classList.remove('hidden');
    isMobileSearchOpen = true;
    document.body.style.overflow = 'hidden';
    if (input) input.focus();
  }
}

/** Close mobile search panel */
function closeMobileSearch() {
  const overlay = document.getElementById('mobile-search-overlay');
  const panel = document.getElementById('mobile-search-panel');
  const input = document.getElementById('mobile-search-input');

  overlay?.classList.add('hidden');
  panel?.classList.add('hidden');
  isMobileSearchOpen = false;
  document.body.style.overflow = '';
  if (input) input.value = '';
  hideGlobalSearchResults('mobile');
}

/** Paints the profile header/overview instantly from the table cache. */
function paintCachedTraineeProfile(traineeId) {
  const trainee = traineesCache.find(t => String(t._id) === String(traineeId));
  if (!trainee) return;

  currentTraineeProfileId = traineeId;
  window.currentTraineeProfileId = traineeId;

  const modal = document.getElementById('trainee-profile-modal');
  if (!modal) return;

  // Populate header
  const initials = getInitials(trainee.fullName);
  document.getElementById('trainee-profile-avatar').textContent = initials;
  document.getElementById('trainee-profile-name').textContent = trainee.fullName || 'Unknown Trainee';

  const courseSection = `${trainee.department || ''} ${trainee.section ? '• ' + trainee.section : ''}`.trim();
  const studentId = trainee.studentId ? `Student ID: ${trainee.studentId}` : '';
  document.getElementById('trainee-profile-meta').textContent = [courseSection, studentId].filter(Boolean).join(' | ');

  const status = getTraineeDisplayStatus(trainee);
  const statusClass = getStatusClassName(status);
  document.getElementById('trainee-profile-status').innerHTML = `
    <span class="status-badge ${statusClass.replace('search-result-status--', 'status-')}">${status}</span>
  `;

  // Populate details grid
  const detailsHtml = `
    <div class="trainee-profile-detail">
      <span class="trainee-profile-detail__label">Student ID</span>
      <span class="trainee-profile-detail__value">${trainee.studentId || '—'}</span>
    </div>
    <div class="trainee-profile-detail">
      <span class="trainee-profile-detail__label">Course</span>
      <span class="trainee-profile-detail__value">${trainee.department || '—'}</span>
    </div>
    <div class="trainee-profile-detail">
      <span class="trainee-profile-detail__label">Section</span>
      <span class="trainee-profile-detail__value">${trainee.section || '—'}</span>
    </div>
    <div class="trainee-profile-detail">
      <span class="trainee-profile-detail__label">Company</span>
      <span class="trainee-profile-detail__value">${trainee.companyName || 'Not assigned'}</span>
    </div>
  `;
  document.getElementById('trainee-profile-details').innerHTML = detailsHtml;

  // Populate OJT Progress
  const completedHours = Number(trainee.completedHours) || 0;
  const requiredHours = Number(trainee.requiredHours) || 486;
  const remainingHours = Math.max(0, requiredHours - completedHours);
  const progressPercent = requiredHours > 0 ? Math.min(100, Math.round((completedHours / requiredHours) * 100)) : 0;

  document.getElementById('trainee-profile-hours').textContent = `${completedHours.toFixed(1)} / ${requiredHours} hrs`;
  document.getElementById('trainee-profile-progress-fill').style.width = `${progressPercent}%`;
  document.getElementById('trainee-profile-required').textContent = `${requiredHours} hrs`;
  document.getElementById('trainee-profile-remaining').textContent = `${remainingHours.toFixed(1)} hrs`;

  // Populate Assignment
  const supervisorName = trainee.supervisorId?.fullName || 'Unassigned';
  const supervisorCompany = trainee.supervisorId?.companyName || '';
  const supervisorPosition = trainee.supervisorId?.companyPosition || '';
  const supervisorEmail = trainee.supervisorId?.email || '';

  let assignmentHtml = `
    <div class="trainee-profile-assignment__row">
      <span class="trainee-profile-assignment__label">Supervisor</span>
      <span class="trainee-profile-assignment__value">${escapeHtml(supervisorName)}${supervisorCompany ? ' — ' + escapeHtml(supervisorCompany) : ''}</span>
    </div>
  `;

  if (supervisorPosition) {
    assignmentHtml += `
      <div class="trainee-profile-assignment__row">
        <span class="trainee-profile-assignment__label">Position</span>
        <span class="trainee-profile-assignment__value">${escapeHtml(supervisorPosition)}</span>
      </div>
    `;
  }

  if (supervisorEmail) {
    assignmentHtml += `
      <div class="trainee-profile-assignment__row">
        <span class="trainee-profile-assignment__label">Email</span>
        <span class="trainee-profile-assignment__value">${escapeHtml(supervisorEmail)}</span>
      </div>
    `;
  }

  if (trainee.supervisorAssignedAt) {
    const assignedDate = new Date(trainee.supervisorAssignedAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
    assignmentHtml += `
      <div class="trainee-profile-assignment__row">
        <span class="trainee-profile-assignment__label">Assigned Since</span>
        <span class="trainee-profile-assignment__value">${assignedDate}</span>
      </div>
    `;
  }

  document.getElementById('trainee-profile-assignment').innerHTML = assignmentHtml;

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Focus trap
  setTimeout(() => {
    const closeBtn = modal.querySelector('button[onclick="closeTraineeProfileModal()"]');
    if (closeBtn) closeBtn.focus();
  }, 100);
}

// ────────────────────────────────────────────────────────────────────────────
// TRAINEE PROFILE — comprehensive OJT monitoring view
// ────────────────────────────────────────────────────────────────────────────
// paintCachedTraineeProfile() above paints an instant header from the table
// cache; everything below fetches the trainee's full OJT record from
// GET /api/coordinator/trainee/:id and renders it across four sections.
// Every figure is computed from those real records: verified hours only ever
// count complete, supervisor-verified DTRs, and the view never invents a
// time-in or time-out it does not have.

let currentTraineeProfileId = null;
let tpData = null;             // payload of the profile on screen
let tpError = '';
let tpLoading = false;
let tpActiveTab = 'overview';
let tpJournalsPage = 1;
let tpDtrPage = 1;
let tpOpenDtrId = null;        // DTR whose detail row is expanded
let tpTimelineLimit = 15;
let tpAttendanceChart = null;

const TP_PAGE_SIZE = 10;
// Mirrors TOTAL_OJT_WEEKS in backend/routes/stats.js.
const TP_TOTAL_OJT_WEEKS = 17;
// Week labels arrive as "Week 3", "3" or "03".
const TP_WEEK_LABEL_RE = /^\s*(?:week\s*)?0*(\d+)\s*$/i;

const TP_TIMELINE_ICONS = {
  journal: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
  attendance: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
  supervisor: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>',
};

// ── formatting & small utilities ────────────────────────────────────────────

function tpHours(value) {
  return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function tpParseWeekLabel(label) {
  const match = TP_WEEK_LABEL_RE.exec(String(label == null ? '' : label));
  return match ? Number(match[1]) : null;
}

/** OJT week number: week 1 contains the placement start day, capped at 17. */
function tpCurrentOjtWeek(startDate, now = new Date()) {
  const start = startOfDay(new Date(startDate));
  const today = startOfDay(now);
  if (Number.isNaN(start.getTime()) || today.getTime() < start.getTime()) return 0;
  const elapsed = Math.floor((today.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return Math.min(elapsed + 1, TP_TOTAL_OJT_WEEKS);
}

/** Calendar span an OJT week covers: [start + (week-1)*7 … +6 days]. */
function tpCoverageForWeek(startDate, week) {
  const from = addDays(startOfDay(new Date(startDate)), (week - 1) * 7);
  return { from, to: addDays(from, 6) };
}

function tpFormatDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function tpFormatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function tpFormatRange(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return '—';
  const left = a.toLocaleDateString('en-US', a.getFullYear() === b.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
  return `${left} – ${tpFormatDay(b)}`;
}

/**
 * Weekdays (Mon–Fri) with no time-in record. Derived, so it is always
 * labelled "weekdays without a record" — configured holidays are not
 * excluded and it is never presented as an official absence count.
 */
function tpWeekdaysWithoutRecord(startDate, dtrs, endDate) {
  if (!startDate) return null;
  const from = startOfDay(new Date(startDate));
  const to = startOfDay(new Date(endDate || Date.now()));
  if (Number.isNaN(from.getTime()) || to.getTime() < from.getTime()) return 0;
  const recorded = new Set(dtrs.filter(d => d.timeIn).map(d => dayKey(new Date(d.date))));
  let gaps = 0;
  for (let day = new Date(from); day <= to; day = addDays(day, 1)) {
    const dow = day.getDay();
    if (dow === 0 || dow === 6) continue;
    if (!recorded.has(dayKey(day))) gaps += 1;
  }
  return gaps;
}

/** Pager shared by the profile's journal and DTR tables. */
function tpPagerHtml(currentPage, totalPages, handler) {
  if (totalPages <= 1) return '';

  const parts = [];
  parts.push(currentPage === 1
    ? '<button type="button" disabled class="pager__btn">Prev</button>'
    : `<button type="button" onclick="${handler}(${currentPage - 1})" class="pager__btn">Prev</button>`);

  const windowSize = 2;
  const first = Math.max(1, currentPage - windowSize);
  const last = Math.min(totalPages, currentPage + windowSize);
  const pages = [];
  if (first > 1) {
    pages.push(1);
    if (first > 2) pages.push('…');
  }
  for (let page = first; page <= last; page++) pages.push(page);
  if (last < totalPages) {
    if (last < totalPages - 1) pages.push('…');
    pages.push(totalPages);
  }

  pages.forEach(page => {
    if (page === '…') {
      parts.push('<span class="pager__ellipsis">…</span>');
      return;
    }
    parts.push(page === currentPage
      ? `<button type="button" class="pager__btn pager__btn--current" aria-current="page">${page}</button>`
      : `<button type="button" onclick="${handler}(${page})" class="pager__btn">${page}</button>`);
  });

  parts.push(currentPage === totalPages
    ? '<button type="button" disabled class="pager__btn">Next</button>'
    : `<button type="button" onclick="${handler}(${currentPage + 1})" class="pager__btn">Next</button>`);

  return parts.join('');
}

function tpSkeletonCellRows(rows, cols) {
  let html = '';
  for (let r = 0; r < rows; r++) {
    html += '<tr>';
    for (let c = 0; c < cols; c++) html += '<td class="cell"><span class="skel skel--cell"></span></td>';
    html += '</tr>';
  }
  return html;
}

function tpSkeletonLines(count) {
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `<span class="skel skel--line ${i === count - 1 ? 'skel--short' : 'skel--mid'}"></span>`;
  }
  return html;
}

/** Centered empty / info / error block for the non-table panels. */
function tpStateBlock(title, text, actionHtml = '') {
  return `
    <div class="tp-state">
      <p class="tp-state__title">${escapeHtml(title)}</p>
      <p class="tp-state__text">${escapeHtml(text)}</p>
      ${actionHtml}
    </div>
  `;
}

function setKpi(id, value, note) {
  const card = el(id);
  if (!card) return;
  const num = card.querySelector('.tp-kpi__num');
  const noteEl = card.querySelector('.tp-kpi__note-text');
  if (num) num.textContent = value;
  if (noteEl) noteEl.textContent = note;
}

// ── header, KPI row, loading & error states ─────────────────────────────────

/** Paints the profile header from a cache or payload trainee object. */
function renderProfileHeaderFrom(trainee) {
  if (!trainee) return;

  const name = trainee.fullName || 'Unknown Trainee';
  const avatar = el('trainee-profile-avatar');
  if (avatar) avatar.textContent = getInitials(name);
  const nameEl = el('trainee-profile-name');
  if (nameEl) nameEl.textContent = name;

  const parts = [];
  const courseSection = [trainee.department, trainee.section].filter(Boolean).join(' • ');
  if (courseSection) parts.push(courseSection);
  if (trainee.companyName) parts.push(trainee.companyName);
  if (trainee.studentId) parts.push(`Student ID: ${trainee.studentId}`);
  const meta = el('trainee-profile-meta');
  if (meta) meta.textContent = parts.join(' | ') || 'No placement details recorded';

  const status = getTraineeDisplayStatus(trainee);
  const statusClass = getStatusClassName(status).replace('search-result-status--', 'status-');
  const badges = [`<span class="status-badge ${statusClass}">${escapeHtml(status)}</span>`];

  if (trainee.supervisorId && trainee.supervisorId.fullName) {
    badges.push(`<span class="chip chip--info">Supervisor: ${escapeHtml(trainee.supervisorId.fullName)}</span>`);
  } else {
    badges.push('<span class="chip chip--warning">Unassigned</span>');
  }
  if (trainee.supervisorAssignedAt) {
    const week = tpCurrentOjtWeek(trainee.supervisorAssignedAt);
    if (week >= 1) badges.push(`<span class="chip chip--neutral">OJT Week ${week}</span>`);
    badges.push(`<span class="chip chip--neutral">Since ${escapeHtml(tpFormatDay(trainee.supervisorAssignedAt))}</span>`);
  }

  const statusWrap = el('trainee-profile-status');
  if (statusWrap) statusWrap.innerHTML = badges.join('');

  // Assignment stays reachable from inside the profile itself.
  const actions = el('tp-header-actions');
  if (actions) {
    const traineeId = trainee._id || currentTraineeProfileId || '';
    actions.innerHTML = `
      <button type="button" class="btn-ghost btn-ghost--sm"
        onclick="openAssignModal('${jsStringArg(traineeId)}', '${jsStringArg(name)}')">
        ${trainee.supervisorId ? 'Reassign Supervisor' : 'Assign Supervisor'}
      </button>
    `;
  }
}

function renderProfileKpisLoading() {
  ['tp-kpi-hours', 'tp-kpi-attendance', 'tp-kpi-journals', 'tp-kpi-dtr'].forEach(id => {
    const card = el(id);
    if (card) {
      card.classList.add('is-loading');
      card.setAttribute('aria-busy', 'true');
    }
    setKpi(id, '—', '');
  });
  const footnote = el('tp-kpi-footnote');
  if (footnote) footnote.hidden = true;
}

/** The four overview cards, all computed from the fetched records. */
function renderProfileKpis(data) {
  const ids = ['tp-kpi-hours', 'tp-kpi-attendance', 'tp-kpi-journals', 'tp-kpi-dtr'];
  ids.forEach(id => {
    const card = el(id);
    if (card) {
      card.classList.remove('is-loading');
      card.removeAttribute('aria-busy');
    }
  });

  if (!data) {
    ids.forEach(id => setKpi(id, '—', 'Profile data unavailable'));
    return;
  }

  const trainee = data.trainee || {};
  const dtrs = Array.isArray(data.dtrRecords) ? data.dtrRecords : [];
  const journals = (Array.isArray(data.journals) ? data.journals : [])
    .filter(j => j && j.status !== 'draft');

  // Hours: verified only (complete + supervisor-verified DTRs, per the API).
  const verified = Number(data.verifiedHours) || 0;
  const required = Number(data.requiredHours) || Number(trainee.requiredHours) || 486;
  const remaining = Math.max(0, required - verified);
  const percent = required > 0 ? Math.min(100, (verified / required) * 100) : 0;
  const recorded = dtrs.reduce((sum, d) => sum + (Number(d.hoursRendered) || 0), 0);
  const unverifiedHours = Math.max(0, recorded - verified);
  setKpi('tp-kpi-hours', `${tpHours(verified)} / ${tpHours(required)} h`,
    `${percent.toFixed(1)}% complete · ${tpHours(remaining)} h remaining`
    + (unverifiedHours > 0.05 ? ` · ${tpHours(unverifiedHours)} h awaiting verification` : ''));
  const bar = el('tp-kpi-hours-bar');
  if (bar) bar.style.width = `${percent}%`;

  // Attendance: record counts only; derived gaps are footnoted separately.
  const counts = { present: 0, late: 0, absent: 0, excused: 0 };
  dtrs.forEach(d => {
    const key = Object.prototype.hasOwnProperty.call(counts, d.status) ? d.status : 'present';
    counts[key] += 1;
  });
  const unverifiedRecords = dtrs.filter(d => !d.verifiedBySupervisor).length;
  setKpi('tp-kpi-attendance', `${counts.present}`,
    `${counts.late} late · ${counts.excused} excused · ${counts.absent} absent · ${unverifiedRecords} unverified`);

  // Weekly journals against the weeks elapsed so far.
  const ojtStart = trainee.supervisorAssignedAt || null;
  const currentWeek = ojtStart ? tpCurrentOjtWeek(ojtStart) : 0;
  const expected = Math.min(currentWeek, TP_TOTAL_OJT_WEEKS);
  const weeksFiled = new Set();
  journals.forEach(journal => {
    const week = tpParseWeekLabel(journal.week);
    if (week) weeksFiled.add(week);
  });
  const reviewed = journals.filter(j => j.coordinatorApproved).length;
  const awaitingReview = journals.filter(j => j.supervisorSigned && !j.coordinatorApproved).length;
  const missing = Math.max(0, expected - weeksFiled.size);
  if (expected <= 0) {
    setKpi('tp-kpi-journals', '—', 'Journal weeks start with the first supervisor assignment');
  } else {
    setKpi('tp-kpi-journals', `${weeksFiled.size} / ${expected}`,
      `${reviewed} reviewed · ${awaitingReview} awaiting review · ${missing} missing`);
  }

  // DTR verification counts.
  const totalRecords = dtrs.length;
  const verifiedRecords = dtrs.filter(d => d.verifiedBySupervisor).length;
  if (totalRecords === 0) {
    setKpi('tp-kpi-dtr', '0 / 0', 'No time records yet');
  } else {
    setKpi('tp-kpi-dtr', `${verifiedRecords} / ${totalRecords}`,
      `${totalRecords - verifiedRecords} pending verification`);
  }

  // Derived weekday gaps — only ever shown with the caveat attached.
  const gaps = tpWeekdaysWithoutRecord(ojtStart, dtrs, new Date());
  const footnote = el('tp-kpi-footnote');
  if (footnote) {
    if (gaps > 0) {
      footnote.textContent = `Weekdays since the OJT start with no time-in record: ${gaps}. `
        + 'This counts missing records only — configured holidays are not excluded.';
      footnote.hidden = false;
    } else {
      footnote.hidden = true;
    }
  }

  const lastTimeIn = dtrs.map(d => d.timeIn).filter(Boolean).sort().pop();
  const lastEl = el('tp-last-timein');
  if (lastEl) {
    lastEl.innerHTML = lastTimeIn
      ? `Last time-in <strong>${escapeHtml(formatTimeIn(lastTimeIn))}</strong>`
      : 'No time-in recorded yet';
  }
}

function renderProfilePanelsLoading() {
  const journalBody = el('tp-journal-body');
  if (journalBody) journalBody.innerHTML = tpSkeletonCellRows(6, 7);
  const dtrBody = el('tp-dtr-body');
  if (dtrBody) dtrBody.innerHTML = tpSkeletonCellRows(6, 9);

  const summary = el('tp-att-summary');
  if (summary) {
    summary.innerHTML = Array.from({ length: 6 }, () =>
      '<div class="tp-stat"><span class="skel skel--line skel--short"></span><span class="skel skel--value"></span></div>').join('');
  }

  ['tp-att-issues', 'tp-att-latest'].forEach(id => {
    const node = el(id);
    if (node) {
      node.innerHTML = Array.from({ length: 3 }, () =>
        `<div class="tp-list__item"><div class="tp-list__main">${tpSkeletonLines(2)}</div></div>`).join('');
    }
  });

  const timeline = el('tp-timeline-list');
  if (timeline) {
    timeline.innerHTML = Array.from({ length: 4 }, () => `
      <li class="tp-timeline__item">
        <span class="skel" style="width:27px;height:27px;border-radius:50%;flex-shrink:0"></span>
        <div class="tp-timeline__body">${tpSkeletonLines(2)}</div>
      </li>`).join('');
  }

  ['tp-journal-count', 'tp-dtr-count-label', 'tp-timeline-count'].forEach(id => {
    const node = el(id);
    if (node) node.textContent = '';
  });
  ['tp-journal-pagination', 'tp-dtr-pagination'].forEach(id => {
    const node = el(id);
    if (node) node.innerHTML = '';
  });
}

function renderProfileLoadError() {
  const message = tpError || 'The trainee profile could not be loaded.';
  ['tp-kpi-hours', 'tp-kpi-attendance', 'tp-kpi-journals', 'tp-kpi-dtr'].forEach(id => {
    const card = el(id);
    if (card) {
      card.classList.remove('is-loading');
      card.removeAttribute('aria-busy');
    }
    setKpi(id, '—', 'Data unavailable');
  });
  const footnote = el('tp-kpi-footnote');
  if (footnote) footnote.hidden = true;

  const retry = currentTraineeProfileId
    ? `loadTraineeProfileData('${jsStringArg(currentTraineeProfileId)}')`
    : '';
  const retryHtml = retry
    ? `<button type="button" class="link-btn" onclick="${escapeHtml(retry)}">Try again</button>`
    : '';

  const journalBody = el('tp-journal-body');
  if (journalBody) journalBody.innerHTML = tableStateHtml('Profile unavailable', message, retry, 'Try again', 7);
  const dtrBody = el('tp-dtr-body');
  if (dtrBody) dtrBody.innerHTML = tableStateHtml('Profile unavailable', message, retry, 'Try again', 9);

  const attSummary = el('tp-att-summary');
  if (attSummary) attSummary.innerHTML = tpStateBlock('Profile unavailable', message, retryHtml);
  ['tp-att-issues', 'tp-att-latest'].forEach(id => {
    const node = el(id);
    if (node) node.innerHTML = tpStateBlock('Profile unavailable', message, retryHtml);
  });
  const timeline = el('tp-timeline-list');
  if (timeline) timeline.innerHTML = tpStateBlock('Profile unavailable', message, retryHtml);
}

// ── open / load / tab switching ─────────────────────────────────────────────

function tpShowProfileShell() {
  const modal = el('trainee-profile-modal');
  if (!modal) return;
  // Defensive re-parenting: if a stale cached copy of the markup still nests
  // the modal inside a tab pane (panes are display:none when inactive), lift
  // it to body level so the profile opens from any tab, including dashboard.
  if (modal.parentElement !== document.body) document.body.appendChild(modal);
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => {
    const closeBtn = modal.querySelector('.tp-modal__close');
    if (closeBtn) closeBtn.focus();
  }, 60);
}

function resetProfileControls() {
  [['tp-dtr-from', ''], ['tp-dtr-to', ''], ['tp-dtr-status', ''], ['tp-dtr-verification', ''],
   ['tp-att-from', ''], ['tp-att-to', '']].forEach(([id, value]) => {
    const node = el(id);
    if (node) node.value = value;
  });
  // Empty values make renderProfileJournals repopulate with the defaults
  // (week 1 … current week + 1) for the new trainee.
  ['tp-journal-from', 'tp-journal-to'].forEach(id => {
    const node = el(id);
    if (node) node.value = '';
  });
  const timelineFilter = el('tp-timeline-filter');
  if (timelineFilter) timelineFilter.value = 'all';
  const journalStatus = el('tp-journal-status');
  if (journalStatus) journalStatus.value = '';
}

function openTraineeProfileModal(traineeId) {
  if (!traineeId) return;
  markInteraction();

  currentTraineeProfileId = traineeId;
  window.currentTraineeProfileId = traineeId;
  tpData = null;
  tpError = '';
  tpLoading = true;
  tpActiveTab = 'overview';
  tpJournalsPage = 1;
  tpDtrPage = 1;
  tpOpenDtrId = null;
  tpTimelineLimit = 15;
  destroyProfileChart();
  resetProfileControls();

  // Clear leftovers from a previously opened profile before painting.
  const staleActions = el('tp-header-actions');
  if (staleActions) staleActions.innerHTML = '';

  // Paint what the table cache already holds so the modal answers instantly;
  // the full record lands a moment later from the API.
  const cached = traineesCache.find(t => String(t._id) === String(traineeId));
  if (cached) {
    paintCachedTraineeProfile(traineeId);
  } else {
    const avatar = el('trainee-profile-avatar');
    if (avatar) avatar.textContent = '…';
    const nameEl = el('trainee-profile-name');
    if (nameEl) nameEl.textContent = 'Loading trainee…';
    const meta = el('trainee-profile-meta');
    if (meta) meta.textContent = 'Fetching the OJT record…';
    const statusWrap = el('trainee-profile-status');
    if (statusWrap) statusWrap.innerHTML = '';
    const actions = el('tp-header-actions');
    if (actions) actions.innerHTML = '';

    const details = el('trainee-profile-details');
    if (details) details.innerHTML = tpSkeletonLines(2);
    ['trainee-profile-hours', 'trainee-profile-required', 'trainee-profile-remaining', 'trainee-profile-recorded'].forEach(id => {
      const node = el(id);
      if (node) node.textContent = '—';
    });
    const fill = el('trainee-profile-progress-fill');
    if (fill) fill.style.width = '0%';
    const assignment = el('trainee-profile-assignment');
    if (assignment) assignment.innerHTML = tpSkeletonLines(2);
  }

  const lastEl = el('tp-last-timein');
  if (lastEl) lastEl.textContent = '';

  renderProfileKpisLoading();
  renderProfilePanelsLoading();
  switchProfileTab('overview');
  tpShowProfileShell();

  loadTraineeProfileData(traineeId);
}

async function loadTraineeProfileData(traineeId) {
  const result = await fetchAPI(`/coordinator/trainee/${traineeId}`);

  // The modal closed or moved to another trainee while the request was in flight.
  if (String(currentTraineeProfileId || '') !== String(traineeId)) return;

  tpLoading = false;

  if (!result || !result.success || !result.data) {
    tpError = (result && result.message)
      || 'The trainee profile could not be loaded. Check your connection and try again.';
    renderProfileLoadError();
    return;
  }

  tpError = '';
  tpData = result.data;
  if (result.data.trainee) renderProfileHeaderFrom(result.data.trainee);
  renderProfileKpis(result.data);
  renderProfileTab();
}

function switchProfileTab(tab) {
  tpActiveTab = tab;

  document.querySelectorAll('#trainee-profile-modal .tp-tab').forEach(btn => {
    const target = (btn.id || '').replace('tp-tab-', '');
    const active = target === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
  });

  document.querySelectorAll('#trainee-profile-modal .tp-panel').forEach(panel => {
    const active = panel.id === `tp-panel-${tab}`;
    panel.classList.toggle('is-active', active);
    if (active) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');
  });

  renderProfileTab();
}

function renderProfileTab() {
  if (tpError) {
    renderProfileLoadError();
    return;
  }
  if (tpLoading || !tpData) return; // skeletons are already on screen

  switch (tpActiveTab) {
    case 'journals': renderProfileJournals(); break;
    case 'dtr': renderProfileDtr(); break;
    case 'attendance': renderProfileAttendance(); break;
    case 'timeline': renderProfileTimeline(); break;
    default: renderProfileOverview(tpData);
  }
}

// ── Overview section ────────────────────────────────────────────────────────

function renderProfileOverview(data) {
  const trainee = data.trainee || {};

  const detail = (label, value) => `
    <div class="trainee-profile-detail">
      <span class="trainee-profile-detail__label">${escapeHtml(label)}</span>
      <span class="trainee-profile-detail__value">${escapeHtml(value || '—')}</span>
    </div>`;

  const details = el('trainee-profile-details');
  if (details) {
    details.innerHTML = [
      detail('Student ID', trainee.studentId),
      detail('Course', trainee.department),
      detail('Section', trainee.section),
      detail('Company', trainee.companyName || 'Not assigned'),
      detail('OJT Start', trainee.supervisorAssignedAt ? tpFormatDay(trainee.supervisorAssignedAt) : 'Not started'),
      detail('Required Hours', `${tpHours(data.requiredHours || trainee.requiredHours || 486)} hrs`),
    ].join('');
  }

  const verified = Number(data.verifiedHours) || 0;
  const required = Number(data.requiredHours) || Number(trainee.requiredHours) || 486;
  const remaining = Number.isFinite(Number(data.remainingHours))
    ? Number(data.remainingHours)
    : Math.max(0, required - verified);
  const percent = required > 0 ? Math.min(100, (verified / required) * 100) : 0;

  const hoursEl = el('trainee-profile-hours');
  if (hoursEl) hoursEl.textContent = `${tpHours(verified)} / ${tpHours(required)} hrs`;
  const fill = el('trainee-profile-progress-fill');
  if (fill) fill.style.width = `${percent}%`;
  const requiredEl = el('trainee-profile-required');
  if (requiredEl) requiredEl.textContent = `${tpHours(required)} hrs`;
  const remainingEl = el('trainee-profile-remaining');
  if (remainingEl) remainingEl.textContent = `${tpHours(remaining)} hrs`;
  const recordedEl = el('trainee-profile-recorded');
  if (recordedEl) {
    const recorded = (data.dtrRecords || []).reduce((sum, d) => sum + (Number(d.hoursRendered) || 0), 0);
    recordedEl.textContent = `${tpHours(recorded)} hrs`;
  }

  const supervisor = trainee.supervisorId || {};
  const supervisorName = supervisor.fullName || 'Unassigned';
  let assignmentHtml = `
    <div class="trainee-profile-assignment__row">
      <span class="trainee-profile-assignment__label">Supervisor</span>
      <span class="trainee-profile-assignment__value">${escapeHtml(supervisorName)}${supervisor.companyName ? ' — ' + escapeHtml(supervisor.companyName) : ''}</span>
    </div>
  `;
  if (supervisor.companyPosition) {
    assignmentHtml += `
      <div class="trainee-profile-assignment__row">
        <span class="trainee-profile-assignment__label">Position</span>
        <span class="trainee-profile-assignment__value">${escapeHtml(supervisor.companyPosition)}</span>
      </div>`;
  }
  if (supervisor.email) {
    assignmentHtml += `
      <div class="trainee-profile-assignment__row">
        <span class="trainee-profile-assignment__label">Email</span>
        <span class="trainee-profile-assignment__value">${escapeHtml(supervisor.email)}</span>
      </div>`;
  }
  if (trainee.supervisorAssignedAt) {
    assignmentHtml += `
      <div class="trainee-profile-assignment__row">
        <span class="trainee-profile-assignment__label">Assigned Since</span>
        <span class="trainee-profile-assignment__value">${escapeHtml(tpFormatDay(trainee.supervisorAssignedAt))}</span>
      </div>`;
  }
  if (trainee.schedule && trainee.schedule.startTime && trainee.schedule.endTime) {
    assignmentHtml += `
      <div class="trainee-profile-assignment__row">
        <span class="trainee-profile-assignment__label">Work Schedule</span>
        <span class="trainee-profile-assignment__value">${escapeHtml(trainee.schedule.startTime)} – ${escapeHtml(trainee.schedule.endTime)}</span>
      </div>`;
  }
  const assignment = el('trainee-profile-assignment');
  if (assignment) assignment.innerHTML = assignmentHtml;
}

// ── Weekly Journals section ─────────────────────────────────────────────────

/** Week index for the tracker: 17 OJT weeks derived from the placement date. */
function tpJournalIndex() {
  const trainee = (tpData && tpData.trainee) || {};
  const startRaw = trainee.supervisorAssignedAt;
  if (!startRaw) return null;
  const start = new Date(startRaw);
  if (Number.isNaN(start.getTime())) return null;

  const currentWeek = tpCurrentOjtWeek(start);
  const byWeek = new Map();
  (tpData.journals || []).filter(j => j && j.status !== 'draft').forEach(journal => {
    const week = tpParseWeekLabel(journal.week);
    if (week) byWeek.set(week, journal);
  });

  const rows = [];
  for (let week = 1; week <= TP_TOTAL_OJT_WEEKS; week++) {
    const journal = byWeek.get(week) || null;
    const coverage = tpCoverageForWeek(start, week);
    rows.push({
      week,
      journal,
      from: coverage.from,
      to: coverage.to,
      submission: journal ? 'submitted' : (week > currentWeek ? 'not-due' : 'missing'),
    });
  }
  return { start, currentWeek, rows };
}

/** Review-state vocabulary taken straight from the existing journal workflow. */
function tpJournalReviewState(journal) {
  if (!journal) return null;
  if (journal.coordinatorApproved) return { key: 'reviewed', label: 'Reviewed', chip: 'chip--success' };
  if (journal.supervisorSigned) return { key: 'pending', label: 'Pending Review', chip: 'chip--info' };
  if (journal.coordinatorRemarks) return { key: 'returned', label: 'Returned', chip: 'chip--danger' };
  return { key: 'submitted', label: 'Awaiting Supervisor', chip: 'chip--warning' };
}

function tpJournalFilterKey(row) {
  if (!row.journal) return row.submission;
  const review = tpJournalReviewState(row.journal);
  // Returned journals were still handed in, so they sit under Submitted.
  return review.key === 'returned' ? 'submitted' : review.key;
}

function tpJournalRowHtml(row, currentWeek) {
  const journal = row.journal;
  const review = tpJournalReviewState(journal);

  const submissionChip = journal
    ? '<span class="chip chip--success">Submitted</span>'
    : (row.submission === 'not-due'
      ? '<span class="chip chip--neutral">Not Yet Due</span>'
      : '<span class="chip chip--danger">Missing</span>');

  const reviewChip = review
    ? `<span class="chip ${review.chip}">${review.label}</span>`
    : '<span class="tp-muted">—</span>';

  const submittedAt = journal ? (formatTimeIn(journal.submittedAt) || formatTimeIn(journal.createdAt)) : null;

  let action = '<span class="tp-muted">—</span>';
  if (journal) {
    // Deep-links into the existing review queue (approved when reviewed).
    const queue = review.key === 'reviewed' ? 'reviewed' : 'pending';
    action = `<button type="button" class="link-btn" onclick="tpOpenJournalFromProfile('${jsStringArg(journal._id)}', '${queue}')">Review</button>`;
  } else if (row.submission === 'missing') {
    action = '<span class="tp-wait" title="No journal has been submitted for this week">Not submitted</span>';
  }

  return `
    <tr>
      <td class="cell">
        <div class="tp-stack">
          <span class="tp-strong">Week ${row.week}</span>
          ${row.week === currentWeek ? '<span class="tp-stack__sub">Current week</span>' : ''}
        </div>
      </td>
      <td class="cell">${escapeHtml(tpFormatRange(row.from, row.to))}</td>
      <td class="cell" title="No separate deadline is configured; the journal covers the whole week.">
        <span class="tp-strong">${escapeHtml(tpFormatDay(row.to))}</span>
      </td>
      <td class="cell">${submissionChip}</td>
      <td class="cell">${submittedAt ? escapeHtml(submittedAt) : '<span class="tp-muted">—</span>'}</td>
      <td class="cell">${reviewChip}</td>
      <td class="cell"><div class="cell-actions">${action}</div></td>
    </tr>
  `;
}

function renderProfileJournals() {
  const index = tpJournalIndex();
  const fromSel = el('tp-journal-from');
  const toSel = el('tp-journal-to');
  const statusSel = el('tp-journal-status');
  const body = el('tp-journal-body');

  if (!index) {
    if (body) {
      body.innerHTML = tableStateHtml(
        'Journal weeks unavailable',
        'This trainee has no recorded supervisor assignment date, so OJT weeks cannot be derived yet.',
        '', '', 7);
    }
    [fromSel, toSel].forEach(sel => {
      if (!sel) return;
      sel.innerHTML = '<option value="">—</option>';
      sel.disabled = true;
    });
    const count = el('tp-journal-count');
    if (count) count.textContent = '';
    const countLabel = el('tp-journal-count-label');
    if (countLabel) countLabel.textContent = '';
    const pager = el('tp-journal-pagination');
    if (pager) pager.innerHTML = '';
    return;
  }

  // Populate the configurable week range, preserving the current selection.
  const currentFrom = Number(fromSel && fromSel.value) || 1;
  const currentTo = Number(toSel && toSel.value)
    || Math.min(index.currentWeek + 1, TP_TOTAL_OJT_WEEKS) || 1;
  const options = Array.from({ length: TP_TOTAL_OJT_WEEKS }, (_, i) =>
    `<option value="${i + 1}">Week ${i + 1}</option>`).join('');
  if (fromSel) {
    fromSel.disabled = false;
    fromSel.innerHTML = options;
    fromSel.value = String(Math.min(Math.max(currentFrom, 1), TP_TOTAL_OJT_WEEKS));
  }
  if (toSel) {
    toSel.disabled = false;
    toSel.innerHTML = options;
    toSel.value = String(Math.min(Math.max(currentTo, 1), TP_TOTAL_OJT_WEEKS));
  }

  const statusFilter = statusSel ? statusSel.value : '';
  const rows = index.rows.filter(row => !statusFilter || tpJournalFilterKey(row) === statusFilter);

  const totalPages = Math.max(1, Math.ceil(rows.length / TP_PAGE_SIZE));
  if (tpJournalsPage > totalPages) tpJournalsPage = totalPages;
  const pageRows = rows.slice((tpJournalsPage - 1) * TP_PAGE_SIZE, tpJournalsPage * TP_PAGE_SIZE);

  if (body) {
    body.innerHTML = pageRows.length
      ? pageRows.map(row => tpJournalRowHtml(row, index.currentWeek)).join('')
      : tableStateHtml('No weeks match these filters',
        'Change the week range or the submission status filter to see other OJT weeks.', '', '', 7);
  }

  const count = el('tp-journal-count');
  if (count) count.textContent = `${rows.length} of ${index.rows.length} OJT weeks`;
  const countLabel = el('tp-journal-count-label');
  if (countLabel) {
    countLabel.textContent = rows.length
      ? `Showing weeks ${(tpJournalsPage - 1) * TP_PAGE_SIZE + 1}–${Math.min(tpJournalsPage * TP_PAGE_SIZE, rows.length)} of ${rows.length}`
      : '';
  }
  const pager = el('tp-journal-pagination');
  if (pager) pager.innerHTML = rows.length ? tpPagerHtml(tpJournalsPage, totalPages, 'tpGoJournalPage') : '';
}

function onTpJournalRangeChange() {
  const fromSel = el('tp-journal-from');
  const toSel = el('tp-journal-to');
  if (fromSel && toSel) {
    const from = Number(fromSel.value) || 1;
    const to = Number(toSel.value) || 1;
    if (from > to) {
      // Keep the pair ordered by moving whichever edge was not just changed.
      if (document.activeElement === fromSel) toSel.value = String(from);
      else fromSel.value = String(to);
    }
  }
  tpJournalsPage = 1;
  renderProfileJournals();
}

function tpGoJournalPage(page) {
  tpJournalsPage = Math.max(1, page);
  renderProfileJournals();
  tpScrollToTabs();
}

function tpOpenJournalFromProfile(journalId, queue) {
  closeTraineeProfileModal();
  openJournalFromTracker(journalId, queue);
}

// ── DTR Logs section ────────────────────────────────────────────────────────

function tpFilteredDtrRows() {
  const records = (tpData && tpData.dtrRecords) || [];
  const from = el('tp-dtr-from') ? el('tp-dtr-from').value : '';
  const to = el('tp-dtr-to') ? el('tp-dtr-to').value : '';
  const status = el('tp-dtr-status') ? el('tp-dtr-status').value : '';
  const verification = el('tp-dtr-verification') ? el('tp-dtr-verification').value : '';

  return records
    .slice()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .filter(record => {
      const key = dayKey(new Date(record.date));
      if (from && key < from) return false;
      if (to && key > to) return false;
      if (status && (record.status || 'present') !== status) return false;
      const verified = record.verifiedBySupervisor === true;
      const incomplete = !record.timeIn || !record.timeOut;
      if (verification === 'verified' && !verified) return false;
      if (verification === 'pending' && verified) return false;
      if (verification === 'incomplete' && !incomplete) return false;
      return true;
    });
}

/** Elapsed wall-clock time of a record; null whenever either end is missing. */
function tpRecordedDuration(record) {
  if (!record.timeIn || !record.timeOut) return null;
  const start = new Date(record.timeIn).getTime();
  const end = new Date(record.timeOut).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 3600000;
}

function tpDtrRowHtml(record) {
  const statusKey = record.status || 'present';
  const statusChips = {
    present: '<span class="chip chip--success">Present</span>',
    late: '<span class="chip chip--warning">Late</span>',
    absent: '<span class="chip chip--danger">Absent</span>',
    excused: '<span class="chip chip--info">Excused</span>',
  };
  const verified = record.verifiedBySupervisor === true;

  const timeIn = record.timeIn
    ? `<span class="tp-strong">${escapeHtml(tpFormatClock(record.timeIn))}</span>`
    : '<span class="tp-muted">—</span>';
  const timeOut = record.timeOut
    ? `<span class="tp-strong">${escapeHtml(tpFormatClock(record.timeOut))}</span>`
    : (record.timeIn ? '<span class="tp-wait">No time-out</span>' : '<span class="tp-muted">—</span>');

  const duration = tpRecordedDuration(record);
  const durationCell = duration !== null
    ? `<span class="tp-strong">${duration.toFixed(1)} h</span>`
    : (record.timeIn ? '<span class="tp-wait">Incomplete</span>' : '<span class="tp-muted">—</span>');

  const credited = verified
    ? `<span class="tp-strong">${tpHours(record.hoursRendered)} h</span>`
    : '<span class="tp-muted" title="Hours count toward OJT only after supervisor verification">Not verified</span>';

  const trainee = (tpData && tpData.trainee) || {};
  const schedule = trainee.schedule || {};
  const scheduleCell = schedule.startTime && schedule.endTime
    ? `${escapeHtml(schedule.startTime)} – ${escapeHtml(schedule.endTime)}`
    : '<span class="tp-muted">—</span>';

  const weekday = new Date(record.date).toLocaleDateString('en-US', { weekday: 'short' });
  const expanded = tpOpenDtrId === String(record._id);

  let html = `
    <tr>
      <td class="cell">
        <div class="tp-stack">
          <span class="tp-strong">${escapeHtml(tpFormatDay(record.date))}</span>
          <span class="tp-stack__sub">${escapeHtml(weekday)}</span>
        </div>
      </td>
      <td class="cell">${scheduleCell}</td>
      <td class="cell">${timeIn}</td>
      <td class="cell">${timeOut}</td>
      <td class="cell">${durationCell}</td>
      <td class="cell">${credited}</td>
      <td class="cell">${statusChips[statusKey] || statusChips.present}</td>
      <td class="cell">${verified
        ? '<span class="chip chip--success">Verified</span>'
        : '<span class="chip chip--warning">Pending</span>'}</td>
      <td class="cell">
        <button type="button" class="link-btn" onclick="tpToggleDtrDetail('${jsStringArg(record._id)}')"
          aria-expanded="${expanded}">${expanded ? 'Hide' : 'Details'}</button>
      </td>
    </tr>`;

  if (expanded) {
    html += `
      <tr class="tp-detail-row">
        <td colspan="9">
          <div class="tp-detail-grid">
            <div><strong>Geofence validated</strong><span>${record.geofenceValidated === true ? 'Yes' : record.geofenceValidated === false ? 'No' : 'Not recorded'}</span></div>
            <div><strong>QR check-in</strong><span>${record.qrToken ? 'Used' : 'Not used'}</span></div>
            <div><strong>Attendance status</strong><span>${escapeHtml(statusKey)}</span></div>
            <div><strong>Supervisor verification</strong><span>${verified ? 'Verified' : 'Pending'}</span></div>
            <div><strong>Hours recorded</strong><span>${tpHours(record.hoursRendered)} h</span></div>
            ${record.remarks ? `<div><strong>Remarks</strong><span>${escapeHtml(record.remarks)}</span></div>` : ''}
            <div><strong>Last updated</strong><span>${escapeHtml(formatTimeIn(record.updatedAt) || '—')}</span></div>
          </div>
        </td>
      </tr>`;
  }

  return html;
}

function renderProfileDtr() {
  const body = el('tp-dtr-body');
  if (!body || !tpData) return;

  const rows = tpFilteredDtrRows();
  const totalPages = Math.max(1, Math.ceil(rows.length / TP_PAGE_SIZE));
  if (tpDtrPage > totalPages) tpDtrPage = totalPages;
  const pageRows = rows.slice((tpDtrPage - 1) * TP_PAGE_SIZE, tpDtrPage * TP_PAGE_SIZE);

  if (!rows.length) {
    body.innerHTML = tableStateHtml(
      'No DTR records match these filters',
      (tpData.dtrRecords || []).length
        ? 'This trainee has records, but none inside the selected dates and statuses.'
        : 'No time records have been captured for this trainee yet.',
      '', '', 9);
  } else {
    body.innerHTML = pageRows.map(tpDtrRowHtml).join('');
  }

  const countLabel = el('tp-dtr-count-label');
  if (countLabel) {
    const start = rows.length ? (tpDtrPage - 1) * TP_PAGE_SIZE + 1 : 0;
    countLabel.textContent = `Showing ${start}–${Math.min(tpDtrPage * TP_PAGE_SIZE, rows.length)} of ${rows.length} record${rows.length === 1 ? '' : 's'}`;
  }
  const pager = el('tp-dtr-pagination');
  if (pager) pager.innerHTML = rows.length ? tpPagerHtml(tpDtrPage, totalPages, 'tpGoDtrPage') : '';
}

function onTpDtrFilterChange() {
  tpDtrPage = 1;
  renderProfileDtr();
}

function resetTpDtrFilters() {
  [['tp-dtr-from', ''], ['tp-dtr-to', ''], ['tp-dtr-status', ''], ['tp-dtr-verification', '']].forEach(([id, value]) => {
    const node = el(id);
    if (node) node.value = value;
  });
  tpDtrPage = 1;
  renderProfileDtr();
}

function tpGoDtrPage(page) {
  tpDtrPage = Math.max(1, page);
  renderProfileDtr();
  tpScrollToTabs();
}

function tpToggleDtrDetail(recordId) {
  tpOpenDtrId = tpOpenDtrId === String(recordId) ? null : String(recordId);
  renderProfileDtr();
}

// ── Attendance History section ──────────────────────────────────────────────

function tpAttendanceRangeRows() {
  const records = (tpData && tpData.dtrRecords) || [];
  const from = el('tp-att-from') ? el('tp-att-from').value : '';
  const to = el('tp-att-to') ? el('tp-att-to').value : '';

  return records
    .filter(record => {
      const key = dayKey(new Date(record.date));
      if (from && key < from) return false;
      if (to && key > to) return false;
      return true;
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

function destroyProfileChart() {
  if (tpAttendanceChart) {
    try { tpAttendanceChart.destroy(); } catch (error) { /* canvas already gone */ }
    tpAttendanceChart = null;
  }
}

function renderProfileAttendanceChart(rows) {
  const canvas = el('tp-attendance-chart');
  const overlay = el('tp-att-chart-overlay');
  const hint = el('tp-att-chart-hint');
  if (!canvas || !overlay) return;

  const attended = rows.filter(r => r.timeIn);
  if (attended.length < 2) {
    destroyProfileChart();
    overlay.hidden = false;
    if (hint) hint.textContent = '';
    return;
  }
  overlay.hidden = true;

  // Short ranges bucket by week, longer histories by month.
  const times = attended.map(r => new Date(r.date).getTime());
  const spanDays = (Math.max(...times) - Math.min(...times)) / 86400000;
  const weekly = spanDays <= 70;

  const buckets = new Map();
  attended.forEach(record => {
    const date = new Date(record.date);
    let label;
    if (weekly) {
      const monday = addDays(startOfDay(date), date.getDay() === 0 ? -6 : 1 - date.getDay());
      label = monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else {
      label = date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    }
    if (!buckets.has(label)) buckets.set(label, new Set());
    buckets.get(label).add(dayKey(date));
  });

  const labels = Array.from(buckets.keys());
  const values = labels.map(label => buckets.get(label).size);
  const dataset = { label: 'Days attended', data: values };
  window.TrackITCharts.styleDataset(dataset, {
    accent: TrackITCharts.accent.teal,
    maxBarThickness: 26,
  });

  destroyProfileChart();
  tpAttendanceChart = window.TrackITCharts.createBar(canvas.getContext('2d'), {
    data: { labels, datasets: [dataset] },
    options: window.TrackITCharts.barOptions({
      vertical: true,
      legend: false,
      categoryCount: labels.length,
      datasetCount: 1,
      xTitle: weekly ? 'Week of' : 'Month',
      yTitle: 'Days with a time-in',
      valueFormatter: value => Math.round(value),
      showValues: true,
      valueMax: Math.max(...values),
    }),
  });

  if (hint) hint.textContent = `Distinct days with a time-in, per ${weekly ? 'week' : 'month'}`;
}

function renderProfileAttendance() {
  if (!tpData) return;
  const rows = tpAttendanceRangeRows();

  // `excused` is still tallied so any such record never pollutes the present
  // count, but it is not surfaced as a card — the app has no excused workflow.
  const counts = { present: 0, late: 0, absent: 0, excused: 0 };
  rows.forEach(r => {
    const key = r.status || 'present';
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
    else counts.present += 1;
  });
  const unverified = rows.filter(r => !r.verifiedBySupervisor).length;
  const verifiedHoursInRange = rows
    .filter(r => r.verifiedBySupervisor === true && r.timeIn && r.timeOut)
    .reduce((sum, r) => sum + (Number(r.hoursRendered) || 0), 0);

  const stat = (label, value, tone, note) => `
    <div class="tp-stat">
      <p class="tp-stat__label">${escapeHtml(label)}</p>
      <p class="tp-stat__value${tone ? ` tp-stat__value--${tone}` : ''}">${escapeHtml(String(value))}</p>
      ${note ? `<p class="tp-stat__note">${escapeHtml(note)}</p>` : ''}
    </div>`;

  const summary = el('tp-att-summary');
  if (summary) {
    summary.innerHTML = [
      stat('Present', counts.present, 'present', 'on-time records'),
      stat('Late', counts.late, 'late'),
      stat('Absent', counts.absent, 'absent', 'records marked absent'),
      stat('Verified Hours', tpHours(verifiedHoursInRange), '', 'credited in this range'),
      stat('Unverified', unverified, unverified ? 'pending' : 'neutral', 'awaiting verification'),
    ].join('');
  }

  renderProfileAttendanceChart(rows);

  // Significant issues: late / absent records, newest first.
  const issues = rows
    .filter(r => r.status === 'late' || r.status === 'absent')
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const issuesEl = el('tp-att-issues');
  if (issuesEl) {
    issuesEl.innerHTML = issues.length
      ? issues.slice(0, 8).map(record => {
          const label = record.status === 'late' ? 'Late' : 'Absent';
          const tone = record.status === 'late' ? 'warning' : 'danger';
          const sub = record.remarks
            || (record.timeIn ? `Time-in ${tpFormatClock(record.timeIn)}` : 'No time-in recorded');
          return `
            <div class="tp-list__item">
              <div class="tp-list__main">
                <p class="tp-list__title">${label} — ${escapeHtml(tpFormatDay(record.date))}</p>
                <p class="tp-list__sub">${escapeHtml(sub)}</p>
              </div>
              <span class="chip chip--${tone}">${label}</span>
            </div>`;
        }).join('')
      : tpStateBlock('No attendance issues', 'No late or absent records fall inside this date range.');
  }

  // Latest attendance activity.
  const latest = rows
    .filter(r => r.timeIn)
    .sort((a, b) => new Date(b.timeIn).getTime() - new Date(a.timeIn).getTime());
  const latestEl = el('tp-att-latest');
  if (latestEl) {
    if (!latest.length) {
      latestEl.innerHTML = tpStateBlock('No attendance activity', 'No time-in has been recorded for this trainee in this date range.');
    } else {
      const top = latest[0];
      latestEl.innerHTML = `
        <div class="tp-list__item">
          <div class="tp-list__main">
            <p class="tp-list__title">Time-in ${escapeHtml(tpFormatClock(top.timeIn))}</p>
            <p class="tp-list__sub">${escapeHtml(tpFormatDay(top.date))}${top.timeOut
              ? ` · Time-out ${escapeHtml(tpFormatClock(top.timeOut))}`
              : ' · No time-out recorded'}</p>
          </div>
          <span class="chip ${top.verifiedBySupervisor ? 'chip--success' : 'chip--warning'}">${top.verifiedBySupervisor ? 'Verified' : 'Pending'}</span>
        </div>`;
    }
  }
}

function resetTpAttendanceRange() {
  const from = el('tp-att-from');
  if (from) from.value = '';
  const to = el('tp-att-to');
  if (to) to.value = '';
  renderProfileAttendance();
}

// ── Activity Timeline section ───────────────────────────────────────────────

/** Timeline events derived only from real recorded timestamps. */
function tpBuildTimelineEvents() {
  const events = [];
  const data = tpData;
  if (!data) return events;
  const trainee = data.trainee || {};

  if (trainee.supervisorAssignedAt) {
    const supervisor = trainee.supervisorId || {};
    events.push({
      type: 'supervisor',
      title: 'First supervisor assigned',
      desc: supervisor.fullName
        ? `${supervisor.fullName}${supervisor.companyName ? ' — ' + supervisor.companyName : ''}`
        : 'Placement recorded',
      at: trainee.supervisorAssignedAt,
      chip: '',
    });
  }

  (data.journals || []).filter(j => j && j.status !== 'draft').forEach(journal => {
    const week = tpParseWeekLabel(journal.week);
    const label = week ? `Week ${week} journal` : 'Journal';
    const review = tpJournalReviewState(journal);
    if (journal.submittedAt || journal.createdAt) {
      events.push({
        type: 'journal',
        title: `${label} submitted`,
        desc: 'Handed in for supervisor review',
        at: journal.submittedAt || journal.createdAt,
        chip: '<span class="chip chip--success">Submitted</span>',
      });
    }
    if (journal.supervisorSigned && journal.supervisorSignedAt) {
      events.push({
        type: 'journal',
        title: `${label} signed by supervisor`,
        desc: 'Awaiting coordinator review',
        at: journal.supervisorSignedAt,
        chip: '<span class="chip chip--info">Pending Review</span>',
      });
    }
    if (journal.coordinatorApproved && journal.coordinatorApprovedAt) {
      events.push({
        type: 'journal',
        title: `${label} reviewed`,
        desc: 'Coordinator approved the journal',
        at: journal.coordinatorApprovedAt,
        chip: '<span class="chip chip--success">Reviewed</span>',
      });
    } else if (review && review.key === 'returned' && journal.updatedAt) {
      events.push({
        type: 'journal',
        title: `${label} returned`,
        desc: journal.coordinatorRemarks || 'Returned to the trainee for revision',
        at: journal.updatedAt,
        chip: '<span class="chip chip--danger">Returned</span>',
      });
    }
  });

  (data.dtrRecords || []).forEach(record => {
    const day = tpFormatDay(record.date);
    if (record.timeIn) {
      events.push({ type: 'attendance', title: 'Time-in recorded', desc: day, at: record.timeIn, chip: '' });
    }
    if (record.timeOut) {
      events.push({ type: 'attendance', title: 'Time-out recorded', desc: day, at: record.timeOut, chip: '' });
    }
  });

  return events;
}

function renderProfileTimeline() {
  const list = el('tp-timeline-list');
  if (!list || !tpData) return;

  const filter = el('tp-timeline-filter') ? el('tp-timeline-filter').value : 'all';
  const events = tpBuildTimelineEvents()
    .filter(event => filter === 'all' || event.type === filter)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const count = el('tp-timeline-count');
  if (count) count.textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;

  const shown = events.slice(0, tpTimelineLimit);
  if (!shown.length) {
    list.innerHTML = tpStateBlock('No activity yet',
      'Real events appear here as this trainee submits journals and records attendance.');
    return;
  }

  const items = shown.map(event => {
    const date = new Date(event.at);
    const time = `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    return `
      <li class="tp-timeline__item">
        <span class="tp-timeline__dot tp-timeline__dot--${event.type}" aria-hidden="true">${TP_TIMELINE_ICONS[event.type] || ''}</span>
        <div class="tp-timeline__body">
          <div class="tp-timeline__row">
            <span class="tp-timeline__title">${escapeHtml(event.title)}</span>
            ${event.chip}
            <span class="tp-timeline__time">${escapeHtml(time)}</span>
          </div>
          ${event.desc ? `<p class="tp-timeline__desc">${escapeHtml(event.desc)}</p>` : ''}
        </div>
      </li>`;
  });

  if (events.length > tpTimelineLimit) {
    items.push(`
      <li class="tp-timeline__item">
        <span class="tp-timeline__dot" aria-hidden="true"></span>
        <div class="tp-timeline__body">
          <button type="button" class="link-btn" onclick="tpShowMoreTimeline()">
            Show ${Math.min(15, events.length - tpTimelineLimit)} more events
          </button>
        </div>
      </li>`);
  }

  list.innerHTML = items.join('');
}

function onTpTimelineFilterChange() {
  tpTimelineLimit = 15;
  renderProfileTimeline();
}

function tpShowMoreTimeline() {
  tpTimelineLimit += 15;
  renderProfileTimeline();
}

// ── shared behaviours ───────────────────────────────────────────────────────

function tpScrollToTabs() {
  const scroll = el('tp-scroll');
  const tabs = document.querySelector('#trainee-profile-modal .tp-tabs');
  if (scroll && tabs) scroll.scrollTo({ top: Math.max(0, tabs.offsetTop - 8), behavior: 'smooth' });
}

function tpViewInTrainees() {
  const traineeId = window.currentTraineeProfileId;
  closeTraineeProfileModal();
  switchTab('trainees');
  if (traineeId) openSnapshotTrainee(traineeId);
}

// Arrow-key navigation for the profile tablist (WAI-ARIA tabs pattern).
document.addEventListener('keydown', (e) => {
  const focused = e.target && e.target.closest ? e.target.closest('#trainee-profile-modal .tp-tab') : null;
  if (!focused) return;
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const tabs = Array.from(document.querySelectorAll('#trainee-profile-modal .tp-tab'));
  const next = tabs[(tabs.indexOf(focused) + step + tabs.length) % tabs.length];
  next.focus();
  switchProfileTab(next.id.replace('tp-tab-', ''));
});

/** Close trainee profile modal */
function closeTraineeProfileModal() {
  const modal = el('trainee-profile-modal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }
  destroyProfileChart();
  currentTraineeProfileId = null;
  window.currentTraineeProfileId = null;
  tpData = null;
  tpError = '';
  tpLoading = false;
}

// Close trainee profile modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('trainee-profile-modal');
    if (modal && !modal.classList.contains('hidden')) {
      closeTraineeProfileModal();
    }
  }
});

// Close trainee profile modal on backdrop click
const traineeProfileModal = document.getElementById('trainee-profile-modal');
if (traineeProfileModal) {
  traineeProfileModal.addEventListener('click', (e) => {
    if (e.target === traineeProfileModal) closeTraineeProfileModal();
  });
}

// ────────────────────────────────────────────────────────────────────────────
// INITIALIZATION
// ────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initializeTheme();
  // Tells the refresh loop when the coordinator is mid-click, mid-scroll or
  // mid-typing so it can wait instead of repainting underneath them.
  startInteractionTracking();
  // Initialize global search
  initGlobalSearch();
  // Load user data and populate dashboard
  loadDashboardData();

  // Overview is the landing tab: record it so the Back toolbar stays hidden
  // here and has somewhere to return to after the first navigation.
  currentTab = 'overview';
  updateTabBackButton();

  // Load trainees and supervisors data
  loadTrainees();
  loadSupervisors();
  loadCoordinatorJournals();
  startCoordinatorRealtimeUpdates();

  // Notifications: fetch on load so the badge is correct before the bell is
  // ever clicked, then keep it fresh in the background.
  loadCoordinatorNotifications({ silent: true });
  startNotificationPolling();

  // Setup filter listeners for auto-filtering
  setupFilterListeners();
  updateTraineeSortIndicators();

  // Set user name
  const name = window.currentUser?.fullName?.split(' ')[0] || 'Coordinator';
  document.getElementById('user-name').textContent = name;

  // Add active state to nav links
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
      link.classList.add('active');
    });
  });

  // Mobile sidebar close on main content click
  const mainContent = document.querySelector('.main-content');
  if (mainContent) {
    mainContent.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        const sidebar = document.querySelector('.sidebar');
        sidebar.classList.remove('open');
      }
    });
  }

  // Close sidebar on window resize to desktop
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      const sidebar = document.querySelector('.sidebar');
      sidebar.classList.remove('open');
    }
  });

  // Report preview modal: close on backdrop click or Escape
  const reportModal = document.getElementById('report-modal');
  if (reportModal) {
    reportModal.addEventListener('click', (event) => {
      if (event.target === reportModal) closeReportModal();
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeReportModal();
  });
});

/* ── Mobile stacked tables ──────────────────────────────────────────────────
   On phones, wide tables render as stacked label/value cards: thead hidden,
   each row becomes a bordered card and each cell shows its column name via a
   data-label pseudo-element. Labels are stamped from the thead here and
   re-stamped whenever a render replaces the rows, so no render code changes. */
(function initStackedTables() {
  const TARGETS = ['#trainees-table-body', '#all-trainees-table-body', '#recent-dtr-body', '#trainee-progress-body', '#department-analytics-body'];

  function stamp(tbody) {
    const table = tbody.closest('table');
    if (!table) return;
    table.classList.add('tk-stack');
    const labels = Array.from(table.querySelectorAll('thead th'))
      .map((th) => {
        // Strip sort arrows / screen-only text so card labels stay clean
        const clone = th.cloneNode(true);
        clone.querySelectorAll('.sort-indicator, .sr-only').forEach((n) => n.remove());
        return (clone.textContent || '').trim().replace(/\s+/g, ' ');
      });
    Array.from(tbody.children).forEach((tr) => {
      Array.from(tr.children).forEach((td, i) => {
        if (td.hasAttribute('colspan')) { td.removeAttribute('data-label'); return; }
        const label = labels[i];
        if (label) td.setAttribute('data-label', label);
        else td.removeAttribute('data-label');
      });
    });
  }

  const stampAll = () => TARGETS.forEach((sel) => {
    const tb = document.querySelector(sel);
    if (tb) stamp(tb);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', stampAll);
  else stampAll();

  const obs = new MutationObserver((muts) => {
    const seen = new Set();
    for (const m of muts) {
      const node = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const tb = node && node.closest ? node.closest('tbody') : null;
      if (tb && !seen.has(tb)) { seen.add(tb); stamp(tb); }
    }
  });

  const attach = () => TARGETS.forEach((sel) => {
    const tb = document.querySelector(sel);
    if (tb) obs.observe(tb, { childList: true });
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})();
