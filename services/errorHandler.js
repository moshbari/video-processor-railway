/**
 * 🛡️ FRIENDLY ERROR HANDLER
 * 
 * Converts ugly technical errors into user-friendly messages
 * Used across all video processing routes in RANT Squad
 * 
 * Part of RANT Squad Video Editor
 */

/**
 * Map of technical error patterns to friendly messages
 * Each entry: { pattern: RegExp or string, friendly: string, suggestion: string }
 */
const errorMappings = [
  // ============================================================
  // VIDEO FILE ERRORS
  // ============================================================
  {
    pattern: /moov atom not found/i,
    friendly: "Video file appears damaged or incomplete",
    suggestion: "Please try re-uploading the video. If the problem continues, try downloading a fresh copy from the original source."
  },
  {
    pattern: /Invalid data found when processing input/i,
    friendly: "We couldn't read this video file",
    suggestion: "The file may be corrupted or in an unsupported format. Please try uploading a different copy or convert it to MP4 format."
  },
  {
    pattern: /No such file or directory/i,
    friendly: "Video file not found",
    suggestion: "Please re-upload your video and try again."
  },
  {
    pattern: /Permission denied/i,
    friendly: "Unable to access the file",
    suggestion: "Please try uploading again."
  },
  {
    pattern: /Invalid argument/i,
    friendly: "There was a problem processing your video",
    suggestion: "Please try re-uploading the file. Make sure it's a valid video file (MP4, MOV, or WebM)."
  },
  
  // ============================================================
  // FORMAT & CODEC ERRORS
  // ============================================================
  {
    pattern: /Avi file format type is unknown/i,
    friendly: "This video format isn't fully supported",
    suggestion: "Please convert your video to MP4 format and try again."
  },
  {
    pattern: /Unknown decoder|codec not found|Decoder .* not found/i,
    friendly: "This video uses an unsupported format",
    suggestion: "Please convert your video to MP4 (H.264) format and try again."
  },
  {
    pattern: /Could not find codec parameters/i,
    friendly: "We couldn't read this video's settings",
    suggestion: "The video file may be damaged. Please try re-downloading or re-recording it."
  },
  {
    pattern: /Discarding misdetected|misdetection possible/i,
    friendly: "Video file appears damaged or incomplete",
    suggestion: "Please try re-uploading the video. If the problem continues, try downloading a fresh copy from the original source."
  },
  
  // ============================================================
  // AUDIO ERRORS
  // ============================================================
  {
    pattern: /Audio stream.*not found|no audio/i,
    friendly: "No audio track found in video",
    suggestion: "This video doesn't have audio. Please upload a video with sound."
  },
  {
    pattern: /Audio encoding failed/i,
    friendly: "There was a problem processing the audio",
    suggestion: "Please try a different video file or contact support."
  },
  
  // ============================================================
  // DOWNLOAD ERRORS (for URL-based features)
  // ============================================================
  {
    pattern: /Video unavailable|Private video|age-restricted/i,
    friendly: "This video is not available for download",
    suggestion: "The video may be private, age-restricted, or removed. Please try a different video."
  },
  {
    pattern: /Unable to extract|no video formats/i,
    friendly: "Couldn't download this video",
    suggestion: "This video may be protected or the link may be invalid. Please try a different video or upload the file directly."
  },
  {
    pattern: /HTTP Error 403|Forbidden/i,
    friendly: "Access to this video was denied",
    suggestion: "The video may be region-locked or require login. Please try downloading it manually and uploading the file."
  },
  {
    pattern: /HTTP Error 404|not found/i,
    friendly: "Video not found",
    suggestion: "This video may have been removed or the link is incorrect. Please check the URL and try again."
  },
  {
    pattern: /Network error|connection|timeout|ETIMEDOUT|ECONNREFUSED/i,
    friendly: "Network connection problem",
    suggestion: "Please check your internet connection and try again."
  },
  
  // ============================================================
  // FILE SIZE & RESOURCE ERRORS
  // ============================================================
  {
    pattern: /File too large|size limit|LIMIT_FILE_SIZE/i,
    friendly: "File is too large",
    suggestion: "Please upload a smaller file (under 500MB) or trim your video before uploading."
  },
  {
    pattern: /Out of memory|ENOMEM|memory allocation/i,
    friendly: "Video is too large to process",
    suggestion: "Please try a shorter or lower-resolution video."
  },
  {
    pattern: /No space left|ENOSPC/i,
    friendly: "Server is temporarily busy",
    suggestion: "Please wait a moment and try again."
  },
  
  // ============================================================
  // PROCESSING ERRORS
  // ============================================================
  {
    pattern: /Discarding .* and .* do not match|discarding frame/i,
    friendly: "Video files have incompatible formats",
    suggestion: "Please make sure all your videos are similar quality and try again."
  },
  {
    pattern: /frame rate|fps.*mismatch/i,
    friendly: "Video frame rates don't match",
    suggestion: "Try re-recording your reaction video or use a video converter to match frame rates."
  },
  {
    pattern: /Duration mismatch|duration error/i,
    friendly: "Video lengths don't align properly",
    suggestion: "Please check that your watch clip matches the original video length."
  },
  
  // ============================================================
  // UPLOAD ERRORS
  // ============================================================
  {
    pattern: /Only video files are allowed/i,
    friendly: "Invalid file type",
    suggestion: "Please upload a video file (MP4, MOV, WebM, AVI, or MKV)."
  },
  {
    pattern: /Unexpected field|MulterError/i,
    friendly: "Upload error",
    suggestion: "Please refresh the page and try uploading again."
  }
];

/**
 * Convert technical error to user-friendly message
 * 
 * @param {Error|string} error - The original error
 * @returns {object} - { friendly: string, suggestion: string, technical: string }
 */
function getFriendlyError(error) {
  const errorMessage = error?.message || error?.toString() || 'Unknown error';
  
  // Check each pattern for a match
  for (const mapping of errorMappings) {
    if (mapping.pattern.test(errorMessage)) {
      return {
        friendly: mapping.friendly,
        suggestion: mapping.suggestion,
        technical: errorMessage // Keep for logging, but don't show to user
      };
    }
  }
  
  // Default fallback for unrecognized errors
  return {
    friendly: "Something went wrong while processing your video",
    suggestion: "Please try again. If the problem continues, try re-uploading your files or contact support.",
    technical: errorMessage
  };
}

/**
 * Format error response for API
 * 
 * @param {Error|string} error - The original error
 * @returns {object} - Formatted error object for JSON response
 */
function formatErrorResponse(error) {
  const friendlyError = getFriendlyError(error);
  
  // Log technical error for debugging (visible in Railway logs)
  console.error('[Technical Error]:', friendlyError.technical);
  
  return {
    success: false,
    error: `${friendlyError.friendly}. ${friendlyError.suggestion}`
  };
}

/**
 * Express error handler middleware
 * Use as: app.use(errorHandler.middleware)
 */
function middleware(err, req, res, next) {
  console.error('[Error Middleware]:', err);
  
  const response = formatErrorResponse(err);
  
  // Determine status code
  let statusCode = 500;
  if (err.message?.includes('not found') || err.message?.includes('404')) {
    statusCode = 404;
  } else if (err.message?.includes('too large') || err.message?.includes('LIMIT')) {
    statusCode = 413;
  } else if (err.message?.includes('Invalid') || err.message?.includes('required')) {
    statusCode = 400;
  }
  
  res.status(statusCode).json(response);
}

module.exports = {
  getFriendlyError,
  formatErrorResponse,
  middleware
};
