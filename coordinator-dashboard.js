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

function updateAnalyticsSummary(summary, windows) {
  const avgCompletionEl = document.getElementById('analytics-avg-completion');
  const avgCompletionNote = document.getElementById('analytics-avg-completion-note');
  const topConceptEl = document.getElementById('analytics-top-concept');
  const topConceptNote = document.getElementById('analytics-top-concept-note');
  const topCompanyEl = document.getElementById('analytics-top-company');
  const topCompanyNote = document.getElementById('analytics-top-company-note');

  if (avgCompletionEl) {
    const rate = Number.isFinite(summary.avgCompletionRate) ? summary.avgCompletionRate : 0;
    avgCompletionEl.textContent = `${rate.toFixed(1)}%`;
  }
  if (avgCompletionNote) {
    const studentCount = summary.studentCount || 0;
    avgCompletionNote.textContent = studentCount > 0
      ? `Across ${studentCount} trainees (verified hours)`
      : 'No trainee data available';
  }

  if (topConceptEl) {
    topConceptEl.textContent = summary.topConcept?.name || 'No concept data';
  }
  if (topConceptNote) {
    const traineeCount = summary.topConcept?.traineeCount || 0;
    const conceptWindowDays = windows.conceptWindowDays || 30;
    topConceptNote.textContent = traineeCount > 0
      ? `${traineeCount} trainees in the last ${conceptWindowDays} days`
      : `No journal concepts in the last ${conceptWindowDays} days`;
  }

  if (topCompanyEl) {
    topCompanyEl.textContent = summary.topCompany?.name || 'No company data';
  }
  if (topCompanyNote) {
    const count = summary.topCompany?.count || 0;
    topCompanyNote.textContent = count > 0
      ? `${count} active trainees`
      : 'No active trainees yet';
  }
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

async function loadAnalyticsData() {
  const result = await fetchAPI('/stats/coordinator/analytics');
  if (!result || !result.success) {
    updateAnalyticsSummary({}, { conceptWindowDays: 30 });
    return;
  }

  const analytics = result.data || {};
  updateAnalyticsSummary(analytics.summary || {}, {
    conceptWindowDays: analytics.conceptWindowDays || 30,
  });
  renderHoursChart(analytics.hoursByTrainee || []);
  renderJournalStatusChart(analytics.journalStatusBreakdown || {}, analytics.journalWindowDays || 90);
  renderDepartmentChart();
}

// ────────────────────────────────────────────────────────────────────────────
// REPORT GENERATION
// ────────────────────────────────────────────────────────────────────────────

function generateSemesterReport() {
  alert('Generating semester summary report...\nFile: Semester_Summary_Report_2026.pdf');
}

function exportTraineeData() {
  alert('Exporting trainee data...\nFile: Trainee_Data_2026.csv');
}

function exportAttendanceLogs() {
  alert('Exporting attendance logs...\nFile: Attendance_Logs_Apr2026.csv');
}

function exportJournalAnalytics() {
  alert('Exporting journal analytics...\nFile: Journal_Analytics_Apr2026.pdf');
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

function changeCoordinatorPassword(event) {
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

  alert('Password changed successfully!');
  document.getElementById('coord-password-form').reset();
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
});
