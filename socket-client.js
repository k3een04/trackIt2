/**
 * Socket.io Real-time Updates Client
 * Shared utility for all dashboards to handle real-time events
 */

let socket = null;
let connectionPromise = null;
let resolveConnection = null;
let userRoomJoined = false;
let companyRoomJoined = false;
const listeners = {}; // Track registered listeners to prevent duplicates

/**
 * Initialize Socket.io connection
 * @param {String} userId - Current logged-in user ID
 * @param {String} companyName - User's company (optional)
 */
function initializeSocket(userId, companyName = null) {
  console.log('🔍 initializeSocket called with userId:', userId, 'companyName:', companyName);
  
  // Create the connection promise immediately
  if (!connectionPromise) {
    connectionPromise = new Promise((resolve) => {
      resolveConnection = resolve;
    });
    console.log('📋 Connection promise created');
  }
  
  // Load Socket.io library from backend
  if (!window.io) {
    console.log('📚 Socket.io library not found in window, loading from backend...');
    const script = document.createElement('script');
    // Use full URL to backend server to avoid dev server routing issues
    script.src = 'http://localhost:5000/socket.io/socket.io.js';
    script.onload = () => {
      console.log('✅ Socket.io library loaded successfully');
      if (window.io) {
        createSocketConnection(userId, companyName);
      } else {
        console.error('❌ Socket.io library loaded but window.io is still undefined');
      }
    };
    script.onerror = (err) => {
      console.error('❌ Failed to load Socket.io library:', err);
      // Reject the connection promise on error
      if (resolveConnection) {
        resolveConnection();
        resolveConnection = null;
      }
    };
    document.head.appendChild(script);
  } else {
    console.log('ℹ️ Socket.io library already loaded, creating connection...');
    createSocketConnection(userId, companyName);
  }
}

/**
 * Create Socket.io connection with proper error handling
 */
function createSocketConnection(userId, companyName) {
  console.log('🔧 createSocketConnection starting...');
  
  // Prevent duplicate connections
  if (socket && socket.connected) {
    console.log('ℹ️ Socket already connected:', socket.id);
    return;
  }

  // Check if io is available
  if (!window.io) {
    console.error('❌ window.io is not available!');
    return;
  }

  console.log('📡 Creating new Socket.io connection...');

  // Create connection promise
  connectionPromise = new Promise((resolve) => {
    resolveConnection = resolve;
  });

  try {
    socket = io('http://localhost:5000', {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 10,
      transports: ['websocket', 'polling'],
    });

    console.log('🔌 Socket instance created:', socket);

    socket.on('connect', () => {
      console.log('✅ Connected to real-time server:', socket.id);

      // Join user-specific room for personal updates
      if (userId && !userRoomJoined) {
        const userIdStr = userId.toString();
        socket.emit('joinUserRoom', userIdStr);
        userRoomJoined = true;
        console.log('📍 Emitted joinUserRoom for:', userIdStr);
      }

      // Join company room for supervisor/coordinator updates
      if (companyName && !companyRoomJoined) {
        socket.emit('joinCompanyRoom', companyName);
        companyRoomJoined = true;
        console.log('📍 Emitted joinCompanyRoom for:', companyName);
      }

      // Give a small delay to ensure rooms are joined before resolving connection
      setTimeout(() => {
        // Resolve connection promise
        if (resolveConnection) {
          resolveConnection();
          resolveConnection = null;
        }

        // Call any pending initialization callbacks
        if (window.onSocketConnected) {
          window.onSocketConnected();
        }
      }, 100);
    });

    socket.on('disconnect', () => {
      console.log('❌ Disconnected from real-time server');
      userRoomJoined = false;
      companyRoomJoined = false;
    });

    socket.on('reconnect', () => {
      console.log('🔄 Reconnected to real-time server:', socket.id);
      userRoomJoined = false;
      companyRoomJoined = false;
      
      // Rejoin rooms on reconnect
      if (userId) {
        const userIdStr = userId.toString();
        socket.emit('joinUserRoom', userIdStr);
        userRoomJoined = true;
        console.log('📍 Rejoined user room:', userIdStr);
      }
      if (companyName) {
        socket.emit('joinCompanyRoom', companyName);
        companyRoomJoined = true;
        console.log('📍 Rejoined company room:', companyName);
      }
    });

    socket.on('error', (error) => {
      console.error('❌ Socket error event:', error);
    });

    socket.on('connect_error', (error) => {
      console.error('❌ Socket connect_error event:', error);
      console.error('   Error type:', error.type);
      console.error('   Error message:', error.message);
      console.error('   Error data:', error.data);
    });
  } catch (error) {
    console.error('❌ Error creating socket connection:', error);
  }
}

