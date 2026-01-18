/**
 * ⚡ RANT SQUAD VIDEO PROCESSOR API ⚡
 * 
 * Complete server.js with all routes including Audio-Only RANT
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
const overlayRoutes = require('./routes/overlay');
const singleReactionRoutes = require('./routes/singleReaction');
const splitReactRoutes = require('./routes/splitReact');
const audioReactionRoutes = require('./routes/audioReaction');  // 🎙️ AUDIO-ONLY RANT (NEW!)

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
app.use(cors());
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
      overlay: 'active',
      singleReaction: 'active',
      splitReact: 'active',
      audioReaction: 'active'  // 🎙️ NEW!
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
app.use('/api/overlay', overlayRoutes);
app.use('/api/single-reaction', singleReactionRoutes);
app.use('/api/split-react', splitReactRoutes);
app.use('/api/audio-reaction', audioReactionRoutes);  // 🎙️ AUDIO-ONLY RANT (NEW!)

// Error handling for multer
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: 'File too large. Maximum size is 500MB.'
    });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({
      success: false,
      error: 'Too many files. Maximum is 20 files.'
    });
  }
  if (err.message) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
  next(err);
});

// General error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`⚡ RANT SQUAD VIDEO PROCESSOR API`);
  console.log(`${'='.repeat(60)}`);
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`\n📡 Available endpoints:`);
  console.log(`   POST /api/download          - Download video from URL`);
  console.log(`   POST /api/transcribe        - Transcribe video audio`);
  console.log(`   POST /api/render            - Render reaction video`);
  console.log(`   POST /api/split             - Split video at timestamps`);
  console.log(`   POST /api/combine           - Combine clips with reactions`);
  console.log(`   POST /api/upload            - Upload video directly`);
  console.log(`   POST /api/overlay           - Add overlay to video`);
  console.log(`   POST /api/single-reaction   - Single reaction video`);
  console.log(`   POST /api/split-react       - Split React feature`);
  console.log(`   POST /api/audio-reaction    - 🎙️ Audio-Only RANT (NEW!)`);
  console.log(`   GET  /api/admin/status      - Storage status`);
  console.log(`   GET  /health                - Health check`);
  console.log(`${'='.repeat(60)}\n`);
});
