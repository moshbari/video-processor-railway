/**
 * 📚 CLIP LIBRARY SERVICE
 * 
 * Manages a permanent library of reusable clips and overlay images in R2.
 * Each user has their own private library (identified by userId).
 * 
 * R2 Structure:
 *   library/{userId}/clips/{clipId}.mp4
 *   library/{userId}/thumbnails/{clipId}.jpg
 *   library/{userId}/overlays/{overlayId}.png
 *   library/{userId}/metadata.json
 * 
 * Metadata format:
 * {
 *   clips: [
 *     { id, name, tags: ['content','cta'], filename, size, duration, thumbnailKey, createdAt }
 *   ],
 *   overlays: [
 *     { id, name, filename, size, createdAt }
 *   ]
 * }
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const r2Service = require('./r2Service');

class ClipLibraryService {
  constructor() {
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
  }

  // ============================================
  // METADATA MANAGEMENT
  // ============================================

  /**
   * Get the R2 key for a user's metadata file
   */
  getMetadataKey(userId) {
    return `library/${userId}/metadata.json`;
  }

  /**
   * Load metadata for a user from R2
   */
  async loadMetadata(userId) {
    try {
      const key = this.getMetadataKey(userId);
      const buffer = await r2Service.getFile(key);
      
      if (!buffer) {
        // No metadata yet - return empty structure
        return { clips: [], overlays: [] };
      }

      const data = JSON.parse(buffer.toString('utf-8'));
      return data;
    } catch (error) {
      console.log(`[Library] No existing metadata for user ${userId}, starting fresh`);
      return { clips: [], overlays: [] };
    }
  }

  /**
   * Save metadata for a user to R2
   */
  async saveMetadata(userId, metadata) {
    const key = this.getMetadataKey(userId);
    const buffer = Buffer.from(JSON.stringify(metadata, null, 2), 'utf-8');
    await r2Service.uploadBuffer(buffer, key, 'application/json');
    console.log(`[Library] Saved metadata for user ${userId} (${metadata.clips.length} clips, ${metadata.overlays.length} overlays)`);
  }

  // ============================================
  // VIDEO CLIP OPERATIONS
  // ============================================

  /**
   * Get video duration using FFprobe
   */
  getVideoDuration(filePath) {
    return new Promise((resolve, reject) => {
      const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          console.error(`[Library] FFprobe error:`, error.message);
          resolve(0); // Return 0 if we can't get duration
        } else {
          const duration = parseFloat(stdout.trim());
          resolve(isNaN(duration) ? 0 : duration);
        }
      });
    });
  }

  /**
   * Generate thumbnail from video (first frame)
   */
  generateThumbnail(videoPath, thumbnailPath) {
    return new Promise((resolve, reject) => {
      const cmd = `ffmpeg -y -i "${videoPath}" -vframes 1 -q:v 5 -vf "scale=320:-1" "${thumbnailPath}"`;
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          console.error(`[Library] Thumbnail generation error:`, error.message);
          reject(error);
        } else {
          resolve(thumbnailPath);
        }
      });
    });
  }

  /**
   * Format duration in seconds to human-readable string
   */
  formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '0s';
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
  }

  /**
   * Upload a video clip to the library
   * 
   * @param {string} userId - Supabase user ID
   * @param {string} filePath - Local path to the uploaded video file
   * @param {string} originalName - Original filename
   * @param {string} name - Friendly name for the clip
   * @param {string[]} tags - Array of tags ('content', 'cta', or both)
   * @param {number} fileSize - File size in bytes
   * @returns {object} The new clip data
   */
  async addClip(userId, filePath, originalName, name, tags, fileSize) {
    const clipId = uuidv4();
    const ext = path.extname(originalName).toLowerCase() || '.mp4';
    
    console.log(`[Library] Adding clip "${name}" for user ${userId}`);

    // 1. Get video duration
    const duration = await this.getVideoDuration(filePath);
    console.log(`[Library] Duration: ${this.formatDuration(duration)}`);

    // 2. Generate thumbnail
    const thumbDir = path.join(this.tempDir, 'library-thumbs');
    await fs.ensureDir(thumbDir);
    const thumbnailPath = path.join(thumbDir, `${clipId}.jpg`);
    
    let thumbnailKey = null;
    try {
      await this.generateThumbnail(filePath, thumbnailPath);
      thumbnailKey = `library/${userId}/thumbnails/${clipId}.jpg`;
      await r2Service.uploadFile(thumbnailPath, thumbnailKey, 'image/jpeg');
      console.log(`[Library] Thumbnail uploaded: ${thumbnailKey}`);
    } catch (err) {
      console.error(`[Library] Thumbnail failed (non-critical):`, err.message);
    }

    // 3. Upload video to R2 (permanent library folder)
    const clipKey = `library/${userId}/clips/${clipId}${ext}`;
    await r2Service.uploadFile(filePath, clipKey, 'video/mp4');
    console.log(`[Library] Clip uploaded: ${clipKey}`);

    // 4. Update metadata
    const metadata = await this.loadMetadata(userId);
    
    const clipData = {
      id: clipId,
      name: name || originalName,
      tags: tags || ['content'],
      filename: `${clipId}${ext}`,
      r2Key: clipKey,
      thumbnailKey: thumbnailKey,
      size: fileSize,
      duration: duration,
      durationFormatted: this.formatDuration(duration),
      originalName: originalName,
      createdAt: new Date().toISOString()
    };

    metadata.clips.push(clipData);
    await this.saveMetadata(userId, metadata);

    // 5. Cleanup temp thumbnail
    await fs.remove(thumbnailPath).catch(() => {});

    console.log(`[Library] ✅ Clip "${name}" added successfully (${clipId})`);
    return clipData;
  }

  /**
   * Get all clips for a user, optionally filtered by tag
   */
  async getClips(userId, tag = null) {
    const metadata = await this.loadMetadata(userId);
    
    let clips = metadata.clips || [];
    
    if (tag) {
      clips = clips.filter(c => c.tags && c.tags.includes(tag));
    }

    // Add public URLs for thumbnails
    clips = clips.map(clip => ({
      ...clip,
      thumbnailUrl: clip.thumbnailKey ? r2Service.getPublicUrl(clip.thumbnailKey) : null,
      downloadUrl: r2Service.getPublicUrl(clip.r2Key)
    }));

    return clips;
  }

  /**
   * Get a single clip by ID
   */
  async getClip(userId, clipId) {
    const metadata = await this.loadMetadata(userId);
    const clip = (metadata.clips || []).find(c => c.id === clipId);
    
    if (clip) {
      clip.thumbnailUrl = clip.thumbnailKey ? r2Service.getPublicUrl(clip.thumbnailKey) : null;
      clip.downloadUrl = r2Service.getPublicUrl(clip.r2Key);
    }

    return clip;
  }

  /**
   * Update clip details (name, tags)
   */
  async updateClip(userId, clipId, updates) {
    const metadata = await this.loadMetadata(userId);
    const clipIndex = metadata.clips.findIndex(c => c.id === clipId);
    
    if (clipIndex === -1) {
      throw new Error('Clip not found');
    }

    // Only allow updating name and tags
    if (updates.name !== undefined) {
      metadata.clips[clipIndex].name = updates.name;
    }
    if (updates.tags !== undefined) {
      metadata.clips[clipIndex].tags = updates.tags;
    }

    metadata.clips[clipIndex].updatedAt = new Date().toISOString();
    await this.saveMetadata(userId, metadata);

    console.log(`[Library] Updated clip ${clipId}: name="${updates.name}", tags=${JSON.stringify(updates.tags)}`);
    return metadata.clips[clipIndex];
  }

  /**
   * Delete a single clip
   */
  async deleteClip(userId, clipId) {
    const metadata = await this.loadMetadata(userId);
    const clip = metadata.clips.find(c => c.id === clipId);
    
    if (!clip) {
      throw new Error('Clip not found');
    }

    // Delete from R2
    try {
      await r2Service.deleteFile(clip.r2Key);
      console.log(`[Library] Deleted clip file: ${clip.r2Key}`);
    } catch (err) {
      console.error(`[Library] Failed to delete clip file:`, err.message);
    }

    // Delete thumbnail from R2
    if (clip.thumbnailKey) {
      try {
        await r2Service.deleteFile(clip.thumbnailKey);
        console.log(`[Library] Deleted thumbnail: ${clip.thumbnailKey}`);
      } catch (err) {
        console.error(`[Library] Failed to delete thumbnail:`, err.message);
      }
    }

    // Remove from metadata
    metadata.clips = metadata.clips.filter(c => c.id !== clipId);
    await this.saveMetadata(userId, metadata);

    console.log(`[Library] ✅ Clip "${clip.name}" deleted`);
    return clip;
  }

  /**
   * Delete multiple clips at once
   */
  async deleteMultipleClips(userId, clipIds) {
    const results = [];
    
    for (const clipId of clipIds) {
      try {
        const deleted = await this.deleteClip(userId, clipId);
        results.push({ id: clipId, success: true, name: deleted.name });
      } catch (error) {
        results.push({ id: clipId, success: false, error: error.message });
      }
    }

    console.log(`[Library] Bulk delete: ${results.filter(r => r.success).length}/${clipIds.length} deleted`);
    return results;
  }

  // ============================================
  // OVERLAY IMAGE OPERATIONS
  // ============================================

  /**
   * Upload an overlay image to the library
   */
  async addOverlay(userId, filePath, originalName, name, fileSize) {
    const overlayId = uuidv4();
    const ext = path.extname(originalName).toLowerCase() || '.png';
    
    console.log(`[Library] Adding overlay "${name}" for user ${userId}`);

    // Upload to R2
    const overlayKey = `library/${userId}/overlays/${overlayId}${ext}`;
    const mimeType = ext === '.png' ? 'image/png' :
                      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                     ext === '.gif' ? 'image/gif' :
                     ext === '.webp' ? 'image/webp' : 'image/png';
    
    await r2Service.uploadFile(filePath, overlayKey, mimeType);
    console.log(`[Library] Overlay uploaded: ${overlayKey}`);

    // Update metadata
    const metadata = await this.loadMetadata(userId);
    
    const overlayData = {
      id: overlayId,
      name: name || originalName,
      filename: `${overlayId}${ext}`,
      r2Key: overlayKey,
      size: fileSize,
      originalName: originalName,
      createdAt: new Date().toISOString()
    };

    metadata.overlays.push(overlayData);
    await this.saveMetadata(userId, metadata);

    console.log(`[Library] ✅ Overlay "${name}" added successfully (${overlayId})`);
    return overlayData;
  }

  /**
   * Get all overlay images for a user
   */
  async getOverlays(userId) {
    const metadata = await this.loadMetadata(userId);
    
    let overlays = metadata.overlays || [];

    // Add public URLs
    overlays = overlays.map(overlay => ({
      ...overlay,
      downloadUrl: r2Service.getPublicUrl(overlay.r2Key)
    }));

    return overlays;
  }

  /**
   * Delete an overlay image
   */
  async deleteOverlay(userId, overlayId) {
    const metadata = await this.loadMetadata(userId);
    const overlay = (metadata.overlays || []).find(o => o.id === overlayId);
    
    if (!overlay) {
      throw new Error('Overlay not found');
    }

    // Delete from R2
    try {
      await r2Service.deleteFile(overlay.r2Key);
      console.log(`[Library] Deleted overlay file: ${overlay.r2Key}`);
    } catch (err) {
      console.error(`[Library] Failed to delete overlay file:`, err.message);
    }

    // Remove from metadata
    metadata.overlays = metadata.overlays.filter(o => o.id !== overlayId);
    await this.saveMetadata(userId, metadata);

    console.log(`[Library] ✅ Overlay "${overlay.name}" deleted`);
    return overlay;
  }

  /**
   * Delete multiple overlays at once
   */
  async deleteMultipleOverlays(userId, overlayIds) {
    const results = [];
    
    for (const overlayId of overlayIds) {
      try {
        const deleted = await this.deleteOverlay(userId, overlayId);
        results.push({ id: overlayId, success: true, name: deleted.name });
      } catch (error) {
        results.push({ id: overlayId, success: false, error: error.message });
      }
    }

    return results;
  }

  // ============================================
  // WEBINAR INTEGRATION
  // ============================================

  /**
   * Download a library clip to a local temp path (for use during rendering)
   * This copies the file from R2 to the local temp directory so FFmpeg can process it
   */
  async downloadClipToTemp(userId, clipId, destDir) {
    const clip = await this.getClip(userId, clipId);
    
    if (!clip) {
      throw new Error(`Library clip not found: ${clipId}`);
    }

    await fs.ensureDir(destDir);
    const localPath = path.join(destDir, clip.filename);

    // Download from R2 to local
    const publicUrl = r2Service.getPublicUrl(clip.r2Key);
    await r2Service.downloadFile(publicUrl, localPath);

    console.log(`[Library] Downloaded clip "${clip.name}" to ${localPath}`);
    return {
      localPath,
      clip
    };
  }

  /**
   * Download a library overlay to a local temp path
   */
  async downloadOverlayToTemp(userId, overlayId, destDir) {
    const metadata = await this.loadMetadata(userId);
    const overlay = (metadata.overlays || []).find(o => o.id === overlayId);
    
    if (!overlay) {
      throw new Error(`Library overlay not found: ${overlayId}`);
    }

    await fs.ensureDir(destDir);
    const localPath = path.join(destDir, overlay.filename);

    const publicUrl = r2Service.getPublicUrl(overlay.r2Key);
    await r2Service.downloadFile(publicUrl, localPath);

    console.log(`[Library] Downloaded overlay "${overlay.name}" to ${localPath}`);
    return {
      localPath,
      overlay
    };
  }

  // ============================================
  // STATS
  // ============================================

  /**
   * Get library statistics for a user
   */
  async getStats(userId) {
    const metadata = await this.loadMetadata(userId);
    
    const totalClipSize = (metadata.clips || []).reduce((sum, c) => sum + (c.size || 0), 0);
    const totalOverlaySize = (metadata.overlays || []).reduce((sum, o) => sum + (o.size || 0), 0);
    
    return {
      clipCount: (metadata.clips || []).length,
      overlayCount: (metadata.overlays || []).length,
      totalSize: totalClipSize + totalOverlaySize,
      totalSizeMB: ((totalClipSize + totalOverlaySize) / (1024 * 1024)).toFixed(2),
      contentClips: (metadata.clips || []).filter(c => c.tags && c.tags.includes('content')).length,
      ctaClips: (metadata.clips || []).filter(c => c.tags && c.tags.includes('cta')).length
    };
  }
}

module.exports = new ClipLibraryService();