/**
 * Wait for socket connection to be established
 */
async function waitForSocketConnection() {
  if (socket && socket.connected) {
    console.log('✅ Socket already connected');
    return;
  }
  if (connectionPromise) {
    console.log('⏳ Waiting for socket connection with 15 second timeout...');
    try {
      await Promise.race([
        connectionPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Socket connection timeout after 15 seconds')), 15000)
        )
      ]);
      console.log('✅ Socket connection established');
    } catch (error) {
      console.error('❌ Socket connection error:', error.message);
      console.error('💡 Troubleshooting: Make sure backend is running on http://localhost:5000');
      throw error;
    }
  } else {
    console.warn('⚠️ No connection promise available');
  }
}

/**
 * Register event listener with deduplication
 */
function registerListener(eventName, callback) {
  if (!socket) {
    console.warn(`⚠️ Socket not initialized for ${eventName}`);
    return;
  }

  // Remove any existing listeners for this event to prevent duplicates
  socket.off(eventName);
  
  socket.on(eventName, callback);
  listeners[eventName] = true;
  console.log(`✅ Registered listener for '${eventName}'`);
}

/**
 * Listen for Time In event (student dashboard)
 */
function onTimeIn(callback) {
  registerListener('timeIn', (data) => {
    console.log('🟢 Time In event received:', data);
    callback(data);
  });
}

/**
 * Listen for Time Out event (student dashboard)
 */
function onTimeOut(callback) {
  registerListener('timeOut', (data) => {
    console.log('🔴 Time Out event received:', data);
    callback(data);
  });
}

/**
 * Listen for Stats Update event (real-time dashboard refresh)
 */
function onStatsUpdate(callback) {
  registerListener('statsUpdate', (data) => {
    console.log('📊 Stats Update event received:', data);
    callback(data);
  });
}

/**
 * Listen for QR Used event (new QR generated)
 */
function onQRUsed(callback) {
  registerListener('qrUsed', (data) => {
    console.log('✔️ QR Used event received:', data);
    callback(data);
  });
}

/**
 * Listen for Student Time In event (supervisor dashboard)
 */
function onStudentTimeIn(callback) {
  registerListener('studentTimeIn', (data) => {
    console.log('👥 Student Time In received:', data);
    callback(data);
  });
}

/**
 * Listen for Student Time Out event (supervisor dashboard)
 */
function onStudentTimeOut(callback) {
  registerListener('studentTimeOut', (data) => {
    console.log('👥 Student Time Out received:', data);
    callback(data);
  });
}

/**
 * Listen for Supervisor Dashboard Update (supervisor/company room)
 */
function onSupervisorDashboardUpdate(callback) {
  registerListener('supervisorDashboardUpdate', (data) => {
    console.log('📊 Supervisor Dashboard Update received:', data);
    callback(data);
  });
}

/**
 * Listen for Coordinator Dashboard Update (all coordinators)
 */
function onCoordinatorDashboardUpdate(callback) {
  registerListener('coordinatorDashboardUpdate', (data) => {
    console.log('📊 Coordinator Dashboard Update received:', data);
    callback(data);
  });
}

/**
 * Listen for QR Code Generated event
 */
function onQRGenerated(callback) {
  registerListener('qrGenerated', (data) => {
    console.log('📱 QR Code Generated:', data);
    callback(data);
  });
}

/**
 * Disconnect socket
 */
function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

/**
 * Get socket instance
 */
function getSocket() {
  return socket;
}

// Verify socket-client.js is loaded
console.log('✅ socket-client.js loaded successfully');
