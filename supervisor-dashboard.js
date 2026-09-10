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
          <div class="w-12 h-12 rounded-full bg-gradient-to-br from-teal-400 to-teal-600 flex items-center justify-center text-white font-bold text-lg">${getInitials(trainee.fullName)}</div>
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
          <div class="w-8 h-8 rounded-full bg-gradient-to-br from-teal-400 to-teal-600 flex items-center justify-center text-white text-xs font-bold">${getInitials(trainee.fullName)}</div>
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
            <button onclick="switchTab('${tabName}')" class="text-teal-400 hover:text-teal-300 text-xs font-semibold whitespace-nowrap">${buttonLabel}</button>
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
                <span class="font-semibold text-teal-400">${totalDaysPresent}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-slate-400">Total Hours:</span>
                <span class="font-semibold text-teal-400">${totalHours}</span>
              </div>
              <div class="flex justify-between pt-3 border-t border-white/10">
                <span class="text-slate-400">Attendance Rate:</span>
                <span class="font-semibold text-teal-400">${attendanceRate}%</span>
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
                  <div class="bg-teal-400 h-2 rounded-full" style="width: ${progressPercentage}%;"></div>
                </div>
              </div>
              <div>
                <p class="text-xs text-slate-400">Remaining: <span class="text-teal-400 font-semibold">${remainingHours.toFixed(1)} hours</span></p>
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
          
          <!-- Rating Section -->
          <div class="mb-6 pb-6 border-b border-white/10">
            <p class="text-sm text-slate-400 mb-3">Performance Rating (0-5 stars)</p>
            <div class="flex gap-2 items-center">
              ${[1, 2, 3, 4, 5].map(star => `
                <button onclick="rateTrainee('${traineeId}', ${star})" class="rating-star text-2xl hover:scale-110 transition" data-rating="${star}">
                  ☆
                </button>
              `).join('')}
              <span id="rating-display" class="ml-4 text-teal-400 font-semibold">
                ${trainee.supervisorRating ? trainee.supervisorRating + '★' : 'Not rated'}
              </span>
            </div>
            <p class="text-xs text-slate-500 mt-2">${trainee.supervisorRating ? `Rated on ${new Date(trainee.supervisorRatingDate).toLocaleDateString()}` : 'Click a star to submit rating'}</p>
          </div>

          <!-- Notes -->
          <div>
            <p class="text-sm text-slate-400 mb-3">Additional Notes</p>
            <textarea id="trainee-notes" placeholder="Add private notes about this trainee..." class="w-full glass-card px-4 py-3 text-white text-sm rounded-lg border border-white/10 focus:border-teal-400 outline-none" rows="4"></textarea>
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
  alert('Trainee notes saved successfully');
}

async function rateTrainee(traineeId, rating) {
  try {
    // Update star display
    document.querySelectorAll('.rating-star').forEach((star, index) => {
      if (index < rating) {
        star.textContent = '★';
        star.style.color = '#fbbf24';
      } else {
        star.textContent = '☆';
        star.style.color = '#9ca3af';
      }
    });

    // Submit rating to backend
    const result = await fetchAPI('/supervisor/rate-trainee', {
      method: 'POST',
      body: JSON.stringify({
        traineeId,
        rating
      })
    });

    if (result && result.success) {
      // Update rating display
      const ratingDisplay = document.getElementById('rating-display');
      if (ratingDisplay) {
        ratingDisplay.textContent = `${rating}★`;
      }
      console.log(`Rating ${rating} submitted for trainee ${traineeId}`);
    } else {
      alert('Failed to submit rating. Please try again.');
    }
  } catch (error) {
    console.error('Error submitting rating:', error);
    alert('Error submitting rating. Please try again.');
  }
}

function messageTrainee(traineeId) {
  alert('Messaging feature - Open messaging dialog');
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
      alert('Please select a trainee from the dropdown');
      return;
    }

    if (!monthPicker?.value) {
      alert('Please select a month');
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
      alert('Failed to load DTR data.\n\nThe backend server may not be running. Please:\n1. Make sure the backend is running (npm start in /backend)\n2. Refresh the page\n3. Try again');
      return;
    }

    if (!result.success) {
      console.error('DTR API Error:', result);
      alert('Failed to load DTR data.\n\nError: ' + (result?.message || 'Unknown error') + '\n\nIf you see "route not found", restart the backend server.');
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
    alert('An error occurred while loading DTR data');
  }
}


