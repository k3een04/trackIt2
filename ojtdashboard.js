const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port !== '5000' && window.location.port !== ''
  ? 'http://localhost:5000/api'
  : '/api';
let weeklyChartInstance = null; // Store chart instance for cleanup
let journalPhotoDataUrl = null;
let journalDownloadCache = [];
let selectedJournalIds = new Set();
const MAX_JOURNAL_DOWNLOAD = 3;
let journalTemplateCache = {};
let currentIdentifiedTheories = []; // Store AI-extracted theories

  const JOURNAL_PDF_LAYOUTS = {
  3: {
    week:     { x: 163, y: 185, size: 10 },
    date:     { x: 390, y: 183, size: 9  },
    coverage: { x: 390, y: 203, size: 9  },
    // Total verified DTR hours for selected journal week(s) — adjust x/y to match your template
    hoursSpent: { x: 165, y: 205, size: 9 },
    supervisorName: { x: 405, y: 687, size: 11 },
    supervisorSignature: { x: 278, y: 660, width: 200, height: 70 },
    rows: [
      {
        date:    { x: 75,  y: 276, size: 8 },
        photo:   { x: 155, y: 270, width: 145, height: 115 },
        summary: { x: 338, y: 284, size: 10, maxWidth: 195, lineHeight: 11, maxHeight: 112 },
      },
      {
        date:    { x: 75,  y: 404, size: 8 },
        photo:   { x: 155, y: 399, width: 145, height: 115 },
        summary: { x: 338, y: 410, size: 10, maxWidth: 195, lineHeight: 11, maxHeight: 112 },
      },
      {
        date:    { x: 75,  y: 531, size: 8 },
        photo:   { x: 155, y: 527, width: 145, height: 115 },
        summary: { x: 338, y: 538, size: 10, maxWidth: 195, lineHeight: 11, maxHeight: 112 },
      },
    ],
  },
  2: {
    // ↓ Tweak these x/y values to match your 2-row template's actual field positions
    week:     { x: 163, y: 185, size: 10 },
    date:     { x: 390, y: 183, size: 9  },
    coverage: { x: 390, y: 203, size: 9  },
    hoursSpent: { x: 165, y: 205, size: 10 },
    supervisorName: { x: 405, y: 687, size: 11 },
    supervisorSignature: { x: 278, y: 660, width: 200, height: 70 },
    rows: [
      {
        date:    { x: 77,  y: 278, size: 8 },
        photo:   { x: 155, y: 280, width: 165, height: 155 },
        summary: { x: 340, y: 290, size: 10, maxWidth: 195, lineHeight: 13, maxHeight: 152 },
      },
      {
        date:    { x: 77,  y: 462, size: 8 },
        photo:   { x: 155, y: 477, width: 165, height: 155 },
        summary: { x: 340, y: 480, size: 11, maxWidth: 195, lineHeight: 13, maxHeight: 152 },
      },
    ],
  },
};

// Keep the old name as a fallback so nothing else breaks
const JOURNAL_PDF_LAYOUT = JOURNAL_PDF_LAYOUTS[3];

/** For PDF "Week no." header: span earliest → latest week (e.g. "Week 1 - Week 3"). */
function parseJournalWeekNumber(weekStr) {
  if (weekStr == null || weekStr === '') return null;
  const m = String(weekStr).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * A draft the student is still writing. Returned-for-revision journals also
 * carry status 'draft' but keep their supervisor's note, so they stay visible
 * in Previous Journals and in the supervisor's Returned queue.
 */
function isPrivateDraft(journal) {
  return !!journal && journal.status === 'draft' && !journal.supervisorReview;
}

/**
 * Origin every week-based calculation counts from: the first supervisor
 * assignment (backend sends it as `supervisorAssignedAt`), falling back to
 * account creation until stats load or while no supervisor is assigned.
 */
function getOjtStartDate() {
  return (
    window.ojtStartDate ||
    window.studentRegistrationDate ||
    window.currentUser?.createdAt ||
    null
  );
}

function weekRangeLabelFromJournals(journals) {
  if (!journals || journals.length === 0) return '—';
  if (journals.length === 1) {
    const w = journals[0].week;
    return (w && String(w).trim()) || '—';
  }
  const enriched = journals.map((j) => ({
    label: (j.week && String(j.week).trim()) || '—',
    n: parseJournalWeekNumber(j.week),
    submittedAt: j.submittedAt,
  }));
  const sorted = [...enriched].sort((a, b) => {
    if (a.n != null && b.n != null) return a.n - b.n;
    if (a.n != null) return -1;
    if (b.n != null) return 1;
    return new Date(a.submittedAt) - new Date(b.submittedAt);
  });
  const first = sorted[0].label;
  const last = sorted[sorted.length - 1].label;
  if (first === last) return first;
  return `${first} - ${last}`;
}

/** OJT week index (Week 1 = first 7 days since the OJT start date), same logic as updateHoursByWeek */
function ojtWeekNumberFromDate(isoOrDate, registrationDate) {
  if (!isoOrDate || !registrationDate) return null;
  const date = new Date(isoOrDate);
  const reg = new Date(registrationDate);
  const daysSinceStart = Math.floor((date.getTime() - reg.getTime()) / (24 * 60 * 60 * 1000));
  const weekNum = Math.floor(daysSinceStart / 7) + 1;
  return weekNum >= 1 ? weekNum : null;
}

function buildVerifiedHoursByOjtWeek(dtrRecords, registrationDate) {
  const reg = new Date(registrationDate);
  const map = {};
  (dtrRecords || []).forEach((record) => {
    if (!record.verifiedBySupervisor) return;
    const date = new Date(record.date);
    const daysSinceStart = Math.floor((date.getTime() - reg.getTime()) / (24 * 60 * 60 * 1000));
    const weekNum = Math.floor(daysSinceStart / 7) + 1;
    if (weekNum < 1) return;
    map[weekNum] = (map[weekNum] || 0) + (record.hoursRendered || 0);
  });
  return map;
}

/**
 * Length of the OJT programme in weeks. Mirrors TOTAL_OJT_WEEKS in
 * backend/routes/stats.js, which is what the missing-journal check uses, so
 * the KPI card and the coordinator's expectations agree on one number.
 */
const OV_OJT_TOTAL_WEEKS = 17;

/** Mon-Fri span of the week containing `date`, e.g. "Oct 5 – Oct 9". */
function ovWeekRangeLabel(date = new Date()) {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
  const friday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 4);
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(monday)} – ${fmt(friday)}`;
}

function ojtWeekNumbersFromJournals(journals, registrationDate) {
  const reg = registrationDate ? new Date(registrationDate) : null;
  const nums = (journals || []).map((j) => {
    const parsed = parseJournalWeekNumber(j.week);
    if (parsed != null) return parsed;
    return reg ? ojtWeekNumberFromDate(j.submittedAt, reg) : null;
  }).filter((n) => n != null && n >= 1);
  return nums;
}

function sumVerifiedHoursForOjtWeeks(weekHoursMap, weekNumbers) {
  const unique = [...new Set(weekNumbers)];
  let sum = 0;
  unique.forEach((w) => { sum += weekHoursMap[w] || 0; });
  return Math.round(sum * 10) / 10;
}

async function fetchAllDtrRecords(traineeId, startIso, endIso) {
  const all = [];
  let page = 1;
  const limit = 500;
  while (true) {
    const url = `${API_BASE}/qr/dtr/${traineeId}?startDate=${encodeURIComponent(startIso)}&endDate=${encodeURIComponent(endIso)}&limit=${limit}&page=${page}`;
    const response = await fetch(url, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('DTR fetch failed');
    const payload = await response.json();
    const batch = payload.data || [];
    all.push(...batch);
    const pages = payload.pagination?.pages;
    const totalPages = typeof pages === 'number' && pages > 0 ? pages : 1;
    if (page >= totalPages || batch.length === 0 || batch.length < limit) break;
    page += 1;
  }
  return all;
}

/** Sum verified DTR hours for each distinct OJT week covered by the selected journals */
async function fetchTotalVerifiedHoursForJournalSelection(journals) {
  const traineeId = window.currentUser?._id;
  const registrationDate = getOjtStartDate();
  if (!traineeId || !registrationDate || !journals || journals.length === 0) return null;
  const reg = new Date(registrationDate);
  const endDate = new Date();
  const weekNums = ojtWeekNumbersFromJournals(journals, reg);
  if (weekNums.length === 0) return null;
  try {
    const records = await fetchAllDtrRecords(traineeId, reg.toISOString(), endDate.toISOString());
    const weekMap = buildVerifiedHoursByOjtWeek(records, reg);
    return sumVerifiedHoursForOjtWeeks(weekMap, weekNums);
  } catch (e) {
    console.error('fetchTotalVerifiedHoursForJournalSelection:', e);
    return null;
  }
}

function wrapTextByWidth(text, maxWidth, ctx) {
  if (!text) return [''];
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fitSummaryText(text, maxWidth, maxHeight, baseFontSize, lineHeight, fontFamily) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const MEASURE_SAFETY = 0.89;
  const measureWidth = maxWidth * MEASURE_SAFETY;
  const effectiveMaxHeight = maxHeight * 0.82; // ← tightened from 0.82

  let fontSize = baseFontSize;
  let lines = [];
  let currentLineHeight = lineHeight;
  const minFontSize = 6;

  while (fontSize >= minFontSize) {
    ctx.font = `${fontSize}px ${fontFamily}`;
    currentLineHeight = lineHeight * (fontSize / baseFontSize);
    lines = wrapTextByWidth(text, measureWidth, ctx);
    if (lines.length * currentLineHeight <= effectiveMaxHeight) break;
    fontSize -= 0.7;
  }

  const maxLines = Math.floor(effectiveMaxHeight / currentLineHeight);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    const ctx2 = document.createElement('canvas').getContext('2d');
    ctx2.font = `${fontSize}px ${fontFamily}`;
    let last = lines[lines.length - 1].trimEnd();
    while (last.length > 0 && ctx2.measureText(last + '…').width > measureWidth) {
      last = last.slice(0, -1).trimEnd();
    }
    lines[lines.length - 1] = last + '…';
  }

  return { text: lines.join('\n'), fontSize, lineHeight: currentLineHeight };
}

/**
 * Setup auto-refresh polling for DTR changes
 * Checks every 5 seconds if a new time in/out has been recorded
 */
let dtrPollInterval = null;
let lastDTRState = null;

function startDTRPolling() {
  // Clear any existing interval
  if (dtrPollInterval) clearInterval(dtrPollInterval);

  // Start polling every 5 seconds
  dtrPollInterval = setInterval(async () => {
    try {
      // Fetch today's DTR records
      const today = new Date();
      const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

      const dtrUrl = `${API_BASE}/qr/dtr/${window.currentUser._id}?startDate=${startOfToday.toISOString()}&endDate=${endOfToday.toISOString()}&limit=10`;
      
      const response = await fetch(dtrUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${window.authToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) return;

      const result = await response.json();
      if (!result.success || !result.data) return;

      const currentDTRRecords = result.data;
      
      // If this is first check, just store the current state and return
      if (lastDTRState === null) {
        lastDTRState = JSON.stringify(currentDTRRecords.map(r => ({
          id: r._id,
          timeIn: r.timeIn,
          timeOut: r.timeOut,
        })));
        return;
      }

      // Compare current state with previous state
      const currentState = JSON.stringify(currentDTRRecords.map(r => ({
        id: r._id,
        timeIn: r.timeIn,
        timeOut: r.timeOut,
      })));

      if (currentState !== lastDTRState) {
        // DTR data has changed! Detect what changed
        const prevRecords = JSON.parse(lastDTRState);
        let changeDetected = false;

        // Check for new records
        if (currentDTRRecords.length > prevRecords.length) {
          changeDetected = true;
          console.log('✅ New DTR record detected!');
        }

        // Check for timeOut additions
        if (!changeDetected) {
          for (let i = 0; i < currentDTRRecords.length; i++) {
            const currentRecord = currentDTRRecords[i];
            const prevRecord = prevRecords.find(r => r.id === currentRecord._id);
            
            if (prevRecord && !prevRecord.timeOut && currentRecord.timeOut) {
              changeDetected = true;
              console.log('✅ Time Out detected!');
              break;
            }
          }
        }

        if (changeDetected) {
          // Show notification and refresh
          showNotification('✅ Attendance Recorded', 'Your time in/out has been recorded. Refreshing page...', 'success');

          // Refresh after showing notification
          setTimeout(() => {
            window.location.reload();
          }, 2000);
        }

        // Update state
        lastDTRState = currentState;
      }
    } catch (error) {
      console.error('Error in DTR polling:', error);
    }
  }, 5000);
}

/**
 * Show notification to user
 */
function showNotification(title, message, type = 'info') {
  // Create notification container if it doesn't exist
  let notificationContainer = document.getElementById('notification-container');
  if (!notificationContainer) {
    notificationContainer = document.createElement('div');
    notificationContainer.id = 'notification-container';
    notificationContainer.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999; max-width: 400px;';
    document.body.appendChild(notificationContainer);
  }

  const notificationEl = document.createElement('div');
  const bgColor = type === 'success' ? 'rgba(0, 200, 170, 0.1)' : type === 'error' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(59, 130, 246, 0.1)';
  const borderColor = type === 'success' ? 'rgba(0, 200, 170, 0.3)' : type === 'error' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(59, 130, 246, 0.3)';
  const textColor = type === 'success' ? '#00c8aa' : type === 'error' ? '#ef4444' : '#3b82f6';
  const messageColor = document.body.classList.contains('light-mode') ? '#1e293b' : '#cbd5e1';

  notificationEl.style.cssText = `
    background: ${bgColor};
    border: 1px solid ${borderColor};
    color: ${textColor};
    padding: 16px;
    border-radius: 8px;
    margin-bottom: 10px;
    animation: slideIn 0.3s ease-out;
  `;

  notificationEl.innerHTML = `
    <p style="margin: 0; font-weight: 600; font-size: 14px; color: ${textColor};">${title}</p>
    <p style="margin: 5px 0 0 0; font-size: 12px; color: ${messageColor};">${message}</p>
  `;

  notificationContainer.appendChild(notificationEl);

  // Auto-remove after 5 seconds
  setTimeout(() => {
    notificationEl.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => notificationEl.remove(), 300);
  }, 5000);
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

let ojtNotifications = [];
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
    loadOJTNotifications();
  }
}

function closeNotifications() {
  const popup = document.getElementById('notif-popup');
  if (popup) popup.style.display = 'none';
  notifPopupOpen = false;
}

/** "Mark all read" - marks every notification read on the server. */
async function clearAllNotifications() {
  if (ojtNotifications.length === 0) return;
  try {
    await fetchAPI('/notifications/read-all', { method: 'PATCH' });
  } catch (error) {
    console.error('Error marking all notifications read:', error);
  }
  ojtNotifications = ojtNotifications.map(n => ({ ...n, unread: false, read: true }));
  notifUnreadCount = 0;
  renderNotificationList();
  updateNotifBadge();
}

/** Dismisses one notification: persisted as read, then hidden locally. */
async function dismissNotification(id) {
  const target = ojtNotifications.find(n => n.id === id);
  if (target && target.unread) {
    try {
      await fetchAPI(`/notifications/${id}/read`, { method: 'PATCH' });
    } catch (error) {
      console.error('Error marking notification read:', error);
    }
    notifUnreadCount = Math.max(0, notifUnreadCount - 1);
  }
  ojtNotifications = ojtNotifications.filter(n => n.id !== id);
  renderNotificationList();
  updateNotifBadge();
}

/** "Clear all" - permanently deletes every notification for this user. */
async function deleteAllNotifications() {
  if (ojtNotifications.length === 0) return;
  if (!confirm('Clear all notifications? This cannot be undone.')) return;
  try {
    await fetchAPI('/notifications', { method: 'DELETE' });
  } catch (error) {
    console.error('Error clearing notifications:', error);
  }
  ojtNotifications = [];
  notifUnreadCount = 0;
  renderNotificationList();
  updateNotifBadge();
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
 * Loads the notifications that belong to the logged-in student.
 * The backend scopes every query to the JWT user id, so a student can never see
 * a coordinator's notification.
 */
async function loadOJTNotifications(options = {}) {
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
      ojtNotifications = result.data || [];
      notifUnreadCount = Number(result.unreadCount) || 0;
      notifError = '';
    } else {
      notifError = (result && result.message) || 'Could not load notifications';
      ojtNotifications = [];
      notifUnreadCount = 0;
    }
  } catch (error) {
    console.error('Error loading notifications:', error);
    notifError = 'Could not load notifications';
    ojtNotifications = [];
    notifUnreadCount = 0;
  } finally {
    notifLoading = false;
    renderNotificationList();
    updateNotifBadge();
  }
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
        <button onclick="loadOJTNotifications()" class="text-xs text-teal-400 hover:underline mt-2">Retry</button>
      </div>`;
    return;
  }
  
  if (ojtNotifications.length === 0) {
    list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
    return;
  }
  
  list.innerHTML = ojtNotifications.map(n => `
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
      const notif = ojtNotifications.find(n => n.id === id);
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

/** Polls the bell every minute and refetches when the tab regains focus. */
function startNotificationPolling() {
  if (notifPollTimer) clearInterval(notifPollTimer);
  notifPollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      loadOJTNotifications({ silent: true });
    }
  }, 60000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadOJTNotifications({ silent: true });
    }
  });
}

function getNotifIcon(type) {
  const icons = {
    journal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
    attendance: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
    dtr: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>',
    system: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
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

// Add CSS animations for notifications
const style = document.createElement('style');
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
  const htmlElement = document.documentElement;
  const body = document.body;
  const themeToggleBtn = document.getElementById('theme-toggle');
  const currentTheme = body.classList.contains('light-mode') ? 'light' : 'dark';
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  
  // Add rotation animation
  if (themeToggleBtn) {
    themeToggleBtn.classList.add('rotating');
    setTimeout(() => {
      themeToggleBtn.classList.remove('rotating');
    }, 400);
  }
  
  applyTheme(newTheme);
  localStorage.setItem('trackit_theme', newTheme);
  updateChartTheme(newTheme === 'light');
  // Update toggle button class for immediate color transition
  if (themeToggleBtn) {
    if (newTheme === 'light') themeToggleBtn.classList.add('light-mode');
    else themeToggleBtn.classList.remove('light-mode');
  }
}

function updateChartTheme(isLightMode) {
  // Prefer the shared design system: it re-derives every theme-dependent colour
  // (grid, ticks, axes, legend, tooltip, value captions) from the live CSS
  // variables and repaints each registered bar chart without animating.
  if (window.TrackITCharts && typeof window.TrackITCharts.refreshAll === 'function') {
    window.TrackITCharts.refreshAll();
    return;
  }
  if (!weeklyChartInstance || !weeklyChartInstance.options || !weeklyChartInstance.options.scales) return;

  const ticksColor = isLightMode ? 'rgba(30, 41, 59, 0.6)' : 'rgba(203, 213, 225, 0.6)';
  const gridColor = isLightMode ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.05)';

  if (weeklyChartInstance.options.scales.y) {
    if (weeklyChartInstance.options.scales.y.ticks) weeklyChartInstance.options.scales.y.ticks.color = ticksColor;
    if (weeklyChartInstance.options.scales.y.grid) weeklyChartInstance.options.scales.y.grid.color = gridColor;
  }
  if (weeklyChartInstance.options.scales.x && weeklyChartInstance.options.scales.x.ticks) {
    weeklyChartInstance.options.scales.x.ticks.color = ticksColor;
  }

  weeklyChartInstance.update();
}

function applyTheme(theme) {
  const body = document.body;
  const themeIcon = document.getElementById('theme-icon');
  
  if (theme === 'light') {
    body.classList.add('light-mode');
    // Fade icons: show moon, hide sun
    if (themeIcon) {
      const moonIcon = themeIcon.querySelector('.moon-icon');
      const sunIcons = themeIcon.querySelectorAll('.sun-icon');
      if (moonIcon) {
        moonIcon.style.display = 'block';
        // ensure starting from 0 if previously hidden
        moonIcon.style.opacity = '0';
        requestAnimationFrame(() => { moonIcon.style.opacity = '1'; });
      }
      sunIcons.forEach(icon => {
        icon.style.opacity = '0';
        // remove from flow after transition completes
        setTimeout(() => { icon.style.display = 'none'; }, 250);
      });
    }
  } else {
    body.classList.remove('light-mode');
    // Fade icons: show sun, hide moon
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

// Initialize theme on page load
document.addEventListener('DOMContentLoaded', initializeTheme);


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
      // Unauthorized - clear auth and redirect
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

// ────────────────────────────────────────────────────────────────────────────
// LOAD DASHBOARD DATA FROM MONGODB
// ────────────────────────────────────────────────────────────────────────────

async function loadDashboardData() {
  // Update profile info from stored user
  if (window.currentUser) {
    const profileNameEl = document.getElementById('profile-name');
    if (profileNameEl) profileNameEl.value = window.currentUser.fullName || '';
    
    const profileIdEl = document.getElementById('profile-id');
    if (profileIdEl) profileIdEl.value = window.currentUser.studentId || '';

    const profileEmailEl = document.getElementById('profile-email');
    if (profileEmailEl) profileEmailEl.value = window.currentUser.email || '';

    const profileDeptEl = document.getElementById('profile-dept');
    if (profileDeptEl) profileDeptEl.value = window.currentUser.department || '';

    const profileCompanyEl = document.getElementById('profile-company');
    if (profileCompanyEl) profileCompanyEl.value = window.currentUser.companyName || '';
  }

  // Fetch real student data from MongoDB
  const result = await fetchAPI('/stats/student');
  if (!result || !result.success) {
    console.error('Failed to load student stats:', result);
    return;
  }

  const { student, stats } = result.data;

  if (student?.supervisor) {
    window.currentUser = { ...window.currentUser, supervisor: student.supervisor };
  }
  if (student?.createdAt) {
    window.studentRegistrationDate = student.createdAt;
  }
  // Week 1 of the OJT starts at the first supervisor assignment. Until one is
  // assigned (supervisorAssignedAt is null) charts fall back to account
  // creation and the journal tab blocks submission.
  window.ojtStartDate = student?.supervisorAssignedAt || student?.createdAt || null;
  window.studentHasSupervisor = !!student?.supervisorAssignedAt;

  // DEBUG: Log the student data to see what's being returned

  // ── Overview tab (redesigned) ──────────────────────────────────────────
  renderOverviewKpis(stats, student);
  loadOverviewToday().catch(err => console.error('Error loading today overview:', err));
  loadOverviewCalendar().catch(err => console.error('Error loading attendance calendar:', err));
  loadOverviewJournal().catch(err => console.error('Error loading journal overview:', err));
  loadOverviewDtrData().catch(err => console.error('Error loading DTR data:', err));

  // ── My Progress tab (unchanged) ────────────────────────────────────────
  const progressTabCircle = document.querySelector('#progress .progress-circle');
  const progressTabValue = document.querySelector('#progress .progress-value');
  const progressTabText = document.querySelector('#progress .progress-circle + p');
  if (progressTabCircle) progressTabCircle.style.setProperty('--progress', `${stats.progressPercentage}%`);
  if (progressTabValue) progressTabValue.textContent = `${stats.progressPercentage}%`;
  if (progressTabText) progressTabText.textContent = `${stats.completedHours} of ${stats.totalRequired} hours`;

  // Update remaining hours in progress tab
  const remainingEl = document.querySelector('#progress .text-4xl.font-display');
  if (remainingEl) remainingEl.textContent = stats.remainingHours;

  // Update company info in progress tab using specific IDs
  const companyNameEl = document.getElementById('progress-company-name');
  if (companyNameEl) {
    // Try student's companyName first, then supervisor's companyName
    const companyName = student.companyName || student.supervisor?.companyName || student.company?.name || 'Not assigned';
    companyNameEl.textContent = companyName;
  }

  // Update supervisor name
  const supervisorNameEl = document.getElementById('progress-supervisor-name');
  if (supervisorNameEl) {
    const supervisorName = student.supervisor?.fullName || 'Not assigned';
    supervisorNameEl.textContent = supervisorName;
  }

  // Update position from supervisor's company position
  const positionEl = document.getElementById('progress-position');
  if (positionEl) {
    const position = student.supervisor?.companyPosition || 'Not assigned';
    positionEl.textContent = position;
  }

  // Update settings account summary
  const settingSupervisor = document.getElementById('account-supervisor');
  if (settingSupervisor) settingSupervisor.textContent = student.supervisor?.fullName || 'Not assigned';

  // Update member since
  const memberSinceEl = document.getElementById('account-member-since');
  if (memberSinceEl) {
    memberSinceEl.textContent = new Date(student.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Update estimated completion date
  updateEstimatedCompletion(stats, student);
}

// ============================================================================
// OVERVIEW TAB — REDESIGNED
// ----------------------------------------------------------------------------
// Every number rendered here comes from the live APIs:
//   · /api/stats/student      → verified all-time hours, month days present,
//                               required hours, pending journal count
//   · /api/qr/dtr/:traineeId  → today's record + verified records per week
//   · /api/journal/my-journals→ this week's journal and its review state
//
// Nothing is fabricated: when a series has no verified data yet the card shows
// an explicit empty state instead of a zero that looks like real attendance.
// The Overview uses `ov-` prefixed ids throughout because `today-time-in`,
// `today-hours` and friends already belong to the DTR tab.
// ============================================================================

function ovText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function ovFormatTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function ovFormatHours(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return '0h 00m';
  const whole = Math.floor(n);
  const minutes = Math.round((n - whole) * 60);
  return `${whole}h ${String(minutes).padStart(2, '0')}m`;
}

/**
 * Local calendar day as a sortable key, zero-padded so it matches ovMonthKey's
 * shape. Local rather than UTC deliberately: an attendance day is the trainee's
 * own day, and the rest of the dashboard already buckets DTR records on local
 * time (updateMonthlyStats uses toDateString). Every call site both builds and
 * looks up keys through here, so the padding is purely for consistency.
 */
function ovDateKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

// ── KPIs ────────────────────────────────────────────────────────────────────

/**
 * Time-aware greeting plus the current date, both from the real clock and the
 * signed-in trainee. Falls back to a neutral line rather than inventing a name
 * when the profile has not loaded yet.
 */
function renderOverviewHeader(student) {
  const now = new Date();

  const hour = now.getHours();
  const partOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

  const fullName = (student && student.fullName) || window.currentUser?.fullName || '';
  const firstName = String(fullName).trim().split(' ')[0] || '';

  const welcome = document.getElementById('ov-welcome');
  if (welcome) {
    welcome.textContent = firstName
      ? `Good ${partOfDay}, ${firstName}. Here's your OJT activity at a glance.`
      : `Here's your OJT activity at a glance.`;
  }

  const dateEl = document.getElementById('ov-header-date');
  if (dateEl) {
    dateEl.textContent = now.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
  }

  // The greeting can go stale if the dashboard is left open across noon or
  // midnight, so it is cheap to keep honest on the existing clock tick.
}

