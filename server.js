/**
 * ⚡ RANT SQUAD VIDEO PROCESSOR API ⚡
 * 
 * Server.js - Production
 * Includes all features + Clip Library
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');

// Import routes (ONLY files that exist in /routes folder)
const adminRoutes = require('./routes/admin');
const audioReactionRoutes = require('./routes/audioReaction');
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
const webinarMultiRoutes = require('./routes/webinarMulti');
const clipLibraryRoutes = require('./routes/clipLibrary');  // 📚 CLIP LIBRARY
const opusClipRoutes = require('./routes/opusClip');        // 🎬 OPUS CLIP

// Import services
const cleanupService = require('./services/cleanupService');

const app = express();
const PORT = process.env.PORT || 8080;

// Ensure directories exist
const ensureDirs = async () => {
  const dirs = [
    process.env.OUTPUT_DIR || '/app/outputs',
    process.env.TEMP_DIR || '/app/temp',
    path.join(process.env.TEMP_DIR || '/app/temp', 'uploads'),
    path.join(process.env.TEMP_DIR || '/app/temp', 'webinar-sessions'),
    path.join(process.env.TEMP_DIR || '/app/temp', 'webinar-render'),
    path.join(process.env.TEMP_DIR || '/app/temp', 'library-uploads'),
    path.join(process.env.TEMP_DIR || '/app/temp', 'library-thumbs'),
    path.join(process.env.TEMP_DIR || '/app/temp', 'opus-uploads')
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
      audioReaction: 'active',
      clipLibrary: 'active',    // 📚 NEW!
      combine: 'active',
      download: 'active',
      jobs: 'active',
      opusClip: 'active',       // 🎬 OPUS CLIP
      render: 'active',
      singleReaction: 'active',
      split: 'active',
      splitReact: 'active',
      transcribe: 'active',
      upload: 'active',
      voice: 'active',
      webinarMulti: 'active'
    }
  });
});

// Routes
app.use('/api/admin', adminRoutes);
app.use('/api/audio-reaction', audioReactionRoutes);
app.use('/api/clip-library', clipLibraryRoutes);  // 📚 CLIP LIBRARY
app.use('/api/opus-clip', opusClipRoutes);        // 🎬 OPUS CLIP
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
app.use('/api/webinar-multi', webinarMultiRoutes);

// Error handling for multer
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: 'File too large. Maximum size is 5GB per file.'
    });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({
      success: false,
      error: 'Too many files.'
    });
  }
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Server error'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`⚡ RANT SQUAD API listening on port ${PORT}`);
  console.log('Available services:');
  console.log('  📚 /api/clip-library     - Clip Library (NEW!)');
  console.log('  🎬 /api/opus-clip        - AI Viral Clip Maker');
  console.log('  🎬 /api/webinar-multi    - Multi-file Webinar');
  console.log('  🎙️  /api/audio-reaction   - Audio-Only RANT');
  console.log('  🎥 /api/single-reaction  - Single Reaction');
  console.log('  ✂️  /api/split-react      - Split React');
  console.log('  📥 /api/download         - Video Download');
  console.log('  📝 /api/transcribe       - Transcription');
});
