/**
 * ⚡ RANT SQUAD VIDEO PROCESSOR API ⚡
 * 
 * Complete server.js with all routes including Split React
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
// Import routes
const downloadRoutes = require('./routes/download');
const transcribeRoutes = require('./routes/transcribe');
const renderRoutes = require('./routes/render');
const jobsRoutes = require('./routes/jobs');
const splitRoutes = require('./routes/split');
const combineRoutes = require('./routes/combine');
const adminRoutes = require('./routes/admin');
const uploadRoutes = require('./routes/upload');
const singleReactionRoutes = require('./routes/singleReaction');
const splitReactRoutes = require('./routes/splitReact');  // ⚡ SPLIT REACT (NEW!)
// Import services
const cleanupService = require('./services/cleanupService');
const app = express();
const PORT = process.env.PORT || 8080;
// Ensure directories exist
const ensureDirs = async () => {
  const dirs = [
    process.env.OUTPUT_DIR || '/app/outputs',
    process.env.TEMP_DIR || '/app/temp',
    path.join(process.env.TEMP_DIR || '/app/temp', 'uploads')
  ];
  for (const dir of dirs) {
    await fs.ensureDir(dir);
  }
};
ensureDirs();
// Start cleanup service (runs every hour, deletes files older than 24h)
cleanupService.startAutoCleanup();
// Middleware
// CORS Configuration - Allow frontend domains
app.use(cors({
  origin: [
    'https://rantsquad.99dfy.com',
    'https://devrant.99dfy.com',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8080'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id'],
  credentials: true
}));

// Handle preflight requests
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      download: 'active',
      transcribe: 'active',
      render: 'active',
      split: 'active',
      combine: 'active',
      cleanup: 'active',
      upload: 'active',
      'single-reaction': 'active',
      'split-react': 'active'  // ⚡ SPLIT REACT (NEW!)
    }
  });
});
// Routes
app.use('/api/download', downloadRoutes);
app.use('/api/transcribe', transcribeRoutes);
app.use('/api/render', renderRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/split', splitRoutes);
app.use('/api/combine', combineRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/single-reaction', singleReactionRoutes);
app.use('/api/split-react', splitReactRoutes);  // ⚡ SPLIT REACT (NEW!)
// Error handling for multer
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: 'File too large. Maximum size is 10GB.'
    });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({
      success: false,
      error: 'Too many files. Maximum is 20 files.'
    });
  }
  if (err.message && err.message.includes('Invalid file type')) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
  console.error('Error:', err);
  res.status(500).json({ 
    success: false, 
    error: err.message 
  });
});
// Start server
app.listen(PORT, () => {
  console.log('');
  console.log('⚡ RANT SQUAD VIDEO PROCESSOR API ⚡');
  console.log(`Listening on port ${PORT}`);
  console.log('');
  console.log('Available endpoints:');
  console.log('  POST /api/download');
  console.log('  POST /api/transcribe');
  console.log('  POST /api/render');
  console.log('  POST /api/admin/cleanup');
  console.log('  POST /api/split');
  console.log('  POST /api/combine');
  console.log('  POST /api/combine/from-split/:splitJobId');
  console.log('  POST /api/upload');
  console.log('  POST /api/single-reaction/*');
  console.log('  POST /api/split-react/*        ← ⚡ SPLIT REACT (NEW!)');
  console.log('  GET  /api/combine/:jobId/download');
  console.log('  GET  /api/split/:jobId/download');
  console.log('  GET  /api/jobs/:jobId/download');
  console.log('  GET  /api/admin/status');
  console.log('  GET  /health');
});
module.exports = app;