/**
 * Fills the two top KPI cards from the /stats/student payload.
 *
 * Overall Progress is the single home for OJT completion: hours, percentage,
 * programme week, date range and streak live in one card so the same figure is
 * never restated beside itself, and Days Present keeps the attendance count it
 * has always owned.
 */
function renderOverviewKpis(stats, student) {
  const completed = Number(stats.completedHours) || 0;
  const required = Number(stats.totalRequired) || 486;
  const remaining = Number(stats.remainingHours) ?? Math.max(0, required - completed);
  const days = Number(stats.daysPresent) || 0;
  const pct = Math.max(0, Math.min(100, Number(stats.progressPercentage) ?? Math.round((completed / required) * 100)));

  ovText('ov-kpi-hours', completed % 1 === 0 ? String(completed) : completed.toFixed(1));
  ovText('ov-kpi-hours-required', `/ ${required} hrs`);
  ovText('ov-kpi-pct', `${pct}%`);
  ovText('ov-kpi-estimate', completed > 0 ? `${remaining} hrs remaining` : 'Clock in to start tracking');

  // Ring: teal arc on a quiet track, animated from zero on first paint and
  // frozen outright when the visitor prefers reduced motion.
  const ring = document.getElementById('ov-progress-ring');
  const ringFill = document.getElementById('ov-progress-fill');
  if (ring) ring.setAttribute('aria-label', `OJT progress: ${pct}% of ${required} hours completed`);
  if (ringFill) {
    const circumference = 2 * Math.PI * 52;
    ringFill.style.strokeDasharray = String(circumference);
    ringFill.style.strokeDashoffset = String(circumference * (1 - pct / 100));
  }

  ovText('ov-kpi-days', String(days));
  const daysNote = document.getElementById('ov-kpi-days-note');
  if (daysNote) {
    daysNote.textContent = days === 0 ? 'Your attendance will appear here after your first time-in.' : 'This month';
  }

  // Week 1 is the first supervisor placement, so the card only has a number to
  // show once the trainee has actually been assigned. The streak needs the DTR
  // records and is filled in by loadOverviewDtrData once they arrive.
  const assignedAt = student?.supervisorAssignedAt || null;
  const weekNumber = assignedAt ? ojtWeekNumberFromDate(new Date(), assignedAt) : null;
  ovText('ov-kpi-week', weekNumber ? `Week ${weekNumber}` : 'Not started');
  ovText('ov-kpi-week-total', weekNumber ? `of ${OV_OJT_TOTAL_WEEKS}` : '');
  ovText('ov-kpi-week-range', weekNumber ? ovWeekRangeLabel() : 'Awaiting supervisor assignment');
  ovText('ov-kpi-streak', '—');

  renderOverviewHeader(student);
}

/**
 * Secondary line on the Days Present card.
 *
 * Derived from real records rather than invented: verified days with hours over
 * the days elapsed so far this month. It deliberately counts only VERIFIED
 * days so it agrees with the Days Present figure the backend supplies and with
 * Completed Hours, which is also verified-only. Shown as "—" when the month has
 * no verified records yet, so a brand-new trainee never sees a misleading 0%.
 *
 * @param {Array} records - DTR records for the displayed month
 * @param {boolean} isCurrentMonth - only the current month's data may set this
 */
function renderAttendanceRate(records, isCurrentMonth) {
  const el = document.getElementById('ov-kpi-attendance');
  if (!el) return;

  // Navigating to another month must not overwrite a figure that describes
  // this month, so a non-current view leaves the existing value alone.
  if (!isCurrentMonth) return;

  const now = new Date();
  const daysElapsed = now.getDate();
  const present = new Set();
  let verifiedRecords = 0;

  (records || []).forEach(record => {
    if (!record.verifiedBySupervisor) return;
    const d = new Date(record.date);
    if (d.getMonth() !== now.getMonth() || d.getFullYear() !== now.getFullYear()) return;
    verifiedRecords += 1;
    if (Number(record.hoursRendered) > 0 && String(record.status || '').toLowerCase() !== 'absent') {
      present.add(ovDateKey(record.date));
    }
  });

  if (verifiedRecords === 0) {
    el.textContent = '—';
    el.title = 'No verified attendance records yet this month';
    return;
  }

  const rate = Math.min(100, Math.round((present.size / daysElapsed) * 100));
  el.textContent = `${rate}% rate`;
  el.title = `${present.size} verified day${present.size === 1 ? '' : 's'} of ${daysElapsed} elapsed this month`;
}

// ── Today's OJT ─────────────────────────────────────────────────────────────

/**
 * Reads today's DTR record and the supervisor-set schedule. The Time In action
 * itself is NOT duplicated here: a real punch is gated on the supervisor's
 * schedule window *and* geofence validation, both of which live in the DTR tab,
 * so the card deep-links there instead of re-implementing that gating.
 */
async function loadOverviewToday() {
  const stateEl = document.getElementById('ov-today-state');
  const badge = document.getElementById('ov-today-badge');
  const message = document.getElementById('ov-today-message');
  const cta = document.getElementById('ov-today-cta');
  const clockOutBtn = document.getElementById('ov-today-clockout');
  const lateEl = document.getElementById('ov-today-late');

  const dateEl = document.getElementById('ov-today-date');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
    });
  }

  if (!window.currentUser?._id) {
    if (stateEl) stateEl.dataset.state = 'not-started';
    if (badge) badge.textContent = 'Unavailable';
    if (message) message.textContent = 'Sign in to see today’s attendance.';
    if (cta) cta.classList.add('hidden');
    if (clockOutBtn) clockOutBtn.classList.add('hidden');
    return;
  }

  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

  try {
    const [dtrResult, schedule] = await Promise.all([
      fetchAPI(`/qr/dtr/${window.currentUser._id}?startDate=${startOfToday.toISOString()}&endDate=${endOfToday.toISOString()}&limit=5`),
      fetchOverviewSchedule(),
    ]);

    const record = Array.isArray(dtrResult?.data) ? dtrResult.data[0] : null;

    renderOverviewSchedule(schedule);

    ovText('ov-today-in', record?.timeIn ? ovFormatTime(record.timeIn) : '—');
    ovText('ov-today-out', record?.timeOut ? ovFormatTime(record.timeOut) : '—');

    // Late duration
    if (lateEl) {
      if (record && record.timeIn && schedule?.startTime) {
        const lateMs = computeLateDurationMs(record.timeIn, schedule.startTime);
        if (lateMs > 120000) {
          lateEl.textContent = `Late by ${formatLateDuration(lateMs)}`;
          lateEl.hidden = false;
        } else {
          lateEl.hidden = true;
        }
      } else {
        lateEl.hidden = true;
      }
    }

    // Live timer or final hours
    if (record && record.timeIn && !record.timeOut) {
      startOverviewTimer(record.timeIn);
      if (clockOutBtn) clockOutBtn.classList.remove('hidden');
    } else {
      stopOverviewTimer();
      const hoursEl = document.getElementById('ov-today-hours');
      if (hoursEl) hoursEl.textContent = ovFormatHours(record?.hoursRendered);
      if (clockOutBtn) clockOutBtn.classList.add('hidden');
    }

    const isLate = record && String(record.status || '').toLowerCase() === 'late';
    let state = 'not-started';
    let label = 'Not Timed In';
    let text = 'You haven’t timed in yet.';

    if (record && record.timeIn && record.timeOut) {
      state = isLate ? 'late' : 'completed';
      label = isLate ? 'Completed · Late' : 'Completed';
      text = isLate
        ? 'You timed in after the scheduled start.'
        : 'Today’s time in and time out are both recorded.';
    } else if (record && record.timeIn) {
      state = isLate ? 'late' : 'ongoing';
      label = isLate ? 'Ongoing · Late' : 'Ongoing';
      text = isLate
        ? 'You are clocked in. Your time in was after the scheduled start.'
        : 'You are clocked in. Remember to time out before you leave.';
    }

    if (stateEl) stateEl.dataset.state = state;
    if (badge) badge.textContent = label;
    if (message) message.textContent = text;

    // Only offer the hand-off when there is still something to do today.
    if (cta) cta.classList.toggle('hidden', !record || Boolean(record.timeOut));
  } catch (error) {
    console.error('Error loading today overview:', error);
    if (stateEl) stateEl.dataset.state = 'not-started';
    if (badge) badge.textContent = 'Unavailable';
    if (message) message.textContent = 'Could not load today’s record.';
    if (cta) cta.classList.add('hidden');
    if (clockOutBtn) clockOutBtn.classList.add('hidden');
    if (lateEl) lateEl.hidden = true;
  }
}

// ── Live OJT timer ─────────────────────────────────────────────────────────

let ovTimerInterval = null;

