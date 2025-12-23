const express = require('express');
const cors = require('cors');
const downloadRoutes = require('./routes/download');
const transcribeRoutes = require('./routes/transcribe');
const renderRoutes = require('./routes/render');
const jobsRoutes = require('./routes/jobs');
const splitRoutes = require('./routes/split');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      download: 'active',
      transcribe: 'active',
      render: 'active',
      split: 'active'
    }
  });
});

// Routes
app.use('/api/download', downloadRoutes);
app.use('/api/transcribe', transcribeRoutes);
app.use('/api/render', renderRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/split', splitRoutes);

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    success: false, 
    error: err.message 
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Video Processor API listening on port ${PORT}`);
  console.log('Available endpoints:');
  console.log('  POST /api/download');
  console.log('  POST /api/transcribe');
  console.log('  POST /api/render');
  console.log('  POST /api/split');
  console.log('  GET  /api/split/:jobId/download');
  console.log('  GET  /api/jobs/:jobId/download');
});
