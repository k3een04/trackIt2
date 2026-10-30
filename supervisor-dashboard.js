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

  const toastIcon = toastType === 'success' ? 'tick-circle' : toastType === 'error' ? 'close-circle' : 'info-circle';
  notificationEl.innerHTML = `
    <p style="margin: 0; font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-iconsax="${toastIcon}"></svg>
      <span>${title}</span>
    </p>
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
// NOTIFICATION BELL POPUP
// ────────────────────────────────────────────────────────────────────────────

/**
 * Escapes a value before it is interpolated into innerHTML. Notification
 * titles/messages come from the database, so they must never be able to inject
 * markup into the dashboard.
 */
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let supervisorNotifications = [];
let notifPopupOpen = false;
let notifLoading = false;
let notifError = '';
let notifUnreadCount = 0;
let notifPollTimer = null;

/**
 * The panel is a body-level fixed element (the header's backdrop-filter would
 * trap it otherwise), so it is anchored to the bell here rather than in CSS.
 * It is clamped to the viewport on both axes and flips above the bell when the
 * list would otherwise run off the bottom edge.
 */
function positionNotifPopup() {
  const popup = document.getElementById('notif-popup');
  const btn = document.getElementById('notif-btn');
  if (!popup || !btn || !notifPopupOpen) return;

  const gap = 8;
  const margin = 10;
  const rect = btn.getBoundingClientRect();
  const width = popup.offsetWidth;
  const height = popup.offsetHeight;
  const maxLeft = window.innerWidth - width - margin;
  const maxTop = window.innerHeight - height - margin;

  // Right-aligned to the bell, pulled back inside the viewport on narrow screens.
  const left = Math.max(margin, Math.min(rect.right - width, maxLeft));

  let top = rect.bottom + gap;
  if (top > maxTop && rect.top - gap - height >= margin) {
    top = rect.top - gap - height;
  }
  top = Math.max(margin, Math.min(top, maxTop));

  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(top)}px`;
}

function openNotifications() {
  const popup = document.getElementById('notif-popup');
  const btn = document.getElementById('notif-btn');
  if (!popup) return;

  notifPopupOpen = true;
  popup.classList.add('is-open');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  positionNotifPopup();
  // Always refetch on open so a notification created while the dashboard was
  // already loaded shows up without a full page refresh.
  loadSupervisorNotifications();
}

function closeNotifications() {
  const popup = document.getElementById('notif-popup');
  const btn = document.getElementById('notif-btn');
  if (popup) popup.classList.remove('is-open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  notifPopupOpen = false;
}

function toggleNotifications() {
  if (notifPopupOpen) closeNotifications();
  else openNotifications();
}

/** "Mark all read" - marks every notification read on the server. */
async function clearAllNotifications() {
  if (supervisorNotifications.length === 0) return;
  try {
    await fetchAPI('/notifications/read-all', { method: 'PATCH' });
  } catch (error) {
    console.error('Error marking all notifications read:', error);
  }
  supervisorNotifications = supervisorNotifications.map(n => ({ ...n, unread: false, read: true }));
  notifUnreadCount = 0;
  renderNotificationList();
  updateNotifBadge();
}

/** Dismisses one notification: persisted as read, then hidden locally. */
async function dismissNotification(id) {
  const target = supervisorNotifications.find(n => n.id === id);
  if (target && target.unread) {
    try {
      await fetchAPI(`/notifications/${id}/read`, { method: 'PATCH' });
    } catch (error) {
      console.error('Error marking notification read:', error);
    }
    notifUnreadCount = Math.max(0, notifUnreadCount - 1);
  }
  supervisorNotifications = supervisorNotifications.filter(n => n.id !== id);
  renderNotificationList();
  updateNotifBadge();
}

/** "Clear all" - permanently deletes every notification for this user. */
function deleteAllNotifications() {
  if (supervisorNotifications.length === 0) return;

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
      supervisorNotifications = [];
      notifUnreadCount = 0;
      renderNotificationList();
      updateNotifBadge();
    },
  });
}

function updateNotifBadge() {
  const badge = document.getElementById('notif-badge');
  const btn = document.getElementById('notif-btn');
  const count = document.getElementById('notif-count');

  // The accessible name carries the real number; the chip is capped at 9+.
  if (btn) {
    btn.setAttribute(
      'aria-label',
      notifUnreadCount > 0 ? `Notifications, ${notifUnreadCount} unread` : 'Notifications'
    );
  }

  if (badge) {
    if (notifUnreadCount > 0) {
      badge.style.display = 'flex';
      badge.textContent = notifUnreadCount > 9 ? '9+' : String(notifUnreadCount);
    } else {
      badge.style.display = 'none';
    }
  }

  // The panel header has room to spell the count out, so the true number is
  // never hidden behind the bell's 9+ cap.
  if (count) {
    count.hidden = notifUnreadCount === 0;
    count.textContent = notifUnreadCount === 0 ? '' : `${notifUnreadCount} unread`;
  }
}

/**
 * Loads the notifications that belong to the logged-in supervisor.
 * The backend scopes every query to the JWT user id.
 */
async function loadSupervisorNotifications(options = {}) {
  const { silent = false } = options;
  if (notifLoading) return;
  notifLoading = true;
  if (!silent) {
    notifError = '';
    renderNotificationList();
  }

  try {
    const result = await fetchAPI('/notifications?limit=20');
    if (result && result.success) {
      supervisorNotifications = result.data || [];
      notifUnreadCount = Number(result.unreadCount) || 0;
      notifError = '';
    } else {
      notifError = (result && result.message) || 'Could not load notifications';
      supervisorNotifications = [];
      notifUnreadCount = 0;
    }
  } catch (error) {
    console.error('Error loading notifications:', error);
    notifError = 'Could not load notifications';
    supervisorNotifications = [];
    notifUnreadCount = 0;
  } finally {
    notifLoading = false;
    renderNotificationList();
    updateNotifBadge();
  }
}

const NOTIF_TYPES = ['journal', 'attendance', 'dtr', 'system', 'inactivity', 'activity'];

/** Unknown or missing types fall back to the neutral system icon and tint. */
function notifType(type) {
  const value = String(type || '').toLowerCase();
  return NOTIF_TYPES.includes(value) ? value : 'system';
}

/**
 * The model has no avatar field, so a row shows the actor's initials. When
 * there is no actor (system/inactivity events) the type icon is used instead.
 */
function notificationInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Persists a read on the server, then repaints the row and the badge. */
function markNotificationRead(id) {
  const notif = supervisorNotifications.find(n => n.id === id);
  if (!notif || !notif.unread) return;
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

function notificationRow(n) {
  const type = notifType(n.type);
  const title = escapeHtml(n.title || 'Notification');
  const message = escapeHtml(n.message || n.text || '');
  const initials = notificationInitials(n.actorName);
  const label = `${n.unread ? 'Unread: ' : ''}${n.title || 'Notification'}`;

  return `
    <div class="notif-item ${n.unread ? 'unread' : ''}" data-id="${escapeHtml(String(n.id || ''))}" role="button" tabindex="0" aria-label="${escapeHtml(label)}">
      <div class="notif-avatar ${type}" aria-hidden="true">${initials ? escapeHtml(initials) : getNotifIcon(type)}</div>
      <div class="notif-content">
        <div class="notif-head">
          <p class="notif-text notif-text--title">${title}</p>
          <span class="notif-time">${timeAgo(n.createdAt || n.time)}</span>
        </div>
        ${message ? `<p class="notif-text notif-message">${message}</p>` : ''}
      </div>
      ${n.unread ? '<span class="notif-dot" aria-hidden="true"></span>' : ''}
      <button type="button" class="notif-close" aria-label="Dismiss notification">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-iconsax="close-circle"></svg>
      </button>
    </div>`;
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
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-iconsax="info-circle"></svg>
        <p>${escapeHtml(notifError)}</p>
        <button type="button" class="notif-action" onclick="loadSupervisorNotifications()">Try again</button>
      </div>`;
    return;
  }
  
  if (supervisorNotifications.length === 0) {
    list.innerHTML = `
      <div class="notif-empty">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-iconsax="notification"></svg>
        <p>No notifications yet</p>
      </div>`;
    return;
  }
  
  list.innerHTML = supervisorNotifications.map(notificationRow).join('');
  
  // Click or Enter/Space marks the notification read on the server. The
  // dismiss control stops propagation, so it never also marks the row read.
  list.querySelectorAll('.notif-item').forEach(item => {
    item.addEventListener('click', () => markNotificationRead(item.dataset.id));
    item.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      markNotificationRead(item.dataset.id);
    });
    const closeBtn = item.querySelector('.notif-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', event => {
        event.stopPropagation();
        dismissNotification(item.dataset.id);
      });
    }
  });

  // The list just changed height (loading stub -> rows), so the clamped
  // position has to be recomputed.
  positionNotifPopup();
}

/** Polls the bell every minute and refetches when the tab regains focus. */
function startNotificationPolling() {
  if (notifPollTimer) clearInterval(notifPollTimer);
  notifPollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      loadSupervisorNotifications({ silent: true });
    }
  }, 60000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadSupervisorNotifications({ silent: true });
    }
  });
}

function getNotifIcon(type) {
  const icons = {
    journal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-iconsax="note-text"></svg>',
    attendance: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-iconsax="calendar-tick"></svg>',
    dtr: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-iconsax="calendar-tick"></svg>',
    system: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-iconsax="info-circle"></svg>'
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

// Clicking outside closes the panel; Escape closes it and returns focus to the
// bell, matching the other dialogs in the dashboard.
document.addEventListener('click', function(e) {
  const notifBtn = document.getElementById('notif-btn');
  const notifPopup = document.getElementById('notif-popup');
  if (notifBtn && notifPopup && notifPopupOpen) {
    if (!notifBtn.contains(e.target) && !notifPopup.contains(e.target)) {
      closeNotifications();
    }
  }
});

document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape' || !notifPopupOpen) return;
  closeNotifications();
  const notifBtn = document.getElementById('notif-btn');
  if (notifBtn) notifBtn.focus();
});

// The panel is fixed-positioned, so it follows the bell on resize and scroll.
// Registered once here - opening and closing never adds another listener.
window.addEventListener('resize', positionNotifPopup);
window.addEventListener('scroll', positionNotifPopup, true);

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

    const data = await response.json();
    
    // Log response for debugging
    console.log(`API Response [${response.status}] ${endpoint}:`, data);
    
    return data;
  } catch (error) {
    console.error('API Error:', error);
    return null;
  }
}

async function loadSupervisorProfile() {
  const profileResult = await fetchAPI('/dashboard/profile');
  if (!profileResult || !profileResult.success) return;

  const profile = profileResult.data || {};
  window.currentUser = profile;
  localStorage.setItem('trackit_user', JSON.stringify(profile));

  const nameInput = document.getElementById('sup-name');
  const emailInput = document.getElementById('sup-email');
  const companyInput = document.getElementById('sup-company');
  const positionInput = document.getElementById('sup-position');

  if (nameInput) nameInput.value = profile.fullName || '';
  if (emailInput) emailInput.value = profile.email || '';
  if (companyInput) companyInput.value = profile.companyName || '';
  if (positionInput) positionInput.value = profile.companyPosition || '';

  updateSignaturePreview();
  setSignaturePreview(profile.signatureDataUrl || null);
}

async function loadSupervisorData() {
  await loadSupervisorProfile();

  // Fetch real stats from MongoDB
  const statsResult = await fetchAPI('/stats/supervisor');
  if (statsResult && statsResult.success) {
    const { stats } = statsResult.data;
    // Update overview stat cards
    const statNums = document.querySelectorAll('#overview .stat-num');
    if (statNums.length >= 4) {
      statNums[0].textContent = stats.assignedTrainees;
      statNums[1].textContent = stats.pendingDTRs;
      statNums[2].textContent = stats.pendingJournals;
      statNums[3].textContent = stats.pendingAppraisals;
    }
  }

  // Load assigned trainees from API
  loadAssignedTrainees();
  
  // Load pending actions for overview tab
  loadPendingActions();
}

async function loadAssignedTrainees() {
  const result = await fetchAPI('/supervisor/trainees');

  // Update the My Trainees cards container
  const cardsContainer = document.getElementById('trainees-cards-container');
  // Update the Overview → Assigned Trainees list
  const overviewTrainees = document.querySelector('#overview .space-y-4.max-h-96');

  if (!result || !result.success) {
    // API failed — keep the static mock data as fallback
    return;
  }

  const trainees = result.data;

  if (trainees.length === 0) {
    if (cardsContainer) {
      cardsContainer.innerHTML = `
        <div class="glass-card p-8 col-span-full text-center">
          <p class="text-slate-400 mb-2">No trainees assigned yet</p>
          <p class="text-xs text-slate-500">Ask your coordinator to assign trainees to you</p>
        </div>
      `;
    }
    if (overviewTrainees) {
      overviewTrainees.innerHTML = `
        <div class="text-center py-6">
          <p class="text-slate-400 text-sm">No trainees assigned yet</p>
        </div>
      `;
    }
    return;
  }

  // Helper: get initials from full name
  function getInitials(name) {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
  }

  // Render trainee cards in My Trainees tab
  if (cardsContainer) {
    cardsContainer.innerHTML = trainees.map(trainee => `
      <div class="glass-card p-6 trainee-card">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-12 h-12 rounded-full bg-gradient-to-br from-blue-600 to-blue-600 flex items-center justify-center text-white font-bold text-lg overflow-hidden">${trainee.profilePictureDataUrl ? `<img class="avatar-img" src="${escapeHtml(trainee.profilePictureDataUrl)}" alt="">` : getInitials(trainee.fullName)}</div>
          <div class="flex-1">
            <h4 class="font-semibold text-white">${trainee.fullName}</h4>
            <p class="text-xs text-slate-500">${trainee.studentId || '—'}</p>
          </div>
        </div>
        <div class="mb-4">
          <p class="text-xs text-slate-400 mb-1"><strong>Department:</strong> ${trainee.department || '—'}</p>
          <p class="text-xs text-slate-400 mb-1"><strong>Company:</strong> ${trainee.companyName || '—'}</p>
          <p class="text-xs text-slate-400 mb-3"><strong>Status:</strong> <span class="status-badge ${trainee.isActive ? 'status-active' : 'status-inactive'}">${trainee.isActive ? 'Active' : 'Inactive'}</span></p>
        </div>
        <div class="flex gap-2">
          <button onclick="viewTraineeFullProfile('${trainee._id}')" class="btn-primary text-xs flex-1">View Profile</button>
          <button onclick="messageTrainee('${trainee._id}')" class="btn-ghost text-xs flex-1">Message</button>
        </div>
      </div>
    `).join('');
  }

  // Render trainee summary in Overview tab
  if (overviewTrainees) {
    overviewTrainees.innerHTML = trainees.map(trainee => `
      <div class="trainee-summary-item">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-full bg-gradient-to-br from-blue-600 to-blue-600 flex items-center justify-center text-white text-xs font-bold overflow-hidden">${trainee.profilePictureDataUrl ? `<img class="avatar-img" src="${escapeHtml(trainee.profilePictureDataUrl)}" alt="">` : getInitials(trainee.fullName)}</div>
          <div class="flex-1">
            <p class="text-sm font-semibold text-white">${trainee.fullName}</p>
            <p class="text-xs text-slate-500">${trainee.department || '—'} • ${trainee.studentId || '—'}</p>
          </div>
        </div>
      </div>
    `).join('');
  }

  // Also populate the DTR and Appraisal trainee select dropdowns
  const dtrSelect = document.getElementById('dtr-trainee-select');
  const appraisalSelect = document.getElementById('appraisal-trainee-select');

  if (dtrSelect) {
    const placeholder = '<option value="">Select a trainee...</option>';
    dtrSelect.innerHTML = placeholder + trainees.map(t =>
      `<option value="${t._id}">${t.fullName} (${t.studentId || 'N/A'})</option>`
    ).join('');
  }

  if (appraisalSelect) {
    const placeholder = '<option value="">Select a trainee...</option>';
    appraisalSelect.innerHTML = placeholder + trainees.map(t =>
      `<option value="${t._id}">${t.fullName} (${t.studentId || 'N/A'})</option>`
    ).join('');
  }
}

async function loadPendingActions() {
  try {
    const result = await fetchAPI('/stats/pending-actions');

    if (!result || !result.success) {
      console.error('Failed to load pending actions:', result);
      return;
    }

    const actions = result.data || [];
    const actionsContainer = document.querySelector('#overview .space-y-3.max-h-96');

    if (!actionsContainer) return;

    if (actions.length === 0) {
      actionsContainer.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">No pending actions</p>';
      return;
    }

    // Build HTML for pending actions
    let actionsHTML = '';
    actions.forEach(action => {
      const dotColor = action.type === 'dtr' ? 'bg-red-400' : 'bg-yellow-400';
      const buttonLabel = action.type === 'dtr' ? 'Verify' : 'Review';
      const tabName = action.type === 'dtr' ? 'dtr-verification' : 'journal-sign';
      const timeDisplay = action.type === 'dtr' ? action.date : `${action.week}`;

      actionsHTML += `
        <div class="action-item">
          <div class="flex items-start gap-3">
            <div class="flex-shrink-0 w-2.5 h-2.5 rounded-full ${dotColor} mt-1.5"></div>
            <div class="flex-1">
              <p class="text-sm font-semibold text-white">${action.type === 'dtr' ? 'DTR to Verify' : 'Journal to Review'}</p>
              <p class="text-xs text-slate-400">${action.trainee} • ${timeDisplay}</p>
              <p class="text-xs text-slate-500 mt-1">${action.date}</p>
            </div>
            <button onclick="switchTab('${tabName}')" class="text-blue-400 hover:text-blue-300 text-xs font-semibold whitespace-nowrap">${buttonLabel}</button>
          </div>
        </div>
      `;
    });

    actionsContainer.innerHTML = actionsHTML;
  } catch (error) {
    console.error('Error loading pending actions:', error);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// TAB SWITCHING
// ────────────────────────────────────────────────────────────────────────────

let tabHistory = [];
let currentTab = null;

function switchTab(tabName, options = {}) {
  const { fromHistory = false, direction = 'forward' } = options;
  // Save current tab to local storage
  localStorage.setItem('trackit_current_tab', tabName);

  if (!fromHistory && currentTab && currentTab !== tabName) {
    tabHistory.push(currentTab);
  }
  currentTab = tabName;
  updateTabBackButton();

  const tabs = document.querySelectorAll('.tab-content');
  tabs.forEach(tab => tab.classList.remove('active'));

  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => link.classList.remove('active'));

  const selectedTab = document.getElementById(tabName);
  if (selectedTab) {
    selectedTab.classList.add('active');
    selectedTab.classList.add(direction === 'back' ? 'is-entering-back' : 'is-entering');
    selectedTab.addEventListener('animationend', () => {
      selectedTab.classList.remove('is-entering', 'is-entering-back');
    }, { once: true });
    window.scrollTo(0, 0);
  }

  const activeLink = document.querySelector(`.nav-link[onclick*="'${tabName}'"]`);
  if (activeLink) activeLink.classList.add('active');

  // Load journals if switching to journal tab
  if (tabName === 'journal-sign') {
    loadPendingJournals().catch(err => console.error('Error loading journals:', err));
    refreshPendingJournalBadge().catch(err => console.error('Error refreshing pending badge:', err));
  } else if (tabName === 'notifications') {
    loadNotifications();
  } else if (tabName === 'schedule-manager') {
    loadScheduleTraineeList().catch(err => console.error('Error loading schedule trainees:', err));
  } else if (tabName === 'performance') {
    // Performance Appraisal: load criteria + context for the selected trainee
    initAppraisalTab();
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
}

function goBackTab() {
  if (tabHistory.length === 0) return;
  const previousTab = tabHistory.pop();
  switchTab(previousTab, { fromHistory: true, direction: 'back' });
}

// ────────────────────────────────────────────────────────────────────────────
// MY TRAINEES SECTION
// ────────────────────────────────────────────────────────────────────────────

async function viewTraineeFullProfile(traineeId) {
  const modal = document.getElementById('trainee-detail-modal');
  const content = document.getElementById('trainee-detail-content');
  
  // Show loading state
  content.innerHTML = '<div class="text-center py-8"><p class="text-slate-400">Loading trainee profile...</p></div>';
  modal.classList.remove('hidden');
  window.scrollTo(0, 0);

  try {
    // Fetch trainee basic info
    const traineeResult = await fetchAPI('/supervisor/trainees');
    if (!traineeResult || !traineeResult.success) {
      content.innerHTML = '<div class="text-red-400">Error loading trainee data</div>';
      return;
    }

    const trainee = traineeResult.data.find(t => t._id === traineeId);
    if (!trainee) {
      content.innerHTML = '<div class="text-red-400">Trainee not found</div>';
      return;
    }

    // Get current month and year
    const now = new Date();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const year = now.getFullYear();

    // Fetch DTR records for current month
    const dtrResult = await fetchAPI(`/supervisor/dtr/${traineeId}?month=${month}&year=${year}`);
    const dtrRecords = dtrResult?.success ? dtrResult.data.records : [];
    const dtrSummary = dtrResult?.success ? dtrResult.data.summary : {};

    // Calculate attendance statistics
    const totalDaysPresent = dtrSummary.totalDaysPresent || 0;
    const totalHours = dtrSummary.totalHours || 0;
    const totalDaysInMonth = new Date(year, now.getMonth() + 1, 0).getDate();
    const daysAbsent = totalDaysInMonth - totalDaysPresent;
    const attendanceRate = totalDaysInMonth > 0 ? ((totalDaysPresent / totalDaysInMonth) * 100).toFixed(1) : 0;

    // Calculate progress
    const completedHours = trainee.completedHours || 0;
    const requiredHours = trainee.requiredHours || 486;
    const remainingHours = Math.max(0, requiredHours - completedHours);
    const progressPercentage = requiredHours > 0 ? ((completedHours / requiredHours) * 100).toFixed(1) : 0;

    // Format DTR rows
    const dtrRows = dtrRecords.map(record => {
      const timeInDate = new Date(record.timeIn);
      const timeOutDate = new Date(record.timeOut);
      const dateStr = new Date(record.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const timeInStr = timeInDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const timeOutStr = timeOutDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const isVerified = record.verifiedBySupervisor === true;
      const verificationStatus = isVerified ? 'Verified' : 'Pending';
      const statusBadge = isVerified ? 'status-completed' : 'status-pending';
      const hoursDisplay = record.hoursRendered ? parseFloat(record.hoursRendered).toFixed(1) : '0.0';

      return `
        <tr class="border-b border-white/10">
          <td class="py-2 px-3">${dateStr}</td>
          <td class="py-2 px-3">${timeInStr}</td>
          <td class="py-2 px-3">${timeOutStr}</td>
          <td class="py-2 px-3">${hoursDisplay}</td>
          <td class="py-2 px-3"><span class="status-badge ${statusBadge}">${verificationStatus}</span></td>
        </tr>
      `;
    }).join('');

    content.innerHTML = `
      <div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <!-- Personal Info -->
          <div class="glass-card p-6">
            <h4 class="font-semibold mb-4">Personal Information</h4>
            <div class="space-y-2 text-sm">
              <div><span class="text-slate-400">Full Name:</span> <span class="text-white">${trainee.fullName || '—'}</span></div>
              <div><span class="text-slate-400">Student ID:</span> <span class="text-white">${trainee.studentId || '—'}</span></div>
              <div><span class="text-slate-400">Department:</span> <span class="text-white">${trainee.department || '—'}</span></div>
              <div><span class="text-slate-400">Company:</span> <span class="text-white">${trainee.companyName || '—'}</span></div>
              <div><span class="text-slate-400">Status:</span> <span class="status-badge ${trainee.isActive ? 'status-active' : 'status-inactive'}">${trainee.isActive ? 'Active' : 'Inactive'}</span></div>
            </div>
          </div>

          <!-- Attendance Summary -->
          <div class="glass-card p-6">
            <h4 class="font-semibold mb-4">Attendance Summary (${month}/${year})</h4>
            <div class="space-y-3 text-sm">
              <div class="flex justify-between">
                <span class="text-slate-400">Days Present:</span>
                <span class="font-semibold text-blue-400">${totalDaysPresent}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-slate-400">Total Hours:</span>
                <span class="font-semibold text-blue-400">${totalHours}</span>
              </div>
              <div class="flex justify-between pt-3 border-t border-white/10">
                <span class="text-slate-400">Attendance Rate:</span>
                <span class="font-semibold text-blue-400">${attendanceRate}%</span>
              </div>
            </div>
          </div>

          <!-- Progress Overview -->
          <div class="glass-card p-6">
            <h4 class="font-semibold mb-4">OJT Progress</h4>
            <div class="space-y-4">
              <div>
                <div class="flex justify-between mb-2">
                  <span class="text-xs text-slate-400">OJT Hours (Verified)</span>
                  <span class="text-xs font-semibold">${completedHours.toFixed(1)}/${requiredHours} (${progressPercentage}%)</span>
                </div>
                <div class="w-full bg-white/10 rounded-full h-2">
                  <div class="bg-blue-400 h-2 rounded-full" style="width: ${progressPercentage}%;"></div>
                </div>
              </div>
              <div>
                <p class="text-xs text-slate-400">Remaining: <span class="text-blue-400 font-semibold">${remainingHours.toFixed(1)} hours</span></p>
              </div>
            </div>
          </div>
        </div>

        <!-- DTR Records -->
        <div class="glass-card p-6 mb-6">
          <h4 class="font-semibold mb-4">DTR Records (${month}/${year})</h4>
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="border-b border-white/10">
                  <th class="text-left py-2 px-3">Date</th>
                  <th class="text-left py-2 px-3">Time In</th>
                  <th class="text-left py-2 px-3">Time Out</th>
                  <th class="text-left py-2 px-3">Hours</th>
                  <th class="text-left py-2 px-3">Status</th>
                </tr>
              </thead>
              <tbody>
                ${dtrRows || '<tr><td class="py-2 px-3 text-center" colspan="5">No DTR records for this month</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Notes and Rating -->
        <div class="glass-card p-6">
          <h4 class="font-semibold mb-4">Supervisor Feedback</h4>
          
          <!-- Performance Appraisal shortcut (the official 100-point form) -->
          <div class="mb-6 pb-6 border-b border-white/10">
            <p class="text-sm text-slate-400 mb-3">Performance Appraisal</p>
            <button onclick="openPerformanceAppraisal('${traineeId}')" class="btn-primary w-full">Evaluate in Performance Appraisal</button>
            <p class="text-xs text-slate-500 mt-2">Monthly appraisals use the official 100-point form with Save Draft and Submit &amp; Sign.</p>
          </div>

          <!-- Notes -->
          <div>
            <p class="text-sm text-slate-400 mb-3">Additional Notes</p>
            <textarea id="trainee-notes" placeholder="Add private notes about this trainee..." class="w-full glass-card px-4 py-3 text-white text-sm rounded-lg border border-white/10 focus:border-blue-400 outline-none" rows="4"></textarea>
            <button onclick="saveTraineeNotes('${traineeId}')" class="btn-primary w-full mt-4">Save Notes</button>
          </div>
        </div>
      </div>
    `;
  } catch (error) {
    console.error('Error loading trainee profile:', error);
    content.innerHTML = '<div class="text-red-400">Error loading trainee profile. Please try again.</div>';
  }
}

function closeTraineeDetail() {
  document.getElementById('trainee-detail-modal').classList.add('hidden');
}

function saveTraineeNotes(traineeId) {
  const notes = document.getElementById('trainee-notes')?.value || '';
  console.log(`Saving notes for trainee ${traineeId}:`, notes);
  showNotification('Success', 'Trainee notes saved successfully', 'success');
}

/**
 * "Message" buttons in the My Trainees tab (and the trainee detail modal).
 * Hands the trainee's user id to the shared sidebar messenger, which opens the
 * panel and loads the conversation with that person.
 */
function messageTrainee(traineeId) {
  const messenger = window.TrackITMessenger;

  if (!messenger || typeof messenger.openWith !== 'function') {
    showNotification(
      'Messages unavailable',
      'The messaging panel has not loaded yet. Refresh the page and try again.',
      'error'
    );
    return;
  }

  // Static fallback cards use placeholder ids; openWith() opens the contact
  // list in that case instead of failing silently.
  Promise.resolve(messenger.openWith(traineeId)).catch((error) => {
    console.error('[Supervisor] Could not open message thread:', error);
    showNotification('Messages', 'Could not open the conversation. Please try again.', 'error');
  });
}

// ────────────────────────────────────────────────────────────────────────────
// DTR VERIFICATION SECTION
// ────────────────────────────────────────────────────────────────────────────

async function loadDTRData() {
  try {
    const traineeSelect = document.getElementById('dtr-trainee-select');
    const monthPicker = document.getElementById('dtr-month-picker');
    
    console.log('DTR Load - Trainee Select Value:', traineeSelect?.value);
    console.log('DTR Load - Month Picker Value:', monthPicker?.value);
    
    if (!traineeSelect?.value) {
      showNotification('Error', 'Please select a trainee from the dropdown', 'error');
      return;
    }

    if (!monthPicker?.value) {
      showNotification('Error', 'Please select a month', 'error');
      return;
    }

    const traineeId = traineeSelect.value;
    const [year, month] = monthPicker.value.split('-');

    console.log('Fetching DTR for trainee:', traineeId, 'month:', month, 'year:', year);

    // Fetch DTR data from MongoDB via API
    const result = await fetchAPI(`/supervisor/dtr/${traineeId}?month=${month}&year=${year}`);
    
    console.log('DTR API Response:', result);
    
    if (!result) {
      console.error('No response from API - backend may not be running');
      showNotification('Error', 'Failed to load DTR data.\n\nThe backend server may not be running. Please:\n1. Make sure the backend is running (npm start in /backend)\n2. Refresh the page\n3. Try again', 'error');
      return;
    }

    if (!result.success) {
      console.error('DTR API Error:', result);
      showNotification('Error', 'Failed to load DTR data.\n\nError: ' + (result?.message || 'Unknown error') + '\n\nIf you see "route not found", restart the backend server.', 'error');
      return;
    }

    const { records, summary } = result.data;

    // Sort records by date descending (latest first)
    records.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Limit to 5 records as requested
    const displayRecords = records.slice(0, 5);

    console.log('DTR Records:', records);
    console.log('DTR Summary:', summary);

    // Store current selection for verify operations
    window.currentDTRRecords = displayRecords;
    window.currentTraineeId = traineeId;

    // Populate DTR table with actual data
    const tableBody = document.getElementById('dtr-table-body');
    tableBody.innerHTML = '';

    if (displayRecords.length === 0) {
      tableBody.innerHTML = `
        <tr class="border-b border-white/10">
          <td colspan="8" class="text-center py-8 text-slate-400">
            No DTR records found for this period
          </td>
        </tr>
      `;
    } else {
      displayRecords.forEach((record) => {
        // Format dates
        const dateObj = new Date(record.date);
        const dateStr = dateObj.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
        const dayStr = dateObj.toLocaleDateString('en-US', { weekday: 'long' });

        // Format times
        const timeInStr = record.timeIn
          ? new Date(record.timeIn).toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })
          : '—';

        const timeOutStr = record.timeOut
          ? new Date(record.timeOut).toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })
          : '—';

        // Calculate hours
        const hours = record.hoursRendered ? parseFloat(record.hoursRendered).toFixed(1) : '0';

        // Status badge styling
        let statusBadgeClass = 'status-pending';
        let statusText = 'Pending';

        if (record.verifiedBySupervisor) {
          statusBadgeClass = 'status-completed';
          statusText = 'Verified';
        } else if (record.status === 'absent') {
          statusBadgeClass = 'status-inactive';
          statusText = 'Absent';
        } else if (record.status === 'late') {
          statusBadgeClass = 'status-warning';
          statusText = 'Late';
        } else if (record.status === 'excused') {
          statusBadgeClass = 'status-info';
          statusText = 'Excused';
        }

        // Location info
        const location = record.companyName || 'Office';

        // Disable checkbox if already verified
        const isVerified = record.verifiedBySupervisor;
        const checkboxDisabled = isVerified ? 'disabled' : '';
        const rowClass = isVerified ? 'opacity-60' : '';

        const row = `
          <tr class="border-b border-white/10 hover:bg-white/5 transition ${rowClass}" data-dtr-id="${record._id}">
            <td class="py-3 px-4"><input type="checkbox" class="w-4 h-4 dtr-checkbox" ${checkboxDisabled} data-dtr-id="${record._id}"></td>
            <td class="py-3 px-4">${dateStr}</td>
            <td class="py-3 px-4">${dayStr}</td>
            <td class="py-3 px-4">${timeInStr}</td>
            <td class="py-3 px-4">${timeOutStr}</td>
            <td class="py-3 px-4">${hours}</td>
            <td class="py-3 px-4">${location}</td>
            <td class="py-3 px-4"><span class="status-badge ${statusBadgeClass}">${statusText}</span></td>
          </tr>
        `;

        tableBody.innerHTML += row;
      });
    }

    // Update summary section
    document.getElementById('summary-total-days').textContent = summary.totalDaysPresent;
    document.getElementById('summary-total-hours').textContent = summary.totalHours;
  } catch (error) {
    console.error('Error loading DTR data:', error);
    showNotification('Error', 'An error occurred while loading DTR data', 'error');
  }
}


// Helpers shared by the DTR verification modal (single source of the data it
// summarises: `window.currentDTRRecords`, populated by loadDTRData()).
function dtrRecordById(dtrId) {
  const records = window.currentDTRRecords || [];
  return records.find((record) => record._id === dtrId) || null;
}

function dtrDateLabel(dateValue) {
  return new Date(dateValue).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function dtrTimeLabel(timeValue) {
  return timeValue
    ? new Date(timeValue).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
    : '—';
}

function dtrAttendancePill(record) {
  if (record.verifiedBySupervisor) return { text: 'Verified', tone: 'ok' };
  if (record.status === 'absent') return { text: 'Absent', tone: 'neutral' };
  if (record.status === 'late') return { text: 'Late', tone: 'warn' };
  if (record.status === 'excused') return { text: 'Excused', tone: 'neutral' };
  return { text: 'Present', tone: 'neutral' };
}

function dtrModalRows(ids, limit) {
  const rows = [];
  ids.forEach((dtrId) => {
    const record = dtrRecordById(dtrId);
    if (!record) return;
    const pill = dtrAttendancePill(record);
    rows.push({
      title: dtrDateLabel(record.date),
      meta: `${dtrTimeLabel(record.timeIn)} – ${dtrTimeLabel(record.timeOut)}`,
      status: pill.text,
      tone: pill.tone,
    });
  });
  const cap = limit || 6;
  if (rows.length > cap) {
    const extra = rows.length - cap;
    return { rows: rows.slice(0, cap), more: extra };
  }
  return { rows, more: 0 };
}

function dtrDateRange(records) {
  const dates = records
    .map((record) => (record && record.date ? new Date(record.date).getTime() : NaN))
    .filter((value) => !Number.isNaN(value));
  if (!dates.length) return '—';
  const from = new Date(Math.min.apply(null, dates));
  const to = new Date(Math.max.apply(null, dates));
  const short = { month: 'short', day: 'numeric', year: 'numeric' };
  const sameDay = from.toDateString() === to.toDateString();
  return sameDay
    ? from.toLocaleDateString('en-US', short)
    : `${from.toLocaleDateString('en-US', short)} – ${to.toLocaleDateString('en-US', short)}`;
}

/**
 * Builds the async runner handed to the verification modal.
 * Only the entries still pending are attempted, so "Try Again" after a partial
 * failure retries just the ones that failed instead of re-signing everything.
 */
function createDtrVerificationRunner(ids, signature, remarks) {
  let remaining = ids.slice();
  let verifiedCount = 0;

  return async () => {
    const batch = remaining.slice();
    const failed = [];

    for (const dtrId of batch) {
      try {
        const result = await fetchAPI(`/qr/verify/${dtrId}`, {
          method: 'PUT',
          body: JSON.stringify({
            supervisorId: window.currentUser._id,
            signature,
            remarks,
          }),
        });

        if (result && result.success) {
          verifiedCount++;
        } else {
          failed.push(dtrId);
        }
      } catch (error) {
        console.error('Error verifying DTR:', error);
        failed.push(dtrId);
      }
    }

    remaining = failed.slice();

    if (failed.length === 0) {
      return { verified: verifiedCount, failed: 0 };
    }
    if (failed.length === batch.length) {
      throw new Error('No DTR entries could be verified. Please try again.');
    }
    return {
      verified: verifiedCount,
      failed: failed.length,
      warning: `${failed.length} of ${batch.length} entries could not be verified. The remaining entries were signed successfully.`,
    };
  };
}

function openDtrVerificationModal(ids, records, options) {
  const traineeSelect = document.getElementById('dtr-trainee-select');
  const traineeLabel = traineeSelect?.selectedOptions?.[0]?.text?.trim() || 'Selected trainee';
  const single = ids.length === 1;
  const first = records[0] || null;

  VerificationModal.open({
    type: 'dtr',
    title: single ? 'Verify DTR Entry' : 'Verify DTR Entries',
    description: single
      ? 'This DTR entry will be marked as verified and recorded as an official attendance record. Once verified, this action cannot be undone.'
      : 'These DTR entries will be marked as verified and recorded as official attendance records. Once verified, this action cannot be undone.',
    summary: [
      {
        label: single ? 'DTR Entry' : 'Entries',
        value: single ? (first ? dtrDateLabel(first.date) : 'Selected entry') : `${ids.length} entries`,
      },
      { label: 'Trainee', value: traineeLabel },
      ...(single
        ? [
            { label: 'Time In', value: first ? dtrTimeLabel(first.timeIn) : '—' },
            { label: 'Time Out', value: first ? dtrTimeLabel(first.timeOut) : '—' },
          ]
        : [{ label: 'Period', value: dtrDateRange(records) }]),
      { label: 'Status', value: 'Pending Verification' },
    ],
    list: single ? null : dtrModalRows(ids),
    successSummary: (result) => {
      const verifiedNow = result?.verified || 0;
      return [
        single
          ? { label: 'DTR Entry', value: first ? dtrDateLabel(first.date) : 'Selected entry' }
          : { label: 'Entries', value: `${ids.length} selected` },
        { label: 'Verified', value: `${verifiedNow} of ${ids.length}` },
        { label: 'Status', value: result?.failed ? 'Partially Verified' : 'Verified' },
      ];
    },
    onConfirm: options.runner,
    onSuccess: options.onSuccess,
  });
}

function verifySelectedDTR() {
  const checkboxes = Array.from(
    document.querySelectorAll('#dtr-table-body input[type="checkbox"]:checked')
  );

  if (checkboxes.length === 0) {
    showNotification('No entries selected', 'Please select at least one DTR entry to verify.', 'info');
    return;
  }

  const ids = checkboxes.map((checkbox) => checkbox.getAttribute('data-dtr-id')).filter(Boolean);
  const records = ids.map((id) => dtrRecordById(id)).filter(Boolean);

  if (ids.length === 0) {
    showNotification('No entries selected', 'Please select at least one DTR entry to verify.', 'info');
    return;
  }

  openDtrVerificationModal(ids, records, {
    runner: createDtrVerificationRunner(
      ids,
      `Verified by ${window.currentUser.fullName} on ${new Date().toLocaleString()}`,
      ''
    ),
    onSuccess: () => {
      checkboxes.forEach((checkbox) => {
        checkbox.disabled = true;
        checkbox.closest('tr')?.classList.add('opacity-60');
      });
      loadDTRData();
    },
  });
}

function flagDTREntry() {
  const checkboxes = document.querySelectorAll('#dtr-table-body input[type="checkbox"]:checked');

  if (checkboxes.length === 0) {
    showNotification('No entries selected', 'Please select at least one DTR entry to flag.', 'info');
    return;
  }

  const count = checkboxes.length;

  VerificationModal.open({
    type: 'prompt',
    title: 'Flag DTR Entries',
    description: `${count} DTR ${count === 1 ? 'entry' : 'entries'} will be flagged for review.`,
    input: {
      label: 'Reason for flagging',
      placeholder: 'Describe why these entries need attention...',
      required: true,
      requiredMessage: 'Please enter a reason for flagging.',
      hint: 'The reason is shown alongside the flagged entries.',
    },
    confirmLabel: 'Flag Entries',
    onConfirm: (reason) => {
      showNotification(
        'Entries flagged',
        `${count} DTR entry/entries flagged with reason: ${reason}. Note: Flag functionality can be implemented in the remarks field.`,
        'info'
      );
    },
  });
}

function verifyAllAndSign() {
  const tableBody = document.getElementById('dtr-table-body');
  const allRows = tableBody.querySelectorAll('tr[data-dtr-id]');

  if (allRows.length === 0) {
    showNotification('Nothing to verify', 'There are no DTR records to verify for this period.', 'info');
    return;
  }

  const unverifiedRows = Array.from(allRows).filter(row => {
    const statusBadge = row.querySelector('.status-badge');
    return statusBadge && !statusBadge.classList.contains('status-completed');
  });

  if (unverifiedRows.length === 0) {
    showNotification('Already verified', 'All DTR entries are already verified.', 'info');
    return;
  }

  const ids = unverifiedRows.map((row) => row.getAttribute('data-dtr-id')).filter(Boolean);
  const records = ids.map((id) => dtrRecordById(id)).filter(Boolean);

  openDtrVerificationModal(ids, records, {
    runner: createDtrVerificationRunner(
      ids,
      `Digitally signed by ${window.currentUser.fullName} on ${new Date().toLocaleString()}`,
      'Batch verification - entire month verified'
    ),
    onSuccess: () => {
      document.getElementById('dtr-signature-area').classList.remove('hidden');
      document.getElementById('sig-supervisor-name').textContent = window.currentUser.fullName || 'Supervisor';
      document.getElementById('sig-supervisor-pos').textContent = window.currentUser.companyPosition || 'Company Supervisor';
      document.getElementById('sig-supervisor-company').textContent = window.currentUser.companyName || 'Your Company';
      document.getElementById('sig-timestamp').textContent = new Date().toLocaleString();
      loadDTRData();
    },
  });
}

function downloadDTRPDF() {
  showNotification('Notice', 'Downloading DTR as PDF...\nFile: DTR_' + (window.currentUser?.fullName || 'Trainee') + '_' + new Date().toISOString().slice(0, 7) + '.pdf', 'info');
}

// ────────────────────────────────────────────────────────────────────────────
// JOURNAL REVIEW & SIGN SECTION
// ────────────────────────────────────────────────────────────────────────────

function filterJournals(status) {
  const buttons = document.querySelectorAll('.tab-btn');
  buttons.forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');

  refreshPendingJournalBadge().catch(err => console.error('Error refreshing pending badge:', err));

  if (status === 'pending') {
    loadPendingJournals();
  } else if (status === 'signed') {
    loadSignedJournals();
  } else if (status === 'returned') {
    loadReturnedJournals();
  }
}

async function refreshPendingJournalBadge() {
  const pendingCountBadge = document.getElementById('pending-count');
  if (!pendingCountBadge) return;

  const result = await fetchAPI('/supervisor/journals', {
    method: 'GET',
  });

  if (!result || !result.success) return;
  pendingCountBadge.textContent = (result.data || []).length;
}

async function loadPendingJournals() {
  try {
    const result = await fetchAPI('/supervisor/journals', {
      method: 'GET',
    });

    if (!result || !result.success) {
      console.error('Failed to load journals:', result);
      return;
    }

    const journals = result.data || [];
    const journalListContainer = document.getElementById('supervisor-journal-list');
    
    if (!journalListContainer) return;

    if (journals.length === 0) {
      journalListContainer.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">No pending journals awaiting signature</p>';
      return;
    }

    let journalListHTML = '';
    journals.forEach(journal => {
      const date = new Date(journal.submittedAt).toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric', 
        year: 'numeric' 
      });
      
      const traineeInfo = journal.studentId || {};
      journalListHTML += `
        <div class="journal-item p-4 rounded-lg bg-white/5 border border-white/10 cursor-pointer hover:bg-white/10 transition" onclick="selectJournal(this, '${journal._id}')">
          <div class="flex items-start justify-between mb-2">
            <div>
              <p class="font-semibold text-sm text-blue-400">${journal.week}</p>
              <p class="text-xs text-slate-400">${traineeInfo.fullName || 'Unknown Trainee'}</p>
              <p class="text-xs text-slate-500">${date}</p>
            </div>
            <span class="status-badge status-pending">Pending</span>
          </div>
        </div>
      `;
    });
    
    journalListContainer.innerHTML = journalListHTML;
    
    // Update pending count badge
    const pendingCountBadge = document.getElementById('pending-count');
    if (pendingCountBadge) {
      pendingCountBadge.textContent = journals.length;
    }
  } catch (error) {
    console.error('Error loading pending journals:', error);
  }
}

async function loadSignedJournals() {
  try {
    const result = await fetchAPI('/supervisor/journals/signed', {
      method: 'GET',
    });

    if (!result || !result.success) {
      console.error('Failed to load signed journals:', result);
      return;
    }

    const journals = result.data || [];
    const journalListContainer = document.getElementById('supervisor-journal-list');
    
    if (!journalListContainer) return;

    if (journals.length === 0) {
      journalListContainer.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">No signed journals</p>';
      return;
    }

    let journalListHTML = '';
    journals.forEach(journal => {
      const date = new Date(journal.supervisorSignedAt).toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric', 
        year: 'numeric' 
      });
      
      const traineeInfo = journal.studentId || {};
      journalListHTML += `
        <div class="journal-item p-4 rounded-lg bg-white/5 border border-white/10 cursor-pointer hover:bg-white/10 transition" onclick="selectJournal(this, '${journal._id}')">
          <div class="flex items-start justify-between mb-2">
            <div>
              <p class="font-semibold text-sm text-blue-400">${journal.week}</p>
              <p class="text-xs text-slate-400">${traineeInfo.fullName || 'Unknown Trainee'}</p>
              <p class="text-xs text-slate-500">Signed: ${date}</p>
            </div>
            <span class="status-badge status-completed">Signed</span>
          </div>
        </div>
      `;
    });
    
    journalListContainer.innerHTML = journalListHTML;
  } catch (error) {
    console.error('Error loading signed journals:', error);
  }
}

async function loadReturnedJournals() {
  try {
    const result = await fetchAPI('/supervisor/journals/returned', {
      method: 'GET',
    });

    if (!result || !result.success) {
      console.error('Failed to load returned journals:', result);
      return;
    }

    const journals = result.data || [];
    const journalListContainer = document.getElementById('supervisor-journal-list');
    
    if (!journalListContainer) return;

    if (journals.length === 0) {
      journalListContainer.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">No returned journals</p>';
      return;
    }

    let journalListHTML = '';
    journals.forEach(journal => {
      const date = new Date(journal.submittedAt).toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric', 
        year: 'numeric' 
      });
      
      const traineeInfo = journal.studentId || {};
      journalListHTML += `
        <div class="journal-item p-4 rounded-lg bg-white/5 border border-white/10 cursor-pointer hover:bg-white/10 transition" onclick="selectJournal(this, '${journal._id}')">
          <div class="flex items-start justify-between mb-2">
            <div>
              <p class="font-semibold text-sm text-blue-400">${journal.week}</p>
              <p class="text-xs text-slate-400">${traineeInfo.fullName || 'Unknown Trainee'}</p>
              <p class="text-xs text-slate-500">Submitted: ${date}</p>
            </div>
            <span class="status-badge status-returned">Returned</span>
          </div>
          <p class="text-xs text-slate-400 mt-2">Reason: ${journal.supervisorReview || 'No reason provided'}</p>
        </div>
      `;
    });
    
    journalListContainer.innerHTML = journalListHTML;
  } catch (error) {
    console.error('Error loading returned journals:', error);
  }
}

function selectJournal(element, journalId) {
  const items = document.querySelectorAll('#supervisor-journal-list .journal-item');
  items.forEach(item => item.classList.remove('selected'));
  element.classList.add('selected');

  const viewer = document.getElementById('supervisor-journal-viewer');
  
  // Re-trigger animation on content change
  viewer.classList.remove('supervisor-journal-viewer');
  requestAnimationFrame(() => {
    viewer.classList.add('supervisor-journal-viewer');
  });

  // Find the selected journal data from the list
  fetchAPI(`/journal/${journalId}`).then(journalResult => {
    if (!journalResult || !journalResult.success) {
      viewer.innerHTML = '<div class="text-red-400">Error loading journal details</div>';
      return;
    }

    const journal = journalResult.data;
    const traineeInfo = journal.studentId || {};
    const isSigned = journal.supervisorSigned;
    window.currentJournalForReview = journal;
    
    // Determine status badge styling
    const statusStyle = isSigned ? 'status-completed' : 'status-pending';
    const statusText = isSigned ? 'Signed' : 'Pending Signature';
    
    viewer.innerHTML = `
      <div>
        <div class="flex items-center justify-between mb-6">
          <div>
            <h3 class="font-display font-700 text-xl">${journal.week} Journal</h3>
            <p class="text-slate-400 text-sm">Trainee: ${traineeInfo.fullName || 'Unknown'}</p>
            <p class="text-slate-500 text-xs mt-1">Submitted: ${new Date(journal.submittedAt).toLocaleDateString('en-US')}</p>
            ${isSigned ? `<p class="text-slate-500 text-xs mt-1">Signed: ${new Date(journal.supervisorSignedAt).toLocaleDateString('en-US')}</p>` : ''}
          </div>
          <div class="flex items-start gap-2">
            <span class="status-badge ${statusStyle}">${statusText}</span>
            <button onclick="closeJournalViewer()" class="p-2 hover:bg-white/10 rounded-lg transition" title="Close" aria-label="Close journal viewer">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-iconsax="close-circle"></svg>
            </button>
          </div>
        </div>

        ${journal.identifiedTheories && journal.identifiedTheories.length > 0 ? `
          <div class="mb-6">
            <h4 class="font-semibold mb-3">Identified Theories</h4>
            <div class="space-y-2">
              ${journal.identifiedTheories.map((theory, index) => {
                return `
                <div class="theory-card" style="padding: 10px 14px; border-radius: 8px;">
                  <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                    <span class="theory-card__title" style="font-weight: 600; font-size: 12px;">${escapeHtml(theory.course || '')} – ${escapeHtml(theory.courseName || '')}</span>
                    <span class="theory-card__tag" style="font-size: 10px; padding: 2px 8px; border-radius: 999px;">${escapeHtml(theory.category || '')}</span>
                  </div>
                  <p class="theory-card__text" style="margin: 5px 0 0 0; font-size: 13px; line-height: 1.5; font-style: italic;">${escapeHtml(theory.theory || '')}</p>
                </div>
                `;
              }).join('')}
            </div>
          </div>
        ` : ''}

        ${journal.narrative && journal.narrative.trim() ? `
          <div class="glass-card p-4 bg-white/5 border-l-4 border-blue-400 mb-6">
            <p class="text-xs text-slate-400 mb-2">JOURNAL ENTRY</p>
            <p class="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">${journal.narrative}</p>
          </div>
        ` : journal.summary ? `
          <div class="glass-card p-4 bg-white/5 border-l-4 border-blue-400 mb-6">
            <p class="text-xs text-slate-400 mb-2">AI-GENERATED SUMMARY</p>
            <p class="text-sm text-slate-200">${journal.summary}</p>
          </div>
        ` : `
          <div class="glass-card p-4 bg-slate-600/20 border-l-4 border-slate-500 mb-6">
            <p class="text-xs text-slate-400 mb-2">JOURNAL ENTRY</p>
            <p class="text-sm text-slate-300">No entry content available</p>
          </div>
        `}

        ${journal.supervisorRemarks ? `
          <div class="glass-card p-4 bg-white/5 border-l-4 border-amber-400 mb-6">
            <p class="text-xs text-slate-400 mb-2">SUPERVISOR REMARKS</p>
            <p class="text-sm text-slate-200">${escapeHtml(journal.supervisorRemarks)}</p>
          </div>
        ` : ''}

        ${!isSigned ? `
          <div class="mb-6">
            <label class="block text-sm font-semibold mb-3">Supervisor Remarks (Optional)</label>
            <textarea id="journal-remarks" class="w-full glass-card px-4 py-3 text-white text-sm rounded-lg border border-white/10 focus:border-blue-400 outline-none" rows="3" placeholder="Add your remarks here..."></textarea>
          </div>
        ` : ''}

        <div class="flex gap-3">
          ${isSigned ? `
            <div class="glass-card p-4 bg-green-500/10 border border-green-500/30 rounded-lg w-full">
              <p class="text-sm text-green-400"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-iconsax="tick-circle"></svg> This journal has been signed on ${new Date(journal.supervisorSignedAt).toLocaleDateString('en-US')}</p>
              ${journal.supervisorReview ? `<p class="text-xs text-slate-400 mt-2">Your remarks: ${journal.supervisorReview}</p>` : ''}
            </div>
          ` : `
            <button onclick="returnJournalForRevision('${journal._id}')" class="btn-ghost flex-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-iconsax="arrow-rotate-left"></svg>
              Return for Revision
            </button>
            <button onclick="verifyAndSignJournal('${journal._id}')" class="btn-primary flex-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-iconsax="tick-circle"></svg>
              Verify & Sign
            </button>
          `}
        </div>
      </div>
    `;
  }).catch(err => {
    console.error('Error loading journal:', err);
    viewer.innerHTML = '<div class="text-red-400">Error loading journal details</div>';
  });
}

function closeJournalViewer() {
  window.currentJournalForReview = null;
  const items = document.querySelectorAll('#supervisor-journal-list .journal-item');
  items.forEach(item => item.classList.remove('selected'));
  
  const viewer = document.getElementById('supervisor-journal-viewer');
  viewer.innerHTML = `
    <div class="text-center py-12">
      <p class="text-slate-400">Select a journal to review and sign</p>
    </div>
  `;
}

function returnJournalForRevision(journalId) {
  VerificationModal.open({
    type: 'prompt',
    title: 'Return for Revision',
    description: 'Explain what needs to be revised before this journal can be signed.',
    input: {
      label: 'Feedback for revision',
      placeholder: 'Describe the changes the trainee should make...',
      required: true,
      requiredMessage: 'Please enter feedback for revision.',
      hint: 'This feedback is stored with the returned journal.',
    },
    confirmLabel: 'Return for Revision',
    onConfirm: (feedback) => rejectJournal(journalId, feedback),
  });
}

function verifyAndSignJournal(journalId) {
  const journal = window.currentJournalForReview || {};
  const traineeInfo = journal.studentId || {};
  const remarksEl = document.getElementById('journal-remarks');
  const remarks = remarksEl ? remarksEl.value : '';

  const journalLabel = journal.week ? `${journal.week} Journal` : 'Journal';
  const traineeLabel = traineeInfo.fullName || 'Unknown Trainee';
  const submittedLabel = journal.submittedAt
    ? new Date(journal.submittedAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '—';

  VerificationModal.open({
    type: 'journal',
    summary: [
      { label: 'Journal', value: journalLabel },
      { label: 'Trainee', value: traineeLabel },
      { label: 'Submitted', value: submittedLabel },
      { label: 'Status', value: 'Pending Signature' },
    ],
    successSummary: [
      { label: 'Journal', value: journalLabel },
      { label: 'Trainee', value: traineeLabel },
      { label: 'Status', value: 'Signed' },
    ],
    onConfirm: async () => {
      const result = await fetchAPI(`/supervisor/journals/${journalId}/sign`, {
        method: 'POST',
        body: JSON.stringify({
          remarks: remarks || null,
        }),
      });

      if (!result || !result.success) {
        throw new Error(result?.message || 'Failed to sign journal');
      }
      return result;
    },
    onSuccess: () => {
      const viewer = document.getElementById('supervisor-journal-viewer');
      if (viewer) {
        viewer.innerHTML =
          '<div class="text-center py-12"><p class="text-slate-400">Select a journal to review and sign</p></div>';
      }
      window.currentJournalForReview = null;
      loadPendingJournals();
    },
  });
}

async function rejectJournal(journalId, remarks) {
  try {
    const result = await fetchAPI(`/supervisor/journals/${journalId}/reject`, {
      method: 'POST',
      body: JSON.stringify({
        remarks: remarks || 'Returned for revision',
      }),
    });

    if (!result || !result.success) {
      showNotification('Error', result?.message || 'Failed to return journal', 'error');
      return;
    }

    showNotification('Success', 'Journal returned for revision', 'success');
    // Clear viewer and reload pending journals list
    document.getElementById('supervisor-journal-viewer').innerHTML = '<div class="text-center py-12"><p class="text-slate-400">Select a journal to review and sign</p></div>';
    loadPendingJournals();
  } catch (error) {
    console.error('Error rejecting journal:', error);
    showNotification('Error', 'Error rejecting journal', 'error');
  }
}

async function loadSupervisorJournals() {
  await loadPendingJournals();
}

let supervisorRealtimeTimer = null;

function startSupervisorRealtimeUpdates() {
  if (supervisorRealtimeTimer) clearInterval(supervisorRealtimeTimer);

  supervisorRealtimeTimer = setInterval(async () => {
    if (document.hidden) return;

    const activeTab = document.querySelector('.tab-content.active')?.id;
    try {
      if (activeTab === 'overview') {
        await loadSupervisorData();
      } else if (activeTab === 'my-trainees') {
        await loadAssignedTrainees();
      } else if (activeTab === 'journal-sign') {
        await loadPendingJournals();
      } else if (activeTab === 'dtr-verification') {
        await loadDTRData();
      }
    } catch (error) {
      console.error('Supervisor real-time update failed:', error);
    }
  }, 10000);
}

// ────────────────────────────────────────────────────────────────────────────
// PERFORMANCE APPRAISAL SECTION (official 100-point form)
// ────────────────────────────────────────────────────────────────────────────

// Criteria/categories come from the server (single source of truth); totals
// shown here are a live preview only — the backend always recomputes them.
let appraisalCriteria = null;
let appraisalCriteriaPromise = null;

const APPRAISAL_PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

async function initAppraisalTab() {
  try {
    if (!appraisalCriteriaPromise) {
      appraisalCriteriaPromise = fetchAPI('/appraisal/criteria').then((result) => {
        if (!result || !result.success) {
          throw new Error(result?.message || 'Failed to load evaluation criteria.');
        }
        appraisalCriteria = result.data;
        renderAppraisalCriteria();
        return appraisalCriteria;
      });
    }
    await appraisalCriteriaPromise;
    await loadAppraisalContext();
  } catch (error) {
    const container = document.getElementById('appraisal-criteria-container');
    if (container) {
      container.innerHTML = `<p class="text-sm text-red-400">${escapeHtml(error.message || 'Failed to load evaluation criteria.')}</p>`;
    }
  }
}

/** Render the four weighted categories and their nine official indicators. */
function renderAppraisalCriteria() {
  const container = document.getElementById('appraisal-criteria-container');
  if (!container || !appraisalCriteria) return;
  const { categories, criteria } = appraisalCriteria;

  container.innerHTML = categories.map((category) => {
    const rows = criteria.filter((c) => c.category === category.key);
    return `
      <div class="mb-6 pb-6 border-b border-white/10">
        <p class="text-sm font-semibold mb-1">${escapeHtml(category.label)}</p>
        <p class="text-xs text-slate-500 mb-4">Maximum points: ${category.max}</p>
        <div class="space-y-4">
          ${rows.map((row) => `
            <div class="p-4 rounded-lg bg-white/5 border border-white/10">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <p class="text-sm text-slate-300 flex-1 min-w-0">${escapeHtml(row.text)}</p>
                <div class="flex items-center gap-2 flex-shrink-0">
                  <span class="text-xs text-slate-500">Max <span class="font-semibold text-slate-300">${row.max}</span></span>
                  <input type="number" data-score="${row.key}" min="0" max="${row.max}" step="any"
                    aria-label="Rating for ${escapeHtml(row.short)} out of ${row.max}"
                    placeholder="—"
                    class="w-20 px-3 py-2 text-white text-sm text-center rounded-lg border border-white/10 focus:border-blue-400 outline-none" style="background: #0f172a;">
                </div>
              </div>
              <input type="text" data-remarks="${row.key}" maxlength="300" placeholder="Remarks (optional)"
                class="mt-3 w-full px-3 py-2 text-white text-xs rounded-lg border border-white/10 focus:border-blue-400 outline-none" style="background: #0f172a;">
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');
}

/** Live preview of subtotals / total / rating equivalent from the inputs. */
function updateAppraisalTotals() {
  if (!appraisalCriteria) return;
  const { categories, criteria, ratingEquivalents } = appraisalCriteria;

  const scores = {};
  let allScored = true;
  criteria.forEach((criterion) => {
    const el = document.querySelector(`[data-score="${criterion.key}"]`);
    const raw = el ? String(el.value).trim() : '';
    let score = null;
    if (raw !== '') {
      const num = Number(raw);
      // An out-of-range or non-numeric entry is not a valid score.
      if (Number.isFinite(num) && num >= 0 && num <= criterion.max) score = num;
      else allScored = false;
    } else {
      allScored = false;
    }
    scores[criterion.key] = score;
  });

  categories.forEach((category) => {
    const rows = criteria.filter((c) => c.category === category.key);
    const complete = rows.every((c) => scores[c.key] !== null);
    const subtotal = complete
      ? Math.round(rows.reduce((sum, c) => sum + scores[c.key], 0) * 100) / 100
      : null;
    const el = document.getElementById(`subtotal-${category.key}`);
    if (el) el.textContent = subtotal === null ? '—' : `${subtotal} / ${category.max}`;
  });

  const numEl = document.getElementById('overall-rating-num');
  const labelEl = document.getElementById('overall-rating-label');
  const noteEl = document.getElementById('appraisal-incomplete-note');

  if (!allScored) {
    // Incomplete evaluations never show a fabricated grade.
    if (numEl) numEl.textContent = '—';
    if (labelEl) labelEl.textContent = 'Incomplete';
    if (noteEl) noteEl.classList.remove('hidden');
    return;
  }

  const total = Math.round(criteria.reduce((sum, c) => sum + scores[c.key], 0) * 100) / 100;
  const band = (ratingEquivalents || []).find((entry) => total >= entry.min && total <= entry.max);
  if (numEl) numEl.textContent = `${total} / 100`;
  // "Below 75 → Fail" covers fractional totals such as 74.5 (backend agrees).
  if (labelEl) labelEl.textContent = band ? band.label : (total < 75 ? 'Fail' : '—');
  if (noteEl) noteEl.classList.add('hidden');
}

function clearAppraisalForm() {
  document.querySelectorAll('[data-info]').forEach((el) => { el.value = ''; });
  document.querySelectorAll('[data-score]').forEach((el) => { el.value = ''; });
  document.querySelectorAll('[data-remarks]').forEach((el) => { el.value = ''; });
  const remarks = document.getElementById('overall-remarks');
  if (remarks) remarks.value = '';
  const checkbox = document.getElementById('recommended-completion');
  if (checkbox) checkbox.checked = false;
  ['technical', 'attitude', 'quality', 'attendance'].forEach((key) => {
    const el = document.getElementById(`subtotal-${key}`);
    if (el) el.textContent = '—';
  });
  const numEl = document.getElementById('overall-rating-num');
  if (numEl) numEl.textContent = '—';
  const labelEl = document.getElementById('overall-rating-label');
  if (labelEl) labelEl.textContent = 'Incomplete';
  const noteEl = document.getElementById('appraisal-incomplete-note');
  if (noteEl) noteEl.classList.add('hidden');
  const badge = document.getElementById('appraisal-status-badge');
  if (badge) badge.hidden = true;
  const lockNotice = document.getElementById('appraisal-lock-notice');
  if (lockNotice) lockNotice.classList.add('hidden');
}

function setAppraisalFormEnabled(enabled) {
  const fieldset = document.getElementById('appraisal-fieldset');
  if (fieldset) fieldset.disabled = !enabled;
  const saveBtn = document.getElementById('appraisal-save-draft-btn');
  const submitBtn = document.getElementById('appraisal-submit-btn');
  if (saveBtn) saveBtn.classList.toggle('hidden', !enabled);
  if (submitBtn) submitBtn.classList.toggle('hidden', !enabled);
}

function showAppraisalEmptyNotice(show) {
  const notice = document.getElementById('appraisal-empty-notice');
  if (notice) notice.classList.toggle('hidden', !show);
}

function showAppraisalStatusBadge(status) {
  const badge = document.getElementById('appraisal-status-badge');
  if (!badge) return;
  badge.hidden = false;
  badge.classList.remove('status-pending', 'status-completed');
  if (status === 'draft') {
    badge.classList.add('status-pending');
    badge.textContent = 'Draft';
  } else {
    badge.classList.add('status-completed');
    badge.textContent = status === 'acknowledged' ? 'Acknowledged' : 'Submitted & Signed';
  }
}

function populateAppraisalForm(info, record) {
  document.querySelectorAll('[data-info]').forEach((el) => {
    el.value = (info && info[el.getAttribute('data-info')]) || '';
  });
  const ratings = (record && record.ratings) || {};
  document.querySelectorAll('[data-score]').forEach((el) => {
    const entry = ratings[el.getAttribute('data-score')];
    const score = entry ? entry.score : null;
    el.value = score === null || score === undefined ? '' : score;
  });
  document.querySelectorAll('[data-remarks]').forEach((el) => {
    const entry = ratings[el.getAttribute('data-remarks')];
    el.value = (entry && entry.remarks) || '';
  });
}

/**
 * Load the selected trainee + month: prefilled defaults from the trainee
 * record, or the saved record when one exists (drafts reopen, submitted
 * records lock the form).
 */
async function loadAppraisalContext() {
  const traineeSelect = document.getElementById('appraisal-trainee-select');
  const monthPicker = document.getElementById('appraisal-month-picker');
  const traineeId = traineeSelect ? traineeSelect.value : '';
  const period = monthPicker ? monthPicker.value : '';

  clearAppraisalForm();
  setAppraisalFormEnabled(false);

  if (!traineeId || !APPRAISAL_PERIOD_RE.test(period || '')) {
    showAppraisalEmptyNotice(true);
    await loadAppraisalHistory(traineeId || '');
    return;
  }
  showAppraisalEmptyNotice(false);

  try {
    const result = await fetchAPI(`/appraisal/context?traineeId=${encodeURIComponent(traineeId)}&period=${encodeURIComponent(period)}`);
    if (!result || !result.success) {
      throw new Error(result?.message || 'Failed to load the appraisal form.');
    }

    const { defaults, record } = result.data;
    // The saved snapshot always wins over fresh defaults when reopening.
    populateAppraisalForm(record ? record.info : defaults, record);

    const remarks = document.getElementById('overall-remarks');
    if (remarks) remarks.value = (record && record.overallRemarks) || '';
    const checkbox = document.getElementById('recommended-completion');
    if (checkbox) checkbox.checked = !!(record && record.recommendedCompletion);

    updateAppraisalTotals();

    const locked = !!record && record.status !== 'draft';
    setAppraisalFormEnabled(!locked);
    if (record) {
      showAppraisalStatusBadge(record.status);
      const lockNotice = document.getElementById('appraisal-lock-notice');
      if (lockNotice) lockNotice.classList.toggle('hidden', !locked);
    }

    await loadAppraisalHistory(traineeId);
  } catch (error) {
    showNotification('Error', error.message || 'Failed to load the appraisal form.', 'error');
  }
}

/** Previous Appraisals table for the selected trainee. */
async function loadAppraisalHistory(traineeId) {
  const body = document.getElementById('appraisal-history-body');
  if (!body) return;

  if (!traineeId) {
    body.innerHTML = '<tr class="border-b border-white/10"><td colspan="5" class="py-6 px-4 text-center text-slate-500">Select a trainee to view their appraisal history.</td></tr>';
    return;
  }

  try {
    const result = await fetchAPI(`/appraisal/trainee/${encodeURIComponent(traineeId)}`);
    if (!result || !result.success) {
      throw new Error(result?.message || 'Failed to load appraisal history.');
    }

    const records = result.data || [];
    if (!records.length) {
      body.innerHTML = '<tr class="border-b border-white/10"><td colspan="5" class="py-6 px-4 text-center text-slate-500">No appraisals yet for this trainee.</td></tr>';
      return;
    }

    body.innerHTML = records.map((record) => {
      const isDraft = record.status === 'draft';
      const month = (record.info && record.info.evaluationPeriodLabel) || record.period;
      const score = record.isComplete && typeof record.totalScore === 'number'
        ? `${record.totalScore} / 100`
        : '—';
      const equivalent = record.isComplete && record.ratingEquivalent ? record.ratingEquivalent : 'Incomplete';
      const badge = isDraft
        ? '<span class="status-badge status-pending">Draft</span>'
        : `<span class="status-badge status-completed">${record.status === 'acknowledged' ? 'Acknowledged' : 'Submitted'}</span>`;
      const action = isDraft
        ? `<button type="button" onclick="openAppraisalDraft('${record.period}')" class="text-blue-400 hover:text-blue-300 text-xs font-semibold">Continue Draft</button>`
        : `<button type="button" onclick="downloadAppraisalPDF('${record._id}')" class="text-blue-400 hover:text-blue-300 text-xs font-semibold">Download PDF</button>`;
      return `
        <tr class="border-b border-white/10">
          <td class="py-3 px-4">${escapeHtml(month)}</td>
          <td class="py-3 px-4"><span class="font-semibold text-blue-400">${escapeHtml(score)}</span></td>
          <td class="py-3 px-4">${escapeHtml(equivalent)}</td>
          <td class="py-3 px-4">${badge}</td>
          <td class="py-3 px-4">${action}</td>
        </tr>
      `;
    }).join('');
  } catch (error) {
    body.innerHTML = `<tr class="border-b border-white/10"><td colspan="5" class="py-6 px-4 text-center text-red-400">${escapeHtml(error.message || 'Failed to load appraisal history.')}</td></tr>`;
  }
}

/** Reopen a draft by switching the month picker to its period. */
function openAppraisalDraft(period) {
  const monthPicker = document.getElementById('appraisal-month-picker');
  if (monthPicker && APPRAISAL_PERIOD_RE.test(period || '')) monthPicker.value = period;
  loadAppraisalContext();
}

/** Jump from the trainee profile modal to the appraisal form. */
function openPerformanceAppraisal(traineeId) {
  closeTraineeDetail();
  const select = document.getElementById('appraisal-trainee-select');
  if (select) select.value = traineeId;
  switchTab('performance');
}

/** Gather the form into the API payload shape (totals are never sent). */
function collectAppraisalPayload() {
  const info = {};
  document.querySelectorAll('[data-info]').forEach((el) => {
    info[el.getAttribute('data-info')] = el.value.trim();
  });
  const ratings = {};
  document.querySelectorAll('[data-score]').forEach((el) => {
    const key = el.getAttribute('data-score');
    const remarksEl = document.querySelector(`[data-remarks="${key}"]`);
    const raw = String(el.value).trim();
    ratings[key] = {
      score: raw === '' ? null : raw,
      remarks: remarksEl ? remarksEl.value.trim() : '',
    };
  });
  const traineeSelect = document.getElementById('appraisal-trainee-select');
  const monthPicker = document.getElementById('appraisal-month-picker');
  return {
    traineeId: traineeSelect ? traineeSelect.value : '',
    period: monthPicker ? monthPicker.value : '',
    info,
    ratings,
    overallRemarks: document.getElementById('overall-remarks')?.value || '',
    recommendedCompletion: document.getElementById('recommended-completion')?.checked || false,
  };
}

async function saveDraftAppraisal() {
  if (!appraisalCriteria) {
    showNotification('Notice', 'The evaluation criteria are still loading. Please try again in a moment.', 'info');
    return;
  }
  const traineeSelect = document.getElementById('appraisal-trainee-select');
  if (!traineeSelect || !traineeSelect.value) {
    showNotification('Notice', 'Select a trainee first.', 'info');
    return;
  }

  try {
    const result = await fetchAPI('/appraisal/draft', {
      method: 'POST',
      body: JSON.stringify(collectAppraisalPayload()),
    });
    if (!result || !result.success) {
      const errors = result?.data?.errors;
      throw new Error((errors && errors.length ? errors.join(' ') : null)
        || result?.message
        || 'Failed to save the draft.');
    }
    showNotification('Success', 'Appraisal saved as draft', 'success');
    await loadAppraisalContext();
  } catch (error) {
    showNotification('Error', error.message || 'Failed to save the draft.', 'error');
  }
}

function submitAppraisal(event) {
  event.preventDefault();

  if (!appraisalCriteria) {
    showNotification('Notice', 'The evaluation criteria are still loading. Please try again in a moment.', 'info');
    return;
  }
  const traineeSelect = document.getElementById('appraisal-trainee-select');
  if (!traineeSelect || !traineeSelect.value) {
    showNotification('Notice', 'Select a trainee first.', 'info');
    return;
  }

  // Client-side completeness gate; the backend enforces this too. Out-of-range
  // entries (e.g. 20 for a max-15 criterion) block submission as well.
  const invalid = Array.from(document.querySelectorAll('[data-score]')).filter((el) => {
    const raw = String(el.value).trim();
    if (raw === '') return true;
    const criterion = appraisalCriteria.criteria.find((c) => c.key === el.getAttribute('data-score'));
    const num = Number(raw);
    return !criterion || !Number.isFinite(num) || num < 0 || num > criterion.max;
  });
  if (invalid.length) {
    const noteEl = document.getElementById('appraisal-incomplete-note');
    if (noteEl) noteEl.classList.remove('hidden');
    updateAppraisalTotals();
    showNotification('Error', `All 9 criteria need a valid score (0 to max) — ${invalid.length} unscored or out of range.`, 'error');
    return;
  }

  const traineeLabel = traineeSelect.selectedOptions[0]?.textContent || 'Trainee';
  const periodLabel = document.getElementById('info-evaluationPeriodLabel')?.value || '';
  const totalText = document.getElementById('overall-rating-num')?.textContent?.trim() || '—';
  const equivalent = document.getElementById('overall-rating-label')?.textContent?.trim() || '—';

  VerificationModal.open({
    type: 'appraisal',
    summary: [
      { label: 'Trainee', value: traineeLabel },
      { label: 'Evaluation Period', value: periodLabel },
      { label: 'Total Score', value: totalText },
      { label: 'Rating Equivalent', value: equivalent },
    ],
    successSummary: [
      { label: 'Trainee', value: traineeLabel },
      { label: 'Evaluation Period', value: periodLabel },
      { label: 'Status', value: 'Submitted & Signed' },
    ],
    onConfirm: async () => {
      const result = await fetchAPI('/appraisal/submit', {
        method: 'POST',
        body: JSON.stringify(collectAppraisalPayload()),
      });
      if (!result || !result.success) {
        const errors = result?.data?.errors;
        throw new Error((errors && errors.length ? errors.join(' ') : null)
          || result?.message
          || 'Failed to submit the appraisal.');
      }
      return result.data;
    },
    onSuccess: () => {
      showNotification('Success', 'Appraisal submitted and signed.', 'success');
      loadAppraisalContext();
    },
  });
}

/** Generate the official PDF from the SAVED record (never unsaved inputs). */
async function downloadAppraisalPDF(recordId) {
  try {
    const result = await fetchAPI(`/appraisal/record/${encodeURIComponent(recordId)}`);
    if (!result || !result.success) {
      throw new Error(result?.message || 'Failed to load the appraisal record.');
    }
    if (!window.AppraisalPDF) {
      throw new Error('PDF library is not loaded yet. Please try again in a moment.');
    }
    await window.AppraisalPDF.download(result.data);
    showNotification('Success', 'Performance appraisal PDF downloaded.', 'success');
  } catch (error) {
    showNotification('Error', error.message || 'Failed to generate the appraisal PDF.', 'error');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS SECTION
// ────────────────────────────────────────────────────────────────────────────

function markAllNotificationsRead() {
  document.querySelectorAll('.notification-item').forEach(item => {
    item.classList.remove('unread');
    const dot = item.querySelector('.unread-dot');
    if (dot) dot.remove();
  });
  showNotification('Success', 'All notifications marked as read', 'success');
}

function filterSupervisorNotifications(type) {
  const tabs = document.querySelectorAll('.filter-tab');
  tabs.forEach(tab => tab.classList.remove('active'));
  event.target.classList.add('active');
  showNotification('Notice', `Filtering notifications: ${type}`, 'info');
}

// ────────────────────────────────────────────────────────────────────────────
// SETTINGS SECTION
// ────────────────────────────────────────────────────────────────────────────

function updateSignaturePreview() {
  const name = document.getElementById('sup-name').value || 'Your Name';
  document.getElementById('sig-preview-name').textContent = name;
}

function setSignaturePreview(dataUrl) {
  const previewImg = document.getElementById('sig-preview-image');
  if (!previewImg) return;

  if (dataUrl) {
    previewImg.src = dataUrl;
    previewImg.style.display = 'block';
  } else {
    previewImg.removeAttribute('src');
    previewImg.style.display = 'none';
  }
}

function loadSignaturePreview() {
  if (window.currentUser?.signatureDataUrl) {
    setSignaturePreview(window.currentUser.signatureDataUrl);
  }
}

async function handleSignatureUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) {
    setSignaturePreview(null);
    return;
  }

  if (!file.type.startsWith('image/')) {
    showNotification('Invalid file', 'Please upload an image file for your signature.', 'error');
    event.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    if (typeof dataUrl !== 'string') return;

    const image = new Image();
    image.onload = async () => {
      const maxWidth = 400;
      const maxHeight = 200;
      const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
      const targetWidth = Math.round(image.width * scale);
      const targetHeight = Math.round(image.height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, targetWidth, targetHeight);
      ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

      const optimizedDataUrl = canvas.toDataURL('image/png');

      const result = await fetchAPI('/dashboard/profile', {
        method: 'PUT',
        body: JSON.stringify({ signatureDataUrl: optimizedDataUrl }),
      });

      if (!result || !result.success) {
        showNotification('Upload failed', result?.message || 'Unable to save signature.', 'error');
        return;
      }

      const updatedUser = result.data || {};
      window.currentUser = updatedUser;
      localStorage.setItem('trackit_user', JSON.stringify(updatedUser));
      setSignaturePreview(updatedUser.signatureDataUrl || optimizedDataUrl);
    };
    image.src = dataUrl;
  };
  reader.readAsDataURL(file);
}

function saveSupervisorProfile(event) {
  event.preventDefault();
  const nameInput = document.getElementById('sup-name');
  const companyInput = document.getElementById('sup-company');
  const positionInput = document.getElementById('sup-position');

  const fullName = nameInput?.value?.trim() || '';
  const companyName = companyInput?.value?.trim() || '';
  const companyPosition = positionInput?.value?.trim() || '';

  if (!fullName) {
    showNotification('Missing name', 'Please enter your full name before saving.', 'error');
    return;
  }

  fetchAPI('/dashboard/profile', {
    method: 'PUT',
    body: JSON.stringify({ fullName, companyName, companyPosition }),
  }).then((result) => {
    if (!result || !result.success) {
      showNotification('Save failed', result?.message || 'Unable to update profile.', 'error');
      return;
    }

    const updatedUser = result.data;
    window.currentUser = updatedUser;
    localStorage.setItem('trackit_user', JSON.stringify(updatedUser));

    if (nameInput) nameInput.value = updatedUser.fullName || fullName;
    if (companyInput) companyInput.value = updatedUser.companyName || companyName;
    if (positionInput) positionInput.value = updatedUser.companyPosition || companyPosition;

    updateSignaturePreview();
    if (window.TrackITProfilePicture) window.TrackITProfilePicture.refresh();
    showNotification('Profile updated', 'Your changes have been saved.', 'success');
  });
}

async function changeSupervisorPassword(event) {
  event.preventDefault();
  const current = document.getElementById('sup-current-pass').value;
  const newPass = document.getElementById('sup-new-pass').value;
  const confirm = document.getElementById('sup-confirm-pass').value;

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
    showNotification('Password changed', 'Your password has been updated successfully.', 'success');
    document.getElementById('sup-password-form').reset();
  } else {
    showNotification('Password change failed', result?.message || 'Please try again.', 'error');
  }
}

function saveSupervisorPreferences() {
  showNotification('Success', 'Notification preferences saved!', 'success');
}

// ────────────────────────────────────────────────────────────────────────────
// GEOFENCE SETTINGS
// ────────────────────────────────────────────────────────────────────────────

function setGeofenceStatus(message, type = 'info') {
  const statusEl = document.getElementById('geofence-status');
  if (!statusEl) return;

  const colors = {
    info: '#94a3b8',
    success: '#22c55e',
    error: '#ef4444',
  };

  statusEl.textContent = message;
  statusEl.style.color = colors[type] || colors.info;
}

async function loadGeofenceSettings() {
  const latInput = document.getElementById('geofence-lat');
  const lngInput = document.getElementById('geofence-lng');
  const radiusInput = document.getElementById('geofence-radius');

  if (!latInput || !lngInput || !radiusInput) return;

  const result = await fetchAPI('/geofence/company/current');
  if (!result || !result.success) {
    setGeofenceStatus(result?.message || 'Unable to load geofence location.', 'error');
    return;
  }

  const { companyName, geofenceLocation } = result.data || {};
  if (geofenceLocation?.latitude != null && geofenceLocation?.longitude != null) {
    latInput.value = geofenceLocation.latitude;
    lngInput.value = geofenceLocation.longitude;
    radiusInput.value = geofenceLocation.radiusMeters || 100;
    setGeofenceStatus(`Current geofence set for ${companyName || 'company'}.`, 'success');
    return;
  }

  setGeofenceStatus('No geofence set yet. Use current location to pin.', 'info');
}

function useCurrentGeofenceLocation() {
  if (!navigator.geolocation) {
    showNotification('Error', 'Geolocation is not supported by your browser.', 'error');
    setGeofenceStatus('Geolocation not supported.', 'error');
    return;
  }

  setGeofenceStatus('Locating current position...', 'info');

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const latInput = document.getElementById('geofence-lat');
      const lngInput = document.getElementById('geofence-lng');

      if (!latInput || !lngInput) return;

      latInput.value = position.coords.latitude.toFixed(6);
      lngInput.value = position.coords.longitude.toFixed(6);

      const accuracy = Math.round(position.coords.accuracy || 0);
      setGeofenceStatus(`Location captured (accuracy ~${accuracy}m).`, 'success');
    },
    (error) => {
      const message = error?.message || 'Unable to get current location.';
      showNotification('Error', message, 'error');
      setGeofenceStatus(message, 'error');
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    }
  );
}

async function saveGeofenceLocation(event) {
  event.preventDefault();

  const latInput = document.getElementById('geofence-lat');
  const lngInput = document.getElementById('geofence-lng');
  const radiusInput = document.getElementById('geofence-radius');

  const latitude = latInput ? Number(latInput.value) : NaN;
  const longitude = lngInput ? Number(lngInput.value) : NaN;
  const radiusMeters = radiusInput && radiusInput.value ? Number(radiusInput.value) : 100;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    showNotification('Missing location', 'Please provide valid latitude and longitude.', 'error');
    return;
  }

  const result = await fetchAPI('/geofence/company/current', {
    method: 'PUT',
    body: JSON.stringify({ latitude, longitude, radiusMeters }),
  });

  if (!result || !result.success) {
    showNotification('Save failed', result?.message || 'Unable to save geofence.', 'error');
    setGeofenceStatus(result?.message || 'Unable to save geofence.', 'error');
    return;
  }

  showNotification('Geofence saved', 'Location updated successfully.', 'success');
  setGeofenceStatus('Geofence saved successfully.', 'success');
}

// ────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION & LOGOUT
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// MOBILE MENU TOGGLE
// ────────────────────────────────────────────────────────────────────────────

function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const isOpen = sidebar.classList.toggle('open');
  if (overlay) overlay.classList.toggle('visible', isOpen);
}

// Close sidebar when a nav link is clicked on mobile
function closeSidebarOnMobile() {
  if (window.innerWidth <= 768) {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('visible');
  }
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
// SCHEDULE MANAGER FUNCTIONS
// ────────────────────────────────────────────────────────────────────────────

/**
 * Load list of trainees for schedule selection
 */
async function loadScheduleTraineeList() {
  try {
    console.log('[Schedule Manager] Loading trainee list...');
    const select = document.getElementById('schedule-trainee-select');
    const response = await fetchAPI('/supervisor/trainees');

    console.log('[Schedule Manager] API Response:', response);

    if (!response || !response.success) {
      console.error('[Schedule Manager] Failed to get trainees');
      select.innerHTML = '<option value="">Error loading trainees</option>';
      return;
    }

    const trainees = response.data || [];
    console.log('[Schedule Manager] Loaded trainees:', trainees.length);
    
    select.innerHTML = '<option value="">Select a trainee...</option>';
    
    trainees.forEach(trainee => {
      const option = document.createElement('option');
      option.value = trainee._id;
      option.textContent = `${trainee.fullName} (${trainee.studentId || 'No ID'})`;
      select.appendChild(option);
      console.log('[Schedule Manager] Added option:', trainee.fullName);
    });

    // Populate schedule list
    updateScheduleList(trainees);
  } catch (error) {
    console.error('[Schedule Manager] Error loading trainees:', error);
    showNotification('Error', 'Failed to load trainees', 'error');
  }
}

/**
 * Update the schedule list display
 */
function updateScheduleList(trainees) {
  const listContainer = document.getElementById('schedule-list');
  console.log('[Schedule Manager] Updating list with trainees:', trainees?.length || 0);
  
  if (!trainees || trainees.length === 0) {
    listContainer.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">No trainees assigned</p>';
    console.log('[Schedule Manager] No trainees to display');
    return;
  }

  // Use a simpler approach with event delegation on the container
  listContainer.innerHTML = trainees.map((trainee, index) => {
    const hasSchedule = trainee.schedule && trainee.schedule.startTime;
    const statusText = hasSchedule ? 'Configured' : 'Not Set';

    return `
      <div class="schedule-item schedule-item-${index}" data-index="${index}" style="padding: 12px; border-radius: 6px; cursor: pointer; transition: all 0.2s; user-select: none; pointer-events: auto;" onclick="selectTraineeForSchedule('${trainee._id}')">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <p style="margin: 0; font-weight: 600; font-size: 13px;">${trainee.fullName}</p>
          <span class="status-badge ${hasSchedule ? 'status-completed' : 'status-neutral'}" style="font-size: 11px; padding: 4px 8px; border-radius: 4px; font-weight: 600;">${statusText}</span>
        </div>
        ${hasSchedule ? `
          <p class="schedule-item__time" style="margin: 0; font-size: 12px;">${trainee.schedule.startTime} - ${trainee.schedule.endTime}</p>
        ` : ''}
      </div>
    `;
  }).join('');

  console.log('[Schedule Manager] Rendered trainee items');
}

/**
 * Clear schedule fields without resetting the trainee selection
 */
function clearScheduleFields() {
  const startTimeInput = document.getElementById('schedule-start-time');
  const endTimeInput = document.getElementById('schedule-end-time');
  const overtimeCheckbox = document.getElementById('schedule-allows-overtime');
  const overtimeStartInput = document.getElementById('schedule-overtime-start');
  const overtimeEndInput = document.getElementById('schedule-overtime-end');
  const overtimeFields = document.getElementById('overtime-fields');

  if (startTimeInput) startTimeInput.value = '';
  if (endTimeInput) endTimeInput.value = '';
  if (overtimeCheckbox) overtimeCheckbox.checked = false;
  if (overtimeStartInput) overtimeStartInput.value = '';
  if (overtimeEndInput) overtimeEndInput.value = '';
  if (overtimeFields) overtimeFields.style.display = 'none';
}

/**
 * Load schedule for selected trainee
 */
async function loadTraineeSchedule() {
  const select = document.getElementById('schedule-trainee-select');
  const traineeId = select.value;

  console.log('[Schedule Manager] loadTraineeSchedule called. Selected traineeId:', traineeId);

  if (!traineeId) {
    console.log('[Schedule Manager] No trainee selected, resetting form');
    clearScheduleFields();
    document.getElementById('clear-schedule-btn').disabled = true;
    return;
  }

  try {
    console.log('[Schedule Manager] Fetching schedule for traineeId:', traineeId);
    const response = await fetchAPI(`/supervisor/schedule/${traineeId}`);

    if (!response || !response.success) {
      console.error('[Schedule Manager] Failed to load schedule:', response);
      showNotification('Error', 'Failed to load schedule', 'error');
      return;
    }

    const { schedule } = response.data;
    console.log('[Schedule Manager] Received schedule:', schedule);

    if (schedule && schedule.startTime) {
      // Populate form with existing schedule
      console.log('[Schedule Manager] Populating form with existing schedule');
      document.getElementById('schedule-start-time').value = schedule.startTime;
      document.getElementById('schedule-end-time').value = schedule.endTime;
      document.getElementById('schedule-allows-overtime').checked = schedule.allowsOvertime || false;
      
      if (schedule.allowsOvertime) {
        document.getElementById('overtime-fields').style.display = 'block';
        document.getElementById('schedule-overtime-start').value = schedule.overtimeStartTime || '';
        document.getElementById('schedule-overtime-end').value = schedule.overtimeEndTime || '';
      }
    } else {
      console.log('[Schedule Manager] No existing schedule, clearing form');
      clearScheduleFields();
    }

    document.getElementById('clear-schedule-btn').disabled = false;
  } catch (error) {
    console.error('[Schedule Manager] Error loading schedule:', error);
    showNotification('Error', 'Failed to load schedule', 'error');
  }
}

/**
 * Select trainee from list
 */
function selectTraineeForSchedule(traineeId) {
  console.log('[Schedule Manager] selectTraineeForSchedule called with:', traineeId);
  const select = document.getElementById('schedule-trainee-select');
  
  if (!select) {
    console.error('[Schedule Manager] schedule-trainee-select element not found!');
    return;
  }
  
  console.log('[Schedule Manager] Setting select value to:', traineeId);
  select.value = traineeId;
  
  // Trigger change event
  const event = new Event('change', { bubbles: true });
  select.dispatchEvent(event);
  console.log('[Schedule Manager] Dispatched change event, calling loadTraineeSchedule...');
  
  loadTraineeSchedule();
}

/**
 * Toggle overtime fields visibility
 */
function toggleOvertimeFields() {
  const checkbox = document.getElementById('schedule-allows-overtime');
  const fields = document.getElementById('overtime-fields');
  fields.style.display = checkbox.checked ? 'block' : 'none';
}

/**
 * Save trainee schedule
 */
async function saveTraineeSchedule(event) {
  event.preventDefault();

  const select = document.getElementById('schedule-trainee-select');
  const traineeId = select.value;

  if (!traineeId) {
    showNotification('Error', 'Please select a trainee', 'error');
    return;
  }

  const startTime = document.getElementById('schedule-start-time').value;
  const endTime = document.getElementById('schedule-end-time').value;
  const allowsOvertime = document.getElementById('schedule-allows-overtime').checked;
  const overtimeStartTime = document.getElementById('schedule-overtime-start').value;
  const overtimeEndTime = document.getElementById('schedule-overtime-end').value;

  if (!startTime || !endTime) {
    showNotification('Error', 'Start and end times are required', 'error');
    return;
  }

  if (allowsOvertime && (!overtimeStartTime || !overtimeEndTime)) {
    showNotification('Error', 'Overtime times are required when overtime is enabled', 'error');
    return;
  }

  try {
    const btn = event.target.querySelector('button[type="submit"]');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<svg width="18" height="18" class="animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 2A10 10 0 0 1 22 12"></path></svg> Saving...';

    const payload = {
      traineeId,
      startTime,
      endTime,
      allowsOvertime,
      overtimeStartTime: allowsOvertime ? overtimeStartTime : null,
      overtimeEndTime: allowsOvertime ? overtimeEndTime : null,
    };

    console.log('[Schedule Manager] Sending POST /supervisor/schedule/set with payload:', payload);
    console.log('[Schedule Manager] Auth Token present:', !!window.authToken);
    console.log('[Schedule Manager] Auth Token value:', window.authToken ? window.authToken.substring(0, 20) + '...' : 'MISSING');

    const response = await fetchAPI('/supervisor/schedule/set', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    console.log('[Schedule Manager] API Response:', response);

    btn.disabled = false;
    btn.innerHTML = originalText;

    if (!response || !response.success) {
      const errorMsg = response?.message || 'Failed to save schedule';
      console.error('[Schedule Manager] Error response:', errorMsg);
      showNotification('Error', errorMsg, 'error');
      return;
    }

    showNotification('Success', 'Schedule saved successfully', 'success');
    await loadScheduleTraineeList(); // Refresh list
  } catch (error) {
    console.error('[Schedule Manager] Exception error saving schedule:', error);
    showNotification('Error', 'Failed to save schedule: ' + error.message, 'error');
  }
}

/**
 * Clear trainee schedule
 */
function clearTraineeSchedule() {
  const select = document.getElementById('schedule-trainee-select');
  const traineeId = select.value;

  if (!traineeId) {
    showNotification('Error', 'Please select a trainee', 'error');
    return;
  }

  VerificationModal.open({
    type: 'confirm',
    title: 'Clear Trainee Schedule',
    description: 'All scheduled shifts for this trainee will be permanently removed.',
    warning: 'This cannot be undone.',
    confirmLabel: 'Clear Schedule',
    onConfirm: async () => {
      try {
        const response = await fetchAPI(`/supervisor/schedule/${traineeId}`, {
          method: 'DELETE',
        });

        if (!response || !response.success) {
          throw new Error(response?.message || 'Failed to clear schedule');
        }

        showNotification('Success', 'Schedule cleared successfully', 'success');
        clearScheduleFields();
        await loadScheduleTraineeList(); // Refresh list
      } catch (error) {
        console.error('[Schedule Manager] Error clearing schedule:', error);
        throw error;
      }
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// INITIALIZATION
// ────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Initialize theme from local storage
  initializeTheme();

  // Restore last active tab or default to overview
  const savedTab = localStorage.getItem('trackit_current_tab') || 'overview';
  switchTab(savedTab);

  // Load supervisor data and populate dashboard
  loadSupervisorData();
  startSupervisorRealtimeUpdates();

  // Notifications: fetch on load so the badge is correct before the bell is
  // ever clicked, then keep it fresh in the background.
  loadSupervisorNotifications({ silent: true });
  startNotificationPolling();

  // Load geofence settings for supervisor
  loadGeofenceSettings();

  // Set user name in navbar
  const name = window.currentUser?.fullName?.split(' ')[0] || 'Supervisor';
  document.getElementById('user-name').textContent = name;

  // Add active state to nav links
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
      link.classList.add('active');
    });
  });

  // Auto-load DTR data when month is changed
  const monthPicker = document.getElementById('dtr-month-picker');
  if (monthPicker) {
    // Set default month to current month/year
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    monthPicker.value = `${year}-${month}`;
    
    monthPicker.addEventListener('change', () => {
      loadDTRData();
    });
  }

  // Auto-load DTR data when trainee is selected
  const traineeSelect = document.getElementById('dtr-trainee-select');
  if (traineeSelect) {
    traineeSelect.addEventListener('change', () => {
      if (traineeSelect.value) {
        loadDTRData();
      }
    });
  }

  // Update signature preview on input changes
  ['sup-name'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', updateSignaturePreview);
    }
  });

  const signatureUpload = document.getElementById('sig-upload');
  if (signatureUpload) {
    signatureUpload.addEventListener('change', handleSignatureUpload);
  }

  loadSignaturePreview();

  // Performance Appraisal: reload context when the trainee or month changes
  const appraisalTraineeSelect = document.getElementById('appraisal-trainee-select');
  if (appraisalTraineeSelect) {
    appraisalTraineeSelect.addEventListener('change', () => loadAppraisalContext());
  }
  const appraisalMonthPicker = document.getElementById('appraisal-month-picker');
  if (appraisalMonthPicker) {
    // Default to the current month (mirrors the DTR picker).
    const now = new Date();
    appraisalMonthPicker.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    appraisalMonthPicker.addEventListener('change', () => loadAppraisalContext());
  }
  // Live subtotals/total preview as any criterion input changes
  const appraisalForm = document.getElementById('appraisal-form');
  if (appraisalForm) {
    appraisalForm.addEventListener('input', updateAppraisalTotals);
  }

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
});

// ────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ────────────────────────────────────────────────────────────────────────────

async function loadNotifications() {
  const container = document.getElementById('notifications-list');
  if (!container) return;

  try {
    const result = await fetchAPI('/stats/pending-actions');
    if (!result || !result.success) {
      container.innerHTML = '<p class="text-red-400 text-sm py-4">Failed to load notifications</p>';
      return;
    }

    const actions = result.data || [];
    if (actions.length === 0) {
      container.innerHTML = '<p class="text-slate-500 text-sm py-4">No recent notifications</p>';
      return;
    }

    window.supervisorNotifications = actions;
    renderNotifications(actions, 'all');
  } catch (error) {
    console.error('Error loading notifications:', error);
    container.innerHTML = '<p class="text-red-400 text-sm py-4">Error loading notifications</p>';
  }
}

function renderNotifications(actions, filterType) {
  const container = document.getElementById('notifications-list');
  if (!container) return;

  let filtered = actions;
  if (filterType === 'dtr') {
    filtered = actions.filter(a => a.type === 'dtr');
  } else if (filterType === 'journals') {
    filtered = actions.filter(a => a.type === 'journal');
  } else if (filterType === 'appraisals') {
    filtered = actions.filter(a => a.type === 'appraisal');
  }
  
  if (filtered.length === 0) {
    container.innerHTML = '<p class="text-slate-500 text-sm py-4">No notifications match this filter</p>';
    return;
  }

  container.innerHTML = filtered.map(action => {
    let icon, title, desc, timeDisplay;

    if (action.type === 'dtr') {
      icon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-iconsax="calendar"></svg>';
      title = 'DTR Submitted for Verification';
      desc = `${action.trainee} submitted DTR for ${action.date}`;
      
      const diffHrs = Math.floor((new Date() - new Date(action.timestamp)) / 3600000);
      timeDisplay = diffHrs > 24 ? Math.floor(diffHrs / 24) + ' days ago' : (diffHrs > 0 ? diffHrs + ' hours ago' : 'Recently');
    } else if (action.type === 'journal') {
      icon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-iconsax="note-text"></svg>';
      title = 'Journal Submitted';
      desc = `${action.trainee} submitted ${action.week} journal`;
      
      const diffHrs = Math.floor((new Date() - new Date(action.timestamp)) / 3600000);
      timeDisplay = diffHrs > 24 ? Math.floor(diffHrs / 24) + ' days ago' : (diffHrs > 0 ? diffHrs + ' hours ago' : 'Recently');
    }

    return `
      <div class="notification-item unread" data-type="${action.type}">
        <div class="notification-icon ${action.type}">
          ${icon}
        </div>
        <div class="flex-1">
          <p class="text-sm font-semibold text-white title-text">${title}</p>
          <p class="text-xs text-slate-400 desc-text">${desc}</p>
          <p class="text-xs text-slate-500 mt-1 time-text">${timeDisplay}</p>
        </div>
        <div class="unread-dot"></div>
      </div>
    `;
  }).join('');

}

function filterSupervisorNotifications(type) {
  const tabs = document.querySelectorAll('.filter-tab');
  tabs.forEach(tab => tab.classList.remove('active'));
  const activeTab = document.querySelector(`.filter-tab[onclick*="'${type}'"]`);
  if (activeTab) activeTab.classList.add('active');

  if (type === 'unread') {
    renderNotifications(window.supervisorNotifications || [], 'all');
  } else {
    renderNotifications(window.supervisorNotifications || [], type);
  }
}

function markAllNotificationsRead() {
  const items = document.querySelectorAll('.notification-item');
  items.forEach(item => {
    item.classList.remove('unread');
    const dot = item.querySelector('.unread-dot');
    if (dot) dot.remove();
  });
  showNotification('Notifications', 'All notifications marked as read', 'success');
}

// ────────────────────────────────────────────────────────────────────────────
// THEME MANAGEMENT
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
}

function applyTheme(theme) {
  const body = document.body;
  const themeIcon = document.getElementById('theme-icon');

  if (theme === 'light') {
    body.classList.add('light-mode');
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


/* ── Mobile stacked tables ──────────────────────────────────────────────────
   On phones, wide tables render as stacked label/value cards: thead hidden,
   each row becomes a bordered card and each cell shows its column name via a
   data-label pseudo-element. Labels are stamped from the thead here and
   re-stamped whenever a render replaces the rows, so no render code changes. */
(function initStackedTables() {
  const TARGETS = ['#dtr-table-body', '#appraisal-history-body'];

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