function startOverviewTimer(timeInIso) {
  // Avoid stacking intervals when the overview refreshes repeatedly.
  if (ovTimerInterval) clearInterval(ovTimerInterval);
  const timeIn = new Date(timeInIso).getTime();
  const hoursEl = document.getElementById('ov-today-hours');
  if (!hoursEl || Number.isNaN(timeIn)) return;

  const tick = () => {
    const elapsed = Date.now() - timeIn;
    const h = Math.floor(elapsed / 3600000);
    const m = Math.floor((elapsed % 3600000) / 60000);
    const s = Math.floor((elapsed % 60000) / 1000);
    hoursEl.textContent = `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  };
  tick();
  ovTimerInterval = setInterval(tick, 1000);
}

function stopOverviewTimer() {
  if (ovTimerInterval) {
    clearInterval(ovTimerInterval);
    ovTimerInterval = null;
  }
}

// Clean up the timer when the user navigates away from the overview tab.
window.addEventListener('beforeunload', stopOverviewTimer);

// Called by the Clock Out button on the Overview card.
async function handleOverviewClockOut() {
  if (!currentCoordinates) {
    showNotification('Error', 'Unable to get your location', 'error');
    return;
  }
  try {
    const companyId = await getUserCompanyId();
    if (!companyId) {
      showNotification('Error', 'Company not assigned', 'error');
      return;
    }
    const response = await fetchAPI('/geofence/time-out', {
      method: 'POST',
      body: JSON.stringify({
        companyId,
        coordinates: currentCoordinates,
        timezoneOffsetMinutes: getClientTimezoneOffsetMinutes(),
      }),
    });
    if (!response || !response.success) {
      showNotification('Error', response?.message || 'Failed to record time out', 'error');
      return;
    }
    showNotification('Success', '✓ Time Out Recorded', 'success');
    await loadDTRRecords();
    await loadOverviewToday();
  } catch (error) {
    showNotification('Error', error.message || 'Error recording time out', 'error');
  }
}

/**
 * Milliseconds late from scheduled start, or 0 when on time.
 */
function computeLateDurationMs(timeInIso, scheduleStartHHmm) {
  const timeIn = new Date(timeInIso);
  if (Number.isNaN(timeIn.getTime())) return 0;
  const match = String(scheduleStartHHmm || '').match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return 0;
  const scheduled = new Date(timeIn);
  scheduled.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return Math.max(0, timeIn.getTime() - scheduled.getTime());
}

function formatLateDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * The supervisor's schedule window. Read from today-status, which publishes the
 * trainee's schedule without asking for a location; /geofence/validate cannot be
 * reused here because it rejects a request with no coordinates.
 */
async function fetchOverviewSchedule() {
  const cached = window.supervisorScheduleTimes;
  if (cached && (cached.startTime || cached.endTime)) return cached;
  if (!window.currentUser?._id) return null;

  try {
    const result = await fetchAPI('/geofence/today-status');
    const schedule = result?.data?.schedule;
    if (schedule && (schedule.startTime || schedule.endTime)) {
      window.supervisorScheduleTimes = schedule;
      return schedule;
    }
  } catch (error) {
    console.error('Error loading schedule for overview:', error);
  }
  return null;
}

function renderOverviewSchedule(schedule) {
  const el = document.getElementById('ov-today-schedule');
  if (!el) return;
  if (!schedule || (!schedule.startTime && !schedule.endTime)) {
    el.textContent = 'Not set';
    return;
  }
  const start = formatScheduleTime(schedule.startTime);
  const end = formatScheduleTime(schedule.endTime);
  el.textContent = start && end ? `${start} – ${end}` : (start || end);
}

// ============================================================================
// ATTENDANCE CALENDAR
// ----------------------------------------------------------------------------
// A compact month grid over real DTR records.
//
// Two deliberate choices, both agreed with the user:
//
//  1. It renders EVERY DTR record, not just supervisor-verified ones, with an
//     unverified marker so the two are distinguishable. Completed Hours stays
//     verified-only (that is what the backend counts), so a hollow dot is how a
//     trainee sees "recorded, not yet counted". The card carries a footnote to
//     say so rather than letting the two silently disagree.
//
//  2. Day detail expands inline on tap instead of on hover. Hover is
//     unavailable on touch, and an inline panel cannot be clipped by a card
//     edge the way an absolutely-positioned popover can.
//
// Month navigation is supported because /api/qr/dtr/:traineeId already accepts
// an arbitrary startDate/endDate window. Statuses come from the DTR schema's
// own enum (present, late, absent, excused) - nothing is invented.
// ============================================================================

// Month currently on screen, as a Date pinned to the 1st so the grid maths is
// stable. Null until the first load.
let ovCalMonth = null;

// DTR records for the displayed month, keyed by local date string.
let ovCalRecords = new Map();

// The day whose detail is expanded, or null.
let ovCalSelected = null;

const OV_CAL_STATUS_CLASS = {
  present: 'ov-cal__day--present',
  late: 'ov-cal__day--late',
  absent: 'ov-cal__day--absent',
  excused: 'ov-cal__day--excused',
};

const OV_CAL_STATUS_LABEL = {
  present: 'Present',
  late: 'Late',
  absent: 'Absent',
  excused: 'Excused',
};

function ovMonthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function ovMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Advances the displayed month by `delta` months and reloads. */
function ovShiftCalendarMonth(delta) {
  const base = ovCalMonth || ovMonthStart(new Date());
  ovCalMonth = new Date(base.getFullYear(), base.getMonth() + delta, 1);
  loadOverviewCalendar();
}

/** Returns to the current month and reloads. */
function ovResetCalendarMonth() {
  ovCalMonth = ovMonthStart(new Date());
  loadOverviewCalendar();
}

/**
 * Wires the calendar controls once. Safe to call more than once: the buttons
 * live in static markup, so a single delegated listener on the card covers
 * month navigation and day selection together.
 */
function initOverviewCalendar() {
  const card = document.getElementById('ov-calendar-card');
  if (!card || card.dataset.wired === 'true') return;
  card.dataset.wired = 'true';

  card.addEventListener('click', event => {
    const nav = event.target.closest('[data-ov-cal-nav]');
    if (nav) {
      const action = nav.dataset.ovCalNav;
      if (action === 'prev') ovShiftCalendarMonth(-1);
      else if (action === 'next') ovShiftCalendarMonth(1);
      else if (action === 'today') ovResetCalendarMonth();
      return;
    }

    const day = event.target.closest('.ov-cal__day--selectable');
    if (day) ovToggleCalendarDay(day.dataset.ovCalDay);
  });
}

/**
 * Loads the records for the displayed month and paints the grid. Opens on the
 * current month the first time it runs.
 */
async function loadOverviewCalendar() {
  const grid = document.getElementById('ov-cal-grid');
  const label = document.getElementById('ov-cal-label');
  const empty = document.getElementById('ov-cal-empty');
  if (!grid) return;

  if (!ovCalMonth) ovCalMonth = ovMonthStart(new Date());
  const month = ovCalMonth;

  if (label) {
    label.textContent = month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  if (!window.currentUser?._id) {
    grid.innerHTML = '';
    if (empty) {
      empty.textContent = 'Sign in to see your attendance history.';
      empty.classList.remove('hidden');
    }
    return;
  }

  // Inclusive window covering the whole displayed month.
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  const end = new Date(month.getFullYear(), month.getMonth() + 1, 0, 23, 59, 59);

  try {
    const records = await fetchAllDtrRecords(
      window.currentUser._id,
      start.toISOString(),
      end.toISOString()
    );

    ovCalRecords = new Map();
    (records || []).forEach(record => {
      const key = ovDateKey(record.date);
      // A trainee can have more than one row on a day in principle; the first
      // one with a time-in is the attendance for that day.
      if (!ovCalRecords.has(key) || (!ovCalRecords.get(key).timeIn && record.timeIn)) {
        ovCalRecords.set(key, record);
      }
    });

    renderAttendanceCalendar();
    renderAttendanceRate(records, ovMonthKey(month) === ovMonthKey(new Date()));
  } catch (error) {
    console.error('Error loading attendance calendar:', error);
    grid.innerHTML = '';
    if (empty) {
      empty.textContent = 'Attendance history is unavailable right now.';
      empty.classList.remove('hidden');
    }
  }
}

/**
 * Paints the month grid using the shared TrackIT calendar-picker markup
 * (.tk-cal-day / .tk-cal-grid), so it matches the date pickers on the DTR and
 * Journal forms.
 *
 * Sunday-first, because that is the column order the shared picker uses - the
 * existing week maths there is `new Date(y, m - 1, 1).getDay()`, and matching
 * it keeps the two UIs visually identical.
 *
 * Only the weeks the month actually spans are emitted. The picker pads to a
 * fixed six rows so its own height never jumps, but here that padding is dead
 * space in a dashboard card, so the grid is trimmed to keep the card short.
 */
function renderAttendanceCalendar() {
  const grid = document.getElementById('ov-cal-grid');
  const empty = document.getElementById('ov-cal-empty');
  if (!grid) return;

  const month = ovCalMonth || ovMonthStart(new Date());
  const year = month.getFullYear();
  const monthIndex = month.getMonth(); // 0-based
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

  // Sunday-first: getDay() already returns 0=Sunday, so no shift is needed.
  const lead = new Date(year, monthIndex, 1).getDay();

  const todayKey = ovDateKey(new Date());
  const cells = [];

  for (let i = 0; i < lead; i += 1) {
    cells.push('<span class="tk-cal-day" aria-hidden="true"></span>');
  }

  let hasRecords = false;

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, monthIndex, day);
    const key = ovDateKey(date);
    const record = ovCalRecords.get(key) || null;
    if (record) hasRecords = true;

    const status = record ? String(record.status || '').toLowerCase() : '';
    const statusClass = OV_CAL_STATUS_CLASS[status] || '';
    const verified = Boolean(record && record.verifiedBySupervisor);
    const isSelected = Boolean(record && ovCalSelected === key);

    const classes = ['tk-cal-day'];
    if (record) {
      classes.push('ov-cal__day--selectable', 'ov-cal__day--marked');
      classes.push(statusClass);
      if (!verified) classes.push('ov-cal__day--unverified');
    }
    // The shared picker's own outline treatment marks today.
    if (key === todayKey) classes.push('is-today');
    if (isSelected) classes.push('is-selected');

    const label = record
      ? `${date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}, ${OV_CAL_STATUS_LABEL[status] || 'Recorded'}${verified ? '' : ', not yet verified'}`
      : `${date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}, no record`;

    if (record) {
      // Real button: keyboard focusable and announces the full status.
      cells.push(
        `<button type="button" class="${classes.join(' ')}" data-ov-cal-day="${key}"` +
        ` aria-label="${label}" aria-pressed="${isSelected}">${day}` +
        '<span class="ov-cal__dot" aria-hidden="true"></span></button>'
      );
    } else {
      // No record: inert, but still labelled so a screen reader can say so.
      cells.push(
        `<span class="${classes.join(' ')}" role="gridcell" aria-label="${label}">${day}` +
        '<span class="ov-cal__dot" aria-hidden="true"></span></span>'
      );
    }
  }

  grid.innerHTML = cells.join('');

  if (empty) {
    if (hasRecords) {
      empty.classList.add('hidden');
    } else {
      empty.textContent = `No attendance records for ${month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}.`;
      empty.classList.remove('hidden');
    }
  }

  // Re-paint the detail panel so it never points at a day that is gone.
  if (ovCalSelected && !ovCalRecords.has(ovCalSelected)) {
    ovCalSelected = null;
  }
  if (ovCalSelected) renderCalendarDayDetail(ovCalSelected);
  else hideCalendarDayDetail();
}

/**
 * Expands the tapped day's detail, or collapses it when the same day is tapped
 * again. Only fields the DTR record actually carries are shown; anything
 * missing reads "Not recorded" rather than a fabricated zero.
 */
function ovToggleCalendarDay(key) {
  if (!key) return;
  ovCalSelected = ovCalSelected === key ? null : key;
  renderAttendanceCalendar();
}

function hideCalendarDayDetail() {
  const panel = document.getElementById('ov-cal-detail');
  if (panel) panel.classList.add('hidden');
}

/**
 * Day detail. Date, status, time in, time out and total hours all come
 * straight off the DTR row; an unverified row says so explicitly.
 */
function renderCalendarDayDetail(key) {
  const panel = document.getElementById('ov-cal-detail');
  const record = ovCalRecords.get(key);
  if (!panel || !record) {
    hideCalendarDayDetail();
    return;
  }

  const date = new Date(record.date);
  const status = String(record.status || '').toLowerCase();
  const verified = Boolean(record.verifiedBySupervisor);

  const facts = [
    ['Time In', record.timeIn ? ovFormatTime(record.timeIn) : 'Not recorded'],
    ['Time Out', record.timeOut ? ovFormatTime(record.timeOut) : 'Not recorded'],
    ['Total Hours', Number(record.hoursRendered) > 0 ? ovFormatHours(record.hoursRendered) : 'Not recorded'],
    ['Verification', verified ? 'Verified' : 'Not yet verified'],
  ];

  panel.innerHTML = `
    <div class="ov-cal__detailHead">
      <p class="ov-cal__detailDate">${date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
      <span class="ov-today__badge" data-state="${status}">${OV_CAL_STATUS_LABEL[status] || 'Recorded'}</span>
    </div>
    <dl class="ov-cal__facts">
      ${facts.map(([k, v]) => `
        <div class="ov-cal__fact">
          <dt>${k}</dt>
          <dd>${escapeHtml(String(v))}</dd>
        </div>`).join('')}
    </dl>`;
  panel.classList.remove('hidden');
}
// ── Journal progress ────────────────────────────────────────────────────────

/**
 * Answers the one question the card exists for: did I submit this week's
 * journal? The week is derived from the OJT start date (the first supervisor
 * assignment) with the same rule the Weekly Journal tab uses, then matched
 * against the trainee's journals.
 *
 * States map onto what the Journal model can actually express: draft,
 * submitted, reviewed, plus the supervisorSigned and coordinatorApproved
 * flags. There is no deadline field in the schema, so none is shown.
 */
/**
 * Shared state behind the This Week card. Two independent requests feed it -
 * the DTR records and the journal list - and a single renderer paints the card
 * from both, so whichever loader settles last cannot wipe out the section the
 * other one already filled. `journal`/`journalState` stay undefined until the
 * journal request has run, which is how the card keeps its placeholder instead
 * of claiming there is no journal while the request is still in flight.
 */
const ovWeekState = {
  records: null,
  journal: undefined,
  journalState: null,
  journalLoaded: false,
};

const OV_WEEK_ABBRS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const OV_WEEK_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

/**
 * Day marks for the timeline. Every cell also carries a written state in its
 * aria-label, so colour is never the only signal.
 */
const OV_WEEK_ICONS = {
  present: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6.5 9.5 17 4 11.5"></polyline></svg>',
  late: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><polyline points="12 7.5 12 12 15 13.5"></polyline></svg>',
  absent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="7.5" y1="7.5" x2="16.5" y2="16.5"></line><line x1="16.5" y1="7.5" x2="7.5" y2="16.5"></line></svg>',
  excused: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6.5" y1="12" x2="17.5" y2="12"></line></svg>',
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="8.5"></circle></svg>',
  upcoming: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="7"></circle></svg>',
};
OV_WEEK_ICONS.missed = OV_WEEK_ICONS.absent;

const OV_WEEK_STATE_LABELS = {
  present: 'Present',
  late: 'Late',
  absent: 'Absent',
  excused: 'Excused',
  missed: 'Missed',
  today: 'Not timed in',
  upcoming: 'Upcoming',
};

/** Monday through Friday of the week containing `date`, as local days. */
function ovWeekDays(date = new Date()) {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
  return OV_WEEK_ABBRS.map((abbr, i) => ({
    abbr,
    name: OV_WEEK_NAMES[i],
    date: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i),
  })).map((day) => ({ ...day, key: ovDateKey(day.date) }));
}

/**
 * Friday deadline for the journal, plus how much of the Mon-Fri window has
 * already passed. Pure calendar maths: the deadline exists whether or not a
 * journal has been written, so this needs no request of its own.
 */
function ovWeekDeadline() {
  const now = new Date();
  const mondayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const fridayEnd = new Date(mondayStart.getFullYear(), mondayStart.getMonth(), mondayStart.getDate() + 4, 23, 59, 59, 999);
  const msLeft = fridayEnd.getTime() - now.getTime();
  const daysLeft = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
  const span = fridayEnd.getTime() - mondayStart.getTime();
  const elapsed = Math.min(span, Math.max(0, now.getTime() - mondayStart.getTime()));

  let state = 'ok';
  let label = `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`;
  if (msLeft <= 0) {
    state = 'overdue';
    label = 'Overdue';
  } else if (daysLeft <= 1) {
    state = 'warn';
    label = msLeft < 24 * 60 * 60 * 1000 ? 'Due today' : `${daysLeft} day left`;
  }

  return { state, label, progress: Math.max(4, Math.min(100, Math.round((elapsed / span) * 100))) };
}

/** Attendance state for one day of the current week. */
function ovWeekDayState(day, records, todayKey) {
  if (records && records.length) {
    const status = String(records[0].status || '').toLowerCase();
    if (status === 'late') return 'late';
    if (status === 'absent') return 'absent';
    if (status === 'excused') return 'excused';
    return 'present';
  }
  if (day.key === todayKey) return 'today';
  return day.date > new Date() ? 'upcoming' : 'missed';
}

/**
 * Paints the whole This Week card from whatever has arrived so far: the
 * Monday-Friday timeline and the hours figure come from the DTR records, the
 * journal line, deadline and button label from the journal list.
 */
function renderThisWeek() {
  const daysEl = document.getElementById('ov-week-days');
  if (!daysEl) return;

  ovText('ov-week-range', ovWeekRangeLabel());

  const days = ovWeekDays();
  const todayKey = ovDateKey(new Date());
  const journal = ovWeekState.journal;
  const journalDay = journal && journal.dayCovered ? journal.dayCovered : null;
  const journalMark = !journal
    ? 'none'
    : journal.status === 'draft' ? 'draft' : 'submitted';

  if (ovWeekState.records === 'error') {
    daysEl.innerHTML = '<p class="ov-week__loading">This week\'s activity is unavailable right now.</p>';
  } else if (!ovWeekState.records) {
    daysEl.innerHTML = '<p class="ov-week__loading">Checking this week\'s activity…</p>';
  } else {
    const byDay = new Map();
    ovWeekState.records.forEach((record) => {
      const key = ovDateKey(record.date);
      if (!key) return;
      const list = byDay.get(key) || [];
      list.push(record);
      byDay.set(key, list);
    });

    let weeklyHours = 0;
    daysEl.innerHTML = days.map((day) => {
      const records = byDay.get(day.key) || [];
      const hours = records.reduce((sum, record) => sum + (Number(record.hoursRendered) || 0), 0);
      weeklyHours += hours;
      const state = ovWeekDayState(day, records, todayKey);
      const stateLabel = OV_WEEK_STATE_LABELS[state] || state;
      const covered = journalDay === day.name;
      const book = covered ? journalMark : 'none';
      const hoursLabel = hours > 0 ? `${Math.round(hours * 10) / 10}h` : '—';
      const journalLabel = covered
        ? (journalMark === 'draft' ? 'journal draft' : 'journal submitted')
        : 'no journal entry';
      const aria = `${day.name}: ${stateLabel}, ${hours > 0 ? `${hoursLabel} logged` : 'no hours'}, ${journalLabel}`;

      return `
        <div class="ov-week__day" data-state="${state}" data-today="${day.key === todayKey}" role="img" aria-label="${aria}">
          <span class="ov-week__dayName">${day.abbr}</span>
          <span class="ov-week__mark" aria-hidden="true">${OV_WEEK_ICONS[state]}</span>
          <span class="ov-week__dayHours">${hoursLabel}</span>
          <span class="ov-week__book" data-book="${book}" aria-hidden="true">${OV_JOURNAL_MARKS[book === 'submitted' ? 'approved' : 'draft']}</span>
        </div>`;
    }).join('');

    ovText('ov-week-hours', ovFormatHours(weeklyHours));
  }

  // Journal state: one document per OJT week, so the card reports the state of
  // that journal instead of a per-day submission count the system cannot make.
  const journalState = ovWeekState.journalState;
  const journalEl = document.getElementById('ov-week-journal');
  if (journalEl) {
    journalEl.textContent = ovWeekState.journalLoaded && journalState ? journalState.headline : '—';
    if (ovWeekState.journalLoaded && journalState) journalEl.dataset.state = journalState.state;
    else delete journalEl.dataset.state;
  }

  const deadline = ovWeekDeadline();
  const deadlineEl = document.getElementById('ov-week-deadline');
  if (deadlineEl) deadlineEl.dataset.state = deadline.state;
  ovText('ov-week-days-left', deadline.label);
  const fill = document.getElementById('ov-week-deadline-fill');
  if (fill) fill.style.width = `${deadline.progress}%`;

  const cta = document.getElementById('ov-week-cta');
  if (cta && ovWeekState.journalLoaded && journalState) {
    const label = journalState.cta || 'Write Journal';
    cta.childNodes[0].nodeValue = ` ${label} `;
  }

  const container = document.getElementById('ov-week');
  if (container) {
    container.dataset.state = ovWeekState.records === 'error'
      ? 'error'
      : (ovWeekState.records ? 'ready' : 'loading');
  }
}

/**
 * Fills the journal half of the This Week card.
 *
 * Every path ends by handing a state to renderThisWeek() instead of painting
 * the card itself: the timeline and the journal line belong to one card, so
 * neither loader may write into the other's section.
 */
function ovWeekJournalUnavailable(headline, cta) {
  ovWeekState.journal = null;
  ovWeekState.journalState = { state: 'error', headline, cta };
  ovWeekState.journalLoaded = true;
  renderThisWeek();
}

async function loadOverviewJournal() {
  // OJT weeks only start counting once a supervisor is assigned.
  if (window.studentHasSupervisor === false) {
    ovWeekJournalUnavailable('Waiting for supervisor', 'Open Weekly Journal');
    return;
  }

  const registration = getOjtStartDate();
  const week = ojtWeekNumberFromDate(new Date(), registration);
  if (!week) {
    ovWeekJournalUnavailable('Week unavailable', 'Write Journal');
    return;
  }

  try {
    const result = await fetchAPI('/journal/my-journals');
    if (!result || !result.success) {
      ovWeekJournalUnavailable('Status unavailable', 'Write Journal');
      return;
    }

    // One journal per OJT week: find this week's document and read its state.
    const journals = result.data || [];
    const match = journals.find((j) => parseJournalWeekNumber(j.week) === week) || null;
    ovWeekState.journal = match;
    ovWeekState.journalState = resolveJournalState(match);
    ovWeekState.journalLoaded = true;
    renderThisWeek();
  } catch (error) {
    console.error('Error loading journal overview:', error);
    ovWeekJournalUnavailable('Status unavailable', 'Write Journal');
  }
}

/**
 * Journal status marks, as inline SVG in the same stroke style used across the
 * app. A glyph character was mixing a second visual language into the card and
 * rendered inconsistently between platforms; colour stays a secondary cue and
 * the adjacent text label carries the meaning.
 */
const OV_JOURNAL_MARKS = {
  pending: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"></circle></svg>',
  draft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12.5a2 2 0 0 1 2 2z"></path><path d="M10 9h5"></path></svg>',
  submitted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6.5 9.5 17 4 11.5"></polyline></svg>',
  reviewed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"></circle><polyline points="8.5 12.2 11 14.7 15.5 9.5"></polyline></svg>',
  approved: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12.5a2 2 0 0 1 2 2z"></path><polyline points="9 11.5 11.5 14 15.5 9.5"></polyline></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 8v5"></path><circle cx="12" cy="16.5" r="0.6" fill="currentColor"></circle></svg>',
};

function ovJournalMark(state) {
  return OV_JOURNAL_MARKS[state] || OV_JOURNAL_MARKS.pending;
}

/**
 * Collapses the Journal model's flags into the states the card renders. A
 * returned journal is stored as a draft with supervisor feedback, which is why
 * a draft with feedback reads as "Needs revision"; a draft without it is still
 * being written, so it reads like nothing has been submitted yet.
 */
function resolveJournalState(journal) {
  if (!journal || isPrivateDraft(journal)) {
    return journal
      ? { state: 'pending', headline: 'Draft In Progress', label: 'Draft - not submitted', cta: 'Continue Draft' }
      : { state: 'pending', headline: 'Not Submitted', label: 'Not submitted', cta: 'Write Journal' };
  }
  if (journal.status === 'draft') {
    return { state: 'draft', headline: 'Needs Revision', label: 'Returned for revision', cta: 'Revise Journal' };
  }
  if (journal.coordinatorApproved) {
    return { state: 'approved', headline: 'Approved', label: 'Approved', cta: 'View Journal' };
  }
  if (journal.status === 'reviewed' || journal.supervisorSigned) {
    return { state: 'reviewed', headline: 'Reviewed', label: 'Under review', cta: 'View Journal' };
  }
  return { state: 'submitted', headline: 'Journal Submitted', label: 'Awaiting supervisor signature', cta: 'View Journal' };
}

// ── DTR verification & weekly activity ─────────────────────────────────────

const OV_DTR_ICONS = {
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><polyline points="14 3 14 8 19 8"></polyline><line x1="8.5" y1="13" x2="15" y2="13"></line><line x1="8.5" y1="16.5" x2="13" y2="16.5"></line></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6.5 9.5 17 4 11.5"></polyline></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><polyline points="12 7.5 12 12 15 13.5"></polyline></svg>',
};

/**
 * Consecutive attended days ending today - or yesterday, when today's record
 * does not exist yet. A day with an absent or excused record, or with no record
 * at all, breaks the chain. Derived from the DTR records the dashboard already
 * fetches, so no endpoint or stored field was added for it.
 */
function renderStreak(records) {
  const attended = new Set();
  const recorded = new Set();
  (records || []).forEach((record) => {
    const key = ovDateKey(record.date);
    if (!key) return;
    recorded.add(key);
    const status = String(record.status || '').toLowerCase();
    if (status === 'present' || status === 'late') attended.add(key);
  });

  let cursor = new Date();
  if (!recorded.has(ovDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);

  let streak = 0;
  while (attended.has(ovDateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  ovText('ov-kpi-streak', `${streak} ${streak === 1 ? 'day' : 'days'} streak`);
}

/**
 * Hands the fetched DTR records to the This Week timeline. Kept separate from
 * the card renderer so the DTR card and the week timeline keep one source.
 */
function renderWeekAttendance(records) {
  ovWeekState.records = records;
  renderThisWeek();
}

/**
 * DTR Verification card: a two-segment donut, the verified / pending counts,
 * the current state as a badge, then the latest entries.
 *
 * The DTR model stores `verifiedBySupervisor` and nothing else, so verified and
 * pending are the only states that exist to count - a rejected segment would
 * have to be invented rather than read. Entries (records), not calendar days,
 * are the unit here because that is what the supervisor actually signs off.
 *
 * @param {Array|null} records - all DTR records since the OJT start; null when
 *   there is nothing to show.
 */
function renderDtrVerification(records) {
  const container = document.getElementById('ov-dtr');
  if (!container) return;

  if (!records || records.length === 0) {
    container.dataset.state = 'empty';
    container.innerHTML = `
      <div class="ov-dtr__empty">
        <span class="ov-dtr__emptyIcon" aria-hidden="true">${OV_DTR_ICONS.doc}</span>
        <p class="ov-dtr__emptyTitle">No DTR entries yet</p>
        <p class="ov-dtr__emptyText">Your attendance records will appear here after you start your OJT.</p>
      </div>`;
    return;
  }

  const sorted = records.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  const total = sorted.length;
  const verified = sorted.filter((record) => record.verifiedBySupervisor).length;
  const pending = total - verified;
  const state = pending === 0 ? 'verified' : 'pending';

  const circumference = 2 * Math.PI * 42;
  const verifiedLen = (verified / total) * circumference;
  const pendingLen = circumference - verifiedLen;

  const recent = sorted.slice(0, 4).map((record) => {
    const status = String(record.status || '').toLowerCase();
    const date = new Date(record.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    let when;
    if (status === 'absent') when = 'Absent';
    else if (status === 'excused') when = 'Excused';
    else {
      const timeIn = ovFormatTime(record.timeIn);
      const timeOut = ovFormatTime(record.timeOut);
      when = timeIn === '—' && timeOut === '—' ? 'No times recorded' : `${timeIn} – ${timeOut}`;
    }
    const ok = Boolean(record.verifiedBySupervisor);
    return `
        <li class="ov-dtr__entry" data-state="${ok ? 'verified' : 'pending'}">
          <span class="ov-dtr__entryDate">${date}</span>
          <span class="ov-dtr__entryTime">${when}</span>
          <span class="ov-dtr__entryState"><span class="ov-dtr__entryIcon" aria-hidden="true">${ok ? OV_DTR_ICONS.check : OV_DTR_ICONS.clock}</span>${ok ? 'Verified' : 'Pending'}</span>
        </li>`;
  }).join('');

  container.dataset.state = state;
  container.innerHTML = `
    <p class="ov-dtr__badge" data-state="${state}">
      <span class="ov-dtr__badgeMark" aria-hidden="true">${state === 'verified' ? OV_DTR_ICONS.check : OV_DTR_ICONS.clock}</span>
      ${state === 'verified' ? 'Verified' : 'Pending verification'}
    </p>

    <div class="ov-dtr__top">
      <div class="ov-dtr__donut" role="img" aria-label="${verified} of ${total} DTR entries verified, ${pending} pending verification">
        <svg class="ov-dtr__donutSvg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
          <circle class="ov-dtr__donutTrack" cx="50" cy="50" r="42"></circle>
          <circle class="ov-dtr__donutSeg ov-dtr__donutSeg--pending" cx="50" cy="50" r="42" style="stroke-dasharray: ${pendingLen} ${circumference - pendingLen}; stroke-dashoffset: ${-verifiedLen}"></circle>
          <circle class="ov-dtr__donutSeg ov-dtr__donutSeg--verified" cx="50" cy="50" r="42" style="stroke-dasharray: ${verifiedLen} ${circumference - verifiedLen}"></circle>
        </svg>
        <span class="ov-dtr__donutCenter" aria-hidden="true"><b>${total}</b><span>${total === 1 ? 'entry' : 'entries'}</span></span>
      </div>

      <dl class="ov-dtr__counts">
        <div class="ov-dtr__count"><dt>Verified</dt><dd data-state="verified">${verified}</dd></div>
        <div class="ov-dtr__count"><dt>Pending</dt><dd data-state="pending">${pending}</dd></div>
      </dl>
    </div>

    <div class="ov-dtr__entries">
      <p class="ov-dtr__entriesHead">Recent entries</p>
      <ul class="ov-dtr__list">${recent}</ul>
    </div>`;
}

/**
 * One request for every DTR record since the OJT start, feeding three cards:
 * the streak on Overall Progress, the Monday-Friday timeline in This Week, and
 * the verification card itself. Fetched once so the dashboard never asks for
 * the same records twice while it is loading.
 */
async function loadOverviewDtrData() {
  const container = document.getElementById('ov-dtr');
  if (container) {
    container.dataset.state = 'loading';
    container.innerHTML = '<p class="ov-dtr__loading">Checking your DTR records…</p>';
  }

  const traineeId = window.currentUser?._id;
  const start = getOjtStartDate();
  if (!traineeId || !start) {
    renderWeekAttendance([]);
    renderStreak([]);
    renderDtrVerification([]);
    return;
  }

  try {
    const records = await fetchAllDtrRecords(
      traineeId,
      new Date(start).toISOString(),
      new Date().toISOString()
    );

    renderWeekAttendance(records || []);
    renderStreak(records || []);
    renderDtrVerification(records || []);
  } catch (error) {
    console.error('Error loading DTR verification:', error);
    ovWeekState.records = 'error';
    renderThisWeek();
    if (container) {
      container.dataset.state = 'error';
      container.innerHTML = '<p class="ov-dtr__loading">Your DTR verification status is unavailable right now.</p>';
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// TAB SWITCHING & UI UPDATES
// ────────────────────────────────────────────────────────────────────────────

let tabHistory = [];
let currentTab = null;

function switchTab(tabName, options = {}) {
  const { fromHistory = false, direction = 'forward' } = options;
  // Save current tab to localStorage for persistence
  localStorage.setItem('trackit_current_tab', tabName);

  if (!fromHistory && currentTab && currentTab !== tabName) {
    tabHistory.push(currentTab);
  }
  currentTab = tabName;
  updateTabBackButton();
  
  
  // Hide all tabs
  const tabs = document.querySelectorAll('.tab-content');
  tabs.forEach(tab => tab.classList.remove('active'));

  // Remove active from all nav links
  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => link.classList.remove('active'));

  // Show selected tab
  const selectedTab = document.getElementById(tabName);
  if (selectedTab) {
    selectedTab.classList.add('active');
    selectedTab.classList.add(direction === 'back' ? 'is-entering-back' : 'is-entering');
    selectedTab.addEventListener('animationend', () => {
      selectedTab.classList.remove('is-entering', 'is-entering-back');
    }, { once: true });
    window.scrollTo(0, 0);
  } else {
    console.warn('⚠️ Tab element not found:', tabName);
  }

  // Add active to corresponding nav link
  const activeNavLink = document.querySelector(`.nav-link[href="#${tabName}"]`);
  if (activeNavLink) {
    activeNavLink.classList.add('active');
  } else {
    console.warn('⚠️ Nav link not found for:', tabName);
  }

  // Close sidebar on mobile
  closeSidebarOnMobile();

  // Load tab-specific data asynchronously (non-blocking)
  if (tabName === 'overview') {
    // Refetch on every visit so the cards reflect anything recorded since the
    // last one; the calendar keeps its own currently-viewed month.
    loadOverviewToday().catch(err => console.error('Error loading today overview:', err));
    loadOverviewCalendar().catch(err => console.error('Error loading attendance calendar:', err));
    loadOverviewJournal().catch(err => console.error('Error loading journal overview:', err));
    loadOverviewDtrData().catch(err => console.error('Error loading DTR data:', err));
  } else if (tabName === 'dtr') {
    loadDTRRecords().catch(err => console.error('Error loading DTR:', err));
  } else if (tabName === 'journal') {
    (async () => {
      try {
        await refreshJournalWeek();
        await loadPreviousJournals();
      } catch (err) {
        console.error('Error loading journal tab:', err);
      }
    })();
  } else if (tabName === 'progress') {
    // Load progress data asynchronously
    fetchAPI('/stats/student').then(result => {
      if (result && result.success) {
        const { student: studentData, stats: statsData } = result.data;
        initWeeklyChart(studentData);
        updateHoursByWeek(studentData);
        updatePerformanceMetrics();
        updateEstimatedCompletion(statsData, studentData);
      }
    }).catch(err => console.error('Error loading progress:', err));
  }
}

function updateTabBackButton() {
  const backButton = document.getElementById('tab-back');
  if (!backButton) return;
  const hasHistory = tabHistory.length > 0;
  backButton.disabled = !hasHistory;
  backButton.classList.toggle('is-disabled', !hasHistory);

  // Overview is the dashboard's entry point, so there is never anywhere to go
  // back to from it and the control would always sit there disabled. The
  // toolbar itself is hidden there; every other tab keeps a working Back.
  const toolbar = document.querySelector('.tab-toolbar');
  if (toolbar) toolbar.classList.toggle('hidden', currentTab === 'overview');
}

function goBackTab() {
  if (tabHistory.length === 0) return;
  const previousTab = tabHistory.pop();
  switchTab(previousTab, { fromHistory: true, direction: 'back' });
}

// Update current date/time
function updateDateTime() {
  const now = new Date();
  const options = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  };
  const dateTimeString = now.toLocaleDateString('en-US', options);
  const datetimeElement = document.getElementById('current-datetime');
  if (datetimeElement) {
    datetimeElement.textContent = dateTimeString;
  }
}

// Generate DTR Calendar
function generateDTRCalendar() {
  const monthInput = document.getElementById('dtr-month');
  if (!monthInput) {
    console.warn('⚠️ dtr-month element not found, skipping calendar generation');
    return;
  }

  const selectedMonth = monthInput.value;
  const [year, month] = selectedMonth.split('-').map(Number);

  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const daysInMonth = lastDay.getDate();

  const tbody = document.getElementById('dtr-table-body');
  if (!tbody) {
    console.warn('⚠️ dtr-table-body element not found, skipping calendar generation');
    return;
  }
  tbody.innerHTML = '';

  let totalHours = 0;
  const dtrData = generateMockDTRData(daysInMonth);

  for (let day = 1; day <= daysInMonth; day++) {
    const dayDate = new Date(year, month - 1, day);
    const dayOfWeek = dayDate.getDay();

    let status = 'Present';
    let timeIn = '08:00 AM';
    let timeOut = '05:00 PM';
    let hours = 8.0;

    // Mock data
    if ([0, 6].includes(dayOfWeek)) {
      status = 'Holiday';
      timeIn = '-';
      timeOut = '-';
      hours = 0;
    } else if (day === 3 || day === 15) {
      status = 'Absent';
      timeIn = '-';
      timeOut = '-';
      hours = 0;
    } else {
      hours = dtrData[day] || 8.0;
    }

    if (status === 'Present') {
      totalHours += hours;
    }

    const statusBadgeClass = status === 'Present' ? 'status-present' : 
                            status === 'Absent' ? 'status-absent' : 'status-holiday';

    const row = `
      <tr class="border-b border-white/10">
        <td class="py-3 px-4">${day}</td>
        <td class="py-3 px-4">${timeIn}</td>
        <td class="py-3 px-4">${timeOut}</td>
        <td class="py-3 px-4">${hours > 0 ? hours.toFixed(1) : '-'}</td>
        <td class="py-3 px-4"><span class="status-badge ${statusBadgeClass}">${status}</span></td>
      </tr>
    `;
    tbody.innerHTML += row;
  }

  // Update total hours
  const totalHoursEl = document.getElementById('total-hours');
  if (totalHoursEl) {
    totalHoursEl.textContent = totalHours.toFixed(1);
  }
}

function generateMockDTRData(daysInMonth) {
  const data = {};
  for (let day = 1; day <= daysInMonth; day++) {
    if (![3, 15].includes(day)) {
      data[day] = 7.5 + Math.random() * 1.5;
    }
  }
  return data;
}

function updateDTRCalendar() {
  generateDTRCalendar();
}

// Chart initialization
async function initWeeklyChart(student) {
  const ctx = document.getElementById('weeklyChart');
  if (!ctx) {
    console.error('Chart canvas element not found');
    return;
  }

  try {
    // Destroy existing chart if it exists
    if (weeklyChartInstance) {
      weeklyChartInstance.destroy();
    }

    // OJT start date: the first supervisor assignment, so the chart's "Week 4"
    // is the same week the journal tab stamps.
    const registrationDate = new Date(student?.supervisorAssignedAt || getOjtStartDate() || new Date());
    const today = new Date();

    console.log('Fetching DTR from', registrationDate, 'to', today);

    const response = await fetch(
      `${API_BASE}/qr/dtr/${window.currentUser._id}?startDate=${registrationDate.toISOString()}&endDate=${today.toISOString()}&limit=1000`,
      { headers: getAuthHeaders() }
    );

    if (!response.ok) throw new Error('Failed to fetch DTR records');
    const data = await response.json();
    const records = data.data || [];
    
    console.log('Received DTR records:', records.length);

    // Group records by week since registration
    const weeklyData = {};
    records.forEach(record => {
      if (!record.verifiedBySupervisor) return; // Only count verified records
      
      const date = new Date(record.date);
      // Calculate week number based on registration date
      const daysSinceStart = Math.floor((date.getTime() - registrationDate.getTime()) / (24 * 60 * 60 * 1000));
      const weekNum = Math.floor(daysSinceStart / 7) + 1;
      const key = `week-${weekNum}`;

      if (!weeklyData[key]) {
        weeklyData[key] = 0;
      }
      weeklyData[key] += record.hoursRendered || 0;
    });

    console.log('Weekly data:', weeklyData);

    // Get last 7 weeks based on registration date
    const weeks = [];
    const weekHours = [];
    const daysSinceStart = Math.floor((today.getTime() - registrationDate.getTime()) / (24 * 60 * 60 * 1000));
    const totalWeeks = Math.floor(daysSinceStart / 7) + 1;
    
    // Show last 7 weeks or all weeks if less than 7
    const startWeek = Math.max(1, totalWeeks - 6);
    for (let w = startWeek; w <= totalWeeks; w++) {
      const key = `week-${w}`;
      weeks.push(`Week ${w}`);
      weekHours.push(Math.round((weeklyData[key] || 0) * 10) / 10);
    }

    console.log('Chart data - weeks:', weeks, 'hour ' + 's:', weekHours);

    // Shared bar-chart design system: same spacing, corner radius, grid, hover
    // emphasis and value captions as the coordinator analytics charts, and the
    // theme tokens are read live so a theme switch repaints correctly.
    const dataset = window.TrackITCharts.styleDataset({
      label: 'Hours Rendered',
      data: weekHours,
    }, {
      accent: window.TrackITCharts.tokens().teal,
      maxBarThickness: 34,
      fill: 'flat', // single weekly series reads better as a flat fill
    });

    const chartConfig = window.TrackITCharts.withPlugins({
      type: 'bar',
      data: { labels: weeks, datasets: [dataset] },
      options: window.TrackITCharts.barOptions({
        vertical: true,
        timeSeries: true, // weeks stay on the x axis
        legend: false,
        categoryCount: weeks.length,
        datasetCount: 1,
        yTitle: 'Hours',
        valueFormatter: (value) => `${Math.round(value * 10) / 10}`,
      }),
    });

    // The existing 0-50 hour ceiling is preserved so the scale semantics of this
    // chart do not change.
    chartConfig.options.scales.y.max = 50;

    weeklyChartInstance = new Chart(ctx, chartConfig);
    window.TrackITCharts.register(weeklyChartInstance);
    
    console.log('Chart created successfully');
  } catch (error) {
    console.error('Error initializing weekly chart:', error);
  }
}

// Get ISO week number for a date
function getISOWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// Update estimated completion date based on current progress
async function updateEstimatedCompletion(stats, student) {
  try {
    // Use standard 35 hours/week (6-8 hours × 5 days)
    const standardHoursPerWeek = 35;
    
    // Calculate weeks remaining
    const remainingHours = Math.max(0, stats.totalRequired - stats.completedHours);
    const weeksRemaining = Math.ceil(remainingHours / standardHoursPerWeek);
    
    // Calculate estimated completion date
    const today = new Date();
    const estimatedDate = new Date(today.getTime() + weeksRemaining * 7 * 24 * 60 * 60 * 1000);
    
    // Update the estimated completion date in the progress tab
    const remainingCard = document.querySelector('#progress .glass-card:has(.text-4xl.font-display)');
    if (remainingCard) {
      const dateEl = remainingCard.querySelector('.text-sm.font-semibold.text-teal-400');
      if (dateEl) {
        dateEl.textContent = estimatedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
    }
  } catch (error) {
    console.error('Error updating estimated completion:', error);
  }
}

// Update hours by week section with actual data
async function updateHoursByWeek(student) {
  try {
    // OJT start date: first supervisor assignment (falls back to account
    // creation only when no supervisor is assigned yet).
    const registrationDate = new Date(student?.supervisorAssignedAt || getOjtStartDate() || new Date());
    const today = new Date();

    const response = await fetch(
      `${API_BASE}/qr/dtr/${window.currentUser._id}?startDate=${registrationDate.toISOString()}&endDate=${today.toISOString()}&limit=1000`,
      { headers: getAuthHeaders() }
    );

    if (!response.ok) throw new Error('Failed to fetch DTR records');
    const data = await response.json();
    const records = data.data || [];
    
    // Group records by week since registration
    const weeklyData = {};
    records.forEach(record => {
      if (!record.verifiedBySupervisor) return;
      
      const date = new Date(record.date);
      const daysSinceStart = Math.floor((date.getTime() - registrationDate.getTime()) / (24 * 60 * 60 * 1000));
      const weekNum = Math.floor(daysSinceStart / 7) + 1;
      const key = `week-${weekNum}`;

      if (!weeklyData[key]) {
        weeklyData[key] = 0;
      }
      weeklyData[key] += record.hoursRendered || 0;
    });

    // Get last 2 weeks based on registration date
    const weeksDisplay = [];
    const daysSinceStart = Math.floor((today.getTime() - registrationDate.getTime()) / (24 * 60 * 60 * 1000));
    const totalWeeks = Math.floor(daysSinceStart / 7) + 1;
    
    for (let i = 1; i >= 0; i--) {
      const weekNum = totalWeeks - i;
      if (weekNum >= 1) {
        const key = `week-${weekNum}`;
        const hours = Math.round((weeklyData[key] || 0) * 10) / 10;
        weeksDisplay.push({ week: weekNum, hours: hours });
      }
    }

    // Update the container
    const container = document.getElementById('hoursbyweek-container');
    if (!container) return;

    // Build HTML for all weeks
    const weekHTML = weeksDisplay.map(({ week, hours }) => {
      const percentage = Math.min((hours / 50) * 100, 100);
      return `
        <div>
          <div class="flex justify-between items-center mb-2">
            <span class="text-sm text-slate-400">Week ${week}</span>
            <span class="text-lg font-semibold text-teal-400">${hours.toFixed(1)}</span>
          </div>
          <div class="w-full bg-white/10 rounded-full h-2">
            <div class="bg-teal-400 h-2 rounded-full" style="width: ${percentage}%;"></div>
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = weekHTML;
  } catch (error) {
    console.error('Error updating hours by week:', error);
  }
}

// Update performance metrics with actual data
async function updatePerformanceMetrics() {
  try {
    // Fetch student stats including supervisor rating and journal count
    const response = await fetch(
      `${API_BASE}/stats/student`,
      { headers: getAuthHeaders() }
    );

    if (!response.ok) throw new Error('Failed to fetch student stats');
    const data = await response.json();
    
    const { student, stats } = data.data;

    // Calculate attendance rate from DTR records
    const dtrResponse = await fetch(
      `${API_BASE}/qr/dtr/${window.currentUser._id}?limit=1000`,
      { headers: getAuthHeaders() }
    );

    if (!dtrResponse.ok) throw new Error('Failed to fetch DTR records');
    const dtrData = await dtrResponse.json();
    const records = dtrData.data || [];

    // Calculate metrics
    const verifiedRecords = records.filter(r => r.verifiedBySupervisor);
    const uniqueDays = new Set();
    const presentDays = new Set();
    
    verifiedRecords.forEach(r => {
      if (r.hoursRendered > 0) {
        const dateKey = new Date(r.date).toDateString();
        uniqueDays.add(dateKey);
        if (r.status === 'present' || r.status !== 'absent') {
          presentDays.add(dateKey);
        }
      }
    });
    
    const totalDays = uniqueDays.size;
    const presentCount = presentDays.size;
    const attendanceRate = totalDays > 0 ? Math.round((presentCount / totalDays) * 100) : 0;
    
    const totalHours = verifiedRecords.reduce((sum, r) => sum + (r.hoursRendered || 0), 0);
    const weeksWorked = new Set(verifiedRecords.map(r => {
      const d = new Date(r.date);
      return `${d.getFullYear()}-W${getISOWeekNumber(d)}`;
    })).size;
    
    const avgHoursPerWeek = weeksWorked > 0 ? Math.round((totalHours / weeksWorked) * 10) / 10 : 0;

    // Update Attendance Rate
    const attendanceEl = document.getElementById('metric-attendance');
    if (attendanceEl) {
      attendanceEl.textContent = `${attendanceRate}%`;
      document.getElementById('metric-attendance-detail').textContent = `${presentCount} days present`;
    }

    // Update Journal Submissions
    const journalsEl = document.getElementById('metric-journals');
    if (journalsEl) {
      const journalCount = stats.journalSubmissions || 0;
      journalsEl.textContent = journalCount > 0 ? journalCount.toString() : '0';
      document.getElementById('metric-journals-detail').textContent = journalCount > 0 ? `${journalCount} submitted` : 'No journals yet';
    }

    // Update Avg Hours/Week
    const hoursEl = document.getElementById('metric-hours');
    if (hoursEl) {
      hoursEl.textContent = avgHoursPerWeek.toString();
      const rate = avgHoursPerWeek >= 39.5 ? 'Above requirement' : 'On track';
      document.getElementById('metric-hours-detail').textContent = rate;
    }

    // Update Supervisor Rating
    const ratingEl = document.getElementById('metric-rating');
    if (ratingEl) {
      if (student.supervisorRating !== null && student.supervisorRating !== undefined) {
        ratingEl.textContent = `${student.supervisorRating}★`;
        document.getElementById('metric-rating-detail').textContent = 'Out of 5.0';
      } else {
        ratingEl.textContent = '—';
        document.getElementById('metric-rating-detail').textContent = 'Not rated yet';
      }
    }

    console.log('Performance metrics updated:', { attendanceRate, journalCount: stats.journalSubmissions, avgHoursPerWeek, rating: student.supervisorRating });
  } catch (error) {
    console.error('Error updating performance metrics:', error);
  }
}

// Journal submission. The week is never sent: the server stamps the current
// OJT week (or keeps the original week when a returned journal is revised).
async function submitJournal(event) {
  event.preventDefault();

  const dayCovered = document.getElementById('day-covered')?.value || null;
  const narrative = document.getElementById('journal-narrative').value;
  const identifiedTheories = window.currentIdentifiedTheories || [];

  if (!narrative.trim()) {
    showNotification('Error', 'Please write a journal entry', 'error');
    return;
  }

  if (!journalWeekState.submitEnabled) {
    const banner = document.getElementById('journal-block-banner');
    showNotification(
      'Notice',
      banner && banner.textContent.trim()
        ? banner.textContent.trim()
        : 'Journal submission is not available right now.',
      'info'
    );
    return;
  }

  const weekLabel = (currentEditingJournal && currentEditingJournal.week) || journalWeekState.label;

  // Show loading state
  const submitBtn = event.target.querySelector('button[type="submit"]');
  const headerBtn = document.getElementById('journal-submit-btn');
  const originalText = submitBtn.innerHTML;
  const originalHeaderText = headerBtn ? headerBtn.innerHTML : '';
  submitBtn.disabled = true;
  if (headerBtn) headerBtn.disabled = true;
  submitBtn.innerHTML = '<svg width="18" height="18" class="animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 2A10 10 0 0 1 22 12"></path></svg> Submitting...';

  const restore = () => {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
    if (headerBtn) {
      headerBtn.disabled = !journalWeekState.submitEnabled;
      headerBtn.innerHTML = originalHeaderText;
    }
  };

  try {
    const result = await fetchAPI('/journal/submit', {
      method: 'POST',
      body: JSON.stringify({
        // Revision target: the server keeps that journal's original week.
        journalId: currentEditingJournal ? currentEditingJournal._id : undefined,
        dayCovered,
        narrative,
        identifiedTheories,
        photoDataUrl: journalPhotoDataUrl,
      }),
    });

    if (!result || !result.success) {
      const detail = result?.error || result?.message || 'Unknown error';
      showNotification('Error', detail, 'error');
      restore();
      return;
    }

    const submittedWeek = result.data?.week || weekLabel;
    document.getElementById('journal-form').reset();
    document.getElementById('theories-result').classList.add('hidden');
    resetJournalPhotoPreview();
    window.currentIdentifiedTheories = [];
    clearJournalEditing();

    // Success confirmation replaces the old browser alert. The progress UI is
    // refreshed behind it, so the week already reads "Submitted" when Done is
    // clicked - no page reload, and the entered data has been persisted.
    VerificationModal.open({
      type: 'success',
      success: {
        title: 'Journal Submitted Successfully!',
        text: submittedWeek
          ? 'Your ' + submittedWeek + ' journal has been submitted and recorded successfully.'
          : 'Your journal has been submitted and recorded successfully.',
        note: 'Your journal is now available for review.',
        badge: '',
        doneLabel: 'Done'
      }
    });

    await loadPreviousJournals();
    await refreshJournalWeek();

    restore();
  } catch (error) {
    console.error('Error submitting journal:', error);
    showNotification('Error', 'Error submitting journal. Please try again.', 'error');
    restore();
  }
}

// Auto-extract theories from narrative
async function autoExtractTheories(event) {
  const narrative = document.getElementById('journal-narrative').value;
  if (!narrative.trim()) {
    showNotification('Error', 'Please write a journal entry first', 'error');
    return;
  }

  // Show loading state
  const button = event.target.closest('button');
  const originalText = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<svg width="18" height="18" class="animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 2A10 10 0 0 1 22 12"></path></svg> Analyzing...';

  try {
    // Call backend theory extraction endpoint
    const result = await fetchAPI('/journal/extract-theories', {
      method: 'POST',
      body: JSON.stringify({ 
        narrative,
      }),
    });

    if (!result || !result.success) {
      alert('Failed to extract theories: ' + (result?.message || 'Unknown error'));
      button.disabled = false;
      button.innerHTML = originalText;
      return;
    }

    const rawTheories = result.data.identifiedTheories || [];
    // Sanitize AI/local output defensively: Mongoose subdocs reject nulls and
    // unexpected shapes, which would otherwise fail the later /journal/submit.
    const identifiedTheories = (Array.isArray(rawTheories) ? rawTheories : [])
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({
        course: typeof t.course === 'string' ? t.course : '',
        courseName: typeof t.courseName === 'string' ? t.courseName : '',
        category: typeof t.category === 'string' ? t.category : '',
        theory: typeof t.theory === 'string' ? t.theory : '',
      }))
      .filter((t) => t.course || t.courseName || t.category || t.theory);
    window.currentIdentifiedTheories = identifiedTheories;

    renderTheoriesList(identifiedTheories);
    button.disabled = false;
    button.innerHTML = originalText;
  } catch (error) {
    console.error('Error extracting theories:', error);
    alert('Error extracting theories. Please try again.');
    button.disabled = false;
    button.innerHTML = originalText;
  }
}

