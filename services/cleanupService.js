const fs = require('fs-extra');
const path = require('path');

class CleanupService {
  constructor() {
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
    this.retentionHours = parseInt(process.env.RETENTION_HOURS) || 24;
    this.cleanupIntervalHours = parseInt(process.env.CLEANUP_INTERVAL_HOURS) || 1;
  }

  /**
   * Start automatic cleanup on interval
   */
  startAutoCleanup() {
    console.log(`🧹 Cleanup service started`);
    console.log(`   Retention: ${this.retentionHours} hours`);
    console.log(`   Cleanup interval: ${this.cleanupIntervalHours} hour(s)`);

    // Run cleanup immediately on startup
    this.cleanup();

    // Then run on interval
    setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalHours * 60 * 60 * 1000);
  }

  /**
   * Clean up files older than retention period
   */
  async cleanup() {
    try {
      console.log(`🧹 Running cleanup at ${new Date().toISOString()}`);
      
      const now = Date.now();
      const maxAge = this.retentionHours * 60 * 60 * 1000;
      
      if (!await fs.pathExists(this.tempDir)) {
        console.log('   Temp directory does not exist, nothing to clean');
        return { deleted: 0, kept: 0 };
      }

      const entries = await fs.readdir(this.tempDir);
      let deleted = 0;
      let kept = 0;
      let freedBytes = 0;

      for (const entry of entries) {
        if (entry === 'uploads') continue;

        const entryPath = path.join(this.tempDir, entry);
        
        try {
          const stats = await fs.stat(entryPath);
          const age = now - stats.mtimeMs;

          if (age > maxAge) {
            const size = await this.getDirectorySize(entryPath);
            freedBytes += size;
            
            await fs.remove(entryPath);
            console.log(`   ✓ Deleted: ${entry} (age: ${Math.round(age / 3600000)}h, size: ${this.formatBytes(size)})`);
            deleted++;
          } else {
            kept++;
          }
        } catch (err) {
          console.error(`   ✗ Error processing ${entry}:`, err.message);
        }
      }

      // Also clean uploads folder
      const uploadsDir = path.join(this.tempDir, 'uploads');
      if (await fs.pathExists(uploadsDir)) {
        const uploadEntries = await fs.readdir(uploadsDir);
        for (const entry of uploadEntries) {
          const entryPath = path.join(uploadsDir, entry);
          try {
            const stats = await fs.stat(entryPath);
            const age = now - stats.mtimeMs;
            if (age > maxAge) {
              const size = await this.getDirectorySize(entryPath);
              freedBytes += size;
              await fs.remove(entryPath);
              console.log(`   ✓ Deleted upload: ${entry}`);
              deleted++;
            }
          } catch (err) {
            console.error(`   ✗ Error processing upload ${entry}:`, err.message);
          }
        }
      }

      console.log(`🧹 Cleanup complete: ${deleted} deleted, ${kept} kept, ${this.formatBytes(freedBytes)} freed`);
      
      return { deleted, kept, freedBytes };
    } catch (error) {
      console.error('Cleanup error:', error);
      return { error: error.message };
    }
  }

  /**
   * Get current storage status
   */
  async getStatus() {
    try {
      const status = {
        tempDir: this.tempDir,
        retentionHours: this.retentionHours,
        cleanupIntervalHours: this.cleanupIntervalHours,
        currentTime: new Date().toISOString(),
        jobs: [],
        totalSize: 0,
        totalJobs: 0
      };

      if (!await fs.pathExists(this.tempDir)) {
        return status;
      }

      const entries = await fs.readdir(this.tempDir);
      
      for (const entry of entries) {
        if (entry === 'uploads') continue;
        
        const entryPath = path.join(this.tempDir, entry);
        
        try {
          const stats = await fs.stat(entryPath);
          const size = await this.getDirectorySize(entryPath);
          const ageMs = Date.now() - stats.mtimeMs;
          const ageHours = Math.round(ageMs / 3600000 * 10) / 10;
          const expiresIn = Math.round((this.retentionHours - ageHours) * 10) / 10;
          
          status.jobs.push({
            jobId: entry,
            size: this.formatBytes(size),
            sizeBytes: size,
            ageHours,
            expiresInHours: Math.max(0, expiresIn),
            createdAt: stats.mtime.toISOString()
          });
          
          status.totalSize += size;
          status.totalJobs++;
        } catch (err) {
          // Skip entries we can't read
        }
      }

      status.jobs.sort((a, b) => a.ageHours - b.ageHours);
      status.totalSizeFormatted = this.formatBytes(status.totalSize);

      return status;
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Force cleanup now (manual trigger)
   */
  async forceCleanup() {
    console.log('🧹 Manual cleanup triggered');
    return await this.cleanup();
  }

  /**
   * Get directory size recursively
   */
  async getDirectorySize(dirPath) {
    let size = 0;
    
    try {
      const stats = await fs.stat(dirPath);
      
      if (stats.isFile()) {
        return stats.size;
      }
      
      if (stats.isDirectory()) {
        const entries = await fs.readdir(dirPath);
        for (const entry of entries) {
          size += await this.getDirectorySize(path.join(dirPath, entry));
        }
      }
    } catch (err) {
      // Ignore errors
    }
    
    return size;
  }

  /**
   * Format bytes to human readable
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

module.exports = new CleanupService();
