require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const { initializeOpenRouter } = require('./services/summaryService');

const app = express();

// Middleware
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(cors());

// Initialize OpenRouter
initializeOpenRouter();

// Middleware to ensure DB connection for API routes
app.use(async (req, res, next) => {
  // Static assets and root or health check do not require pre-blocking DB connection
  if (!req.path.startsWith('/api') && req.path !== '/health') {
    return next();
  }
  if (req.path === '/api/health' || req.path === '/health') {
    return next();
  }
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error('Database connection failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Database connection failed. Please verify your MONGODB_URI configuration.',
      error: error.message
    });
  }
});

// Import routes
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const coordinatorRoutes = require('./routes/coordinator');
const supervisorRoutes = require('./routes/supervisor');
const statsRoutes = require('./routes/stats');
const qrRoutes = require('./routes/qr');
const journalRoutes = require('./routes/journal');
const geofenceRoutes = require('./routes/geofence');

// API Router
const apiRouter = express.Router();

apiRouter.use('/auth', authRoutes);
apiRouter.use('/dashboard', dashboardRoutes);
apiRouter.use('/coordinator', coordinatorRoutes);
apiRouter.use('/supervisor', supervisorRoutes);
apiRouter.use('/stats', statsRoutes);
apiRouter.use('/qr', qrRoutes);
apiRouter.use('/journal', journalRoutes);
apiRouter.use('/geofence', geofenceRoutes);

// Health check endpoint
apiRouter.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  try {
    await connectDB();
    dbStatus = 'connected';
  } catch (err) {
    dbStatus = 'error: ' + err.message;
  }

  res.status(200).json({
    success: true,
    message: 'TrackIT API is operational',
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

// Mount API router on both '/api' and '/'
app.use('/api', apiRouter);
app.use('/', apiRouter);

// Serve static assets from project root for local development
const rootDir = path.join(__dirname, '..');
app.use(express.static(rootDir));

// Root path fallback for local development
app.get('/', (req, res, next) => {
  const indexPath = path.join(rootDir, 'index.html');
  const fs = require('fs');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  next();
});

// Global error handler
app.use(errorHandler);



module.exports = app;