// Duty log submission
async function submitDutyLog(event) {
  event.preventDefault();
  const date = document.getElementById('dutylog-date').value;
  const desc = document.getElementById('dutylog-desc').value;
  const category = document.getElementById('dutylog-category').value;
  const hours = document.getElementById('dutylog-hours').value;

  if (!date || !desc || !hours) {
    alert('Please fill all fields');
    return;
  }

  // API call to save duty log (when backend endpoint is ready)
  // const result = await fetchAPI(`/dutylog`, {
  //   method: 'POST',
  //   body: JSON.stringify({
  //     studentId: window.currentUser.id,
  //     date,
  //     taskDescription: desc,
  //     category,
  //     hoursSpent: parseFloat(hours),
  //     status: 'submitted'
  //   })
  // });

  alert(`Duty log added for ${date}!\nTask: ${desc}\nCategory: ${category}\nHours: ${hours}`);
  document.getElementById('dutylog-form').reset();
}

// Profile functions
async function saveProfile(event) {
  event.preventDefault();
  const name = document.getElementById('profile-name').value;
  const studentId = document.getElementById('profile-id').value;
  const dept = document.getElementById('profile-dept').value;
  const company = document.getElementById('profile-company').value;

  if (!name || !studentId) {
    alert('Please fill required fields');
    return;
  }

  const btn = event.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  const result = await fetchAPI('/dashboard/profile', {
    method: 'PUT',
    body: JSON.stringify({
      fullName: name,
      studentId,
      department: dept,
      companyName: company
    })
  });

  btn.disabled = false;
  btn.textContent = 'Save Profile Changes';

  if (result && result.success) {
    // Update localStorage so changes persist across page reloads
    const updatedUser = { ...window.currentUser, fullName: name, studentId, department: dept, companyName: company };
    window.currentUser = updatedUser;
    localStorage.setItem('trackit_user', JSON.stringify(updatedUser));

    // Update the nav username
    document.getElementById('user-name').textContent = name.split(' ')[0];

    alert('Profile updated successfully!');
  } else {
    alert(result?.message || 'Failed to update profile');
  }
}

