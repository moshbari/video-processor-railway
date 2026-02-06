/**
 * 📚 CLIP LIBRARY API ROUTES
 * 
 * All endpoints require X-User-Id header (Supabase user ID)
 * 
 * CLIPS:
 *   GET    /api/clip-library/clips              - List all clips (optional ?tag=content or ?tag=cta)
 *   POST   /api/clip-library/clips              - Upload a new clip
 *   PUT    /api/clip-library/clips/:clipId       - Update clip name/tags
 *   DELETE /api/clip-library/clips/:clipId       - Delete a clip
 *   POST   /api/clip-library/clips/delete-bulk   - Delete multiple clips
 * 
 * OVERLAYS:
 *   GET    /api/clip-library/overlays            - List all overlays
 *   POST   /api/clip-library/overlays            - Upload a new overlay
 *   DELETE /api/clip-library/overlays/:overlayId  - Delete an overlay
 *   POST   /api/clip-library/overlays/delete-bulk - Delete multiple overlays
 * 
 * STATS:
 *   GET    /api/clip-library/stats               - Get library stats
 * 
 * WEBINAR INTEGRATION:
 *   POST   /api/clip-library/prepare-for-render  - Download library clips to temp for rendering
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const clipLibraryService = require('../services/clipLibraryService');

// ============================================
// MIDDLEWARE - Require User ID
// ============================================

/**
 * All library routes require X-User-Id header
 */
const requireUserId = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  
  if (!userId) {
    return res.status(401).json({
      success: false,
      error: 'User ID required. Please log in.'
    });
  }

  req.userId = userId;
  next();
};

router.use(requireUserId);

// ============================================
// MULTER CONFIGURATION
// ============================================

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(process.env.TEMP_DIR || '/app/temp', 'library-uploads');
    await fs.ensureDir(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}_${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { 
    fileSize: 2 * 1024 * 1024 * 1024 // 2GB max per file
  },
  fileFilter: (req, file, cb) => {
    // Determine if this is a video or image upload based on the route
    const isOverlay = req.baseUrl.includes('overlays') || req.path.includes('overlays');
    
    if (isOverlay) {
      const imageTypes = /png|jpg|jpeg|gif|webp/i;
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
      if (imageTypes.test(ext)) {
        cb(null, true);
      } else {
        cb(new Error('Only image files (PNG, JPG, GIF, WEBP) are allowed'));
      }
    } else {
      const videoTypes = /mp4|mov|avi|webm|mkv/i;
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
      if (videoTypes.test(ext)) {
        cb(null, true);
      } else {
        cb(new Error('Only video files (MP4, MOV, AVI, WEBM, MKV) are allowed'));
      }
    }
  }
});

// ============================================
// CLIP ENDPOINTS
// ============================================

/**
 * GET /api/clip-library/clips
 * List all clips for the current user
 * Optional query: ?tag=content or ?tag=cta
 */
