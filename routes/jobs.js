const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');

/**
 * GET /api/jobs/:jobId
 * Get job status
 */
router.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;

    // Check if job exists in temp or output directory
    const tempDir = path.join(process.env.TEMP_DIR || '/app/temp', jobId);
    const outputDir = process.env.OUTPUT_DIR || '/app/outputs';

    const tempExists = await fs.pathExists(tempDir);
    const outputFiles = await fs.readdir(outputDir).catch(() => []);
    const outputFile = outputFiles.find(f => f.includes(jobId));

    if (!tempExists && !outputFile) {
      return res.status(404).json({
        error: 'Job not found'
      });
    }

    const status = {
      jobId,
      status: outputFile ? 'completed' : 'processing',
      tempDir: tempExists ? tempDir : null,
      outputFile: outputFile ? path.join(outputDir, outputFile) : null
    };

    res.json({
      success: true,
      data: status
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * GET /api/jobs/:jobId/download
 * Download rendered video
 */
router.get('/:jobId/download', async (req, res) => {
  try {
    const { jobId } = req.params;
    const outputDir = process.env.OUTPUT_DIR || '/app/outputs';

    // Find the output file
    const files = await fs.readdir(outputDir);
    const outputFile = files.find(f => f.includes(jobId));

    if (!outputFile) {
      return res.status(404).json({
        error: 'Rendered video not found'
      });
    }

    const filePath = path.join(outputDir, outputFile);
    const stats = await fs.stat(filePath);

    // Set headers for download
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `attachment; filename="${outputFile}"`);

    // Stream the file
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * DELETE /api/jobs/:jobId
 * Cleanup job files
 */
router.delete('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;

    // Remove temp directory
    const tempDir = path.join(process.env.TEMP_DIR || '/app/temp', jobId);
    await fs.remove(tempDir).catch(() => {});

    // Remove output files
    const outputDir = process.env.OUTPUT_DIR || '/app/outputs';
    const files = await fs.readdir(outputDir).catch(() => []);
    const jobFiles = files.filter(f => f.includes(jobId));

    for (const file of jobFiles) {
      await fs.remove(path.join(outputDir, file)).catch(() => {});
    }

    res.json({
      success: true,
      data: {
        jobId,
        message: 'Job files cleaned up'
      }
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * GET /api/jobs
 * List all jobs
 */
router.get('/', async (req, res) => {
  try {
    const tempDir = process.env.TEMP_DIR || '/app/temp';
    const outputDir = process.env.OUTPUT_DIR || '/app/outputs';

    const tempDirs = await fs.readdir(tempDir).catch(() => []);
    const outputFiles = await fs.readdir(outputDir).catch(() => []);

    const jobs = [];

    // Check temp directories (processing)
    for (const dir of tempDirs) {
      const dirPath = path.join(tempDir, dir);
      const stats = await fs.stat(dirPath).catch(() => null);
      if (stats && stats.isDirectory()) {
        jobs.push({
          jobId: dir,
          status: 'processing',
          createdAt: stats.birthtime
        });
      }
    }

    // Check output files (completed)
    for (const file of outputFiles) {
      const filePath = path.join(outputDir, file);
      const stats = await fs.stat(filePath).catch(() => null);
      if (stats && stats.isFile()) {
        const jobIdMatch = file.match(/rendered_(.+?)\.mp4/);
        const jobId = jobIdMatch ? jobIdMatch[1] : file;
        
        jobs.push({
          jobId,
          status: 'completed',
          filename: file,
          size: stats.size,
          createdAt: stats.birthtime
        });
      }
    }

    res.json({
      success: true,
      data: {
        total: jobs.length,
        jobs: jobs.sort((a, b) => b.createdAt - a.createdAt)
      }
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * POST /api/jobs/cleanup
 * Cleanup old jobs
 */
router.post('/cleanup', async (req, res) => {
  try {
    const { olderThanHours = 24 } = req.body;
    const cutoffTime = Date.now() - (olderThanHours * 60 * 60 * 1000);

    const tempDir = process.env.TEMP_DIR || '/app/temp';
    const outputDir = process.env.OUTPUT_DIR || '/app/outputs';

    let cleaned = 0;

    // Cleanup temp directories
    const tempDirs = await fs.readdir(tempDir).catch(() => []);
    for (const dir of tempDirs) {
      const dirPath = path.join(tempDir, dir);
      const stats = await fs.stat(dirPath).catch(() => null);
      if (stats && stats.birthtime.getTime() < cutoffTime) {
        await fs.remove(dirPath).catch(() => {});
        cleaned++;
      }
    }

    // Cleanup output files
    const outputFiles = await fs.readdir(outputDir).catch(() => []);
    for (const file of outputFiles) {
      const filePath = path.join(outputDir, file);
      const stats = await fs.stat(filePath).catch(() => null);
      if (stats && stats.birthtime.getTime() < cutoffTime) {
        await fs.remove(filePath).catch(() => {});
        cleaned++;
      }
    }

    res.json({
      success: true,
      data: {
        cleaned,
        message: `Cleaned up ${cleaned} old job(s)`
      }
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

module.exports = router;