async function changePassword(event) {
  event.preventDefault();
  const current = document.getElementById('current-pass').value;
  const newPass = document.getElementById('new-pass').value;
  const confirm = document.getElementById('confirm-pass').value;

  if (!current || !newPass || !confirm) {
    alert('Please fill all password fields');
    return;
  }

  if (newPass !== confirm) {
    alert('Passwords do not match');
    return;
  }

  if (newPass.length < 6) {
    alert('New password must be at least 6 characters');
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
    alert('Password changed successfully!');
    document.getElementById('password-form').reset();
  } else {
    alert(result?.message || 'Failed to change password. Please try again.');
  }
}

// ── Week state ──────────────────────────────────────────────────────────────
// The student never picks a week. It is derived from the OJT start date (the
// first supervisor assignment) and stamped by the server on submit; a journal
// that is being revised keeps the week it was originally filed under.
let currentEditingJournal = null; // draft being resumed, or journal being revised
let journalWeekState = {
  week: null,
  label: '—',
  hasSupervisor: false,
  periodComplete: false,
  alreadySubmitted: false,
  returnedForRevision: null,
  // Optimistic until refreshJournalWeek reports otherwise; the server is the
  // authority either way, so a slow refresh can never let a bad submit through.
  submitEnabled: true,
  saveEnabled: true,
};

function setJournalBanner(html) {
  const banner = document.getElementById('journal-block-banner');
  if (!banner) return;
  if (html) {
    banner.innerHTML = html;
    banner.classList.remove('hidden');
  } else {
    banner.innerHTML = '';
    banner.classList.add('hidden');
  }
}

function setJournalActions({ submit, save }) {
  const submitBtn = document.getElementById('journal-submit-btn');
  const saveBtn = document.getElementById('journal-save-draft');
  if (submitBtn) submitBtn.disabled = !submit;
  if (saveBtn) saveBtn.disabled = !save;
  journalWeekState.submitEnabled = submit;
  journalWeekState.saveEnabled = save;
}

function privateDraftsFrom(journals) {
  return (journals || []).filter(isPrivateDraft);
}

function updateDraftCount(journals) {
  const count = privateDraftsFrom(journals).length;
  const countEl = document.getElementById('drafts-count');
  if (countEl) countEl.textContent = String(count);
  const btn = document.getElementById('drafts-open-btn');
  if (btn) btn.classList.toggle('hidden', count === 0);
  return count;
}

/** Paint the automatic week label plus whatever is blocking submission. */
function renderJournalWeekState() {
  const weekValueEl = document.getElementById('week-auto-value');
  const helpEl = document.getElementById('week-auto-help');
  if (!weekValueEl) return;

  const editing = currentEditingJournal;
  const label = (editing && editing.week) || journalWeekState.label;
  weekValueEl.textContent = label;

  const state = journalWeekState;
  let submit = true;
  let save = true;
  let banner = '';
  let help = 'Week 1 starts the day your supervisor is assigned, so the week is stamped for you when you submit - there is nothing to pick.';

  if (state.periodComplete) {
    help = 'All required OJT hours have been rendered.';
    banner = '<strong>OJT Period Complete</strong> - weekly journal submission is now closed.';
    submit = false;
  } else if (editing) {
    help = editing.supervisorReview
      ? 'This journal keeps its original week when you resubmit.'
      : 'This draft keeps its week when you submit it.';
    if (editing.supervisorReview) {
      banner = `<strong>Returned for revision</strong> - your supervisor's note: ${escapeHtml(editing.supervisorReview)}`;
    }
  } else if (!state.hasSupervisor) {
    banner = '<strong>Waiting for supervisor assignment</strong> - you can keep writing drafts; submission unlocks once a supervisor is assigned.';
    submit = false;
  } else if (state.returnedForRevision) {
    const id = state.returnedForRevision._id;
    banner = `<strong>${escapeHtml(state.returnedForRevision.week || state.label)} was returned for revision</strong> - open it to revise and resubmit. <button type="button" class="btn-ghost text-xs ml-2" onclick="resumeJournal('${id}')">Revise now</button>`;
    submit = false;
    save = false;
  } else if (state.alreadySubmitted) {
    banner = `<strong>${escapeHtml(state.label)} already submitted</strong> - the next week opens automatically.`;
    submit = false;
    save = false;
  }

  if (helpEl) helpEl.textContent = help;
  setJournalBanner(banner);
  setJournalActions({ submit, save });
}

/**
 * Recompute the automatic week from fresh stats + journals and repaint the
 * form state. Replaces the old week picker.
 */
async function refreshJournalWeek() {
  const weekValueEl = document.getElementById('week-auto-value');
  if (!weekValueEl) return;

  try {
    const [statsResult, journalsResult] = await Promise.all([
      fetchAPI('/stats/student'),
      fetchAPI('/journal/my-journals', { method: 'GET' }),
    ]);

    if (!statsResult || !statsResult.success) {
      console.error('Failed to fetch student data');
      return;
    }

    const journals = journalsResult?.success && Array.isArray(journalsResult.data)
      ? journalsResult.data
      : [];
    journalDownloadCache = journals;

    const { student, stats } = statsResult.data;

    // Keep the week origins in sync so charts, overview and the journal tab
    // all count from the same day.
    window.ojtStartDate = student.supervisorAssignedAt || student.createdAt || window.ojtStartDate;
    window.studentHasSupervisor = !!student.supervisorAssignedAt;

    const hasSupervisor = !!student.supervisorAssignedAt;
    const week = hasSupervisor
      ? ojtWeekNumberFromDate(new Date(), student.supervisorAssignedAt)
      : null;
    const required = Number(stats.totalRequired) || 486;
    const completed = Number(stats.completedHours) || 0;
    const alreadySubmitted = week != null && journals.some(
      (j) => parseJournalWeekNumber(j.week) === week && j.status !== 'draft'
    );
    const returnedForRevision = week != null
      ? journals.find(
          (j) => j.status === 'draft' && j.supervisorReview && parseJournalWeekNumber(j.week) === week
        ) || null
      : null;

    journalWeekState = {
      week,
      label: week ? `Week ${week}` : '—',
      hasSupervisor,
      periodComplete: completed >= required,
      alreadySubmitted,
      returnedForRevision,
      submitEnabled: journalWeekState.submitEnabled,
      saveEnabled: journalWeekState.saveEnabled,
    };

    updateDraftCount(journals);
    renderJournalWeekState();
  } catch (error) {
    console.error('Error refreshing journal week:', error);
  }
}

// Download functions
async function loadPreviousJournals() {
  try {
    const result = await fetchAPI('/journal/my-journals', {
      method: 'GET',
    });

    if (!result || !result.success) {
      console.error('Failed to load journals:', result);
      return;
    }

    const journals = result.data || [];
    journalDownloadCache = journals;

    // Drafts the student is still writing live in their own modal and are
    // invisible to the supervisor and coordinator - keep them out of here too.
    const visible = journals.filter((j) => !isPrivateDraft(j));
    updateDraftCount(journals);

    const journalContainer = document.getElementById('previous-journals-list');

    if (!journalContainer) return;

    if (visible.length === 0) {
      journalContainer.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">No journals submitted yet</p>';
      return;
    }

    // Clear container
    journalContainer.innerHTML = '';

    // Add each journal to the list
    visible.forEach(journal => {
      const returned = journal.status === 'draft' && !!journal.supervisorReview;
      const journalEl = document.createElement('div');
      journalEl.className = 'p-4 rounded-lg bg-white/5 border border-white/10 cursor-pointer hover:bg-white/10 hover:border-teal-400/50 transition group';
      journalEl.innerHTML = `
        <div class="flex items-start justify-between mb-2">
          <div>
            <p class="font-semibold text-sm text-teal-400">${journal.week || 'Week unavailable'}</p>
            <p class="text-xs text-slate-400">Day covered: ${journal.dayCovered || 'Not specified'}</p>
          </div>
          <span class="px-2 py-1 rounded text-xs font-medium ${
            returned ? 'bg-amber-500/20 text-amber-400' :
            journal.status === 'reviewed' ? 'bg-green-500/20 text-green-400' :
            journal.status === 'submitted' ? 'bg-blue-500/20 text-blue-400' :
            'bg-slate-500/20 text-slate-400'
          }">${returned ? 'needs revision' : (journal.status || 'unknown')}</span>
        </div>
        <p class="text-xs text-slate-500 mt-2 group-hover:text-slate-400">${returned ? 'Returned by your supervisor - click to revise' : 'Click to view full content'}</p>
      `;

      journalEl.addEventListener('click', () => showJournalTooltip(journal));

      journalContainer.appendChild(journalEl);
    });

    // Update day tab indicators and progress text. Every entry the student has
    // written counts here - drafts included - because these dots are the form's
    // own progress, not the submitted-journal list.
    const daysWithEntries = {};
    journals.forEach(j => {
      if (j.dayCovered) daysWithEntries[j.dayCovered] = true;
    });
    ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].forEach(day => {
      const dot = document.getElementById(`dot-${day}`);
      if (dot) dot.classList.toggle('filled', Boolean(daysWithEntries[day]));
    });
    updateJournalProgress();
  } catch (error) {
    console.error('Error loading journals:', error);
  }
}

function renderTheoriesList(identifiedTheories) {
  const theoriesResult = document.getElementById('theories-result');
  const theoriesListEl = document.getElementById('theories-list');
  if (!theoriesResult || !theoriesListEl) return;

  const list = Array.isArray(identifiedTheories) ? identifiedTheories : [];
  if (list.length === 0) {
    theoriesListEl.innerHTML = '<p style="color: #cbd5e1; font-size: 13px;">No IT theories or practices were identified in your narrative. Please provide more details about your OJT activities.</p>';
  } else {
    theoriesListEl.innerHTML = list.map((theory) => `
        <div style="padding: 12px; background: rgba(0,200,170,0.05); border-radius: 6px; border-left: 3px solid #00c8aa; margin-bottom: 8px;">
          <p style="margin: 0; font-weight: 600; color: #00c8aa; font-size: 12px;">${theory.course} – ${theory.courseName}</p>
          <p style="margin: 4px 0 0 0; color: #cbd5e1; font-size: 13px;">${theory.category}</p>
          <p style="margin: 6px 0 0 0; color: #cbd5e1; font-size: 13px;">${theory.theory}</p>
        </div>
      `).join('');
  }
  theoriesResult.classList.remove('hidden');
}

// ── Drafts ──────────────────────────────────────────────────────────────────
// Drafts never reach the supervisor or the coordinator, so they get their own
// modal instead of sitting in Previous Journals.