router.get('/clips', async (req, res) => {
  try {
    const tag = req.query.tag || null;
    const clips = await clipLibraryService.getClips(req.userId, tag);

    console.log(`[Library API] Listed ${clips.length} clips for user ${req.userId}${tag ? ` (tag: ${tag})` : ''}`);

    res.json({
      success: true,
      clips,
      count: clips.length
    });
  } catch (error) {
    console.error(`[Library API] Error listing clips:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/clip-library/clips
 * Upload a new clip to the library
 * Form data: file, name, tags (comma-separated: "content,cta")
 */
router.post('/clips', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const name = req.body.name || req.file.originalname;
    const tagsRaw = req.body.tags || 'content';
    const tags = tagsRaw.split(',').map(t => t.trim().toLowerCase()).filter(t => ['content', 'cta'].includes(t));

    if (tags.length === 0) {
      tags.push('content'); // Default to content if no valid tags
    }

    console.log(`[Library API] Uploading clip: "${name}", tags: ${tags.join(',')}`);

    const clip = await clipLibraryService.addClip(
      req.userId,
      req.file.path,
      req.file.originalname,
      name,
      tags,
      req.file.size
    );

    // Cleanup temp upload file
    await fs.remove(req.file.path).catch(() => {});

    res.json({
      success: true,
      clip
    });
  } catch (error) {
    // Cleanup on error
    if (req.file) {
      await fs.remove(req.file.path).catch(() => {});
    }
    console.error(`[Library API] Error uploading clip:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/clip-library/clips/:clipId
 * Update clip name and/or tags
 * Body: { name: "New Name", tags: ["content", "cta"] }
 */
router.put('/clips/:clipId', express.json(), async (req, res) => {
  try {
    const { clipId } = req.params;
    const { name, tags } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (tags !== undefined) updates.tags = tags;

    const updatedClip = await clipLibraryService.updateClip(req.userId, clipId, updates);

    res.json({
      success: true,
      clip: updatedClip
    });
  } catch (error) {
    console.error(`[Library API] Error updating clip:`, error.message);
    res.status(error.message === 'Clip not found' ? 404 : 500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/clip-library/clips/:clipId
 * Delete a single clip
 */
router.delete('/clips/:clipId', async (req, res) => {
  try {
    const { clipId } = req.params;
    const deleted = await clipLibraryService.deleteClip(req.userId, clipId);

    res.json({
      success: true,
      message: `Clip "${deleted.name}" deleted`,
      clip: deleted
    });
  } catch (error) {
    console.error(`[Library API] Error deleting clip:`, error.message);
    res.status(error.message === 'Clip not found' ? 404 : 500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/clip-library/clips/delete-bulk
 * Delete multiple clips at once
 * Body: { clipIds: ["id1", "id2", "id3"] }
 */
router.post('/clips/delete-bulk', express.json(), async (req, res) => {
  try {
    const { clipIds } = req.body;

    if (!clipIds || !Array.isArray(clipIds) || clipIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'clipIds array required'
      });
    }

    console.log(`[Library API] Bulk deleting ${clipIds.length} clips`);
    const results = await clipLibraryService.deleteMultipleClips(req.userId, clipIds);

    res.json({
      success: true,
      results,
      deleted: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    });
  } catch (error) {
    console.error(`[Library API] Error bulk deleting clips:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// OVERLAY ENDPOINTS
// ============================================

/**
 * GET /api/clip-library/overlays
 * List all overlay images for the current user
 */
router.get('/overlays', async (req, res) => {
  try {
    const overlays = await clipLibraryService.getOverlays(req.userId);

    console.log(`[Library API] Listed ${overlays.length} overlays for user ${req.userId}`);

    res.json({
      success: true,
      overlays,
      count: overlays.length
    });
  } catch (error) {
    console.error(`[Library API] Error listing overlays:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/clip-library/overlays
 * Upload a new overlay image to the library
 * Form data: file, name
 */
router.post('/overlays', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const name = req.body.name || req.file.originalname;

    console.log(`[Library API] Uploading overlay: "${name}"`);

    const overlay = await clipLibraryService.addOverlay(
      req.userId,
      req.file.path,
      req.file.originalname,
      name,
      req.file.size
    );

    // Cleanup temp upload file
    await fs.remove(req.file.path).catch(() => {});

    res.json({
      success: true,
      overlay
    });
  } catch (error) {
    if (req.file) {
      await fs.remove(req.file.path).catch(() => {});
    }
    console.error(`[Library API] Error uploading overlay:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/clip-library/overlays/:overlayId
 * Delete a single overlay
 */
router.delete('/overlays/:overlayId', async (req, res) => {
  try {
    const { overlayId } = req.params;
    const deleted = await clipLibraryService.deleteOverlay(req.userId, overlayId);

    res.json({
      success: true,
      message: `Overlay "${deleted.name}" deleted`,
      overlay: deleted
    });
  } catch (error) {
    console.error(`[Library API] Error deleting overlay:`, error.message);
    res.status(error.message === 'Overlay not found' ? 404 : 500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/clip-library/overlays/delete-bulk
 * Delete multiple overlays at once
 * Body: { overlayIds: ["id1", "id2"] }
 */
router.post('/overlays/delete-bulk', express.json(), async (req, res) => {
  try {
    const { overlayIds } = req.body;

    if (!overlayIds || !Array.isArray(overlayIds) || overlayIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'overlayIds array required'
      });
    }

    console.log(`[Library API] Bulk deleting ${overlayIds.length} overlays`);
    const results = await clipLibraryService.deleteMultipleOverlays(req.userId, overlayIds);

    res.json({
      success: true,
      results,
      deleted: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    });
  } catch (error) {
    console.error(`[Library API] Error bulk deleting overlays:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// STATS ENDPOINT
// ============================================

/**
 * GET /api/clip-library/stats
 * Get library statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await clipLibraryService.getStats(req.userId);

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error(`[Library API] Error getting stats:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// WEBINAR INTEGRATION ENDPOINT
// ============================================

/**
 * POST /api/clip-library/prepare-for-render
 * Download library clips and overlays to temp folder for use in webinar rendering
 * 
 * Body: {
 *   sessionId: "abc123",
 *   clipIds: ["clip1", "clip2"],     // Library clip IDs to prepare
 *   overlayId: "overlay1"             // Optional library overlay ID
 * }
 */
router.post('/prepare-for-render', express.json(), async (req, res) => {
  try {
    const { sessionId, clipIds, overlayId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'sessionId required'
      });
    }

    const destDir = path.join(process.env.TEMP_DIR || '/app/temp', 'webinar-sessions', sessionId, 'library');
    const results = { clips: [], overlay: null };

    // Download clips
    if (clipIds && clipIds.length > 0) {
      console.log(`[Library API] Preparing ${clipIds.length} library clips for session ${sessionId}`);
      
      for (const clipId of clipIds) {
        try {
          const { localPath, clip } = await clipLibraryService.downloadClipToTemp(req.userId, clipId, destDir);
          results.clips.push({
            clipId: clip.id,
            name: clip.name,
            localPath,
            success: true
          });
        } catch (error) {
          results.clips.push({
            clipId,
            success: false,
            error: error.message
          });
        }
      }
    }

    // Download overlay
    if (overlayId) {
      try {
        const { localPath, overlay } = await clipLibraryService.downloadOverlayToTemp(req.userId, overlayId, destDir);
        results.overlay = {
          overlayId: overlay.id,
          name: overlay.name,
          localPath,
          success: true
        };
      } catch (error) {
        results.overlay = {
          overlayId,
          success: false,
          error: error.message
        };
      }
    }

    console.log(`[Library API] ✅ Prepared ${results.clips.filter(c => c.success).length} clips for rendering`);

    res.json({
      success: true,
      results
    });
  } catch (error) {
    console.error(`[Library API] Error preparing for render:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'clip-library',
    status: 'operational'
  });
});

module.exports = router;
