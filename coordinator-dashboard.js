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
  const bgColor = type === 'success' ? 'rgba(34, 197, 94, 0.1)' : type === 'error' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(59, 130, 246, 0.1)';
  const borderColor = type === 'success' ? 'rgba(34, 197, 94, 0.3)' : type === 'error' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(59, 130, 246, 0.3)';
  const textColor = type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : '#3b82f6';

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
    <p style="margin: 0; font-weight: 600; font-size: 14px;">${title}</p>
    <p style="margin: 5px 0 0 0; font-size: 12px; color: #cbd5e1;">${message}</p>
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

function toggleNotifications() {
  const popup = document.getElementById('notif-popup');
  if (!popup) return;
  
  if (notifPopupOpen) {
    popup.style.display = 'none';
    notifPopupOpen = false;
  } else {
    popup.style.display = 'flex';
    notifPopupOpen = true;
    loadCoordinatorNotifications();
  }
}

function closeNotifications() {
  const popup = document.getElementById('notif-popup');
  if (popup) popup.style.display = 'none';
  notifPopupOpen = false;
}

function clearAllNotifications() {
  coordinatorNotifications = [];
  renderNotificationList();
  updateNotifBadge();
}

function dismissNotification(id) {
  coordinatorNotifications = coordinatorNotifications.filter(n => n.id !== id);
  renderNotificationList();
  updateNotifBadge();
}

function updateNotifBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  
  const unreadCount = coordinatorNotifications.filter(n => n.unread).length;
  if (unreadCount > 0) {
    badge.style.display = 'flex';
    badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
  } else {
    badge.style.display = 'none';
  }
}

async function loadCoordinatorNotifications() {
  if (coordinatorNotifications.length > 0) {
    renderNotificationList();
    return;
  }
  
  try {
    const result = await fetchAPI('/actions?type=all&limit=10');
    if (result && result.success) {
      coordinatorNotifications = result.data || [];
      renderNotificationList();
      updateNotifBadge();
    }
  } catch (error) {
    console.error('Error loading notifications:', error);
  }
}