async function verifySelectedDTR() {
  const checkboxes = document.querySelectorAll('#dtr-table-body input[type="checkbox"]:checked');
  
  if (checkboxes.length === 0) {
    alert('Please select at least one DTR entry to verify');
    return;
  }

  const confirmed = confirm(`Verify ${checkboxes.length} selected DTR entries?`);
  if (!confirmed) return;

  let successCount = 0;
  let failureCount = 0;

  for (const checkbox of checkboxes) {
    const dtrId = checkbox.getAttribute('data-dtr-id');
    try {
      const result = await fetchAPI(`/qr/verify/${dtrId}`, {
        method: 'PUT',
        body: JSON.stringify({
          supervisorId: window.currentUser._id,
          signature: `Verified by ${window.currentUser.fullName} on ${new Date().toLocaleString()}`,
          remarks: '',
        }),
      });

      if (result && result.success) {
        successCount++;
        checkbox.disabled = true;
        checkbox.closest('tr').classList.add('opacity-60');
      } else {
        failureCount++;
      }
    } catch (error) {
      console.error('Error verifying DTR:', error);
      failureCount++;
    }
  }

  alert(`Verification complete: ${successCount} succeeded, ${failureCount} failed`);
  
  // Reload DTR data to refresh table
  if (successCount > 0) {
    setTimeout(() => loadDTRData(), 1000);
  }
}

function flagDTREntry() {
  const checkboxes = document.querySelectorAll('#dtr-table-body input[type="checkbox"]:checked');
  
  if (checkboxes.length === 0) {
    alert('Please select at least one DTR entry to flag');
    return;
  }

  const reason = prompt('Enter reason for flagging:');
  if (reason) {
    alert(`${checkboxes.length} DTR entry/entries flagged with reason: ${reason}\n\nNote: Flag functionality can be implemented in the remarks field.`);
  }
}

async function verifyAllAndSign() {
  const tableBody = document.getElementById('dtr-table-body');
  const allRows = tableBody.querySelectorAll('tr[data-dtr-id]');
  
  if (allRows.length === 0) {
    alert('No DTR records to verify');
    return;
  }

  const unverifiedRows = Array.from(allRows).filter(row => {
    const statusBadge = row.querySelector('.status-badge');
    return statusBadge && !statusBadge.classList.contains('status-completed');
  });

  if (unverifiedRows.length === 0) {
    alert('All DTR entries are already verified');
    return;
  }

  const confirmed = confirm(
    `You are about to digitally sign ${unverifiedRows.length} DTR entries for this entire month. This action cannot be undone. Continue?`
  );
  
  if (!confirmed) return;

  let successCount = 0;
  let failureCount = 0;

  for (const row of unverifiedRows) {
    const dtrId = row.getAttribute('data-dtr-id');
    try {
      const result = await fetchAPI(`/qr/verify/${dtrId}`, {
        method: 'PUT',
        body: JSON.stringify({
          supervisorId: window.currentUser._id,
          signature: `Digitally signed by ${window.currentUser.fullName} on ${new Date().toLocaleString()}`,
          remarks: 'Batch verification - entire month verified',
        }),
      });

      if (result && result.success) {
        successCount++;
      } else {
        failureCount++;
      }
    } catch (error) {
      console.error('Error verifying DTR:', error);
      failureCount++;
    }
  }

  if (successCount > 0) {
    document.getElementById('dtr-signature-area').classList.remove('hidden');
    document.getElementById('sig-supervisor-name').textContent = window.currentUser.fullName || 'Supervisor';
    document.getElementById('sig-supervisor-pos').textContent = window.currentUser.companyPosition || 'Company Supervisor';
    document.getElementById('sig-supervisor-company').textContent = window.currentUser.companyName || 'Your Company';
    document.getElementById('sig-timestamp').textContent = new Date().toLocaleString();
  }

  alert(`Verification complete: ${successCount} verified, ${failureCount} failed`);

  // Reload DTR data to refresh table
  if (successCount > 0) {
    setTimeout(() => loadDTRData(), 1000);
  }
}