function openDraftsModal() {
  const modal = document.getElementById('journal-drafts-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  renderDraftsList();
}

function closeDraftsModal() {
  const modal = document.getElementById('journal-drafts-modal');
  if (modal) modal.classList.add('hidden');
}

async function renderDraftsList() {
  const list = document.getElementById('journal-drafts-list');
  const hint = document.getElementById('journal-drafts-hint');
  if (!list) return;

  list.innerHTML = '<p class="text-sm text-slate-400">Loading drafts...</p>';

  let journals = journalDownloadCache;
  if (!journals || journals.length === 0) {
    const result = await fetchAPI('/journal/my-journals', { method: 'GET' });
    journals = result?.success && Array.isArray(result.data) ? result.data : [];
    journalDownloadCache = journals;
  }

  const drafts = privateDraftsFrom(journals).slice().sort((a, b) => {
    const aTime = new Date(a.updatedAt || a.submittedAt || 0).getTime();
    const bTime = new Date(b.updatedAt || b.submittedAt || 0).getTime();
    return bTime - aTime;
  });

  if (hint) hint.textContent = 'Drafts stay private to you until you submit them.';

  if (drafts.length === 0) {
    list.innerHTML = '<p class="text-sm text-slate-400">No drafts yet - whatever you write in the journal form is autosaved here.</p>';
    return;
  }

  list.innerHTML = '';
  drafts.forEach((draft) => {
    const savedAt = new Date(draft.updatedAt || draft.submittedAt || Date.now()).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    const row = document.createElement('div');
    row.className = 'download-item draft-item';
    row.innerHTML = `
      <div class="download-item-info">
        <span class="download-item-title">${escapeHtml(draft.week || 'Week assigned on submit')}</span>
        <span class="download-item-sub">${escapeHtml(draft.dayCovered || 'No day yet')} &middot; saved ${savedAt}</span>
      </div>
      <div class="draft-item-actions">
        <button type="button" class="btn-ghost" data-action="resume">Resume</button>
        <button type="button" class="btn-ghost draft-delete" data-action="delete">Delete</button>
      </div>
    `;
    row.querySelector('[data-action="resume"]').addEventListener('click', () => {
      closeDraftsModal();
      resumeJournal(draft._id);
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', () => deleteDraft(draft._id));
    list.appendChild(row);
  });
}

function findCachedJournal(id) {
  return (journalDownloadCache || []).find((j) => j._id === id) || null;
}

/** Open a draft (or a returned journal) in the form to keep writing. */
function resumeJournal(id) {
  const cached = findCachedJournal(id);
  if (cached) {
    loadJournalIntoForm(cached);
    return;
  }
  // Cache is stale (e.g. the modal was opened from the returned banner).
  fetchAPI('/journal/my-journals', { method: 'GET' }).then((result) => {
    if (result?.success && Array.isArray(result.data)) {
      journalDownloadCache = result.data;
      const found = result.data.find((j) => j._id === id);
      if (found) loadJournalIntoForm(found);
      else alert('That journal could not be found.');
    } else {
      alert('That journal could not be found.');
    }
  });
}

function loadJournalIntoForm(journal) {
  currentEditingJournal = journal;

  const narrative = document.getElementById('journal-narrative');
  if (narrative) narrative.value = journal.narrative || '';

  const dayCovered = document.getElementById('day-covered');
  if (dayCovered && journal.dayCovered) dayCovered.value = journal.dayCovered;

  if (journal.photoDataUrl) {
    journalPhotoDataUrl = journal.photoDataUrl;
    const img = document.getElementById('journal-photo-img');
    const placeholder = document.getElementById('journal-photo-placeholder');
    if (img) {
      img.src = journal.photoDataUrl;
      img.classList.remove('hidden');
    }
    if (placeholder) placeholder.classList.add('hidden');
  } else {
    resetJournalPhotoPreview();
  }

  window.currentIdentifiedTheories = Array.isArray(journal.identifiedTheories)
    ? journal.identifiedTheories
    : [];
  renderTheoriesList(window.currentIdentifiedTheories);

  updateJournalWordCount();
  setJournalAutosaveStatus(journal.supervisorReview ? 'Revision loaded' : 'Draft loaded');
  renderJournalWeekState();
}

function clearJournalEditing() {
  currentEditingJournal = null;
  renderJournalWeekState();
}

async function deleteDraft(id) {
  const draft = findCachedJournal(id);
  const label = draft?.week ? draft.week : 'this draft';
  if (!confirm(`Delete ${label}? This cannot be undone.`)) return;

  const result = await fetchAPI(`/journal/draft/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!result || !result.success) {
    alert(result?.message || 'Could not delete this draft.');
    return;
  }

  journalDownloadCache = (journalDownloadCache || []).filter((j) => j._id !== id);
  if (currentEditingJournal && currentEditingJournal._id === id) {
    currentEditingJournal = null;
  }

  updateDraftCount(journalDownloadCache);
  renderDraftsList();
  renderJournalWeekState();
}

async function fetchJournalDownloadData() {
  if (journalDownloadCache.length > 0) return journalDownloadCache;

  const result = await fetchAPI('/journal/my-journals', { method: 'GET' });
  if (!result || !result.success) return [];

  journalDownloadCache = result.data || [];
  return journalDownloadCache;
}

function openJournalDownloadModal() {
  const modal = document.getElementById('journal-download-modal');
  if (!modal) return;

  selectedJournalIds = new Set();
  modal.classList.remove('hidden');
  renderJournalDownloadList();
}

function closeJournalDownloadModal() {
  const modal = document.getElementById('journal-download-modal');
  if (modal) modal.classList.add('hidden');
}

async function renderJournalDownloadList() {
  const list = document.getElementById('journal-download-list');
  if (!list) return;

  list.innerHTML = '<p class="text-sm text-slate-400">Loading journals...</p>';
  // Only handed-in journals can be exported: a draft has no week stamped yet
  // and is still private to the student.
  const journals = (await fetchJournalDownloadData()).filter((j) => !isPrivateDraft(j));

  if (!journals || journals.length === 0) {
    list.innerHTML = '<p class="text-sm text-slate-400">No journals available.</p>';
    updateJournalDownloadActions();
    return;
  }

  list.innerHTML = '';
  journals.forEach((journal) => {
    const date = new Date(journal.submittedAt).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const hasContent = !!(journal.narrative?.trim() || journal.summary?.trim());

    const item = document.createElement('label');
    item.className = `download-item ${hasContent ? '' : 'disabled'}`;
    item.innerHTML = `
      <div class="download-item-info">
        <span class="download-item-title">${journal.week || 'Weekly Journal'}</span>
        <span class="download-item-sub">${date} • ${hasContent ? 'Content available' : 'No content'}</span>
      </div>
      <input type="checkbox" data-id="${journal._id}" ${hasContent ? '' : 'disabled'} />
    `;

    const checkbox = item.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', (event) => {
      const id = event.target.dataset.id;
      if (event.target.checked) {
        if (selectedJournalIds.size >= MAX_JOURNAL_DOWNLOAD) {
          event.target.checked = false;
          return;
        }
        selectedJournalIds.add(id);
      } else {
        selectedJournalIds.delete(id);
      }
      updateJournalDownloadActions();
    });

    list.appendChild(item);
  });

  updateJournalDownloadActions();
}

function updateJournalDownloadActions() {
  const countEl = document.getElementById('journal-download-count');
  const confirmBtn = document.getElementById('journal-download-confirm');
  if (countEl) countEl.textContent = `${selectedJournalIds.size} of ${MAX_JOURNAL_DOWNLOAD} selected`;
  if (confirmBtn) confirmBtn.disabled = selectedJournalIds.size === 0;
}

async function confirmJournalDownload() {
  const journals = await fetchJournalDownloadData();
  const selected = journals.filter((journal) => selectedJournalIds.has(journal._id));

  if (selected.length === 0) {
    alert('Select at least one journal to download.');
    return;
  }

  closeJournalDownloadModal();
  await generateJournalPdf(selected);
}

// Show journal tooltip with full content
function showJournalTooltip(journal) {
  const tooltip = document.getElementById('journal-tooltip');
  const tooltipContent = document.getElementById('journal-tooltip-content');
  if (!tooltip || !tooltipContent) return;
  
  const date = new Date(journal.submittedAt).toLocaleDateString('en-US', { 
    month: 'long', 
    day: 'numeric', 
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const returned = journal.status === 'draft' && !!journal.supervisorReview;
  const statusLabel = returned ? 'needs revision' : journal.status;

  const statusColor = returned ? 'text-amber-400' :
                      journal.status === 'reviewed' ? 'text-green-400' :
                      journal.status === 'submitted' ? 'text-blue-400' :
                      'text-slate-400';

  const statusBgColor = returned ? 'bg-amber-500/20' :
                        journal.status === 'reviewed' ? 'bg-green-500/20' :
                        journal.status === 'submitted' ? 'bg-blue-500/20' :
                        'bg-slate-500/20';

  tooltipContent.innerHTML = `
    <div class="space-y-4">
      <div>
        <h3 class="font-display font-700 text-lg mb-2">${journal.week}</h3>
        <p class="text-xs text-slate-400 mb-3">${date}</p>
        <span class="px-2 py-1 rounded text-xs font-medium ${statusBgColor} ${statusColor}">${statusLabel}</span>
      </div>

      ${returned ? `
        <div class="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
          <p class="text-xs font-semibold text-amber-200 mb-1">SUPERVISOR NOTE</p>
          <p class="text-sm text-amber-100 leading-relaxed">${escapeHtml(journal.supervisorReview)}</p>
        </div>
      ` : ''}

      ${journal.narrative ? `
        <div>
          <p class="text-xs text-slate-400 mb-1 font-semibold">NARRATIVE</p>
          <p class="text-sm text-slate-200 leading-relaxed">${journal.narrative}</p>
        </div>
      ` : ''}

      ${journal.summary ? `
        <div>
          <p class="text-xs text-slate-400 mb-1 font-semibold">SUMMARY</p>
          <p class="text-sm text-slate-200 leading-relaxed">${journal.summary}</p>
        </div>
      ` : ''}

      ${journal.concepts && journal.concepts.length > 0 ? `
        <div>
          <p class="text-xs text-slate-400 mb-2 font-semibold">CONCEPTS APPLIED</p>
          <div class="flex flex-wrap gap-2">
            ${journal.concepts.map(concept => `
              <span class="px-2 py-1 bg-teal-500/20 text-teal-300 rounded text-xs">${concept}</span>
            `).join('')}
          </div>
        </div>
      ` : ''}

      ${returned ? `
        <button type="button" class="btn-primary w-full" onclick="closeJournalTooltip(); resumeJournal('${journal._id}')">
          Revise & Resubmit
        </button>
      ` : ''}
    </div>
  `;

  // Positioning, centering, and the full-screen backdrop are handled entirely
  // by .journal-detail-modal CSS (fixed inset-0, flex-centered). Inline
  // overrides here previously shrank the backdrop (making it overlap page
  // content) and squashed the card into a tall column on mobile.
  tooltip.style.display = ''; // clear any leftover inline display
  tooltip.classList.remove('hidden');
}

// Close journal tooltip
function closeJournalTooltip() {
  const tooltip = document.getElementById('journal-tooltip');
  if (!tooltip) return;
  tooltip.classList.add('hidden');
  tooltip.style.display = ''; // clear inline display so the modal can reopen
}

function setupJournalPhotoUpload() {
  const uploadDiv = document.getElementById('journal-photo-upload');
  const fileInput = document.getElementById('journal-photo');
  const previewImg = document.getElementById('journal-photo-img');
  const placeholder = document.getElementById('journal-photo-placeholder');
  const maxImageMb = 25;
  const maxImageBytes = maxImageMb * 1024 * 1024;

  if (!uploadDiv || !fileInput) return;

  uploadDiv.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      resetJournalPhotoPreview();
      return;
    }

    if (file.size > maxImageBytes) {
      alert(`Image is too large. Maximum size is ${maxImageMb} MB.`);
      resetJournalPhotoPreview();
      return;
    }

    // Compress/resize before storing so the payload stays well under
    // MongoDB's 16MB document limit (raw phone photos can exceed it).
    fileInput.disabled = true;
    try {
      journalPhotoDataUrl = await compressJournalPhoto(file);
      if (previewImg) {
        previewImg.src = journalPhotoDataUrl;
        previewImg.classList.remove('hidden');
      }
      if (placeholder) placeholder.classList.add('hidden');
    } catch (err) {
      console.error('Photo processing failed:', err);
      alert('Could not process the image. Please try a different photo.');
      resetJournalPhotoPreview();
    } finally {
      fileInput.disabled = false;
    }
  });
}

// Resize large photos and re-encode as JPEG so journal submissions stay small
async function compressJournalPhoto(file, { maxDim = 1600, quality = 0.72 } = {}) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  // Already small — keep as-is
  if (file.size <= 300 * 1024) return dataUrl;

  let img;
  try {
    img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataUrl;
    });
  } catch (e) {
    // Browser cannot decode (e.g. HEIC); send original and let the server validate
    return dataUrl;
  }

  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const compressed = canvas.toDataURL('image/jpeg', quality);

  return compressed.length < dataUrl.length ? compressed : dataUrl;
}

function resetJournalPhotoPreview() {
  const fileInput = document.getElementById('journal-photo');
  const previewImg = document.getElementById('journal-photo-img');
  const placeholder = document.getElementById('journal-photo-placeholder');

  journalPhotoDataUrl = null;
  if (fileInput) fileInput.value = '';
  if (previewImg) {
    previewImg.src = '';
    previewImg.classList.add('hidden');
  }
  if (placeholder) placeholder.classList.remove('hidden');
}

function collectSelectedConcepts() {
  return Array.from(document.querySelectorAll('#concepts-list input[type="checkbox"]:checked'))
    .map((checkbox) => {
      const sibling = checkbox.nextElementSibling;
      if (sibling && sibling.tagName === 'SPAN') return sibling.textContent.trim();
      if (sibling && sibling.tagName === 'INPUT') return sibling.value.trim();
      return checkbox.parentElement.textContent.trim();
    })
    .filter((concept) => concept.length > 0);
}

function buildJournalFromForm() {
  return {
    week: (currentEditingJournal && currentEditingJournal.week) || journalWeekState.label || '—',
    narrative: document.getElementById('journal-narrative')?.value || '',
    concepts: collectSelectedConcepts(),
    summary: document.getElementById('summary-text')?.textContent || '',
    submittedAt: new Date().toISOString(),
    photoDataUrl: journalPhotoDataUrl,
  };
}

function ensurePdfRenderContainer(rowCount = 3) {
  // Remove stale container if row count changed
  const existing = document.getElementById('journal-pdf-render');
  if (existing) {
    const currentRows = parseInt(existing.dataset.rowCount || '0', 10);
    if (currentRows !== rowCount) {
      existing.remove();
    } else {
      if (!existing.querySelector('#journal-pdf-hours-spent')) {
        const hoursSpentEl = document.createElement('div');
        hoursSpentEl.id = 'journal-pdf-hours-spent';
        hoursSpentEl.style.position = 'absolute';
        hoursSpentEl.style.fontFamily = 'Arial, sans-serif';
        hoursSpentEl.style.fontWeight = '600';
        hoursSpentEl.style.color = '#0f172a';
        existing.appendChild(hoursSpentEl);
      }
      return existing;
    }
  }

  const layout = JOURNAL_PDF_LAYOUTS[rowCount] || JOURNAL_PDF_LAYOUTS[3];

  const container = document.createElement('div');
  container.id = 'journal-pdf-render';
  container.dataset.rowCount = rowCount;
  container.style.cssText = 'position:fixed;left:-20000px;top:0;background-repeat:no-repeat;background-size:cover;font-family:Arial,sans-serif;color:#0f172a;transform-origin:top left;';

  ['week','date','coverage'].forEach(id => {
    const el = document.createElement('div');
    el.id = `journal-pdf-${id}`;
    el.style.position = 'absolute';
    container.appendChild(el);
  });

  const supervisorSignatureEl = document.createElement('div');
  supervisorSignatureEl.id = 'journal-pdf-supervisor-signature';
  supervisorSignatureEl.style.position = 'absolute';
  supervisorSignatureEl.style.backgroundRepeat = 'no-repeat';
  supervisorSignatureEl.style.backgroundPosition = 'center';
  supervisorSignatureEl.style.backgroundSize = 'contain';
  supervisorSignatureEl.style.pointerEvents = 'none';
  container.appendChild(supervisorSignatureEl);

  const supervisorNameEl = document.createElement('div');
  supervisorNameEl.id = 'journal-pdf-supervisor-name';
  supervisorNameEl.style.position = 'absolute';
  supervisorNameEl.style.fontFamily = 'Arial, sans-serif';
  supervisorNameEl.style.fontWeight = '600';
  supervisorNameEl.style.color = '#111827';
  supervisorNameEl.style.whiteSpace = 'nowrap';
  supervisorNameEl.style.pointerEvents = 'none';
  container.appendChild(supervisorNameEl);

  const hoursSpentEl = document.createElement('div');
  hoursSpentEl.id = 'journal-pdf-hours-spent';
  hoursSpentEl.style.position = 'absolute';
  hoursSpentEl.style.fontFamily = 'Arial, sans-serif';
  hoursSpentEl.style.fontWeight = '600';
  hoursSpentEl.style.color = '#0f172a';
  container.appendChild(hoursSpentEl);

  layout.rows.forEach((_, index) => {
    ['week','photo','summary'].forEach(part => {
      const el = document.createElement('div');
      el.id = `journal-pdf-row-${part}-${index}`;
      el.style.position = 'absolute';
      if (part === 'summary') el.style.whiteSpace = 'pre-wrap';
      if (part === 'photo') {
        el.style.backgroundSize = 'contain';
        el.style.backgroundPosition = 'center';
        el.style.borderRadius = '4px';
      }
      container.appendChild(el);
    });
  });

  document.body.appendChild(container);
  return container;
}

async function loadJournalTemplateBackground(templateName = 'OJT_Weekly_Journal_Template.pdf') {
  if (journalTemplateCache[templateName]) return journalTemplateCache[templateName];
  if (!window.pdfjsLib) return null;

  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.mjs';
  const templateResponse = await fetch(templateName, { cache: 'no-store' });
  if (!templateResponse.ok) return null;

  const templateBytes = await templateResponse.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: templateBytes }).promise;
  const templatePage = await pdf.getPage(1);
  const scale = 2;
  const viewport = templatePage.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await templatePage.render({ canvasContext: context, viewport }).promise;
  const backgroundDataUrl = canvas.toDataURL('image/png');

  journalTemplateCache[templateName] = {
    backgroundDataUrl,
    width: viewport.width,
    height: viewport.height,
    scale,
  };

  return journalTemplateCache[templateName];
}

async function toggleJournalLayoutPreview() {
  const overlay = document.getElementById('journal-layout-preview');
  const content = document.getElementById('journal-layout-preview-content');
  if (!overlay || !content) return;

  if (!overlay.classList.contains('hidden')) {
    overlay.classList.add('hidden');
    return;
  }

  overlay.classList.remove('hidden');
  content.innerHTML = '<p class="text-sm text-slate-400">Loading preview...</p>';

  const journals = await fetchJournalDownloadData();
  const sorted = [...journals].sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
  const rowCount = Math.min(Math.max(sorted.length, 1), MAX_JOURNAL_DOWNLOAD);
  const layout = JOURNAL_PDF_LAYOUTS[rowCount] || JOURNAL_PDF_LAYOUTS[3];
  const templateName = rowCount === 2
    ? 'OJT_Weekly_Journal_Template.2Rows.pdf'
    : 'OJT_Weekly_Journal_Template.pdf';
  const template = await loadJournalTemplateBackground(templateName);
  if (!template) {
    content.innerHTML = '<p class="text-sm text-slate-400">Unable to load template.</p>';
    return;
  }

  const latestDate = sorted.length
    ? new Date(sorted[sorted.length - 1].submittedAt)
    : new Date();
  const latestLabel = latestDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const firstDate = sorted.length
    ? new Date(sorted[0].submittedAt)
    : new Date();
  const firstLabel = firstDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const rows = sorted.slice(0, rowCount).map((journal, index) => ({
    week: journal.week || `Week ${index + 1}`,
    dateLabel: new Date(journal.submittedAt).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
    }),
    summary: journal.summary || 'Summary preview text goes here.',
    photoDataUrl: journal.photoDataUrl || '',
  }));

  const allVerifiedAndSigned = sorted.length > 0 && sorted.every((journal) => journal.supervisorSigned === true);
  const previewJournalSignatureDataUrl = typeof sorted[0]?.supervisorSignature === 'string'
    && sorted[0].supervisorSignature.startsWith('data:image/')
    ? sorted[0].supervisorSignature
    : '';
  const previewSignatureDataUrl = allVerifiedAndSigned
    ? (
        previewJournalSignatureDataUrl ||
        sorted[0]?.supervisorId?.signatureDataUrl ||
        sorted[0]?.supervisor?.signatureDataUrl ||
        window.currentUser?.supervisor?.signatureDataUrl ||
        ''
      )
    : '';
  const previewSupervisorName = allVerifiedAndSigned
    ? (
        sorted[0]?.supervisorId?.fullName ||
        sorted[0]?.supervisor?.fullName ||
        window.currentUser?.supervisor?.fullName ||
        ''
      )
    : '';

  const previewSlice = sorted.slice(0, rowCount);
  const previewHoursTotal = await fetchTotalVerifiedHoursForJournalSelection(previewSlice);
  const previewHoursLabel = previewHoursTotal != null ? previewHoursTotal.toFixed(1) : '—';

  const renderContainer = ensurePdfRenderContainer(rowCount);
  renderContainer.style.position = 'relative';
  renderContainer.style.left = '0';
  renderContainer.style.top = '0';
  renderContainer.style.transform = 'scale(0.85)';
  renderContainer.style.boxShadow = '0 20px 40px rgba(0,0,0,0.35)';

  updateRenderLayout(
    renderContainer,
    template.scale,
    { dataUrl: template.backgroundDataUrl, width: template.width, height: template.height },
    {
      week: weekRangeLabelFromJournals(sorted.slice(0, rowCount)),
      dateLabel: firstLabel,
      coverageLabel: latestLabel,
      rows,
      supervisorSignatureDataUrl: previewSignatureDataUrl,
      supervisorName: previewSupervisorName,
      hoursSpentLabel: previewHoursLabel,
    },
    layout
  );

  content.innerHTML = '';
  content.appendChild(renderContainer);
}

function updateRenderLayout(container, scale, backgroundUrl, journal, layout) {
  // Auto-select layout if not passed
  if (!layout) layout = JOURNAL_PDF_LAYOUTS[journal.rows?.length] || JOURNAL_PDF_LAYOUTS[3];

  container.style.width  = `${backgroundUrl.width}px`;
  container.style.height = `${backgroundUrl.height}px`;
  container.style.backgroundImage = `url(${backgroundUrl.dataUrl})`;

  const weekEl     = container.querySelector('#journal-pdf-week');
  const dateEl     = container.querySelector('#journal-pdf-date');
  const coverageEl = container.querySelector('#journal-pdf-coverage');
  const supervisorSignatureEl = container.querySelector('#journal-pdf-supervisor-signature');
  const supervisorNameEl = container.querySelector('#journal-pdf-supervisor-name');

  weekEl.textContent = journal.week || '—';
  weekEl.style.left     = `${layout.week.x * scale}px`;
  weekEl.style.top      = `${layout.week.y * scale}px`;
  weekEl.style.fontSize = `${layout.week.size * scale}px`;
  weekEl.style.fontWeight = '600';

  dateEl.textContent = journal.dateLabel || '—';
  dateEl.style.left     = `${layout.date.x * scale}px`;
  dateEl.style.top      = `${layout.date.y * scale}px`;
  dateEl.style.fontSize = `${layout.date.size * scale}px`;

  coverageEl.textContent = journal.coverageLabel || '—';
  coverageEl.style.left     = `${layout.coverage.x * scale}px`;
  coverageEl.style.top      = `${layout.coverage.y * scale}px`;
  coverageEl.style.fontSize = `${layout.coverage.size * scale}px`;

  const hoursSpentEl = container.querySelector('#journal-pdf-hours-spent');
  if (hoursSpentEl && layout.hoursSpent) {
    const label = journal.hoursSpentLabel;
    hoursSpentEl.textContent = label != null && label !== '' ? String(label) : '—';
    hoursSpentEl.style.left     = `${layout.hoursSpent.x * scale}px`;
    hoursSpentEl.style.top      = `${layout.hoursSpent.y * scale}px`;
    hoursSpentEl.style.fontSize = `${layout.hoursSpent.size * scale}px`;
  }

  if (supervisorSignatureEl) {
    supervisorSignatureEl.style.left = `${layout.supervisorSignature.x * scale}px`;
    supervisorSignatureEl.style.top = `${layout.supervisorSignature.y * scale}px`;
    supervisorSignatureEl.style.width = `${layout.supervisorSignature.width * scale}px`;
    supervisorSignatureEl.style.height = `${layout.supervisorSignature.height * scale}px`;
    supervisorSignatureEl.style.backgroundImage = journal.supervisorSignatureDataUrl
      ? `url(${journal.supervisorSignatureDataUrl})`
      : 'none';
  }

  if (supervisorNameEl) {
    const nameLayout = layout.supervisorName || { x: layout.supervisorSignature.x + 55, y: layout.supervisorSignature.y + 56, size: 10 };
    supervisorNameEl.textContent = journal.supervisorName || '';
    supervisorNameEl.style.left = `${nameLayout.x * scale}px`;
    supervisorNameEl.style.top = `${nameLayout.y * scale}px`;
    supervisorNameEl.style.fontSize = `${nameLayout.size * scale}px`;
    supervisorNameEl.style.transform = 'translateX(-50%)';
    supervisorNameEl.style.textAlign = 'center';
  }

  layout.rows.forEach((row, index) => {
    const rowWeek    = container.querySelector(`#journal-pdf-row-week-${index}`);
    const rowPhoto   = container.querySelector(`#journal-pdf-row-photo-${index}`);
    const rowSummary = container.querySelector(`#journal-pdf-row-summary-${index}`);
    if (!rowWeek || !rowPhoto || !rowSummary) return;

    const entry = journal.rows?.[index];
    if (!entry) {
      rowWeek.textContent = '';
      rowSummary.textContent = '';
      rowPhoto.style.backgroundImage = 'none';
      return;
    }

    // Date label
    rowWeek.textContent  = entry.dateLabel || entry.week || '';
    rowWeek.style.left   = `${row.date.x * scale}px`;
    rowWeek.style.top    = `${row.date.y * scale}px`;
    rowWeek.style.fontSize = `${row.date.size * scale}px`;

    // Summary with auto-fit
    const sw = row.summary.maxWidth  * scale;
    const sh = row.summary.maxHeight * scale;
    const fitted = fitSummaryText(
      entry.summary || '',
      sw, sh,
      row.summary.size * scale,
      row.summary.lineHeight * scale,
      'Arial'
    );
    rowSummary.textContent       = fitted.text;
    rowSummary.style.left        = `${row.summary.x * scale}px`;
    rowSummary.style.top         = `${row.summary.y * scale}px`;
    rowSummary.style.fontSize    = `${fitted.fontSize}px`;
    rowSummary.style.lineHeight  = `${fitted.lineHeight}px`;
    rowSummary.style.width       = `${sw}px`;
    rowSummary.style.maxHeight   = `${sh}px`;
    rowSummary.style.overflow    = 'visible';
    rowSummary.style.whiteSpace  = 'pre-wrap';
    rowSummary.style.wordBreak   = 'break-word';
    rowSummary.style.overflowWrap = 'break-word';

    // Photo
    rowPhoto.style.left            = `${row.photo.x * scale}px`;
    rowPhoto.style.top             = `${row.photo.y * scale}px`;
    rowPhoto.style.width           = `${row.photo.width  * scale}px`;
    rowPhoto.style.height          = `${row.photo.height * scale}px`;
    rowPhoto.style.overflow        = 'hidden';
    rowPhoto.style.backgroundColor = '#ffffff';
    rowPhoto.style.backgroundImage = entry.photoDataUrl ? `url(${entry.photoDataUrl})` : 'none';
    rowPhoto.style.backgroundRepeat = 'no-repeat';
  });
}


function downloadDTRPDF() {
  alert('Downloading DTR for April 2026...\nFile: DTR_April_2026.pdf');
  // In real implementation, this would generate and download actual PDF
}

async function downloadJournalPDF() {
  openJournalDownloadModal();
}

async function generateJournalPdf(journals) {
  try {
    if (!window.pdfjsLib || !window.html2canvas || !window.jspdf) {
      alert('PDF tools are not available. Please refresh the page.');
      return;
    }

    const rowCount    = Math.min(journals.length, 3);           // 1–3 rows
    const layout      = JOURNAL_PDF_LAYOUTS[rowCount] || JOURNAL_PDF_LAYOUTS[3];
    const templateName = rowCount === 2
      ? 'OJT_Weekly_Journal_Template.2Rows.pdf'
      : 'OJT_Weekly_Journal_Template.pdf';

    const template = await loadJournalTemplateBackground(templateName);
    if (!template) { alert('Unable to load the PDF template.'); return; }

    const renderContainer = ensurePdfRenderContainer(rowCount);   // ← row-aware
    const pageWidth  = template.width  / template.scale;
    const pageHeight = template.height / template.scale;
    const { jsPDF }  = window.jspdf;
    const output     = new jsPDF({ orientation: 'p', unit: 'pt', format: [pageWidth, pageHeight] });

    const sorted = [...journals].sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
    const fmt    = d => new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const firstLabel  = sorted.length ? fmt(sorted[0].submittedAt)                    : '—';
    const latestLabel = sorted.length ? fmt(sorted[sorted.length - 1].submittedAt)    : '—';

    const rows = sorted.slice(0, rowCount).map(journal => {
      // Use narrative as the main content; summary is optional
      const content = (journal.narrative?.trim() || journal.summary?.trim() || 'No entry content');
      return {
        week:        journal.week || '',
        dateLabel:   fmt(journal.submittedAt),
        summary:     content,
        photoDataUrl: journal.photoDataUrl || '',
      };
    });

    const allVerifiedAndSigned = journals.every((journal) => journal.supervisorSigned === true);
    const journalSignatureDataUrl = typeof sorted[0]?.supervisorSignature === 'string'
      && sorted[0].supervisorSignature.startsWith('data:image/')
      ? sorted[0].supervisorSignature
      : '';
    const signatureDataUrl = allVerifiedAndSigned
      ? (
          journalSignatureDataUrl ||
          sorted[0]?.supervisorId?.signatureDataUrl ||
          sorted[0]?.supervisor?.signatureDataUrl ||
          window.currentUser?.supervisor?.signatureDataUrl ||
          ''
        )
      : '';
    const supervisorName = allVerifiedAndSigned
      ? (
          sorted[0]?.supervisorId?.fullName ||
          sorted[0]?.supervisor?.fullName ||
          window.currentUser?.supervisor?.fullName ||
          ''
        )
      : '';

    const hoursTotal = await fetchTotalVerifiedHoursForJournalSelection(sorted);
    const hoursSpentLabel = hoursTotal != null ? hoursTotal.toFixed(1) : '—';

    updateRenderLayout(
      renderContainer, template.scale,
      { dataUrl: template.backgroundDataUrl, width: template.width, height: template.height },
      {
        week: weekRangeLabelFromJournals(sorted),
        dateLabel: firstLabel,
        coverageLabel: latestLabel,
        rows,
        supervisorSignatureDataUrl: signatureDataUrl,
        supervisorName,
        hoursSpentLabel,
      },
      layout   // ← pass layout explicitly
    );

    const rendered = await window.html2canvas(renderContainer, { scale: 1, useCORS: true, backgroundColor: null });
    output.addImage(rendered.toDataURL('image/png'), 'PNG', 0, 0, pageWidth, pageHeight);
    output.save('Weekly_Journal.pdf');
  } catch (error) {
    console.error('Error generating journal PDF:', error);
    if (error?.message === 'Missing summary') { alert('One or more journals are missing an AI summary.'); return; }
    alert('Failed to generate the journal PDF. Please try again.');
  }
}

function downloadAppraisalPDF() {
  alert('Downloading Performance Appraisal Form...\nFile: Performance_Appraisal_April_2026.pdf');
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

// Logout
function logout() {
  VerificationModal.open({
    type: 'confirm',
    mode: 'immediate',
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

// Set today's date in duty log
function setTodayDate() {
  const dateInput = document.getElementById('dutylog-date');
  if (dateInput) {
    const today = new Date().toISOString().split('T')[0];
    dateInput.value = today;
  }
}

// Profile photo upload
function setupProfilePhotoUpload() {
  const uploadDiv = document.querySelector('.profile-photo-upload');
  const fileInput = document.getElementById('profile-photo');

  if (uploadDiv && fileInput) {
    uploadDiv.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        alert('Profile photo updated successfully!');
      }
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// QR SCANNING & DTR FUNCTIONS
// ────────────────────────────────────────────────────────────────────────────

let qrTimerInterval = null;

async function refreshQRCode() {
  try {
    // Don't try to refresh if already timed out
    if (window.qrDisabled) {
      console.log('QR generation disabled - trainee already timed out for today');
      return;
    }

    const companyName = window.currentUser?.companyName;
    
    console.log('QR Refresh:', { 
      companyName, 
      userId: window.currentUser?._id,
      fullName: window.currentUser?.fullName 
    });

    // Show loading state
    const qrStatus = document.getElementById('qr-load-status');
    if (qrStatus) qrStatus.textContent = 'Loading QR code...';

    if (!companyName) {
      const msg = 'Company not assigned to user';
      console.warn(msg);
      if (qrStatus) qrStatus.textContent = '❌ ' + msg;
      return;
    }

    // Build endpoint - only include traineeId and supervisorId if they exist and are valid
    let endpoint = `/qr/generate?companyName=${encodeURIComponent(companyName)}`;
    if (window.currentUser?._id && window.currentUser._id !== 'undefined') {
      endpoint += `&traineeId=${window.currentUser._id}`;
      endpoint += `&supervisorId=${window.currentUser._id}`;
    }
    
    console.log('Calling endpoint:', endpoint);
    
    const response = await fetchAPI(endpoint);
    
    console.log('QR API Response:', response);

    if (response?.success && response?.data) {
      displayQRCode(response.data);
      startQRTimer(response.data.expiresAt);
      // Clear any "already timed out" state if QR generation succeeds
      window.qrDisabled = false;
    } else {
      const errorMsg = response?.error || 'Unknown error generating QR';
      console.error('QR generation failed:', errorMsg);
      
      // Check if trainee already timed out for the day
      if (response?.alreadyTimedOut) {
        window.qrDisabled = true;
        const refreshBtn = document.getElementById('qr-refresh-btn');
        const timerBox = document.getElementById('qr-timer-box');
        
        // Disable refresh button
        if (refreshBtn) {
          refreshBtn.disabled = true;
          refreshBtn.style.opacity = '0.5';
          refreshBtn.style.cursor = 'not-allowed';
        }
        
        // Update timer box to show completion message
        if (timerBox) {
          timerBox.style.background = 'rgba(34, 197, 94, 0.1)';
          timerBox.style.borderColor = 'rgba(34, 197, 94, 0.3)';
          timerBox.style.color = '#22c55e';
          timerBox.innerHTML = '<p style="margin: 0; font-weight: 600;">✅ Completed for Today</p><p style="margin: 5px 0 0 0; font-size: 11px;">No QR code available until tomorrow</p>';
        }
        
        if (qrStatus) {
          qrStatus.innerHTML = `
            <div style="padding: 15px; border-radius: 8px; background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3);">
              <p style="color: #22c55e; font-weight: 600; margin: 0 0 5px 0;">✅ Time Out Completed</p>
              <p style="color: #cbd5e1; font-size: 12px; margin: 0;">You have already completed your time in and time out for today. No new QR code can be generated until tomorrow.</p>
            </div>
          `;
        }
      } else {
        if (qrStatus) qrStatus.textContent = `❌ ${errorMsg}`;
      }
    }
  } catch (error) {
    console.error('QR refresh error:', error);
    const qrStatus = document.getElementById('qr-load-status');
    if (qrStatus) qrStatus.textContent = `❌ Error: ${error.message}`;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GEOFENCE TRACKING FUNCTIONS
// ────────────────────────────────────────────────────────────────────────────

let currentCoordinates = null;
let geolocationWatchId = null;
let geofenceCheckInterval = null;

/**
 * Get current user's company ID from the database
 */
async function getUserCompanyId() {
  try {
    if (!window.currentUser?._id) return null;

    const response = await fetchAPI('/stats/student');
    if (response && response.success && response.data?.student) {
      const student = response.data.student;
      const company = student.company || student.companyId || null;
      return typeof company === 'object' ? company._id || null : company;
    }

    return window.currentUser.companyId || null;
  } catch (error) {
    console.error('[Geofence] Error getting company ID:', error);
    return null;
  }
}

/**
 * Request user's geolocation permission and start tracking
 */
async function initializeGeolocation() {
  try {
    if (!navigator.geolocation) {
      showNotification('Error', 'Geolocation is not supported by your browser', 'error');
      console.error('[Geofence] Geolocation not supported');
      return false;
    }

    console.log('[Geofence] Requesting geolocation permission...');
    
    // Request high accuracy for better geofencing
    const options = {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    };

    // Start watching position
    geolocationWatchId = navigator.geolocation.watchPosition(
      (position) => handleGeolocationSuccess(position),
      (error) => handleGeolocationError(error),
      options
    );

    // Also get immediate position
    navigator.geolocation.getCurrentPosition(
      (position) => handleGeolocationSuccess(position),
      (error) => handleGeolocationError(error),
      options
    );

    return true;
  } catch (error) {
    console.error('[Geofence] Error initializing geolocation:', error);
    return false;
  }
}

/**
 * Handle successful geolocation update
 */
function handleGeolocationSuccess(position) {
  const { latitude, longitude, accuracy } = position.coords;
  currentCoordinates = { latitude, longitude, accuracy };

  console.log('[Geofence] Position updated:', {
    latitude: latitude.toFixed(6),
    longitude: longitude.toFixed(6),
    accuracy: Math.round(accuracy) + 'm',
  });

  // Update UI with coordinates
  updateGeofenceStatus();
}

/**
 * Handle geolocation errors
 */
function handleGeolocationError(error) {
  let message = 'Unable to get your location';
  
  switch (error.code) {
    case error.PERMISSION_DENIED:
      message = 'Location permission denied. Please enable it in your browser settings.';
      break;
    case error.POSITION_UNAVAILABLE:
      message = 'Location information is unavailable.';
      break;
    case error.TIMEOUT:
      message = 'Location request timed out. Please try again.';
      break;
  }

  console.error('[Geofence] Geolocation error:', message, error);
  updateGeofenceStatusUI('error', message);
}

/**
 * Format a 24h "HH:MM" schedule time as a 12-hour display string.
 * e.g. "17:00" -> "5:00 PM"
 */
function formatScheduleTime(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return hhmm || '—';
  const match = hhmm.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return hhmm;
  let hour = parseInt(match[1], 10);
  const minute = match[2];
  const period = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${period}`;
}

/**
 * Show the supervisor-set time in the DTR tab.
 * Before the student clocks out → shows the scheduled time out.
 * After the student clocks out → shows the scheduled time in.
 */
function updateSupervisorScheduleInfo(schedule) {
  const infoBox = document.getElementById('supervisor-time-out-info');
  const valueEl = document.getElementById('supervisor-time-out-value');
  const labelEl = document.getElementById('supervisor-schedule-label');
  if (!infoBox || !valueEl) return;

  const punchState = window.dtrPunchState || {};
  const isTimedOut = !!punchState.hasTimedOut;
  const timeValue = isTimedOut ? schedule?.startTime : schedule?.endTime;

  if (!timeValue) {
    infoBox.style.display = 'none';
    valueEl.textContent = '—';
    return;
  }

  if (labelEl) {
    labelEl.textContent = isTimedOut ? 'Time in set by supervisor' : 'Time out set by supervisor';
  }
  valueEl.textContent = formatScheduleTime(timeValue);
  infoBox.style.display = 'flex';
}

/**
 * Client's UTC offset in minutes, east-positive (UTC+8 => 480, UTC-5 => -300).
 * Browsers expose it west-positive, so negate getTimezoneOffset().
 * Sent with geofence requests so the server validates the attendance timing in
 * the STUDENT's own timezone.
 */
function getClientTimezoneOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

/**
 * Check whether time-in/out is currently allowed for an action.
 * With no supervisor schedule, the action is always allowed.
 * Time-in: blocked only BEFORE the scheduled start; any arrival at/after the
 * start is allowed (and flagged late when after the start). Time-out: opens
 * 10 minutes before the scheduled end so trainees cannot leave early.
 * @param {Object|null} scheduleTimes - { startTime, endTime }
 * @param {'time-in'|'time-out'} action
 */
function getScheduleWindowState(scheduleTimes, action) {
  if (!scheduleTimes) return { allowed: true, late: false, lateMinutes: 0, reason: 'no_schedule' };

  const timeStr = action === 'time-in' ? scheduleTimes.startTime : scheduleTimes.endTime;
  if (!timeStr) return { allowed: true, late: false, lateMinutes: 0, reason: 'no_time' };

  const match = String(timeStr).match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return { allowed: true, late: false, lateMinutes: 0, reason: 'invalid_time' };

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const scheduledMinutes = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  const label = action === 'time-in' ? 'time in' : 'time out';
  const verb = action === 'time-in' ? 'Time in' : 'Time out';

  if (action === 'time-in') {
    const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const deltaSeconds = nowSeconds - scheduledMinutes * 60;
    if (deltaSeconds < 0) {
      return { allowed: false, late: false, lateMinutes: 0, reason: 'too_early', message: `${verb} opens at the scheduled start (${timeStr})` };
    }
    // 120 s grace matches the server: a punch at exactly the scheduled time
    // (12:20 for a 12:20 start) is NEVER late — device/server clock skew and
    // the last seconds of the scheduled minute are covered. More than 2 min
    // after the start is a LATE time-in.
    const late = deltaSeconds > 120;
    const lateMinutes = late ? Math.max(1, Math.round(deltaSeconds / 60)) : 0;
    return {
      allowed: true,
      late,
      lateMinutes,
      reason: late ? 'late' : 'on_time',
      message: late
        ? `Timed in ${lateMinutes} min after the scheduled start`
        : `Within ${label} window`,
    };
  }

  const windowStart = scheduledMinutes - 10;
  const allowed = currentMinutes >= windowStart;
  return {
    allowed,
    late: false,
    lateMinutes: 0,
    reason: allowed ? 'within_window' : 'too_early',
    message: allowed ? `Within ${label} window` : `${verb} opens 10 minutes before the scheduled ${label}`,
  };
}

/**
 * Set an attendance button's enabled/locked state.
 * - unlocked (allowed) → .btn-attendance-enabled (bright + pulse)
 * - locked (blocked)   → .btn-attendance-disabled (dark + pulse)
 * Never touches `display`, so visibility stays managed separately.
 */
function setAttendanceButtonState(btn, allowed) {
  if (!btn) return;
  const on = !!allowed;
  btn.classList.remove(on ? 'btn-attendance-disabled' : 'btn-attendance-enabled');
  btn.classList.add(on ? 'btn-attendance-enabled' : 'btn-attendance-disabled');
  btn.disabled = !on;
  btn.style.cursor = on ? 'pointer' : 'not-allowed';
}

/**
 * Validate geofence and update UI
 */
async function updateGeofenceStatus() {
  if (!currentCoordinates) {
    updateGeofenceStatusUI('locating', 'Locating...');
    return;
  }

  try {
    const companyId = await getUserCompanyId();
    if (!companyId) {
      updateGeofenceStatusUI('error', 'Company not assigned');
      return;
    }

    // Call geofence validation endpoint
    const response = await fetchAPI('/geofence/validate', {
      method: 'POST',
      body: JSON.stringify({
        companyId,
        traineeCoordinates: currentCoordinates,
        timezoneOffsetMinutes: getClientTimezoneOffsetMinutes(),
      }),
    });

    if (!response || !response.success) {
      updateGeofenceStatusUI('error', 'Validation failed');
      return;
    }

    const { geofence, schedule, scheduleTimes } = response.data;
    window.supervisorScheduleTimes = scheduleTimes;

    // Show the supervisor-set time on the DTR tab (time out, or time in after clocking out)
    updateSupervisorScheduleInfo(scheduleTimes);

    // Out of range → show the distance message and lock the buttons
    if (!geofence.isInRange) {
      updateGeofenceStatusUI('out-of-range', geofence.message, geofence, schedule);
      return;
    }

    // In range → green status, then enforce the schedule on the buttons.
    // Time-in opens at the scheduled start and stays open (late arrivals are
    // allowed and flagged late); time-out opens near the scheduled end.
    updateGeofenceStatusUI('in-range', geofence.message, geofence, schedule);

    const timeInBtn = document.getElementById('time-in-btn');
    const timeOutBtn = document.getElementById('time-out-btn');
    const timeInWindow = getScheduleWindowState(scheduleTimes, 'time-in');
    const timeOutWindow = getScheduleWindowState(scheduleTimes, 'time-out');

    if (timeInBtn && timeInBtn.style.display !== 'none') {
      setAttendanceButtonState(timeInBtn, timeInWindow.allowed);
    }
    if (timeOutBtn && timeOutBtn.style.display !== 'none') {
      setAttendanceButtonState(timeOutBtn, timeOutWindow.allowed);
    }
  } catch (error) {
    console.error('[Geofence] Error updating status:', error);
    updateGeofenceStatusUI('error', 'Error validating location');
  }
}

/**
 * Update geofence status UI
 */
function updateGeofenceStatusUI(status, message, geofenceData = null, scheduleData = null) {
  const indicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const distanceInfo = document.getElementById('distance-info');
  const accuracyInfo = document.getElementById('accuracy-info');
  const timeInBtn = document.getElementById('time-in-btn');
  const timeOutBtn = document.getElementById('time-out-btn');
  const geofenceInfo = document.getElementById('geofence-info');
  const geofenceMessage = document.getElementById('geofence-message');
  const loadStatus = document.getElementById('geofence-load-status');
  const distanceSub = document.getElementById('distance-sub');
  const distanceFill = document.getElementById('distance-fill');

  // Reset classes (checking = locating/validating, amber)
  indicator.classList.remove('in-range', 'out-of-range', 'checking');
  statusText.classList.remove('in-range', 'out-of-range', 'checking');

  // Update status
  switch (status) {
    case 'in-range':
      indicator.classList.add('in-range');
      statusText.classList.add('in-range');
      // The badge already carries the glyph, so the label stays clean text.
      statusText.textContent = 'In Range';
      // Button enable/lock is handled by the schedule-window logic AFTER
      // this call; do NOT force-enable here.
      if (loadStatus) {
        loadStatus.textContent = message || 'Within the company geofence.';
      }
      geofenceInfo.style.display = 'none';
      break;

    case 'out-of-range':
      indicator.classList.add('out-of-range');
      statusText.classList.add('out-of-range');
      statusText.textContent = 'Out of Range';
      setAttendanceButtonState(timeInBtn, false);
      setAttendanceButtonState(timeOutBtn, false);
      // The detail box below carries the message, so the supporting line is
      // cleared to avoid saying the same thing twice.
      if (loadStatus) loadStatus.textContent = '';
      geofenceInfo.style.display = 'block';
      geofenceMessage.textContent = message;
      break;

    case 'locating':
      indicator.classList.add('checking');
      statusText.classList.add('checking');
      statusText.textContent = message;
      if (loadStatus) {
        loadStatus.textContent = 'Checking your position against the company geofence…';
      }
      timeInBtn.disabled = true;
      geofenceInfo.style.display = 'none';
      break;

    case 'error':
    default:
      // Unavailable reads as the same red state as out of range.
      indicator.classList.add('out-of-range');
      statusText.classList.add('out-of-range');
      statusText.textContent = 'Error';
      if (loadStatus) loadStatus.textContent = '';
      timeInBtn.disabled = true;
      geofenceInfo.style.display = 'block';
      geofenceMessage.textContent = message;
  }

  // Update distance and accuracy info
  const hasMetrics = !!(geofenceData
    && currentCoordinates
    && geofenceData.distanceMeters != null
    && geofenceData.radiusMeters != null);

  if (hasMetrics) {
    const distanceMeters = Number(geofenceData.distanceMeters);
    const radiusMeters = Number(geofenceData.radiusMeters);

    distanceInfo.textContent = `${distanceMeters}m`;
    distanceSub.textContent = `of ${radiusMeters}m allowed`;
    accuracyInfo.textContent = `±${Math.round(currentCoordinates.accuracy)}m`;

    // Fill = distance against the allowed radius. The far edge of the track IS
    // the geofence boundary, so clamping at 100% reads as "at or beyond it".
    distanceFill.style.width = radiusMeters > 0
      ? `${Math.min(100, (distanceMeters / radiusMeters) * 100)}%`
      : '0%';
  } else {
    distanceInfo.textContent = '—';
    distanceSub.textContent = 'radius not confirmed';
    accuracyInfo.textContent = '—';
    distanceFill.style.width = '0%';
  }
}

/**
 * Refresh geolocation
 */
function refreshGeolocation() {
  console.log('[Geofence] Manual refresh requested');
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => handleGeolocationSuccess(position),
      (error) => handleGeolocationError(error),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }
}

/**
 * Record time in with geolocation. Late arrivals are allowed: the time-in is
 * recorded with status "late" and the supervisor is notified of the lateness.
 */
async function recordTimeIn() {
  if (!currentCoordinates) {
    showNotification('Error', 'Unable to get your location', 'error');
    return;
  }

  // Guard: never allow clocking before the scheduled start, even if the
  // button was somehow force-clicked while disabled. Late arrivals pass.
  const timeInWindow = getScheduleWindowState(window.supervisorScheduleTimes, 'time-in');
  if (!timeInWindow.allowed) {
    showNotification('Locked', timeInWindow.message || 'Time in is currently locked', 'error');
    return;
  }

  try {
    const companyId = await getUserCompanyId();
    if (!companyId) {
      showNotification('Error', 'Company not assigned', 'error');
      return;
    }

    // Show loading state
    const btn = document.getElementById('time-in-btn');
    const originalText = btn.textContent;
    btn.textContent = '⏳ Recording...';
    btn.disabled = true;

    const response = await fetchAPI('/geofence/time-in', {
      method: 'POST',
      body: JSON.stringify({
        companyId,
        coordinates: currentCoordinates,
        timezoneOffsetMinutes: getClientTimezoneOffsetMinutes(),
      }),
    });

    btn.textContent = originalText;
    btn.disabled = false;

    if (!response || !response.success) {
      showNotification('Error', response?.message || 'Failed to record time in', 'error');
      return;
    }

    if (response.data && response.data.late) {
      const mins = Number(response.data.lateMinutes) || 0;
      showNotification('Success', `✓ Time In Recorded — ${mins} min after your scheduled start (supervisor notified)`, 'success');
    } else {
      showNotification('Success', '✓ Time In Recorded', 'success');
    }
    console.log('[Geofence] Time In recorded:', response.data);

    // Update UI to show time out button
    btn.style.display = 'none';
    document.getElementById('time-out-btn').style.display = 'block';

    // Refresh DTR records / re-apply the correct locked state
    await loadDTRRecords();
    loadTodayDTRSummary();
  } catch (error) {
    showNotification('Error', error.message || 'Error recording time in', 'error');
    console.error('[Geofence] Error recording time in:', error);
  }
}

/**
 * Record time out with geolocation
 */
async function recordTimeOut() {
  if (!currentCoordinates) {
    showNotification('Error', 'Unable to get your location', 'error');
    return;
  }

  // Guard: never allow clocking before the scheduled end window, even if the
  // button was somehow force-clicked while disabled.
  const timeOutWindow = getScheduleWindowState(window.supervisorScheduleTimes, 'time-out');
  if (!timeOutWindow.allowed) {
    showNotification('Locked', timeOutWindow.message || 'Time out is currently locked', 'error');
    return;
  }

  try {
    const companyId = await getUserCompanyId();
    if (!companyId) {
      showNotification('Error', 'Company not assigned', 'error');
      return;
    }

    // Show loading state
    const btn = document.getElementById('time-out-btn');
    const originalText = btn.textContent;
    btn.textContent = '⏳ Recording...';
    btn.disabled = true;

    const response = await fetchAPI('/geofence/time-out', {
      method: 'POST',
      body: JSON.stringify({
        companyId,
        coordinates: currentCoordinates,
        timezoneOffsetMinutes: getClientTimezoneOffsetMinutes(),
      }),
    });

    btn.textContent = originalText;
    btn.disabled = false;

    if (!response || !response.success) {
      showNotification('Error', response?.message || 'Failed to record time out', 'error');
      return;
    }

    showNotification('Success', '✓ Time Out Recorded', 'success');
    console.log('[Geofence] Time Out recorded:', response.data);

    // Update UI to show time in button again
    document.getElementById('time-in-btn').style.display = 'block';
    btn.style.display = 'none';

    // Refresh DTR records / re-apply the correct locked state
    await loadDTRRecords();
    loadTodayDTRSummary();
  } catch (error) {
    showNotification('Error', error.message || 'Error recording time out', 'error');
    console.error('[Geofence] Error recording time out:', error);
  }
}

/**
 * Load today's DTR summary
 */
async function loadTodayDTRSummary() {
  try {
    const response = await fetchAPI('/geofence/today-status');
    if (!response || !response.success) return;

    const { hasTimedIn, hasTimedOut, dtr, schedule } = response.data;
    window.dtrPunchState = { hasTimedIn, hasTimedOut };

    // Show the supervisor-set time on the DTR tab (time out, or time in after clocking out)
    updateSupervisorScheduleInfo(schedule);
    window.supervisorScheduleTimes = schedule?.startTime || schedule?.endTime ? schedule : window.supervisorScheduleTimes;

    if (dtr) {
      document.getElementById('today-time-in').textContent = dtr.timeIn ? new Date(dtr.timeIn).toLocaleTimeString() : '—';
      document.getElementById('today-time-out').textContent = dtr.timeOut ? new Date(dtr.timeOut).toLocaleTimeString() : '—';
      document.getElementById('today-hours').textContent = dtr.hoursRendered?.toFixed(2) || '0';
    }

    // Update button visibility AND apply the correct locked/enabled state
    const timeInBtn = document.getElementById('time-in-btn');
    const timeOutBtn = document.getElementById('time-out-btn');

    // Determine which button is visible (in-range state was already checked by updateGeofenceStatus)
    const showTimeIn = !hasTimedIn || hasTimedOut;
    timeInBtn.style.display = showTimeIn ? 'block' : 'none';
    timeOutBtn.style.display = (showTimeIn ? 'none' : 'block');

    // Apply the schedule-window lock to whichever button is visible
    const timeInWindow = getScheduleWindowState(window.supervisorScheduleTimes, 'time-in');
    const timeOutWindow = getScheduleWindowState(window.supervisorScheduleTimes, 'time-out');

    if (!hasTimedIn || hasTimedOut) {
      setAttendanceButtonState(timeInBtn, timeInWindow.allowed);
    }
    if (hasTimedIn && !hasTimedOut) {
      setAttendanceButtonState(timeOutBtn, timeOutWindow.allowed);
    }
  } catch (error) {
    console.error('[Geofence] Error loading today status:', error);
  }
}

function displayQRCode(qrData) {

  const qrImage = document.getElementById('qr-image');
  const qrStatus = document.getElementById('qr-load-status');
  
  console.log('Display QR Code:', { qrData, hasImage: !!qrData?.qrImage });

  if (!qrImage || !qrStatus) {
    console.warn('QR display elements not found');
    return;
  }

  if (!qrData || !qrData.qrImage) {
    qrStatus.textContent = '❌ Invalid QR data received';
    qrImage.style.display = 'none';
    return;
  }

  qrImage.src = qrData.qrImage;
  qrImage.onload = () => {
    console.log('QR image loaded successfully');
    qrImage.style.display = 'block';
    qrStatus.style.display = 'none';
  };
  qrImage.onerror = () => {
    console.error('Failed to load QR image');
    qrStatus.textContent = '❌ Failed to load QR image';
    qrImage.style.display = 'none';
  };
}

function startQRTimer(expiresAt) {
  // Clear existing timer
  if (qrTimerInterval) clearInterval(qrTimerInterval);

  // Don't start timer if QR is disabled (trainee already timed out)
  if (window.qrDisabled) {
    document.getElementById('qr-timer').textContent = '—';
    return;
  }

  const updateTimer = () => {
    const now = new Date();
    const expiry = new Date(expiresAt);
    const diff = expiry - now;

    if (diff <= 0) {
      document.getElementById('qr-timer').textContent = '0:00';
      clearInterval(qrTimerInterval);
      // Auto-refresh when expired, but only if QR is not disabled
      if (!window.qrDisabled) {
        setTimeout(refreshQRCode, 500);
      }
      return;
    }

    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    document.getElementById('qr-timer').textContent = 
      `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  updateTimer();
  qrTimerInterval = setInterval(updateTimer, 1000);
}

async function loadDTRRecords() {
  try {
    // Ensure user is loaded
    if (!window.currentUser?._id) {
      console.warn('User ID not available yet');
      return;
    }

    const monthInput = document.getElementById('dtr-month');
    const currentMonth = new Date().toISOString().slice(0, 7);
    const month = monthInput?.value || currentMonth;
    if (monthInput && !monthInput.value) {
      monthInput.value = month;
    }
    const [year, monthNum] = month.split('-');
    
    const startDate = new Date(year, parseInt(monthNum) - 1, 1).toISOString();
    const endDate = new Date(year, parseInt(monthNum), 0, 23, 59, 59).toISOString();

    const response = await fetch(
      `${API_BASE}/qr/dtr/${window.currentUser._id}?startDate=${startDate}&endDate=${endDate}&limit=100`,
      { headers: getAuthHeaders() }
    );
    const result = await response.json();

    if (result.success) {
      populateDTRTable(result.data);
      updateMonthlyStats(result.data);
      loadTodaysSummary();
    }
  } catch (error) {
    console.error('Failed to load DTR records:', error);
  }
}

async function loadTodaysSummary() {
  try {
    if (!window.currentUser?._id) return;

    // Get today's date range
    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59).toISOString();

    const response = await fetch(
      `${API_BASE}/qr/dtr/${window.currentUser._id}?startDate=${startOfToday}&endDate=${endOfToday}&limit=1`,
      { headers: getAuthHeaders() }
    );
    const result = await response.json();

    if (result.success && result.data.length > 0) {
      const todayRecord = result.data[0];
      
      // Format time in
      const timeIn = todayRecord.timeIn 
        ? new Date(todayRecord.timeIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
        : '—';
      
      // Format time out
      const timeOut = todayRecord.timeOut 
        ? new Date(todayRecord.timeOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
        : '—';

      // Update display
      document.getElementById('today-time-in').textContent = timeIn;
      const timeInStatusEl = document.getElementById('today-time-in-status');
      if (timeInStatusEl) {
        const rawStatus = String(todayRecord.status || '').toLowerCase();
        timeInStatusEl.textContent = !todayRecord.timeIn
          ? 'Not recorded'
          : rawStatus === 'late' ? 'recorded (late)' : 'recorded';
      }
      
      document.getElementById('today-time-out').textContent = timeOut;
      document.getElementById('today-time-out-status').textContent = todayRecord.timeOut ? 'recorded' : 'pending';
      
      const hoursRendered = Number.isFinite(todayRecord.hoursRendered) ? todayRecord.hoursRendered : 0;
      document.getElementById('today-hours').textContent = hoursRendered.toFixed(2);

      console.log('Today\'s Summary:', { timeIn, timeOut, hours: todayRecord.hoursRendered.toFixed(2) });
    } else {
      // No records for today
      document.getElementById('today-time-in').textContent = '—';
      document.getElementById('today-time-in-status').textContent = 'Not recorded';
      document.getElementById('today-time-out').textContent = '—';
      document.getElementById('today-time-out-status').textContent = 'Not recorded';
      document.getElementById('today-hours').textContent = '0';
    }
  } catch (error) {
    console.error('Failed to load today\'s summary:', error);
  }
}

/**
 * Refresh DTR data for the current month - called when stats update
 * Ensures DTR tab shows latest records without manual refresh
 */
async function refreshDTRData() {
  try {
    console.log('🔄 Refreshing DTR data from stats update...');
    
    if (!window.currentUser?._id) {
      console.warn('❌ User ID not available for DTR refresh');
      return;
    }

    const today = new Date();
    const currentMonth = today.toISOString().slice(0, 7);
    
    // Update the month input if it exists
    const monthInput = document.getElementById('dtr-month');
    if (monthInput) {
      monthInput.value = currentMonth;
      console.log('✅ Set DTR month to:', currentMonth);
    } else {
      console.warn('⚠️ dtr-month element not found');
    }

    // Fetch current month's records
    const [year, monthNum] = currentMonth.split('-');
    const startDate = new Date(year, parseInt(monthNum) - 1, 1).toISOString();
    const endDate = new Date(year, parseInt(monthNum), 0, 23, 59, 59).toISOString();

    console.log('📅 Fetching DTR records from', startDate.substring(0, 10), 'to', endDate.substring(0, 10));

    const response = await fetch(
      `${API_BASE}/qr/dtr/${window.currentUser._id}?startDate=${startDate}&endDate=${endDate}&limit=100`,
      { headers: getAuthHeaders() }
    );
    
    if (!response.ok) {
      console.error('❌ DTR fetch failed with status:', response.status);
      return;
    }

    const result = await response.json();

    if (result.success) {
      console.log('✅ DTR refresh successful, records:', result.data.length);
      populateDTRTable(result.data);
      console.log('✅ DTR table populated');
      
      updateMonthlyStats(result.data);
      console.log('✅ Monthly stats updated');
      
      loadTodaysSummary();
      console.log('✅ Today\'s summary loaded');
    } else {
      console.warn('⚠️ DTR refresh returned no success:', result);
    }
  } catch (error) {
    console.error('❌ Error refreshing DTR data:', error);
  }
}

function updateMonthlyStats(records) {
  // Calculate stats from verified DTR records ONLY
  let totalHours = 0;
  let daysWorked = 0;
  let verifiedRecords = 0;
  
  const uniqueDays = new Set();

  records.forEach(record => {
    // Only count VERIFIED records
    if (record.verifiedBySupervisor) {
      // Sum hours for verified records
      totalHours += record.hoursRendered || 0;

      // Count days worked (exclude absent days, count unique days only)
      const dateKey = new Date(record.date).toDateString();
      if (!uniqueDays.has(dateKey) && record.status !== 'absent' && record.hoursRendered > 0) {
        uniqueDays.add(dateKey);
        daysWorked++;
      }

      // Count verified records
      verifiedRecords++;
    }
  });

  // Calculate average hours per day
  const avgHoursPerDay = daysWorked > 0 ? totalHours / daysWorked : 0;

  // Update summary display
  document.getElementById('stat-hours-completed').textContent = totalHours.toFixed(1);
  document.getElementById('stat-days-worked').textContent = daysWorked;
  document.getElementById('stat-avg-hours').textContent = avgHoursPerDay.toFixed(1);
  document.getElementById('stat-verified').textContent = verifiedRecords;

  // Update progress bar based on completed hours vs required
  const trainee = window.currentUser;
  const requiredHours = trainee?.requiredHours || 486; // Default to 486
  const progress = (totalHours / requiredHours) * 100;
  
  document.getElementById('progress-percent').textContent = `${Math.round(Math.min(progress, 100))}%`;
  document.getElementById('progress-fill').style.width = `${Math.min(progress, 100)}%`;
  
  // Update stats subtitle
  const statsRequiredEl = document.getElementById('stat-hours-required');
  if (statsRequiredEl) {
    statsRequiredEl.textContent = `of ${requiredHours} required`;
  }

  console.log('DTR Stats:', { totalHours, daysWorked, avgHoursPerDay, verifiedRecords });
}

function populateDTRTable(records) {
  const tbody = document.getElementById('dtr-table-body');
  if (!tbody) return;

  if (records.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-500">No records for this period</td></tr>';
    return;
  }

  // Sort records by date (newest first) and show only the 10 most recent
  const sortedRecords = records.sort((a, b) => new Date(b.date) - new Date(a.date));
  const displayRecords = sortedRecords.slice(0, 10);

  tbody.innerHTML = displayRecords.map(record => {
    const date = new Date(record.date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const timeIn = record.timeIn 
      ? new Date(record.timeIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : '—';
    const timeOut = record.timeOut 
      ? new Date(record.timeOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : '—';
    
    // Determine status based on verification
    let displayStatus = 'Unverified';
    let statusColor = '#94a3b8'; // Gray for unverified
    
    if (record.verifiedBySupervisor) {
      // Show actual status only if verified; fall back to Present when missing
      const rawStatus = typeof record.status === 'string' ? record.status : '';
      const normalizedStatus = rawStatus ? rawStatus.toLowerCase() : 'present';
      displayStatus = normalizedStatus.charAt(0).toUpperCase() + normalizedStatus.slice(1);
      const statusColors = {
        present: '#22c55e',
        late: '#f59e0b',
        absent: '#ef4444',
        excused: '#8b5cf6',
      };
      statusColor = statusColors[normalizedStatus] || '#94a3b8';
    }

    return `
      <tr class="border-b border-white/10 hover:bg-white/5 transition">
        <td class="py-3 px-4">${date}</td>
        <td class="py-3 px-4">${timeIn}</td>
        <td class="py-3 px-4">${timeOut}</td>
        <td class="py-3 px-4 font-semibold">${(Number.isFinite(record.hoursRendered) ? record.hoursRendered : 0).toFixed(2)}h</td>
        <td class="py-3 px-4">
          <span style="display: inline-block; padding: 4px 8px; border-radius: 4px; background: ${statusColor}20; color: ${statusColor}; font-size: 11px; font-weight: 600; text-transform: uppercase;">
            ${displayStatus}
          </span>
        </td>
        <td class="py-3 px-4">${record.verifiedBySupervisor ? '✅' : '⏳'}</td>
      </tr>
    `;
  }).join('');

  // Store all records for the modal
  window.allDTRRecords = sortedRecords;
}

// Modal functions for viewing all records
function openAllRecordsModal() {
  const modal = document.getElementById('all-records-modal');
  if (!modal) return;

  modal.classList.remove('hidden');
  
  // Get the selected month from the filter
  const monthInput = document.getElementById('dtr-month');
  const month = monthInput?.value || new Date().toISOString().slice(0, 7);
  const [year, monthNum] = month.split('-');
  
  const startDate = new Date(year, parseInt(monthNum) - 1, 1);
  const endDate = new Date(year, parseInt(monthNum), 0, 23, 59, 59);

  // Filter records for the selected month
  const allRecords = window.allDTRRecords || [];
  const filteredRecords = allRecords.filter(record => {
    const recordDate = new Date(record.date);
    return recordDate >= startDate && recordDate <= endDate;
  });

  populateAllRecordsTable(filteredRecords);
}

function closeAllRecordsModal() {
  const modal = document.getElementById('all-records-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

function populateAllRecordsTable(records) {
  const tbody = document.getElementById('all-records-table-body');
  if (!tbody) return;

  if (records.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-500">No records for this month</td></tr>';
    return;
  }

  tbody.innerHTML = records.map(record => {
    const date = new Date(record.date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const timeIn = record.timeIn 
      ? new Date(record.timeIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : '—';
    const timeOut = record.timeOut 
      ? new Date(record.timeOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : '—';
    
    // Determine status based on verification
    let displayStatus = 'Unverified';
    let statusColor = '#94a3b8'; // Gray for unverified
    
    if (record.verifiedBySupervisor) {
      const rawStatus = typeof record.status === 'string' ? record.status : '';
      const normalizedStatus = rawStatus ? rawStatus.toLowerCase() : 'present';
      displayStatus = normalizedStatus.charAt(0).toUpperCase() + normalizedStatus.slice(1);
      const statusColors = {
        present: '#22c55e',
        late: '#f59e0b',
        absent: '#ef4444',
        excused: '#8b5cf6',
      };
      statusColor = statusColors[normalizedStatus] || '#94a3b8';
    }

    return `
      <tr class="border-b border-white/10 hover:bg-white/5 transition">
        <td class="py-3 px-4">${date}</td>
        <td class="py-3 px-4">${timeIn}</td>
        <td class="py-3 px-4">${timeOut}</td>
        <td class="py-3 px-4 font-semibold">${(Number.isFinite(record.hoursRendered) ? record.hoursRendered : 0).toFixed(2)}h</td>
        <td class="py-3 px-4">
          <span style="display: inline-block; padding: 4px 8px; border-radius: 4px; background: ${statusColor}20; color: ${statusColor}; font-size: 11px; font-weight: 600; text-transform: uppercase;">
            ${displayStatus}
          </span>
        </td>
        <td class="py-3 px-4">${record.verifiedBySupervisor ? '✅' : '⏳'}</td>
      </tr>
    `;
  }).join('');
}

// Close modal when clicking outside
document.addEventListener('click', (e) => {
  const modal = document.getElementById('all-records-modal');
  if (modal && e.target === modal) {
    closeAllRecordsModal();
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  initializeTheme();
  
  // Set user name from stored user data
  const userName = window.currentUser?.fullName?.split(' ')[0] || 'Student';
  const userNameEl = document.getElementById('user-name');
  if (userNameEl) {
    userNameEl.textContent = userName;
  }

  // Update date/time
  updateDateTime();
  setInterval(updateDateTime, 60000);

  // Attendance Calendar: month navigation and tap-to-expand day detail. Both
  // are delegated so the handlers survive the grid being re-rendered, and both
  // are keyboard reachable because the controls are real buttons.
  initOverviewCalendar();

  // Load student dashboard data from backend
  await loadDashboardData();

  // Notifications: fetch on load so the badge is correct before the bell is
  // ever clicked, then keep it fresh in the background.
  loadOJTNotifications({ silent: true });
  startNotificationPolling();

  // Restore previous tab from localStorage or default to overview
  const previousTab = localStorage.getItem('trackit_current_tab') || 'overview';
  switchTab(previousTab);

  // Generate DTR calendar
  generateDTRCalendar();

  // Initialize Geofence Tracking (replacing QR Code)
  await initializeGeolocation();
  await loadTodayDTRSummary();
  
  // Update geofence status periodically
  setInterval(updateGeofenceStatus, 5000); // Update every 5 seconds
  
  await loadDTRRecords();

  // Set default month to current month
  const today = new Date();
  const monthInput = document.getElementById('dtr-month');
  if (monthInput) {
    monthInput.value = today.toISOString().slice(0, 7);
  }

  // Initialize chart on page load and when progress tab is clicked
  let chartInitialized = false;
  const initChart = () => {
    if (!chartInitialized) {
      setTimeout(() => {
        initWeeklyChart();
        chartInitialized = true;
      }, 100);
    }
  };

  // Initialize chart on page load
  initChart();

  // Also initialize chart when progress tab is clicked
  const progressLink = document.querySelector('[onclick*="progress"]');
  if (progressLink) {
    progressLink.addEventListener('click', initChart);
  }

  // Setup profile photo upload
  setupProfilePhotoUpload();
  setupJournalPhotoUpload();

  // Start DTR polling to detect time in/out changes and auto-refresh
  startDTRPolling();

  // Add event listeners to nav links for active state
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
});

// Scroll navbar effect
window.addEventListener('scroll', () => {
  const navbar = document.getElementById('navbar');
  if (window.scrollY > 10) {
    navbar.classList.add('scrolled');
  } else {
    navbar.classList.remove('scrolled');
  }
});

// ── Weekly Journal enhancements ─────────────────────────────────────────────

let journalAutosaveTimer = null;
let journalLastSavedAt = null;

function initJournalTabs() {
  document.querySelectorAll('.journal-day-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.journal-day-tab').forEach(t => t.setAttribute('aria-selected', 'false'));
      tab.setAttribute('aria-selected', 'true');
      const dayCovered = document.getElementById('day-covered');
      if (dayCovered) dayCovered.value = tab.dataset.day || '';
    });
  });
}

function updateJournalWordCount() {
  const textarea = document.getElementById('journal-narrative');
  const counter = document.getElementById('journal-word-count');
  if (!textarea || !counter) return;
  const words = (textarea.value || '').trim().split(/\s+/).filter(w => w.length > 0);
  counter.textContent = `${words.length} words`;
}

function updateJournalProgress() {
  const filled = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
    .filter(d => document.getElementById(`dot-${d}`)?.classList.contains('filled')).length;
  const text = document.getElementById('journal-progress-text');
  if (text) text.textContent = `${filled} / 5 days filled`;
}

function setJournalAutosaveStatus(text) {
  const el = document.getElementById('journal-autosave-status');
  if (el) el.textContent = text;
}

async function saveJournalDraft() {
  // While a fresh draft is blocked (already submitted, or a revision is
  // pending for this week) the banner on the form explains why.
  if (!journalWeekState.saveEnabled && !currentEditingJournal) return;

  // Nothing worth storing yet - an empty form must not litter the drafts list.
  const narrativeValue = document.getElementById('journal-narrative')?.value || '';
  if (!currentEditingJournal && !narrativeValue.trim() && !journalPhotoDataUrl) return;

  setJournalAutosaveStatus('Saving...');
  try {
    const result = await fetchAPI('/journal/draft', {
      method: 'POST',
      body: JSON.stringify({
        // Resuming a draft or revising a returned journal keeps its own week.
        journalId: currentEditingJournal ? currentEditingJournal._id : undefined,
        dayCovered: document.getElementById('day-covered')?.value || null,
        narrative: document.getElementById('journal-narrative')?.value || '',
        identifiedTheories: window.currentIdentifiedTheories || [],
        photoDataUrl: journalPhotoDataUrl,
      }),
    });
    if (result && result.success) {
      journalLastSavedAt = new Date();
      setJournalAutosaveStatus('Saved just now');
      // Pin the form to the saved document so every later autosave updates the
      // same draft instead of looking for a fresh one.
      if (result.data && result.data._id) {
        currentEditingJournal = result.data;
      }
      upsertJournalCache(result.data);
      updateDraftCount(journalDownloadCache);
      renderJournalWeekState();
    } else {
      setJournalAutosaveStatus(result?.message ? `Not saved - ${result.message}` : 'Unable to save');
    }
  } catch (err) {
    setJournalAutosaveStatus('Unable to save');
  }
}

/** Keep the cached journal list in step with a just-saved document. */
function upsertJournalCache(saved) {
  if (!saved || !saved._id) return;
  const index = journalDownloadCache.findIndex((j) => j._id === saved._id);
  if (index >= 0) journalDownloadCache[index] = saved;
  else journalDownloadCache.unshift(saved);
}

function scheduleJournalAutosave() {
  setJournalAutosaveStatus('Saving...');
  if (journalAutosaveTimer) clearTimeout(journalAutosaveTimer);
  journalAutosaveTimer = setTimeout(() => {
    saveJournalDraft();
  }, 2000);
}

function initJournalAutosave() {
  const narrative = document.getElementById('journal-narrative');
  if (narrative) {
    narrative.addEventListener('input', () => {
      updateJournalWordCount();
      scheduleJournalAutosave();
    });
  }

  const dayCovered = document.getElementById('day-covered');
  if (dayCovered) {
    dayCovered.addEventListener('change', scheduleJournalAutosave);
  }
}

// Refresh the "Saved X ago" text once a minute.
setInterval(() => {
  if (!journalLastSavedAt) return;
  const diff = Date.now() - journalLastSavedAt.getTime();
  if (diff < 60000) {
    setJournalAutosaveStatus('Saved just now');
  } else {
    const mins = Math.floor(diff / 60000);
    setJournalAutosaveStatus(`Saved ${mins} min ago`);
  }
}, 30000);

// Review step before submission
function openJournalReview() {
  if (!journalWeekState.submitEnabled) {
    const banner = document.getElementById('journal-block-banner');
    showNotification(
      'Notice',
      banner && banner.textContent.trim()
        ? banner.textContent.trim()
        : 'Journal submission is not available right now.',
      'info'
    );
    return;
  }

  const week = (currentEditingJournal && currentEditingJournal.week) || journalWeekState.label || '—';
  const dayCovered = document.getElementById('day-covered')?.value || '—';
  const narrative = document.getElementById('journal-narrative')?.value || '';
  const words = narrative.trim().split(/\s+/).filter(w => w.length > 0).length;

  const content = document.getElementById('journal-review-content');
  if (!content) return;
  content.innerHTML = `
    <div><p class="text-xs text-slate-400 mb-1">Week</p><p class="text-sm font-semibold">${escapeHtml(week)}</p></div>
    <div><p class="text-xs text-slate-400 mb-1">Day Covered</p><p class="text-sm font-semibold">${escapeHtml(dayCovered)}</p></div>
    <div><p class="text-xs text-slate-400 mb-1">Narrative</p><p class="text-sm text-slate-200 leading-relaxed">${escapeHtml(narrative.slice(0, 500))}${narrative.length > 500 ? '…' : ''}</p></div>
    <div><p class="text-xs text-slate-400 mb-1">Word Count</p><p class="text-sm font-semibold">${words} words</p></div>
  `;

  const modal = document.getElementById('journal-review-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeJournalReview() {
  const modal = document.getElementById('journal-review-modal');
  if (modal) modal.classList.add('hidden');
}

function confirmJournalSubmit() {
  closeJournalReview();
  const form = document.getElementById('journal-form');
  if (form) form.dispatchEvent(new Event('submit', { cancelable: true }));
}

// Patch the submit handler to validate through the review modal.
const originalSubmitJournal = typeof submitJournal === 'function' ? submitJournal : null;

// Init on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initJournalTabs();
  initJournalAutosave();
  updateJournalWordCount();
  updateJournalProgress();
});

// Mark day tabs with filled dots based on existing journals.
const originalLoadPreviousJournals = typeof loadPreviousJournals === 'function' ? loadPreviousJournals : null;

// Close review modal on outside click
document.addEventListener('click', (e) => {
  const modal = document.getElementById('journal-review-modal');
  if (modal && !modal.classList.contains('hidden') && e.target === modal) {
    closeJournalReview();
  }
});