function renderNotificationList() {
  const list = document.getElementById('notif-list');
  if (!list) return;
  
  if (coordinatorNotifications.length === 0) {
    list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
    return;
  }
  
  list.innerHTML = coordinatorNotifications.map(n => `
    <div class="notif-item ${n.unread ? 'unread' : ''}" data-id="${n.id}">
      <div class="notif-icon ${n.type || 'system'}">
        ${getNotifIcon(n.type)}
      </div>
      <div class="notif-content">
        <p class="notif-text">${escapeHtml(n.message || n.text || 'Notification')}</p>
        <p class="notif-time">${timeAgo(n.createdAt || n.time)}</p>
      </div>
      <button class="notif-close" onclick="event.stopPropagation(); dismissNotification('${n.id}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  `).join('');
  
  // Click to mark as read
  list.querySelectorAll('.notif-item').forEach(item => {
    item.addEventListener('click', function() {
      const id = this.dataset.id;
      const notif = coordinatorNotifications.find(n => n.id === id);
      if (notif) {
        notif.unread = false;
        updateNotifBadge();
        renderNotificationList();
      }
    });
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

async function loadDashboardData() {
  // Update profile info from stored user
  if (window.currentUser) {
    const profileNameEl = document.getElementById('coord-name');
    if (profileNameEl) profileNameEl.value = window.currentUser.fullName || '';

    const profileEmailEl = document.getElementById('coord-email');
    if (profileEmailEl) profileEmailEl.value = window.currentUser.email || '';

    const profileDeptEl = document.getElementById('coord-dept');
    if (profileDeptEl) profileDeptEl.value = window.currentUser.department || '';
  }

  // Fetch real stats from MongoDB
  const result = await fetchAPI('/stats/coordinator');
  if (!result || !result.success) return;

  const { stats, departmentBreakdown, recentRegistrations, trainees } = result.data;

  // Store stats for chart rendering
  window.overviewStats = stats;

  // Initialize overview charts with trainees data
  setTimeout(() => {
    initOverviewCharts(stats, trainees);
  }, 100);

  // Populate overview trainee list
  const traineeList = el('overview-trainee-list');
  if (traineeList) {
    if (trainees.length === 0) {
      traineeList.innerHTML = '<p class="text-slate-500 text-sm text-center py-6">No trainees registered yet</p>';
    } else {
      traineeList.innerHTML = trainees.map(t => `
        <div class="trainee-progress-item">
          <div class="flex items-center justify-between mb-2">
            <div>
              <p class="text-sm font-semibold text-white">${t.fullName}</p>
              <p class="text-xs text-slate-500">${t.companyName || 'No company'} • ${t.department || '—'}</p>
            </div>
            <span class="status-badge ${t.isActive ? 'status-active' : 'status-inactive'}">${t.isActive ? 'Active' : 'Inactive'}</span>
          </div>
        </div>
      `).join('');
    }
  }

  // Populate recent registrations
  const recentList = el('recent-registrations');
  if (recentList) {
    if (recentRegistrations.length === 0) {
      recentList.innerHTML = '<p class="text-slate-500 text-sm text-center py-6">No recent registrations</p>';
    } else {
      recentList.innerHTML = recentRegistrations.map(r => {
        const date = new Date(r.createdAt);
        const timeAgo = getTimeAgo(date);
        return `
          <div class="flex gap-3">
            <div class="flex-shrink-0 w-2 h-2 rounded-full bg-purple-400 mt-1.5"></div>
            <div>
              <p class="text-sm font-semibold text-white">${r.fullName}</p>
              <p class="text-xs text-slate-400">${r.department || '—'} • ${r.companyName || 'No company'}</p>
              <p class="text-xs text-slate-500 mt-1">${timeAgo}</p>
            </div>
          </div>
        `;
      }).join('');
    }
  }

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

function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

// ────────────────────────────────────────────────────────────────────────────
// TAB SWITCHING
// ────────────────────────────────────────────────────────────────────────────

let tabHistory = [];
let currentTab = null;

function switchTab(tabName, options = {}) {
  const { fromHistory = false, direction = 'forward' } = options;
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

async function loadTrainees() {
  const tbody = document.getElementById('trainees-table-body');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-500">Loading trainees...</td></tr>';

  const result = await fetchAPI('/coordinator/trainees');

  if (!result || !result.success) {
    tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-500">Failed to load trainees. Make sure the server is running.</td></tr>';
    return;
  }

  if (result.data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-500">No trainees registered yet.</td></tr>';
    return;
  }

  tbody.innerHTML = result.data.map(trainee => {
    const supervisorName = trainee.supervisorId
      ? `<span class="text-teal-400 font-semibold">${trainee.supervisorId.fullName}</span><br><span class="text-xs text-slate-500">${trainee.supervisorId.companyName || ''}</span>`
      : '<span class="text-yellow-400/70 text-xs">Unassigned</span>';

    const completedHours = trainee.completedHours || 0;
    const requiredHours = trainee.requiredHours || 486;
    const remainingHours = Math.max(0, requiredHours - completedHours);
    const hoursPercentage = Math.round((completedHours / requiredHours) * 100);

    return `
      <tr class="border-b border-white/10 hover:bg-white/5 transition">
        <td class="py-3 px-4">${trainee.fullName}</td>
        <td class="py-3 px-4">${trainee.studentId || '—'}</td>
        <td class="py-3 px-4">${trainee.department || '—'}</td>
        <td class="py-3 px-4">${trainee.companyName || '—'}</td>
        <td class="py-3 px-4">${supervisorName}</td>
        <td class="py-3 px-4">
          <div class="text-sm">
            <div class="font-semibold text-white mb-1">${completedHours.toFixed(1)}/${requiredHours} hrs</div>
            <div class="text-xs text-slate-400">${remainingHours.toFixed(1)} hrs left</div>
            <div class="w-20 h-2 bg-white/10 rounded-full mt-2 overflow-hidden">
              <div class="h-full bg-gradient-to-r from-teal-400 to-teal-500" style="width: ${hoursPercentage}%"></div>
            </div>
          </div>
        </td>
        <td class="py-3 px-4">
          <button onclick="openAssignModal('${trainee._id}', '${trainee.fullName.replace(/'/g, "\\'")}')"
            class="text-teal-400 hover:text-teal-300 text-xs font-semibold">
            ${trainee.supervisorId ? 'Reassign' : 'Assign Supervisor'}
          </button>
        </td>
      </tr>
    `;
  }).join('');
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

  // Show modal
  document.getElementById('assign-supervisor-modal').classList.remove('hidden');

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
    alert('Please select a supervisor');
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
    alert(result.message);
    closeAssignModal();
    loadTrainees(); // Refresh the table
  } else {
    alert(result?.message || 'Failed to assign supervisor');
  }
}

function closeAssignModal() {
  document.getElementById('assign-supervisor-modal').classList.add('hidden');
}

function applyTraineeFilters() {
  const search = document.getElementById('trainee-search').value.toLowerCase();
  const dept = document.getElementById('dept-filter').value;

  const rows = document.querySelectorAll('#trainees-table-body tr');
  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 5) return; // skip the "loading" row

    const name = cells[0].textContent.toLowerCase();
    const studentId = cells[1].textContent.toLowerCase();
    const department = cells[2].textContent;

    let show = true;
    if (search && !name.includes(search) && !studentId.includes(search)) show = false;
    if (dept !== 'All Departments' && department !== dept) show = false;

    row.style.display = show ? '' : 'none';
  });
}

function setupFilterListeners() {
  const searchInput = document.getElementById('trainee-search');
  const deptFilter = document.getElementById('dept-filter');

  if (searchInput) {
    searchInput.addEventListener('input', applyTraineeFilters);
  }
  if (deptFilter) {
    deptFilter.addEventListener('change', applyTraineeFilters);
  }
}

function viewTraineeProfile(traineeId) {
  alert(`Viewing profile for trainee: ${traineeId}`);
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

async function loadCoordinatorJournals(defaultFilter = 'pending') {
  const journalList = document.getElementById('journal-list');
  if (journalList) {
    journalList.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">Loading journals...</p>';
  }

  const [pendingResult, approvedResult, returnedResult] = await Promise.all([
    fetchAPI('/coordinator/journals'),
    fetchAPI('/coordinator/journals/approved'),
    fetchAPI('/coordinator/journals/returned')
  ]);

  journalDataCache.pending = pendingResult?.success ? (pendingResult.data || []) : [];
  journalDataCache.approved = approvedResult?.success ? (approvedResult.data || []) : [];
  journalDataCache.returned = returnedResult?.success ? (returnedResult.data || []) : [];

  updateJournalCounts();
  filterJournals(null, defaultFilter);
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
          ? `<p class="text-xs text-teal-300 mt-1">💡 ${identifiedTheories.length} theory${identifiedTheories.length === 1 ? '' : 's'} identified</p>`
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
                <input type="checkbox" checked disabled class="w-4 h-4 accent-teal-400">
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
                const accents = ['#00c8aa', '#38bdf8', '#a78bfa', '#fbbf24', '#f472b6'];
                const accent = accents[index % accents.length];
                return `
                <div style="padding: 10px 14px; background: linear-gradient(135deg, rgba(255,255,255,0.04), ${accent}0f); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;">
                  <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                    <span style="font-weight: 600; color: ${accent}; font-size: 12px;">${escapeHtml(theory.course || '')} – ${escapeHtml(theory.courseName || '')}</span>
                    <span style="font-size: 10px; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.07); color: #94a3b8; border: 1px solid rgba(255,255,255,0.08);">${escapeHtml(theory.category || '')}</span>
                  </div>
                  <p style="margin: 5px 0 0 0; color: #e2e8f0; font-size: 13px; line-height: 1.5; font-style: italic;">${escapeHtml(theory.theory || '')}</p>
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

async function approveJournal(journalId) {
  const remarks = prompt('Optional approval remarks:') || '';

  const result = await fetchAPI(`/coordinator/journals/${journalId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ remarks })
  });

  if (!result || !result.success) {
    showNotification('Error', result?.message || 'Failed to approve journal', 'error');
    return;
  }

  showNotification('Success', 'Journal approved successfully', 'success');
  await loadCoordinatorJournals('pending');
}

