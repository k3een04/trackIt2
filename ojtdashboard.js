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

/** Normalize journal.week to the same label as selector options (e.g. "Week 1"). */
function normalizeWeekOptionLabel(weekStr) {
  const n = parseJournalWeekNumber(weekStr);
  if (n != null) return `Week ${n}`;
  const t = String(weekStr || '').trim();
  return t || null;
}

/**
 * Weeks that already have a submitted or reviewed journal.
 * Draft (e.g. returned for revision) stays selectable so the trainee can resubmit.
 */
function getSubmittedWeekLabelsSet(journals) {
  const set = new Set();
  (journals || []).forEach((j) => {
    if (!j || j.status === 'draft') return;
    const label = normalizeWeekOptionLabel(j.week);
    if (label) set.add(label);
  });
  return set;
}

function ensureValidWeekSelection(weekSelector) {
  if (!weekSelector) return;
  const sel = weekSelector.selectedOptions[0];
  if (!sel || sel.disabled) {
    const first = Array.from(weekSelector.options).find((o) => !o.disabled);
    if (first) first.selected = true;
  }
}

/** Disable week options that already have a non-draft journal; fix selection if needed. */
function applySubmittedWeeksToWeekSelector(journals) {
  const weekSelector = document.getElementById('week-selector');
  if (!weekSelector) return;
  const submitted = getSubmittedWeekLabelsSet(journals);
  Array.from(weekSelector.options).forEach((opt) => {
    const label = normalizeWeekOptionLabel(opt.value);
    opt.disabled = !!(label && submitted.has(label));
  });
  ensureValidWeekSelection(weekSelector);
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

/** OJT week index (Week 1 = first 7 days since registration), same logic as updateHoursByWeek */
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
  const registrationDate = window.studentRegistrationDate || window.currentUser?.createdAt;
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
          showNotification('✅ Attendance Updated', 'Your time in/out has been updated.', 'success');
          await loadTodayDTRSummary();
          await loadDTRRecords();
          await loadRecentActivity();
        }

        // Update state
        lastDTRState = currentState;
      }
    } catch (error) {
      console.error('Error in DTR polling:', error);
    }
  }, 5000);
}

let studentRealtimeTimer = null;

