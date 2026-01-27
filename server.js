/**
 * ⚡ RANT SQUAD VIDEO PROCESSOR API ⚡
 * 
 * Server.js for STAGING environment
 * Includes Audio-Only RANT feature
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');

// Import routes (ONLY files that exist in /routes folder)
const adminRoutes = require('./routes/admin');
const audioReactionRoutes = require('./routes/audioReaction');  // 🎙️ AUDIO-ONLY RANT
const combineRoutes = require('./routes/combine');
const downloadRoutes = require('./routes/download');
const jobsRoutes = require('./routes/jobs');
const renderRoutes = require('./routes/render');
const singleReactionRoutes = require('./routes/singleReaction');
const splitRoutes = require('./routes/split');
const splitReactRoutes = require('./routes/splitReact');
const transcribeRoutes = require('./routes/transcribe');
const uploadRoutes = require('./routes/upload');
const voiceRoutes = require('./routes/voice');
const imageOverlayRoutes = require('./routes/imageOverlay');
const webinarRoutes = require('./routes/webinar');

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

// Middleware - CORS Configuration
app.use(cors({
  origin: [
    'https://devrant.99dfy.com',
    'https://rantsquad.99dfy.com',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8080'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id'],
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      admin: 'active',
      audioReaction: 'active',  // 🎙️ NEW!
      combine: 'active',
      download: 'active',
      jobs: 'active',
      render: 'active',
      singleReaction: 'active',
      split: 'active',
      splitReact: 'active',
      transcribe: 'active',
      upload: 'active',
      voice: 'active'
    }
  });
});

// Routes
app.use('/api/admin', adminRoutes);
app.use('/api/audio-reaction', audioReactionRoutes);  // 🎙️ AUDIO-ONLY RANT
app.use('/api/combine', combineRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/render', renderRoutes);
app.use('/api/single-reaction', singleReactionRoutes);
app.use('/api/split', splitRoutes);
app.use('/api/split-react', splitReactRoutes);
app.use('/api/transcribe', transcribeRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/image-overlay', imageOverlayRoutes);
app.use('/api/webinar', webinarRoutes);

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
  console.log(`⚡ RANT SQUAD VIDEO PROCESSOR API - STAGING`);
  console.log(`${'='.repeat(60)}`);
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`\n📡 Available endpoints:`);
  console.log(`   POST /api/admin             - Admin functions`);
  console.log(`   POST /api/audio-reaction    - 🎙️ Audio-Only RANT (NEW!)`);
  console.log(`   POST /api/combine           - Combine clips with reactions`);
  console.log(`   POST /api/download          - Download video from URL`);
  console.log(`   GET  /api/jobs              - Job status`);
  console.log(`   POST /api/render            - Render reaction video`);
  console.log(`   POST /api/single-reaction   - Single reaction video`);
  console.log(`   POST /api/split             - Split video at timestamps`);
  console.log(`   POST /api/split-react       - Split React feature`);
  console.log(`   POST /api/transcribe        - Transcribe video audio`);
  console.log(`   POST /api/upload            - Upload video directly`);
  console.log(`   POST /api/voice             - Voice synthesis`);
  console.log(`   GET  /health                - Health check`);
  console.log(`${'='.repeat(60)}\n`);
});
