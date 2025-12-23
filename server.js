const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs-extra');
const path = require('path');

// Load environment variables
dotenv.config();

// Import routes
const downloadRouter = require('./routes/download');
const transcribeRouter = require('./routes/transcribe');
const renderRouter = require('./routes/render');
const jobRouter = require('./routes/jobs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Create necessary directories
const createDirectories = async () => {
  const dirs = [
    process.env.TEMP_DIR || '/app/temp',
    process.env.UPLOAD_DIR || '/app/uploads',
    process.env.OUTPUT_DIR || '/app/outputs',
    process.env.VOLUME_PATH || '/app/data'
  ];

  for (const dir of dirs) {
    await fs.ensureDir(dir);
    console.log(`✓ Directory ensured: ${dir}`);
  }
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// API routes
app.use('/api/download', downloadRouter);
app.use('/api/transcribe', transcribeRouter);
app.use('/api/render', renderRouter);
app.use('/api/jobs', jobRouter);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Video Processor API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      download: 'POST /api/download',
      transcribe: 'POST /api/transcribe',
      render: 'POST /api/render',
      jobStatus: 'GET /api/jobs/:jobId',
      downloadResult: 'GET /api/jobs/:jobId/download',
      cleanup: 'DELETE /api/jobs/:jobId'
    },
    features: [
      'Video download from 1000+ platforms (yt-dlp)',
      'Audio transcription with timestamps (OpenAI Whisper)',
      'Video rendering with reactions (FFmpeg)',
      'Job queue management (Bull + Redis)',
      'Automatic cleanup'
    ]
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal server error',
      status: err.status || 500
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: 'Endpoint not found',
      status: 404,
      path: req.path
    }
  });
});

// Start server
const startServer = async () => {
  try {
    // Create directories
    await createDirectories();

    // Start listening
    app.listen(PORT, '0.0.0.0', () => {
      console.log('\n🚀 Video Processor API Started');
      console.log(`📍 Port: ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`⏰ Started at: ${new Date().toISOString()}`);
      console.log('\n📋 Available endpoints:');
      console.log(`   GET  /health - Health check`);
      console.log(`   POST /api/download - Download video from URL`);
      console.log(`   POST /api/transcribe - Transcribe video audio`);
      console.log(`   POST /api/render - Render final video`);
      console.log(`   GET  /api/jobs/:jobId - Get job status`);
      console.log(`   GET  /api/jobs/:jobId/download - Download result`);
      console.log(`   DELETE /api/jobs/:jobId - Cleanup job files\n`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

// Start the server
startServer();

module.exports = app;