function startStudentRealtimeUpdates() {
  if (studentRealtimeTimer) clearInterval(studentRealtimeTimer);

  studentRealtimeTimer = setInterval(async () => {
    if (document.hidden) return;

    const activeTab = document.querySelector('.tab-content.active')?.id;
    try {
      if (activeTab === 'overview') {
        await loadDashboardData();
        await loadRecentActivity();
      } else if (activeTab === 'dtr') {
        await loadTodayDTRSummary();
        await loadDTRRecords();
      } else if (activeTab === 'journal') {
        await loadPreviousJournals();
      }
    } catch (error) {
      console.error('Student real-time update failed:', error);
    }
  }, 10000);
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

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const responseText = await response.text();
      return {
        success: false,
        message: `Server returned HTTP ${response.status}${responseText ? `: ${responseText.slice(0, 160)}` : ''}`,
      };
    }

    return await response.json();
  } catch (error) {
    console.error('API Error:', error);
    return {
      success: false,
      message: `Unable to reach the server: ${error.message}`,
    };
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

  // DEBUG: Log the student data to see what's being returned
  console.log('Student data from API:', student);
  console.log('Supervisor data:', student.supervisor);

  // Update overview stat cards
  const statCards = document.querySelectorAll('#overview .stat-num');
  if (statCards.length >= 4) {
    const pendingCount = Number.isFinite(stats.pendingJournals) ? stats.pendingJournals : 0;
    statCards[0].textContent = stats.completedHours;
    statCards[1].textContent = stats.daysPresent;
    statCards[2].textContent = pendingCount;
    statCards[3].textContent = stats.remainingHours;
  }

  // Update overview subtitle
  const hoursSubtitle = document.querySelector('#overview .stat-num + p');
  if (hoursSubtitle) hoursSubtitle.textContent = `/ ${stats.totalRequired} hours required`;

  // Update progress circle
  const progressValue = document.querySelector('#overview .progress-value');
  const progressText = document.querySelector('#overview .progress-circle + p');
  if (progressValue) progressValue.textContent = `${stats.progressPercentage}%`;
  if (progressText) progressText.textContent = `${stats.completedHours} of ${stats.totalRequired} hours completed`;

  // Update progress circle CSS variable
  const progressCircle = document.querySelector('#overview .progress-circle');
  if (progressCircle) progressCircle.style.setProperty('--progress', `${stats.progressPercentage}%`);

  // Update My Progress tab
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
    console.log('Company name set to:', companyName);
  }

  // Update supervisor name
  const supervisorNameEl = document.getElementById('progress-supervisor-name');
  if (supervisorNameEl) {
    const supervisorName = student.supervisor?.fullName || 'Not assigned';
    supervisorNameEl.textContent = supervisorName;
    console.log('Supervisor name set to:', supervisorName);
  }

  // Update position from supervisor's company position
  const positionEl = document.getElementById('progress-position');
  if (positionEl) {
    const position = student.supervisor?.companyPosition || 'Not assigned';
    positionEl.textContent = position;
    console.log('Position set to:', position);
  }

  // Update settings account summary
  const settingSupervisor = document.getElementById('account-supervisor');
  if (settingSupervisor) settingSupervisor.textContent = student.supervisor?.fullName || 'Not assigned';

  // Update member since
  const memberSinceEl = document.getElementById('account-member-since');
  if (memberSinceEl) {
    memberSinceEl.textContent = new Date(student.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Load recent activity for overview
  loadRecentActivity();

  // Load pending journals list for overview
  loadPendingJournalsOverview();

  // Update estimated completion date
  updateEstimatedCompletion(stats, student);
}

// Load recent activity from DTR records and journal submissions for overview tab
async function loadRecentActivity() {
  try {
    // Fetch recent DTR records (last 30 days)
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

    const dtrResponse = await fetch(
      `${API_BASE}/qr/dtr/${window.currentUser._id}?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}&limit=10`,
      { headers: getAuthHeaders() }
    );

    if (!dtrResponse.ok) return;
    const dtrData = await dtrResponse.json();
    const dtrRecords = dtrData.data || [];

    // Fetch recent journal submissions
    const journalResponse = await fetch(
      `${API_BASE}/journal/my-journals`,
      { headers: getAuthHeaders() }
    );

    const journalData = journalResponse.ok ? await journalResponse.json() : { data: [] };
    const journals = journalData.data || [];

    const activityContainer = document.getElementById('recent-activity-container');
    if (!activityContainer) return;

    // Combine activities from both sources
    const activities = [];

    // Add DTR activities (show all, not just verified)
    dtrRecords.forEach(record => {
      activities.push({
        type: 'dtr',
        date: new Date(record.date),
        data: record,
      });
    });

    // Add journal submissions
    journals.forEach(journal => {
      activities.push({
        type: 'journal',
        date: new Date(journal.submittedAt),
        data: journal,
      });
    });

    if (activities.length === 0) {
      activityContainer.innerHTML = '<p class="text-slate-500 text-sm text-center py-6">No recent activity yet. Start by scanning QR to clock in or submitting a journal.</p>';
      return;
    }

    // Sort by date (newest first) and limit to 4
    const sortedActivities = activities
      .sort((a, b) => b.date - a.date)
      .slice(0, 4);

    activityContainer.innerHTML = sortedActivities
      .map(activity => {
        if (activity.type === 'dtr') {
          const record = activity.data;
          const date = new Date(record.date);
          const timeIn = record.timeIn ? new Date(record.timeIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—';
          const timeOut = record.timeOut ? new Date(record.timeOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—';
          const formattedDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const hoursRendered = (record.hoursRendered || 0).toFixed(1);
          const statusColor = record.status === 'present' ? 'text-green-400' : record.status === 'late' ? 'text-yellow-400' : 'text-red-400';

          return `
            <div class="flex gap-3 pb-4 border-b border-white/10 last:border-0">
              <div class="flex-shrink-0 w-2 h-2 rounded-full ${statusColor === 'text-green-400' ? 'bg-green-400' : statusColor === 'text-yellow-400' ? 'bg-yellow-400' : 'bg-red-400'} mt-2"></div>
              <div class="flex-1 min-w-0">
                <p class="text-sm font-semibold text-white">${formattedDate}</p>
                <p class="text-xs text-slate-400">${timeIn} → ${timeOut} (${hoursRendered} hrs)</p>
                <p class="text-xs text-slate-500 capitalize">✅ Clock In/Out</p>
              </div>
            </div>
          `;
        } else if (activity.type === 'journal') {
          const journal = activity.data;
          const date = new Date(journal.submittedAt);
          const formattedDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const statusColor = journal.status === 'reviewed' ? 'text-blue-400' : journal.status === 'submitted' ? 'text-purple-400' : 'text-gray-400';
          const statusLabel = journal.status === 'reviewed' ? 'Reviewed' : journal.status === 'submitted' ? 'Submitted' : 'Draft';

          return `
            <div class="flex gap-3 pb-4 border-b border-white/10 last:border-0">
              <div class="flex-shrink-0 w-2 h-2 rounded-full ${statusColor === 'text-blue-400' ? 'bg-blue-400' : statusColor === 'text-purple-400' ? 'bg-purple-400' : 'bg-gray-400'} mt-2"></div>
              <div class="flex-1 min-w-0">
                <p class="text-sm font-semibold text-white">${formattedDate}</p>
                <p class="text-xs text-slate-400">Week ${journal.week}</p>
                <p class="text-xs text-slate-500 capitalize">📝 Journal ${statusLabel}</p>
              </div>
            </div>
          `;
        }
      })
      .join('');
  } catch (error) {
    console.error('Error loading recent activity:', error);
  }
}

// Load pending journals list for overview tab
async function loadPendingJournalsOverview() {
  try {
    const list = document.getElementById('pending-journals-list');
    if (!list) return;

    list.innerHTML = '<p class="text-slate-500 text-sm text-center py-6">Loading pending journals...</p>';

    const result = await fetchAPI('/journal/my-journals', { method: 'GET' });
    if (!result || !result.success) {
      list.innerHTML = '<p class="text-slate-500 text-sm text-center py-6">Unable to load pending journals.</p>';
      return;
    }

    const pendingJournals = (result.data || []).filter(journal => {
      return journal && journal.supervisorSigned !== true && journal.status === 'submitted';
    });

    const statCards = document.querySelectorAll('#overview .stat-num');
    if (statCards.length >= 3) {
      statCards[2].textContent = pendingJournals.length;
    }

    if (pendingJournals.length === 0) {
      list.innerHTML = '<p class="text-slate-500 text-sm text-center py-6">No pending journals awaiting signature.</p>';
      return;
    }

    const maxItems = 5;
    const items = pendingJournals.slice(0, maxItems).map(journal => {
      const date = journal.submittedAt
        ? new Date(journal.submittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'Unknown date';

      return `
        <div class="flex items-start justify-between p-3 rounded-lg bg-white/5 border border-white/10">
          <div>
            <p class="text-sm font-semibold text-teal-400">${journal.week || 'Weekly Journal'}</p>
            <p class="text-xs text-slate-400">Submitted: ${date}</p>
          </div>
          <span class="status-badge status-pending">Pending</span>
        </div>
      `;
    });

    if (pendingJournals.length > maxItems) {
      items.push(`
        <p class="text-xs text-slate-500 text-center">Showing ${maxItems} of ${pendingJournals.length} pending journals</p>
      `);
    }

    list.innerHTML = items.join('');
  } catch (error) {
    console.error('Error loading pending journals:', error);
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
  
  console.log('🔄 Switching to tab:', tabName);
  
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
    console.log('✅ Tab content shown:', tabName);
    window.scrollTo(0, 0);
  } else {
    console.warn('⚠️ Tab element not found:', tabName);
  }

  // Add active to corresponding nav link
  const activeNavLink = document.querySelector(`.nav-link[href="#${tabName}"]`);
  if (activeNavLink) {
    activeNavLink.classList.add('active');
    console.log('✅ Nav link activated:', tabName);
  } else {
    console.warn('⚠️ Nav link not found for:', tabName);
  }

  // Close sidebar on mobile
  closeSidebarOnMobile();

  // Load tab-specific data asynchronously (non-blocking)
  if (tabName === 'overview') {
    loadPendingJournalsOverview().catch(err => console.error('Error loading pending journals:', err));
    loadRecentActivity().catch(err => console.error('Error loading recent activity:', err));
  } else if (tabName === 'dtr') {
    loadDTRRecords().catch(err => console.error('Error loading DTR:', err));
  } else if (tabName === 'journal') {
    (async () => {
      try {
        await populateWeekSelector();
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

    // Get registration date to calculate weeks from start
    const registrationDate = new Date(student?.createdAt || new Date());
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

    console.log('Chart data - weeks:', weeks, 'hours:', weekHours);

    const isLightMode = document.body.classList.contains('light-mode');
    const ticksColor = isLightMode ? 'rgba(30, 41, 59, 0.6)' : 'rgba(203, 213, 225, 0.6)';
    const gridColor = isLightMode ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.05)';

    weeklyChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: weeks,
        datasets: [{
          label: 'Hours Rendered',
          data: weekHours,
          backgroundColor: 'rgba(0, 200, 170, 0.3)',
          borderColor: 'rgba(0, 200, 170, 1)',
          borderWidth: 2,
          borderRadius: 8,
          tension: 0.4,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            max: 50,
            grid: {
              color: gridColor,
              drawBorder: false
            },
            ticks: {
              color: ticksColor,
              font: {
                family: "'Inter', sans-serif",
                size: 12
              }
            }
          },
          x: {
            grid: {
              display: false,
              drawBorder: false
            },
            ticks: {
              color: ticksColor,
              font: {
                family: "'Inter', sans-serif",
                size: 12
              }
            }
          }
        }
      }
    });
    
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
    // Get registration date
    const registrationDate = new Date(student?.createdAt || new Date());
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

// Journal submission
async function submitJournal(event) {
  event.preventDefault();
  const weekSelector = document.getElementById('week-selector');
  const selectedOpt = weekSelector?.selectedOptions[0];
  const week = weekSelector?.value || '';
  
  if (!week || selectedOpt?.disabled) {
    alert('Please choose a week you have not already submitted. Weeks with an existing journal are disabled.');
    return;
  }

  const dayCovered = document.getElementById('day-covered')?.value || null;
  const narrative = document.getElementById('journal-narrative').value;
  const identifiedTheories = window.currentIdentifiedTheories || [];

  if (!narrative.trim()) {
    alert('Please write a journal entry');
    return;
  }

  if (journalPhotoDataUrl && journalPhotoDataUrl.length > 3_000_000) {
    alert('The journal photo is still too large after compression. Please choose a smaller image.');
    return;
  }

  // Show loading state
  const submitBtn = event.target.querySelector('button[type="submit"]');
  const originalText = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<svg width="18" height="18" class="animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 2A10 10 0 0 1 22 12"></path></svg> Submitting...';

  try {
    const result = await fetchAPI('/journal/submit', {
      method: 'POST',
      body: JSON.stringify({
        week,
        dayCovered,
        narrative,
        identifiedTheories,
        photoDataUrl: journalPhotoDataUrl,
      }),
    });

    if (!result || !result.success) {
      alert('Failed to submit journal: ' + (result?.error || result?.message || 'The server returned no response.'));
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
      return;
    }

    alert(`Journal for ${week} submitted successfully!`);
    document.getElementById('journal-form').reset();
    document.getElementById('theories-result').classList.add('hidden');
    resetJournalPhotoPreview();
    window.currentIdentifiedTheories = [];

    await loadPreviousJournals();
    await populateWeekSelector();

    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
  } catch (error) {
    console.error('Error submitting journal:', error);
    alert('Error submitting journal. Please try again.');
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
  }
}

// Auto-extract theories from narrative
async function autoExtractTheories(event) {
  const narrative = document.getElementById('journal-narrative').value;
  if (!narrative.trim()) {
    alert('Please write a journal entry first');
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
      alert('Failed to extract theories: ' + (result?.error || result?.message || 'Unknown error'));
      button.disabled = false;
      button.innerHTML = originalText;
      return;
    }

    const identifiedTheories = result.data.identifiedTheories || [];
    window.currentIdentifiedTheories = identifiedTheories;

    const theoriesResult = document.getElementById('theories-result');
    const theoriesListEl = document.getElementById('theories-list');

    if (identifiedTheories.length === 0) {
      theoriesListEl.innerHTML = '<p style="color: #cbd5e1; font-size: 13px;">No IT theories or practices were identified in your narrative. Please provide more details about your OJT activities.</p>';
    } else {
      theoriesListEl.innerHTML = identifiedTheories.map((theory, index) => `
        <div style="padding: 12px; background: rgba(0,200,170,0.05); border-radius: 6px; border-left: 3px solid #00c8aa; margin-bottom: 8px;">
          <p style="margin: 0; font-weight: 600; color: #00c8aa; font-size: 12px;">${theory.course} – ${theory.courseName}</p>
          <p style="margin: 4px 0 0 0; color: #cbd5e1; font-size: 13px;">${theory.category}</p>
          <p style="margin: 6px 0 0 0; color: #cbd5e1; font-size: 13px;">${theory.theory}</p>
        </div>
      `).join('');
    }

    theoriesResult.classList.remove('hidden');
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

function changePassword(event) {
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

  // API call to update password (when backend endpoint is ready)
  // const result = await fetchAPI(`/auth/change-password`, {
  //   method: 'POST',
  //   body: JSON.stringify({ currentPassword: current, newPassword: newPass })
  // });

  alert('Password changed successfully!');
  document.getElementById('password-form').reset();
}

// Calculate and populate week selector based on actual registration date
async function populateWeekSelector() {
  const weekSelector = document.getElementById('week-selector');
  if (!weekSelector) return;

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

    const submittedWeeks = getSubmittedWeekLabelsSet(journals);

    const { student } = statsResult.data;
    const registrationDate = new Date(student.createdAt);
    const today = new Date();

    const timeDiff = today - registrationDate;
    const weeksDiff = Math.floor(timeDiff / (7 * 24 * 60 * 60 * 1000));
    const currentWeek = Math.max(1, weeksDiff + 1);

    console.log(`Registration date: ${registrationDate.toDateString()}, Today: ${today.toDateString()}, Weeks elapsed: ${weeksDiff}, Current week: ${currentWeek}`);

    const totalWeeks = 17;
    weekSelector.innerHTML = '';

    for (let week = 1; week <= totalWeeks; week++) {
      const value = `Week ${week}`;
      const option = document.createElement('option');
      option.value = value;
      option.textContent = submittedWeeks.has(value) ? `${value} (submitted)` : value;
      option.disabled = submittedWeeks.has(value);
      weekSelector.appendChild(option);
    }

    const preferred = weekSelector.querySelector(`option[value="Week ${currentWeek}"]`);
    Array.from(weekSelector.options).forEach((o) => { o.selected = false; });
    if (preferred && !preferred.disabled) {
      preferred.selected = true;
    } else {
      const first = Array.from(weekSelector.options).find((o) => !o.disabled);
      if (first) first.selected = true;
    }

    ensureValidWeekSelection(weekSelector);

    console.log(`Week selector populated with weeks 1-${totalWeeks}, current week: ${currentWeek}`);
  } catch (error) {
    console.error('Error populating week selector:', error);
    weekSelector.innerHTML = `
      <option value="Week 1">Week 1</option>
      <option value="Week 2">Week 2</option>
      <option value="Week 3">Week 3</option>
      <option value="Week 4">Week 4</option>
      <option value="Week 5">Week 5</option>
      <option value="Week 6">Week 6</option>
      <option value="Week 7">Week 7</option>
      <option value="Week 8">Week 8</option>
      <option value="Week 9">Week 9</option>
      <option value="Week 10">Week 10</option>
      <option value="Week 11">Week 11</option>
      <option value="Week 12">Week 12</option>
      <option value="Week 13">Week 13</option>
      <option value="Week 14">Week 14</option>
      <option value="Week 15">Week 15</option>
      <option value="Week 16">Week 16</option>
      <option value="Week 17">Week 17</option>
    `;
    try {
      const jr = await fetchAPI('/journal/my-journals', { method: 'GET' });
      if (jr?.success && Array.isArray(jr.data)) {
        journalDownloadCache = jr.data;
        applySubmittedWeeksToWeekSelector(jr.data);
      }
    } catch (_) {
      /* ignore */
    }
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
    applySubmittedWeeksToWeekSelector(journals);

    const journalContainer = document.getElementById('previous-journals-list');

    if (!journalContainer) return;

    if (journals.length === 0) {
      journalContainer.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">No journals submitted yet</p>';
      return;
    }

    // Clear container
    journalContainer.innerHTML = '';

    // Add each journal to the list
    journals.forEach(journal => {
      const dateValue = journal.submittedAt || journal.createdAt;
      const date = dateValue ? new Date(dateValue).toLocaleDateString('en-US', {
        month: 'short', 
        day: 'numeric', 
        year: 'numeric' 
      }) : 'Date unavailable';
      
      const journalEl = document.createElement('div');
      journalEl.className = 'p-4 rounded-lg bg-white/5 border border-white/10 cursor-pointer hover:bg-white/10 hover:border-teal-400/50 transition group';
      journalEl.innerHTML = `
        <div class="flex items-start justify-between mb-2">
          <div>
            <p class="font-semibold text-sm text-teal-400">${journal.week}</p>
            <p class="text-xs text-slate-500">${date}</p>
          </div>
          <span class="px-2 py-1 rounded text-xs font-medium ${
            journal.status === 'reviewed' ? 'bg-green-500/20 text-green-400' :
            journal.status === 'submitted' ? 'bg-blue-500/20 text-blue-400' :
            'bg-slate-500/20 text-slate-400'
          }">${journal.status}</span>
        </div>
        ${journal.summary ? `
          <p class="text-sm text-slate-300 mb-2">
            <strong>Summary:</strong> ${journal.summary.substring(0, 100)}...
          </p>
        ` : ''}
        <p class="text-xs text-slate-400 group-hover:text-teal-300">${journal.identifiedTheories?.length > 0 ? 'Theories identified: ' + journal.identifiedTheories.length : 'No theories identified'}</p>
        <p class="text-xs text-slate-500 mt-2 group-hover:text-slate-400">Hover to view full content →</p>
      `;
      
      // Add hover event listeners
      journalEl.addEventListener('mouseenter', () => showJournalTooltip(journal, journalEl));
      journalEl.addEventListener('mouseleave', () => {
        // Delay hiding to prevent flickering when moving between element and tooltip
        setTimeout(() => {
          const tooltip = document.getElementById('journal-tooltip');
          if (!tooltip.matches(':hover')) {
            closeJournalTooltip();
          }
        }, 200);
      });
      
      journalContainer.appendChild(journalEl);
    });
  } catch (error) {
    console.error('Error loading journals:', error);
  }
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
  const journals = await fetchJournalDownloadData();

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
    const hasSummary = !!(journal.summary && journal.summary.trim());

    const item = document.createElement('label');
    item.className = `download-item ${hasSummary ? '' : 'disabled'}`;
    item.innerHTML = `
      <div class="download-item-info">
        <span class="download-item-title">${journal.week || 'Weekly Journal'}</span>
        <span class="download-item-sub">${date} • ${hasSummary ? 'Summary ready' : 'Missing summary'}</span>
      </div>
      <input type="checkbox" data-id="${journal._id}" ${hasSummary ? '' : 'disabled'} />
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
function showJournalTooltip(journal, sourceElement) {
  const tooltip = document.getElementById('journal-tooltip');
  const tooltipContent = document.getElementById('journal-tooltip-content');
  
  const date = new Date(journal.submittedAt).toLocaleDateString('en-US', { 
    month: 'long', 
    day: 'numeric', 
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const statusColor = journal.status === 'reviewed' ? 'text-green-400' :
                      journal.status === 'submitted' ? 'text-blue-400' :
                      'text-slate-400';
  
  const statusBgColor = journal.status === 'reviewed' ? 'bg-green-500/20' :
                        journal.status === 'submitted' ? 'bg-blue-500/20' :
                        'bg-slate-500/20';

  tooltipContent.innerHTML = `
    <div class="space-y-4">
      <div>
        <h3 class="font-display font-700 text-lg mb-2">${journal.week}</h3>
        <p class="text-xs text-slate-400 mb-3">${date}</p>
        <span class="px-2 py-1 rounded text-xs font-medium ${statusBgColor} ${statusColor}">${journal.status}</span>
      </div>

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
    </div>
  `;

  // Position tooltip near the source element
  const rect = sourceElement.getBoundingClientRect();
  tooltip.style.top = (rect.bottom + 10) + 'px';
  tooltip.style.left = (rect.left) + 'px';
  tooltip.classList.remove('hidden');
  tooltip.style.display = 'block';

  // Adjust position if tooltip goes off-screen
  setTimeout(() => {
    const tooltipRect = tooltip.getBoundingClientRect();
    if (tooltipRect.right > window.innerWidth) {
      tooltip.style.left = (window.innerWidth - tooltipRect.width - 20) + 'px';
    }
    if (tooltipRect.bottom > window.innerHeight) {
      tooltip.style.top = (rect.top - tooltipRect.height - 10) + 'px';
    }
  }, 0);

  // Keep tooltip open on hover
  tooltip.addEventListener('mouseenter', () => {
    tooltip.dataset.keepOpen = 'true';
  });
  tooltip.addEventListener('mouseleave', () => {
    tooltip.dataset.keepOpen = 'false';
    setTimeout(() => closeJournalTooltip(), 200);
  });
}

// Close journal tooltip
function closeJournalTooltip() {
  const tooltip = document.getElementById('journal-tooltip');
  tooltip.classList.add('hidden');
  tooltip.style.display = 'none';
  tooltip.dataset.keepOpen = 'false';
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

    try {
      journalPhotoDataUrl = await compressJournalPhoto(file);
      if (previewImg) {
        previewImg.src = journalPhotoDataUrl;
        previewImg.classList.remove('hidden');
      }
      if (placeholder) placeholder.classList.add('hidden');
    } catch (error) {
      console.error('Unable to process journal photo:', error);
      alert('Unable to process this image. Please choose another image.');
      resetJournalPhotoPreview();
    }
  });
}

function compressJournalPhoto(file) {
  const maxDimension = 1600;
  const quality = 0.78;

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read image file'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('Unsupported image format'));
      image.onload = () => {
        const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('Image processing is unavailable'));
          return;
        }

        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
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
    week: document.getElementById('week-selector')?.value || '—',
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
      if (!journal.summary?.trim()) throw new Error('Missing summary');
      return {
        week:        journal.week || '',
        dateLabel:   fmt(journal.submittedAt),
        summary:     journal.summary,
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
  sidebar.classList.toggle('open');
}

function closeSidebarOnMobile() {
  if (window.innerWidth <= 768) {
    const sidebar = document.querySelector('.sidebar');
    sidebar.classList.remove('open');
  }
}

// Logout
function logout() {
  if (confirm('Are you sure you want to logout?')) {
    localStorage.removeItem('trackit_token');
    localStorage.removeItem('trackit_user');
    localStorage.removeItem('trackit_current_tab');
    window.location.href = 'loginpage.html';
  }
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
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      }),
    });

    if (!response || !response.success) {
      updateGeofenceStatusUI('error', 'Validation failed');
      return;
    }

    const { geofence, schedule, attendanceWindows } = response.data;
    const scheduleWithWindows = { ...schedule, attendanceWindows };
    
    // Update UI based on geofence status
    if (geofence.isInRange && schedule.isWithinSchedule) {
      updateGeofenceStatusUI('in-range', geofence.message, geofence, scheduleWithWindows);
    } else if (geofence.isInRange && !schedule.isWithinSchedule) {
      updateGeofenceStatusUI('outside-schedule', schedule.message, geofence, scheduleWithWindows);
    } else {
      updateGeofenceStatusUI('out-of-range', geofence.message, geofence, scheduleWithWindows);
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
  const timeOutSchedule = document.getElementById('time-out-schedule');
  const timeInAllowed = scheduleData?.attendanceWindows?.timeIn?.allowed !== false;
  const timeOutAllowed = scheduleData?.attendanceWindows?.timeOut?.allowed !== false;
  const timeOutWindow = scheduleData?.attendanceWindows?.timeOut;

  const formatTime12Hour = (timeValue) => {
    if (!timeValue) return '—';
    const [hours, minutes] = timeValue.split(':').map(Number);
    const suffix = hours >= 12 ? 'PM' : 'AM';
    return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${suffix}`;
  };

  const setTimeOutButtonState = (disabled) => {
    timeOutBtn.disabled = disabled;
    timeOutBtn.classList.toggle('waiting-window', disabled);
    timeOutBtn.style.cursor = disabled ? 'not-allowed' : 'pointer';
  };

  if (timeOutSchedule) {
    if (timeOutWindow?.hasSchedule) {
      timeOutSchedule.textContent = `Scheduled time-out: ${formatTime12Hour(timeOutWindow.scheduledTime)} (valid until ${formatTime12Hour(timeOutWindow.windowEndTime)})`;
      timeOutSchedule.classList.toggle('window-active', timeOutAllowed);
    } else {
      timeOutSchedule.textContent = 'Scheduled time-out: Not configured';
      timeOutSchedule.classList.remove('window-active');
    }
  }

  // Reset classes
  indicator.classList.remove('in-range', 'out-of-range');
  statusText.classList.remove('in-range', 'out-of-range');

  // Update status
  switch (status) {
    case 'in-range':
      indicator.classList.add('in-range');
      statusText.classList.add('in-range');
      statusText.textContent = '✓ In Range';
      timeInBtn.disabled = !timeInAllowed;
      timeInBtn.style.cursor = 'pointer';
      setTimeOutButtonState(!timeOutAllowed);
      geofenceInfo.style.display = 'none';
      break;

    case 'out-of-range':
      indicator.classList.add('out-of-range');
      statusText.classList.add('out-of-range');
      statusText.textContent = '✗ Out of Range';
      timeInBtn.disabled = true;
      setTimeOutButtonState(true);
      timeInBtn.style.cursor = 'not-allowed';
      geofenceInfo.style.display = 'block';
      geofenceMessage.textContent = message;
      break;

    case 'outside-schedule':
      indicator.classList.add('out-of-range');
      statusText.classList.add('out-of-range');
      statusText.textContent = '⏰ Outside Schedule';
      timeInBtn.disabled = true;
      setTimeOutButtonState(true);
      timeInBtn.style.cursor = 'not-allowed';
      geofenceInfo.style.display = 'block';
      geofenceMessage.textContent = message;
      break;

    case 'locating':
      statusText.textContent = message;
      timeInBtn.disabled = true;
      setTimeOutButtonState(true);
      geofenceInfo.style.display = 'none';
      break;

    case 'error':
    default:
      statusText.textContent = '⚠ Error';
      timeInBtn.disabled = true;
      setTimeOutButtonState(true);
      geofenceInfo.style.display = 'block';
      geofenceMessage.textContent = message;
  }

  // Update distance and accuracy info
  if (geofenceData && currentCoordinates) {
    distanceInfo.textContent = `Distance: ${geofenceData.distanceMeters}m / ${geofenceData.radiusMeters}m`;
    accuracyInfo.textContent = `Accuracy: ±${Math.round(currentCoordinates.accuracy)}m`;
  } else {
    distanceInfo.textContent = 'Distance: —';
    accuracyInfo.textContent = 'Accuracy: —';
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
 * Record time in with geolocation
 */
async function recordTimeIn() {
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
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      }),
    });

    btn.textContent = originalText;
    btn.disabled = false;

    if (!response || !response.success) {
      showNotification('Error', response?.message || 'Failed to record time in', 'error');
      return;
    }

    showNotification('Success', '✓ Time In Recorded', 'success');
    console.log('[Geofence] Time In recorded:', response.data);

    // Update UI to show time out button
    btn.style.display = 'none';
    document.getElementById('time-out-btn').style.display = 'block';
    document.getElementById('time-out-btn').disabled = false;

    // Refresh DTR records
    await loadDTRRecords();
    loadTodayDTRSummary();
    await updateGeofenceStatus();
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
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
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
    document.getElementById('time-in-btn').disabled = false;
    btn.style.display = 'none';

    // Refresh DTR records
    await loadDTRRecords();
    loadTodayDTRSummary();
    await updateGeofenceStatus();
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

    const { hasTimedIn, hasTimedOut, dtr } = response.data;
    
    if (dtr) {
      document.getElementById('today-time-in').textContent = dtr.timeIn ? new Date(dtr.timeIn).toLocaleTimeString() : '—';
      document.getElementById('today-time-out').textContent = dtr.timeOut ? new Date(dtr.timeOut).toLocaleTimeString() : '—';
      document.getElementById('today-hours').textContent = dtr.hoursRendered?.toFixed(2) || '0';
    }

    // Update button visibility
    const timeInBtn = document.getElementById('time-in-btn');
    const timeOutBtn = document.getElementById('time-out-btn');
    
    if (hasTimedIn && !hasTimedOut) {
      timeInBtn.style.display = 'none';
      timeOutBtn.style.display = 'block';
    } else if (hasTimedOut) {
      timeInBtn.style.display = 'block';
      timeOutBtn.style.display = 'none';
    } else {
      timeInBtn.style.display = 'block';
      timeOutBtn.style.display = 'none';
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
      document.getElementById('today-time-in-status').textContent = todayRecord.timeIn ? 'recorded' : 'pending';
      
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
  console.log('📄 DOMContentLoaded event fired');
  console.log('window.currentUser:', window.currentUser);
  console.log('window.authToken:', window.authToken ? '(exists)' : '(missing)');
  
  // Set user name from stored user data
  const userName = window.currentUser?.fullName?.split(' ')[0] || 'Student';
  const userNameEl = document.getElementById('user-name');
  if (userNameEl) {
    userNameEl.textContent = userName;
  }

  // Update date/time
  updateDateTime();
  setInterval(updateDateTime, 60000);

  // Load student dashboard data from backend
  await loadDashboardData();

  // Restore previous tab from localStorage or default to overview
  const previousTab = localStorage.getItem('trackit_current_tab') || 'overview';
  switchTab(previousTab);
  console.log('✅ Tab restored:', previousTab);

  // Generate DTR calendar
  generateDTRCalendar();

  // Initialize Geofence Tracking (replacing QR Code)
  await initializeGeolocation();
  await loadTodayDTRSummary();
  
  // Update geofence status periodically
  setInterval(updateGeofenceStatus, 5000); // Update every 5 seconds
  
  await loadDTRRecords();
  startStudentRealtimeUpdates();

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