async function returnJournal(journalId) {
  const feedback = prompt('Enter feedback for supervisor:');
  if (!feedback || !feedback.trim()) {
    return;
  }

  const result = await fetchAPI(`/coordinator/journals/${journalId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ remarks: feedback.trim() })
  });

  if (!result || !result.success) {
    showNotification('Error', result?.message || 'Failed to return journal', 'error');
    return;
  }

  showNotification('Success', 'Journal returned to supervisor', 'success');
  await loadCoordinatorJournals('pending');
}

function downloadJournal(journalId) {
  alert(`Downloading journal: ${journalId}.pdf`);
}

// ────────────────────────────────────────────────────────────────────────────
// OVERVIEW ANALYTICS CHARTS
// ────────────────────────────────────────────────────────────────────────────

function initOverviewCharts(stats, trainees = []) {
  // Key Metrics Bar Chart
  const metricsCtx = document.getElementById('overviewMetricsChart');
  if (metricsCtx && !window.overviewMetricsChartInit) {
    new Chart(metricsCtx, {
      type: 'bar',
      data: {
        labels: ['Total Enrolled', 'Active', 'Supervisors', 'Companies'],
        datasets: [{
          label: 'Count',
          data: [stats.totalStudents, stats.activeStudents, stats.supervisorCount, stats.companyCount],
          backgroundColor: [
            'rgba(0, 200, 170, 0.7)',
            'rgba(34, 197, 94, 0.7)',
            'rgba(59, 130, 246, 0.7)',
            'rgba(168, 85, 247, 0.7)'
          ],
          borderColor: [
            'rgba(0, 200, 170, 1)',
            'rgba(34, 197, 94, 1)',
            'rgba(59, 130, 246, 1)',
            'rgba(168, 85, 247, 1)'
          ],
          borderWidth: 2,
          borderRadius: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, labels: { color: 'rgba(203, 213, 225, 0.8)' } }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: 'rgba(203, 213, 225, 0.6)' }
          },
          x: {
            grid: { display: false },
            ticks: { color: 'rgba(203, 213, 225, 0.6)' }
          }
        }
      }
    });
    window.overviewMetricsChartInit = true;
  }

  // Top Trainees Bar Chart (by completed hours)
  const topTraineesCtx = document.getElementById('topTraineesChart');
  if (topTraineesCtx && !window.topTraineesChartInit) {
    // Sort trainees by completed hours (descending) and get top 5
    const topTrainees = [...trainees]
      .sort((a, b) => (b.completedHours || 0) - (a.completedHours || 0))
      .slice(0, 5);

    const labels = topTrainees.map(t => t.fullName.split(' ')[0]); // First name only
    const data = topTrainees.map(t => t.completedHours || 0);

    new Chart(topTraineesCtx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Completed Hours',
          data: data,
          backgroundColor: 'rgba(0, 200, 170, 0.7)',
          borderColor: 'rgba(0, 200, 170, 1)',
          borderWidth: 2,
          borderRadius: 8
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, labels: { color: 'rgba(203, 213, 225, 0.8)' } }
        },
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: 'rgba(203, 213, 225, 0.6)' }
          },
          y: {
            grid: { display: false },
            ticks: { color: 'rgba(203, 213, 225, 0.6)' }
          }
        }
      }
    });
    window.topTraineesChartInit = true;
  }
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
    backgroundColor: 'rgba(0, 200, 170, 0.3)',
    borderColor: 'rgba(0, 200, 170, 1)',
    borderWidth: 2,
    borderRadius: 8,
  };

  if (window.analyticsCharts?.hoursChart) {
    window.analyticsCharts.hoursChart.data.labels = labels;
    window.analyticsCharts.hoursChart.data.datasets = [dataset];
    window.analyticsCharts.hoursChart.update();
    return;
  }

  window.analyticsCharts = window.analyticsCharts || {};
  window.analyticsCharts.hoursChart = new Chart(hoursCtx, {
    type: 'bar',
    data: {
      labels,
      datasets: [dataset],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: 'rgba(203, 213, 225, 0.6)' },
        },
        y: {
          grid: { display: false },
          ticks: { color: 'rgba(203, 213, 225, 0.6)' },
        },
      },
    },
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

  const dataset = {
    data: data.values,
    backgroundColor: [
      'rgba(59, 130, 246, 0.8)',
      'rgba(245, 158, 11, 0.8)',
      'rgba(168, 85, 247, 0.8)',
      'rgba(34, 197, 94, 0.8)',
    ],
    borderColor: [
      'rgba(59, 130, 246, 1)',
      'rgba(245, 158, 11, 1)',
      'rgba(168, 85, 247, 1)',
      'rgba(34, 197, 94, 1)',
    ],
    borderWidth: 2,
  };

  if (window.analyticsCharts?.journalStatusChart) {
    window.analyticsCharts.journalStatusChart.data.labels = data.labels;
    window.analyticsCharts.journalStatusChart.data.datasets = [dataset];
    window.analyticsCharts.journalStatusChart.update();
    return;
  }

  window.analyticsCharts = window.analyticsCharts || {};
  window.analyticsCharts.journalStatusChart = new Chart(journalCtx, {
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
          labels: { color: 'rgba(203, 213, 225, 0.8)' },
        },
        tooltip: {
          callbacks: {
            title: (context) => `${context[0].label} (last ${windowDays} days)`,
          },
        },
      },
    },
  });
}

function renderDepartmentChart() {
  const deptCtx = document.getElementById('deptChart');
  if (!deptCtx || window.deptChartInit) return;

  const deptColors = [
    'rgba(0, 200, 170, 0.8)',
    'rgba(245, 158, 11, 0.8)',
    'rgba(59, 130, 246, 0.8)',
    'rgba(168, 85, 247, 0.8)',
    'rgba(239, 68, 68, 0.8)'
  ];
  const deptBorders = [
    'rgba(0, 200, 170, 1)',
    'rgba(245, 158, 11, 1)',
    'rgba(59, 130, 246, 1)',
    'rgba(168, 85, 247, 1)',
    'rgba(239, 68, 68, 1)'
  ];

  const deptLabels = (window.deptData || []).map(d => d._id || 'Unknown');
  const deptValues = (window.deptData || []).map(d => d.count);

  new Chart(deptCtx, {
    type: 'doughnut',
    data: {
      labels: deptLabels.length > 0 ? deptLabels : ['No data'],
      datasets: [{
        data: deptValues.length > 0 ? deptValues : [1],
        backgroundColor: deptLabels.length > 0 ? deptColors.slice(0, deptLabels.length) : ['rgba(100,100,100,0.3)'],
        borderColor: deptLabels.length > 0 ? deptBorders.slice(0, deptLabels.length) : ['rgba(100,100,100,0.5)'],
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: 'rgba(203, 213, 225, 0.8)' }
        }
      }
    }
  });
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
        'rgba(59, 130, 246, 0.8)',
      ],
      borderColor: [
        'rgba(34, 197, 94, 1)',
        'rgba(245, 158, 11, 1)',
        'rgba(239, 68, 68, 1)',
        'rgba(59, 130, 246, 1)',
      ],
      borderWidth: 2,
    };
    const statusLabels = ['Present', 'Late', 'Absent', 'Excused'];

    if (window.analyticsCharts?.attendanceStatusChart) {
      window.analyticsCharts.attendanceStatusChart.data.labels = statusLabels;
      window.analyticsCharts.attendanceStatusChart.data.datasets = [statusDataset];
      window.analyticsCharts.attendanceStatusChart.update();
    } else {
      window.analyticsCharts = window.analyticsCharts || {};
      window.analyticsCharts.attendanceStatusChart = new Chart(statusCanvas, {
        type: 'doughnut',
        data: { labels: statusLabels, datasets: [statusDataset] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'right',
              labels: { color: 'rgba(203, 213, 225, 0.8)' },
            },
          },
        },
      });
    }
  }

  // Weekly verified hours + present records trend
  const trendCanvas = document.getElementById('attendanceTrendChart');
  if (trendCanvas) {
    const weeks = Array.isArray(data.weeklyHours) ? data.weeklyHours : [];
    const labels = weeks.length > 0 ? weeks.map(week => week.label) : ['No data'];
    const hoursDataset = {
      type: 'bar',
      label: 'Verified Hours',
      data: weeks.length > 0 ? weeks.map(week => week.hours) : [0],
      backgroundColor: 'rgba(0, 200, 170, 0.55)',
      borderColor: 'rgba(0, 200, 170, 1)',
      borderWidth: 2,
      borderRadius: 6,
      yAxisID: 'y',
    };
    const presentDataset = {
      type: 'line',
      label: 'Present Records',
      data: weeks.length > 0 ? weeks.map(week => week.present) : [0],
      borderColor: 'rgba(245, 200, 66, 1)',
      backgroundColor: 'rgba(245, 200, 66, 0.2)',
      borderWidth: 2,
      tension: 0.35,
      pointRadius: 3,
      yAxisID: 'y1',
    };

    if (window.analyticsCharts?.attendanceTrendChart) {
      window.analyticsCharts.attendanceTrendChart.data.labels = labels;
      window.analyticsCharts.attendanceTrendChart.data.datasets = [hoursDataset, presentDataset];
      window.analyticsCharts.attendanceTrendChart.update();
    } else {
      window.analyticsCharts = window.analyticsCharts || {};
      window.analyticsCharts.attendanceTrendChart = new Chart(trendCanvas, {
        type: 'bar',
        data: { labels, datasets: [hoursDataset, presentDataset] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: 'rgba(203, 213, 225, 0.8)' } },
            tooltip: {
              callbacks: {
                afterLabel: (context) => {
                  const week = weeks[context.dataIndex];
                  return week ? week.range : '';
                },
              },
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              position: 'left',
              grid: { color: 'rgba(255, 255, 255, 0.05)' },
              ticks: { color: 'rgba(203, 213, 225, 0.6)' },
              title: { display: true, text: 'Hours', color: 'rgba(203, 213, 225, 0.6)' },
            },
            y1: {
              beginAtZero: true,
              position: 'right',
              grid: { display: false },
              ticks: { color: 'rgba(203, 213, 225, 0.6)' },
              title: { display: true, text: 'Records', color: 'rgba(203, 213, 225, 0.6)' },
            },
            x: {
              grid: { display: false },
              ticks: { color: 'rgba(203, 213, 225, 0.6)' },
            },
          },
        },
      });
    }
  }
}

function renderRecentDTRs(records) {
  const tbody = document.getElementById('recent-dtr-body');
  if (!tbody) return;

  const items = Array.isArray(records) ? records : [];
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-slate-500">No DTR records recorded yet</td></tr>';
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
      tbody.innerHTML = '<tr><td colspan="8" class="py-6 text-center text-slate-500">No trainee records yet</td></tr>';
    } else {
      tbody.innerHTML = items.map(trainee => {
        const rate = Number(trainee.completionRate) || 0;
        const width = Math.min(rate, 100);
        return `
          <tr class="border-b border-white/5">
            <td class="py-3 px-4">
              <span class="block text-white">${escapeHtml(trainee.name)}</span>
              <span class="block text-xs text-slate-500">${escapeHtml(trainee.department)}</span>
            </td>
            <td class="py-3 px-4 text-slate-300">${escapeHtml(trainee.studentId)}</td>
            <td class="py-3 px-4 text-slate-300">${escapeHtml(trainee.company)}</td>
            <td class="py-3 px-4 text-slate-300">${analyticsHours(trainee.completedHours)}</td>
            <td class="py-3 px-4 text-slate-300">${analyticsHours(trainee.remainingHours)}</td>
            <td class="py-3 px-4">
              <div class="progress-track">
                <div class="${progressFillClass(rate)}" style="width: ${width}%"></div>
              </div>
              <span class="text-xs text-slate-500">${analyticsPercent(rate)} of ${analyticsCount(trainee.requiredHours)} h</span>
            </td>
            <td class="py-3 px-4"><span class="status-badge ${traineeStatusBadge(trainee.status)}">${escapeHtml(trainee.status)}</span></td>
            <td class="py-3 px-4 text-slate-300">${trainee.rating === null || trainee.rating === undefined
              ? '<span class="text-xs text-slate-500">Not rated</span>'
              : `${trainee.rating} / 5`}</td>
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
  const completedDatasets = {
    label: 'Completed Hours',
    data: topTrainees.length > 0 ? topTrainees.map(trainee => trainee.completedHours) : [0],
    backgroundColor: 'rgba(0, 200, 170, 0.75)',
    borderColor: 'rgba(0, 200, 170, 1)',
    borderWidth: 2,
    borderRadius: 6,
    stack: 'hours',
  };
  const remainingDatasets = {
    label: 'Remaining Hours',
    data: topTrainees.length > 0 ? topTrainees.map(trainee => trainee.remainingHours) : [0],
    backgroundColor: 'rgba(148, 163, 184, 0.35)',
    borderColor: 'rgba(148, 163, 184, 0.7)',
    borderWidth: 2,
    borderRadius: 6,
    stack: 'hours',
  };

  if (window.analyticsCharts?.traineeProgressChart) {
    window.analyticsCharts.traineeProgressChart.data.labels = labels;
    window.analyticsCharts.traineeProgressChart.data.datasets = [completedDatasets, remainingDatasets];
    window.analyticsCharts.traineeProgressChart.update();
    return;
  }

  window.analyticsCharts = window.analyticsCharts || {};
  window.analyticsCharts.traineeProgressChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [completedDatasets, remainingDatasets] },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: 'rgba(203, 213, 225, 0.8)' } },
      },
      scales: {
        x: {
          beginAtZero: true,
          stacked: true,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: 'rgba(203, 213, 225, 0.6)' },
          title: { display: true, text: 'Hours', color: 'rgba(203, 213, 225, 0.6)' },
        },
        y: {
          stacked: true,
          grid: { display: false },
          ticks: { color: 'rgba(203, 213, 225, 0.6)' },
        },
      },
    },
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
    const dataset = {
      data: [
        distribution.excellent || 0,
        distribution.good || 0,
        distribution.satisfactory || 0,
        distribution.needsImprovement || 0,
        distribution.unrated || 0,
      ],
      backgroundColor: [
        'rgba(34, 197, 94, 0.8)',
        'rgba(0, 200, 170, 0.8)',
        'rgba(59, 130, 246, 0.8)',
        'rgba(239, 68, 68, 0.8)',
        'rgba(148, 163, 184, 0.5)',
      ],
      borderColor: [
        'rgba(34, 197, 94, 1)',
        'rgba(0, 200, 170, 1)',
        'rgba(59, 130, 246, 1)',
        'rgba(239, 68, 68, 1)',
        'rgba(148, 163, 184, 0.8)',
      ],
      borderWidth: 2,
    };

    if (window.analyticsCharts?.performanceChart) {
      window.analyticsCharts.performanceChart.data.labels = labels;
      window.analyticsCharts.performanceChart.data.datasets = [dataset];
      window.analyticsCharts.performanceChart.update();
    } else {
      window.analyticsCharts = window.analyticsCharts || {};
      window.analyticsCharts.performanceChart = new Chart(canvas, {
        type: 'doughnut',
        data: { labels, datasets: [dataset] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'right',
              labels: { color: 'rgba(203, 213, 225, 0.8)' },
            },
          },
        },
      });
    }
  }

  // Top performers list
  const list = document.getElementById('top-performers-list');
  if (!list) return;

  const performers = Array.isArray(data.topPerformers) ? data.topPerformers : [];
  if (performers.length === 0) {
    list.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">No performance appraisals recorded yet</p>';
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
          <span class="text-sm font-semibold text-teal-400">${rating} / 5</span>
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
  const submittedDataset = {
    label: 'Submitted',
    data: trend.length > 0 ? trend.map(row => row.submitted) : [0],
    backgroundColor: 'rgba(59, 130, 246, 0.7)',
    borderColor: 'rgba(59, 130, 246, 1)',
    borderWidth: 2,
    borderRadius: 6,
  };
  const approvedDataset = {
    label: 'Coordinator Approved',
    data: trend.length > 0 ? trend.map(row => row.approved) : [0],
    backgroundColor: 'rgba(34, 197, 94, 0.7)',
    borderColor: 'rgba(34, 197, 94, 1)',
    borderWidth: 2,
    borderRadius: 6,
  };

  if (window.analyticsCharts?.journalTrendChart) {
    window.analyticsCharts.journalTrendChart.data.labels = labels;
    window.analyticsCharts.journalTrendChart.data.datasets = [submittedDataset, approvedDataset];
    window.analyticsCharts.journalTrendChart.update();
    return;
  }

  window.analyticsCharts = window.analyticsCharts || {};
  window.analyticsCharts.journalTrendChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [submittedDataset, approvedDataset] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: 'rgba(203, 213, 225, 0.8)' } },
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: 'rgba(203, 213, 225, 0.6)' },
        },
        x: {
          grid: { display: false },
          ticks: { color: 'rgba(203, 213, 225, 0.6)' },
        },
      },
    },
  });
}

