// Load backend/.env explicitly instead of relying on the current working
// directory. `npm start` runs `node backend/server.js` from the repository
// root, where there is no .env file, so a bare dotenv.config() would silently
// leave MONGODB_URI / SMTP_* undefined and disable email delivery.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const { initializeGoogleAI } = require('./services/summaryService');
const { createRateLimiter, describe: describeRateLimiter } = require('./middleware/rateLimit');

const app = express();

// Behind a proxy (Vercel, nginx, ...) Express must be told to read the client
// address from X-Forwarded-For, otherwise every request looks like it comes
// from the proxy and the per-IP rate limits in /api/auth would lump all users
// together. `1` trusts exactly one hop, so a client cannot spoof its own
// address by sending its own X-Forwarded-For header.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);

// Middleware
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(cors());

// Initialize Google GenAI
initializeGoogleAI();

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
const notificationRoutes = require('./routes/notifications');

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
apiRouter.use('/notifications', notificationRoutes);

// Broad safety net for every API route. The limit is high on purpose - the
// dashboard pages make many small calls - it only exists to blunt a runaway
// script or a flood. The auth routes have their own, much tighter limits.
apiRouter.use(
  '/',
  createRateLimiter({
    name: 'api',
    windowMs: (Number(process.env.API_RATE_WINDOW_SECONDS) || 900) * 1000,
    max: Number(process.env.API_RATE_MAX) || 600,
    message: 'You are making too many requests. Please slow down and try again shortly.',
  }),
);

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

// Mount API router on '/api'
app.use('/api', apiRouter);

// Resolve the repository root correctly in both local and serverless runtimes.
const rootDir = process.env.VERCEL ? process.cwd() : path.join(__dirname, '..');
app.use(express.static(rootDir));

// Explicit routes ensure Vercel's file tracer bundles the landing assets.
app.get('/visuals/landingpage.css', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'visuals', 'landingpage.css'));
});
app.get('/visuals/loginpage.css', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'visuals', 'loginpage.css'));
});
app.get('/visuals/signup.css', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'visuals', 'signup.css'));
});
app.get('/visuals/ojtdashboard.css', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'visuals', 'ojtdashboard.css'));
});
app.get('/visuals/coordinator-dashboard.css', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'visuals', 'coordinator-dashboard.css'));
});
app.get('/visuals/supervisor-dashboard.css', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'visuals', 'supervisor-dashboard.css'));
});
app.get('/landingpage.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landingpage.js'));
});
app.get('/loginpage.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'loginpage.js'));
});
app.get('/signup.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'signup.js'));
});
app.get('/ojtdashboard.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'ojtdashboard.js'));
});
app.get('/coordinator-dashboard.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'coordinator-dashboard.js'));
});
app.get('/supervisor-dashboard.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'supervisor-dashboard.js'));
});
app.get('/Trackitlogo.png', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'Trackitlogo.png'));
});

// Explicit page route handlers
app.get(['/login', '/loginpage.html'], (req, res) => {
  res.sendFile(path.join(rootDir, 'loginpage.html'));
});

app.get(['/signup', '/signup.html'], (req, res) => {
  res.sendFile(path.join(rootDir, 'signup.html'));
});

app.get('/ojtdashboard.html', (req, res) => {
  res.sendFile(path.join(rootDir, 'ojtdashboard.html'));
});

app.get('/coordinator-dashboard.html', (req, res) => {
  res.sendFile(path.join(rootDir, 'coordinator-dashboard.html'));
});

app.get('/supervisor-dashboard.html', (req, res) => {
  res.sendFile(path.join(rootDir, 'supervisor-dashboard.html'));
});

app.get(['/', '/index.html', '/landingpage.html'], (req, res) => {
  res.sendFile(path.join(rootDir, 'index.html'));
});

// Fallback mount for API router at root
app.use('/', apiRouter);

// Global error handler
app.use(errorHandler);

module.exports = app;


