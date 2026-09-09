/**
 * Socket.IO Service - Real-time updates for TrackIT
 * Handles socket connections, listeners, and event emissions
 */

let socket = null;
let isConnected = false;

/**
 * Initialize Socket.IO connection
 */
function initializeSocket() {
  if (socket) return; // Already initialized
  
  // Load socket.io client from CDN if not already loaded
  if (typeof io === 'undefined') {
    const script = document.createElement('script');
    script.src = 'https://cdn.socket.io/4.5.4/socket.io.js';
    script.onload = () => {
      connectSocket();
    };
    document.head.appendChild(script);
  } else {
    connectSocket();
  }
}

/**
 * Connect to socket server
 */
function connectSocket() {
  if (socket) return;
  
  socket = io('http://localhost:5000', {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 10,
    transports: ['websocket', 'polling'],
    forceNew: false,
    rejectUnauthorized: false
  });

  socket.on('connect', () => {
    console.log('✅ Socket.IO connected:', socket.id);
    isConnected = true;
    
    // Notify server of user connection
    if (window.currentUser && window.currentUser._id) {
      socket.emit('user_connected', window.currentUser._id);
    }
  });

  socket.on('disconnect', () => {
    console.log('❌ Socket.IO disconnected');
    isConnected = false;
  });

  socket.on('connect_error', (error) => {
    console.error('Socket.IO connection error:', error);
  });

  // Listen for real-time updates
  socket.on('stats_updated', (data) => {
    console.log('📊 Stats updated:', data);
    handleStatsUpdate(data);
  });

  socket.on('dtr_updated', (data) => {
    console.log('📅 DTR updated:', data);
    handleDTRUpdate(data);
  });

  socket.on('journal_updated', (data) => {
    console.log('📓 Journal updated:', data);
    handleJournalUpdate(data);
  });

  socket.on('verification_updated', (data) => {
    console.log('✔️ Verification updated:', data);
    handleVerificationUpdate(data);
  });
}

/**
 * Handle real-time stats updates
 */
function handleStatsUpdate(data) {
  const currentTab = document.querySelector('.tab-content.active');
  
  // Update stats if on overview tab
  if (currentTab && currentTab.id === 'overview') {
    const statCards = document.querySelectorAll('#overview .stat-num');
    if (statCards.length >= 4 && data.stats) {
      statCards[0].textContent = data.stats.completedHours;
      statCards[1].textContent = data.stats.daysPresent;
      statCards[2].textContent = data.stats.pendingJournals;
      statCards[3].textContent = data.stats.remainingHours;
      
      // Update progress circle
      const progressValue = document.querySelector('#overview .progress-value');
      const progressText = document.querySelector('#overview .progress-circle + p');
      if (progressValue) progressValue.textContent = `${data.stats.progressPercentage}%`;
      if (progressText) progressText.textContent = `${data.stats.completedHours} of ${data.stats.totalRequired} hours completed`;
      
      const progressCircle = document.querySelector('#overview .progress-circle');
      if (progressCircle) progressCircle.style.setProperty('--progress', `${data.stats.progressPercentage}%`);
    }
  }
  
  // Update progress tab if it exists
  if (currentTab && currentTab.id === 'progress') {
    const progressTabCircle = document.querySelector('#progress .progress-circle');
    const progressTabValue = document.querySelector('#progress .progress-value');
    const progressTabText = document.querySelector('#progress .progress-circle + p');
    if (progressTabCircle && data.stats) {
      progressTabCircle.style.setProperty('--progress', `${data.stats.progressPercentage}%`);
      if (progressTabValue) progressTabValue.textContent = `${data.stats.progressPercentage}%`;
      if (progressTabText) progressTabText.textContent = `${data.stats.completedHours} of ${data.stats.totalRequired} hours`;
    }
  }
}

/**
 * Handle real-time DTR updates
 */
function handleDTRUpdate(data) {
  const currentTab = document.querySelector('.tab-content.active');
  
  if (currentTab && currentTab.id === 'dtr') {
    console.log('🔄 Refreshing DTR records...');
    if (typeof loadDTRRecords === 'function') {
      loadDTRRecords();
    }
  }
}

/**
 * Handle real-time Journal updates
 */
function handleJournalUpdate(data) {
  const currentTab = document.querySelector('.tab-content.active');
  
  if (currentTab && currentTab.id === 'journal') {
    console.log('🔄 Refreshing journals...');
    if (typeof loadPreviousJournals === 'function') {
      loadPreviousJournals();
    }
  }
}

/**
 * Handle real-time Verification updates
 */
function handleVerificationUpdate(data) {
  console.log('📬 Verification update received');
  
  // Show notification
  showRealtimeNotification('Records Updated', 'Your DTR records have been verified by your supervisor!');
  
  // Refresh all tabs that might have verification data
  const currentTab = document.querySelector('.tab-content.active');
  if (currentTab) {
    if (currentTab.id === 'overview' && typeof loadRecentActivity === 'function') {
      loadRecentActivity();
    } else if (currentTab.id === 'dtr' && typeof loadDTRRecords === 'function') {
      loadDTRRecords();
    }
  }
}

/**
 * Emit stats update to all connected users
 */
function emitStatsUpdate(userId, stats) {
  if (socket && isConnected) {
    socket.emit('stats_updated', { userId, stats });
  }
}

/**
 * Emit DTR update to all connected users
 */
function emitDTRUpdate(userId, dtr) {
  if (socket && isConnected) {
    socket.emit('dtr_updated', { userId, dtr });
  }
}

/**
 * Emit Journal update to all connected users
 */
function emitJournalUpdate(userId, journal) {
  if (socket && isConnected) {
    socket.emit('journal_updated', { userId, journal });
  }
}

/**
 * Emit Verification update to all connected users
 */
function emitVerificationUpdate(userId, data) {
  if (socket && isConnected) {
    socket.emit('verification_updated', { userId, data });
  }
}

/**
 * Show real-time notification toast
 */
function showRealtimeNotification(title, message) {
  // Create notification element
  const notification = document.createElement('div');
  notification.className = 'realtime-notification';
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%);
    color: white;
    padding: 16px 20px;
    border-radius: 8px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
    z-index: 9999;
    animation: slideIn 0.3s ease-out;
    max-width: 300px;
  `;
  
  notification.innerHTML = `
    <div style="font-weight: 600; margin-bottom: 4px;">${title}</div>
    <div style="font-size: 0.875rem; opacity: 0.9;">${message}</div>
  `;
  
  document.body.appendChild(notification);
  
  // Add animation
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
  
  // Remove notification after 4 seconds
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => notification.remove(), 300);
  }, 4000);
}

/**
 * Get socket connection status
 */
function isSocketConnected() {
  return socket && isConnected;
}

/**
 * Disconnect socket
 */
function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
    isConnected = false;
  }
}

/**
 * Initialize socket on page load
 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSocket);
} else {
  initializeSocket();
}