function renderDepartmentAnalytics(departments) {
  const tbody = document.getElementById('department-analytics-body');
  if (!tbody) return;

  const items = Array.isArray(departments) ? departments : [];
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="py-6 text-center text-slate-500">No department data yet</td></tr>';
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
    container.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">Nothing needs attention right now</p>';
    return;
  }

  const levelClasses = {
    high: 'attention-high',
    medium: 'attention-medium',
    low: 'attention-low',
    info: 'attention-info',
  };

  container.innerHTML = items.map(item => {
    const levelClass = levelClasses[item.level] || 'attention-info';
    const action = item.action
      ? `<button onclick="switchTab('${item.action}')" class="text-xs text-teal-400 hover:underline mt-1">Open ${item.action === 'journal-review' ? 'Journal Review' : 'Trainees'}</button>`
      : '';
    return `
      <div class="attention-item ${levelClass}">
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
    container.innerHTML = '<p class="text-slate-500 text-sm">No recorded data available to summarize yet.</p>';
    return;
  }

  container.innerHTML = lines.map((line, index) => `
    <div class="narrative-item">
      <span class="narrative-index">${index + 1}</span>
      <p class="text-sm text-slate-300">${escapeHtml(line)}</p>
    </div>
  `).join('');
}

async function loadAnalyticsData() {
  const refreshBtn = document.querySelector('#analytics .btn-ghost');
  if (refreshBtn) refreshBtn.disabled = true;

  const result = await fetchAPI('/stats/coordinator/analytics');

  if (refreshBtn) refreshBtn.disabled = false;

  if (!result || !result.success) {
    updateAnalyticsSummary({}, { conceptWindowDays: 30 }, {});
    renderAttentionList([]);
    renderNarrative([]);
    showNotification('Analytics', 'Unable to load analytics data right now', 'error');
    return;
  }

  const analytics = result.data || {};
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
  alert('All notifications marked as read');
}

function filterNotifications(type) {
  const tabs = document.querySelectorAll('.filter-tab');
  tabs.forEach(tab => tab.classList.remove('active'));
  event.target.classList.add('active');
  alert(`Filtering notifications: ${type}`);
}

// ────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ────────────────────────────────────────────────────────────────────────────

function saveCoordinatorProfile(event) {
  event.preventDefault();
  const name = document.getElementById('coord-name').value;
  alert(`Profile updated!\nName: ${name}`);
}

async function changeCoordinatorPassword(event) {
  event.preventDefault();
  const current = document.getElementById('coord-current-pass').value;
  const newPass = document.getElementById('coord-new-pass').value;
  const confirm = document.getElementById('coord-confirm-pass').value;

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
    document.getElementById('coord-password-form').reset();
  } else {
    alert(result?.message || 'Failed to change password. Please try again.');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// MOBILE MENU TOGGLE
// ────────────────────────────────────────────────────────────────────────────

function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  sidebar.classList.toggle('open');
}

function closeSidebarOnMobile() {
  if (window.innerWidth <= 768) {
    const sidebar = document.querySelector('.sidebar');
    sidebar.classList.remove('open');
  }
}

let coordinatorRealtimeTimer = null;

function startCoordinatorRealtimeUpdates() {
  if (coordinatorRealtimeTimer) clearInterval(coordinatorRealtimeTimer);

  coordinatorRealtimeTimer = setInterval(async () => {
    if (document.hidden) return;

    const activeTab = document.querySelector('.tab-content.active')?.id;
    try {
      if (activeTab === 'overview') {
        await loadDashboardData();
      } else if (activeTab === 'trainees') {
        await loadTrainees();
      } else if (activeTab === 'journal-review') {
        await loadCoordinatorJournals(currentJournalFilter);
      } else if (activeTab === 'analytics') {
        await loadAnalyticsData();
      }
    } catch (error) {
      console.error('Coordinator real-time update failed:', error);
    }
  }, 10000);
}

// ────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION & LOGOUT
// ────────────────────────────────────────────────────────────────────────────

function logout() {
  if (confirm('Are you sure you want to logout?')) {
    localStorage.removeItem('trackit_token');
    localStorage.removeItem('trackit_user');
    localStorage.removeItem('trackit_current_tab');
    window.location.href = 'loginpage.html';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// INITIALIZATION
// ────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initializeTheme();
  // Load user data and populate dashboard
  loadDashboardData();

  // Load trainees and supervisors data
  loadTrainees();
  loadSupervisors();
  loadCoordinatorJournals();
  startCoordinatorRealtimeUpdates();

  // Setup filter listeners for auto-filtering
  setupFilterListeners();

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
