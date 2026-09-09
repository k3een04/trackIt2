const path = require('path');
const express = require('express');
const app = require('./app');

// Add cache-busting middleware for development
app.use((req, res, next) => {
  // Prevent caching for HTML, JS, CSS in development
  if (req.path.match(/\.(js|css|html)$/i)) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// Serve static files from parent directory (root of TrackIT)
app.use(express.static(path.join(__dirname, '..')));

// 404 handler for local server
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// Start local server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 TrackIT Backend Server running on port ${PORT}`);
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/api/health\n`);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error(`\n✗ Unhandled Rejection: ${err.message}`);
  process.exit(1);
});