function downloadDTRPDF() {
  alert('Downloading DTR as PDF...\nFile: DTR_' + (window.currentUser?.fullName || 'Trainee') + '_' + new Date().toISOString().slice(0, 7) + '.pdf');
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
              <p class="font-semibold text-sm text-teal-400">${journal.week}</p>
              <p class="text-xs text-slate-400">${traineeInfo.fullName || 'Unknown Trainee'}</p>
              <p class="text-xs text-slate-500">${date}</p>
            </div>
            <span class="status-badge" style="background: rgba(245,158,11,0.2); color: #f59e0b; border: 1px solid rgba(245,158,11,0.3);">Pending</span>
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
              <p class="font-semibold text-sm text-teal-400">${journal.week}</p>
              <p class="text-xs text-slate-400">${traineeInfo.fullName || 'Unknown Trainee'}</p>
              <p class="text-xs text-slate-500">Signed: ${date}</p>
            </div>
            <span class="status-badge" style="background: rgba(34,197,94,0.2); color: #22c55e; border: 1px solid rgba(34,197,94,0.3);">Signed</span>
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
              <p class="font-semibold text-sm text-teal-400">${journal.week}</p>
              <p class="text-xs text-slate-400">${traineeInfo.fullName || 'Unknown Trainee'}</p>
              <p class="text-xs text-slate-500">Submitted: ${date}</p>
            </div>
            <span class="status-badge" style="background: rgba(239,68,68,0.2); color: #ef4444; border: 1px solid rgba(239,68,68,0.3);">Returned</span>
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
  
  // Find the selected journal data from the list
  fetchAPI(`/journal/${journalId}`).then(journalResult => {
    if (!journalResult || !journalResult.success) {
      viewer.innerHTML = '<div class="text-red-400">Error loading journal details</div>';
      return;
    }

    const journal = journalResult.data;
    const traineeInfo = journal.studentId || {};
    const isSigned = journal.supervisorSigned;
    
    // Determine status badge styling
    const statusStyle = isSigned 
      ? 'background: rgba(34,197,94,0.2); color: #22c55e; border: 1px solid rgba(34,197,94,0.3);'
      : 'background: rgba(245,158,11,0.2); color: #f59e0b; border: 1px solid rgba(245,158,11,0.3);';
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
            <span class="status-badge" style="${statusStyle}">${statusText}</span>
            <button onclick="closeJournalViewer()" class="p-2 hover:bg-white/10 rounded-lg transition" title="Close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
        </div>

        ${journal.summary ? `
          <div class="glass-card p-4 bg-white/5 border-l-4 border-teal-400 mb-6">
            <p class="text-xs text-slate-400 mb-2">AI-GENERATED SUMMARY</p>
            <p class="text-sm text-slate-200">${journal.summary}</p>
          </div>
        ` : `
          <div class="glass-card p-4 bg-slate-600/20 border-l-4 border-slate-500 mb-6">
            <p class="text-xs text-slate-400 mb-2">AI-GENERATED SUMMARY</p>
            <p class="text-sm text-slate-300">No summary available for this journal</p>
          </div>
        `}

        ${journal.concepts && journal.concepts.length > 0 ? `
          <div class="mb-6">
            <h4 class="font-semibold mb-3">Concepts Applied</h4>
            <div class="space-y-2">
              ${journal.concepts.map(concept => `
                <label class="flex items-center gap-2">
                  <input type="checkbox" checked disabled class="w-4 h-4 accent-teal-400">
                  <span class="text-sm">${concept}</span>
                </label>
              `).join('')}
            </div>
          </div>
        ` : ''}

        ${!isSigned ? `
          <div class="mb-6">
            <label class="block text-sm font-semibold mb-3">Supervisor Remarks (Optional)</label>
            <textarea id="journal-remarks" class="w-full glass-card px-4 py-3 text-white text-sm rounded-lg border border-white/10 focus:border-teal-400 outline-none" rows="3" placeholder="Add your remarks here..."></textarea>
          </div>
        ` : ''}

        <div class="flex gap-3">
          ${isSigned ? `
            <div class="glass-card p-4 bg-green-500/10 border border-green-500/30 rounded-lg w-full">
              <p class="text-sm text-green-400">✓ This journal has been signed on ${new Date(journal.supervisorSignedAt).toLocaleDateString('en-US')}</p>
              ${journal.supervisorReview ? `<p class="text-xs text-slate-400 mt-2">Your remarks: ${journal.supervisorReview}</p>` : ''}
            </div>
          ` : `
            <button onclick="returnJournalForRevision('${journal._id}')" class="btn-ghost flex-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"></path><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"></path></svg>
              Return for Revision
            </button>
            <button onclick="verifyAndSignJournal('${journal._id}')" class="btn-primary flex-1" style="background: linear-gradient(135deg, #00c8aa 0%, #00c8aa 100%);">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
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
  const feedback = prompt('Enter feedback for revision:');
  if (feedback) {
    rejectJournal(journalId, feedback);
  }
}

async function verifyAndSignJournal(journalId) {
  const confirmed = confirm('You are about to digitally sign this journal. This action cannot be undone. Continue?');
  if (confirmed) {
    const remarks = document.getElementById('journal-remarks')?.value || '';
    
    try {
      const result = await fetchAPI(`/supervisor/journals/${journalId}/sign`, {
        method: 'POST',
        body: JSON.stringify({
          remarks: remarks || null,
        }),
      });

      if (!result || !result.success) {
        showNotification('Error', result?.message || 'Failed to sign journal', 'error');
        return;
      }

      showNotification('Success', 'Journal signed successfully', 'success');
      // Clear viewer and reload pending journals list
      document.getElementById('supervisor-journal-viewer').innerHTML = '<div class="text-center py-12"><p class="text-slate-400">Select a journal to review and sign</p></div>';
      loadPendingJournals();
    } catch (error) {
      console.error('Error signing journal:', error);
      showNotification('Error', 'Error signing journal', 'error');
    }
  }
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
// PERFORMANCE APPRAISAL SECTION
// ────────────────────────────────────────────────────────────────────────────

const appraisalRatings = {};

function setRating(category, rating) {
  appraisalRatings[category] = rating;
  updateRatingStars(category, rating);
  calculateOverallRating();
}

function updateRatingStars(category, rating) {
  const buttons = document.querySelectorAll(`#${category}-stars .star-btn`);
  buttons.forEach((btn, idx) => {
    if (idx < rating) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function calculateOverallRating() {
  const ratings = Object.values(appraisalRatings);
  if (ratings.length === 0) {
    document.getElementById('overall-rating-num').textContent = '0.0';
    document.getElementById('overall-rating-label').textContent = 'No Rating';
    return;
  }
  
  const avg = (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1);
  let label = 'No Rating';
  
  if (avg >= 4.5) label = 'Excellent';
  else if (avg >= 4) label = 'Very Good';
  else if (avg >= 3) label = 'Good';
  else label = 'Needs Improvement';
  
  document.getElementById('overall-rating-num').textContent = avg;
  document.getElementById('overall-rating-label').textContent = label;
}

function saveDraftAppraisal() {
  alert('Appraisal saved as draft');
}

function submitAppraisal(event) {
  event.preventDefault();
  const confirmed = confirm('You are about to submit and digitally sign this appraisal. This action cannot be undone. Continue?');
  if (confirmed) {
    alert('Appraisal submitted and digitally signed successfully');
    document.getElementById('appraisal-form').reset();
    appraisalRatings = {};
  }
}

function downloadAppraisalPDF(month) {
  alert(`Downloading appraisal for ${month}...\nFile: Appraisal_JohnDoe_${month.toUpperCase()}2026.pdf`);
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
  alert('All notifications marked as read');
}

function filterSupervisorNotifications(type) {
  const tabs = document.querySelectorAll('.filter-tab');
  tabs.forEach(tab => tab.classList.remove('active'));
  event.target.classList.add('active');
  alert(`Filtering notifications: ${type}`);
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
    showNotification('Profile updated', 'Your changes have been saved.', 'success');
  });
}

async function changeSupervisorPassword(event) {
  event.preventDefault();
  const current = document.getElementById('sup-current-pass').value;
  const newPass = document.getElementById('sup-new-pass').value;
  const confirm = document.getElementById('sup-confirm-pass').value;

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
    showNotification('Password changed', 'Your password has been updated successfully.', 'success');
    document.getElementById('sup-password-form').reset();
  } else {
    showNotification('Password change failed', result?.message || 'Please try again.', 'error');
  }
}

function saveSupervisorPreferences() {
  alert('Notification preferences saved!');
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
  sidebar.classList.toggle('open');
}

// Close sidebar when a nav link is clicked on mobile
function closeSidebarOnMobile() {
  if (window.innerWidth <= 768) {
    const sidebar = document.querySelector('.sidebar');
    sidebar.classList.remove('open');
  }
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
    const statusBg = hasSchedule ? 'rgba(34,197,94,0.1)' : 'rgba(100,116,139,0.1)';
    const statusText = hasSchedule ? 'Configured' : 'Not Set';
    const statusColor = hasSchedule ? '#22c55e' : '#cbd5e1';

    return `
      <div class="schedule-item-${index}" data-index="${index}" style="padding: 12px; background: ${statusBg}; border-radius: 6px; cursor: pointer; transition: all 0.2s; user-select: none; pointer-events: auto;" onmouseenter="this.style.background='rgba(0,200,170,0.15)'" onmouseleave="this.style.background='${statusBg}'" onclick="selectTraineeForSchedule('${trainee._id}')">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <p style="margin: 0; font-weight: 600; font-size: 13px; color: #cbd5e1;">${trainee.fullName}</p>
          <span style="font-size: 11px; padding: 4px 8px; background: ${statusBg}; border-radius: 4px; color: ${statusColor}; font-weight: 600;">${statusText}</span>
        </div>
        ${hasSchedule ? `
          <p style="margin: 0; font-size: 12px; color: #94a3b8;">${trainee.schedule.startTime} - ${trainee.schedule.endTime}</p>
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

    showNotification('Success', '✓ Schedule saved successfully', 'success');
    await loadScheduleTraineeList(); // Refresh list
  } catch (error) {
    console.error('[Schedule Manager] Exception error saving schedule:', error);
    showNotification('Error', 'Failed to save schedule: ' + error.message, 'error');
  }
}

/**
 * Clear trainee schedule
 */
async function clearTraineeSchedule() {
  const select = document.getElementById('schedule-trainee-select');
  const traineeId = select.value;

  if (!traineeId) {
    showNotification('Error', 'Please select a trainee', 'error');
    return;
  }

  if (!confirm('Are you sure you want to clear this trainee\'s schedule?')) {
    return;
  }

  try {
    const response = await fetchAPI(`/supervisor/schedule/${traineeId}`, {
      method: 'DELETE',
    });

    if (!response || !response.success) {
      showNotification('Error', response?.message || 'Failed to clear schedule', 'error');
      return;
    }

    showNotification('Success', '✓ Schedule cleared successfully', 'success');
    clearScheduleFields();
    await loadScheduleTraineeList(); // Refresh list
  } catch (error) {
    console.error('[Schedule Manager] Error clearing schedule:', error);
    showNotification('Error', 'Failed to clear schedule', 'error');
  }
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

  // Initialize star rating buttons
  document.querySelectorAll('.star-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
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
    let icon, bgColor, color, title, desc, timeDisplay;

    if (action.type === 'dtr') {
      bgColor = 'rgba(245,158,11,0.2)';
      color = '#f59e0b';
      icon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect></svg>';
      title = 'DTR Submitted for Verification';
      desc = `${action.trainee} submitted DTR for ${action.date}`;
      
      const diffHrs = Math.floor((new Date() - new Date(action.timestamp)) / 3600000);
      timeDisplay = diffHrs > 24 ? Math.floor(diffHrs / 24) + ' days ago' : (diffHrs > 0 ? diffHrs + ' hours ago' : 'Recently');
    } else if (action.type === 'journal') {
      bgColor = 'rgba(0,200,170,0.2)';
      color = '#00c8aa';
      icon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
      title = 'Journal Submitted';
      desc = `${action.trainee} submitted ${action.week} journal`;
      
      const diffHrs = Math.floor((new Date() - new Date(action.timestamp)) / 3600000);
      timeDisplay = diffHrs > 24 ? Math.floor(diffHrs / 24) + ' days ago' : (diffHrs > 0 ? diffHrs + ' hours ago' : 'Recently');
    }

    return `
      <div class="notification-item unread" data-type="${action.type}">
        <div class="notification-icon" style="background: ${bgColor}; color: ${color};">
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

  // Update theme colors if in light mode
  if (document.body.classList.contains('light-mode')) {
    container.querySelectorAll('.title-text').forEach(el => el.style.color = '#0f172a');
    container.querySelectorAll('.desc-text').forEach(el => el.style.color = '#475569');
    container.querySelectorAll('.time-text').forEach(el => el.style.color = '#64748b');
  }
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

