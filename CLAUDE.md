# RANT SQUAD - Complete Project Context

> **IMPORTANT**: Read this file entirely before making any changes.
> The project owner (Mosh) is NOT a programmer. He manages all development independently.
> Never ask him technical questions — use this document for context.
> Never suggest coordinating with other developers — Mosh does everything himself.
> All explanations must be at a 5th-grade level. No jargon.

---

## PROJECT OVERVIEW

**RANT Squad** is a video reaction platform that helps content creators produce reaction videos. Users combine original content with their own recorded reactions in various formats.

**Owner**: Mosh (moshbari on GitHub)

---

## ARCHITECTURE

### Stack
- **Backend**: Node.js / Express on Railway (auto-deploys from GitHub)
- **Frontend**: React managed through Lovable (no-code platform — Claude cannot edit frontend directly)
- **Storage**: Cloudflare R2 (S3-compatible, with public URL for downloads)
- **Database/Auth**: Supabase (managed entirely through Lovable)
- **Video Processing**: FFmpeg, yt-dlp
- **AI**: GPT-4o, OpenAI Whisper (transcription)

### Two Environments
| Environment | Branch | Railway Server | Frontend URL |
|-------------|--------|----------------|--------------|
| Staging | develop | video-processor-staging | devrant.99dfy.com |
| Production | main | video-processor-production | rantsquad.99dfy.com |

**Rule**: Always develop and test on develop branch/staging first. Only merge to main after confirmed working.

### GitHub Workflow
Mosh provides a GitHub Personal Access Token. Claude handles all clone/edit/commit/push operations directly. Mosh never touches code. Railway auto-deploys from GitHub pushes.

For frontend changes (Lovable/Supabase), Claude writes detailed checklists (40-100+ items) for Mosh to send to Lovable.

---

## FEATURES

### 1. Multi-Clip Video Editor (/api/combine, /api/split)
- Split original video into clips at reaction timestamps
- Upload reaction clips (one per original clip)
- Combine in Sequential (clip-reaction-clip-reaction) or PiP mode
- **Clip Maker Import**: Reaction clips can be imported directly from Manual Clip Maker via R2 URLs (no download/re-upload needed). The combine route accepts reactionR2Urls in FormData.

### 2. Single Reaction (/api/single-reaction)
- Record one video watching + reacting
- Combines into picture-in-picture format

### 3. Split React (/api/split-react)
- Split original video at reaction timestamps
- Combine with recorded reactions (Sequential or PiP modes)
- Has centralized FFmpeg error handling via errorHandler.js

### 4. Audio-Only RANT (/api/audio-reaction)
- Faceless reactions — audio plays over frozen video frames
- Copies clip-loading logic from combineService (uses r2Service.downloadSplitJob())

### 5. Webinar Creator (/api/webinar-multi, /api/webinar)
- Multi-file webinar tool with Content/CTA/Overlay groups
- Reusable Clip Library (/api/clip-library) with permanent R2 storage under library/ prefix
- Auto-sequencing, drag-and-drop, countdown timer, render history
- Video standardization: 1920x1080, 30fps, yuv420p, stereo 44100Hz for gap-free transitions
- Two versions: webinarMultiService.js (multi-file) and webinarService.js (developer/single)

### 6. Video Overlay (/api/image-overlay)
- Upload video + overlay image; FFmpeg applies overlay

### 7. Clip Maker — AI Mode (/api/opus-clip)
- AI-powered viral moment detection using GPT-4o
- Multi-agent visual metaphor: Scanner, Viral Hunter, Scorer, Editor
- Vertical reframing, auto-captions via Whisper

### 8. Clip Maker — Manual Mode (/api/manual-clip)
- User marks timestamps while watching video with waveform visualization
- Maximum quality output (CRF 18 + 192k audio)
- Clips uploaded to R2 at manual-clips/{jobId}/clip_N_title.mp4
- GET /api/manual-clip/jobs — lists completed jobs for import into Multi-Clip Editor

### Separate App: RANT PRO
- AI script generator with four agents (Advocate, Critic, Judge, Viral Thread Publisher)
- Generates timestamp-based reaction scripts from video transcripts
- Uses Supabase Edge Functions
- **Agent prompts live in app_settings Supabase table** — remixing the app copies code but NOT this data

---

## FILE STRUCTURE

```
video-processor-railway/
├── server.js                          # Express app, route registration, CORS
├── package.json
├── Dockerfile
├── CLAUDE.md                          # This file
├── routes/
│   ├── admin.js
│   ├── audioReaction.js               # Audio-Only RANT
│   ├── clipLibrary.js                 # Reusable clip library for webinars
│   ├── combine.js                     # Multi-clip combine/render (supports R2 reaction import)
│   ├── download.js                    # Video download via yt-dlp
│   ├── imageOverlay.js                # Video + image overlay
│   ├── jobs.js                        # Job status tracking
│   ├── manualClip.js                  # Manual clip maker (+ /jobs endpoint for import)
│   ├── opusClip.js                    # AI clip maker
│   ├── render.js
│   ├── singleReaction.js              # Single reaction PiP
│   ├── split.js                       # Video splitting
│   ├── splitReact.js                  # Split + react combined
│   ├── transcribe.js                  # Whisper transcription
│   ├── upload.js
│   ├── voice.js
│   ├── webinar.js                     # Single/developer webinar
│   └── webinarMulti.js                # Multi-file webinar
├── services/
│   ├── audioReactionService.js
│   ├── cleanupService.js              # Auto-cleanup temp files (hourly, 24h old)
│   ├── clipLibraryService.js          # R2 library management
│   ├── combineService.js              # FFmpeg clip combining (Sequential + PiP)
│   ├── downloadService.js             # yt-dlp wrapper
│   ├── driveService.js
│   ├── imageOverlayService.js
│   ├── manualClipService.js           # Manual clipping + job tracking
│   ├── opusClipService.js             # AI viral clip detection
│   ├── projectMetadataService.js
│   ├── r2Service.js                   # Cloudflare R2 upload/download/delete
│   ├── renderService.js
│   ├── singleReactionService.js
│   ├── splitReactService.js
│   ├── splitService.js                # Video splitting at timestamps
│   ├── transcriptionService.js        # OpenAI Whisper
│   ├── voiceService.js
│   ├── webinarMultiService.js         # Multi-file webinar processing
│   └── webinarService.js              # Single webinar processing
```

---

## KEY TECHNICAL PATTERNS

### Video Standardization (Critical for Concatenation)
All clips must be forced to consistent settings before joining:
- Resolution: 1920x1080
- Frame rate: 30fps
- Pixel format: yuv420p
- Audio: stereo, 44100Hz, AAC

**Use the concat filter (not concat demuxer)** when combining clips from different sources. The demuxer requires identical timebases/codecs. The filter decodes first and handles format differences.

### Three-Pass Rendering for PiP
1. Extract last frame from original clip
2. Create frozen background video with exact duration matching reaction audio
3. Overlay reaction video on frozen frame
More reliable than filter-based approaches for audio/video sync.

### R2 Storage Patterns
- Clips stored at: splits/{jobId}/manifest.json and {jobId}/clip_N.mp4
- Manual clips at: manual-clips/{jobId}/clip_N_title.mp4
- Combined videos at: combined/MODE-XXX-MonYY-HHMMSSAM.mp4
- Library files at: library/ (permanent — never auto-deleted)
- **Lifecycle rules must use prefixes**: splits/, renders/, webinar-sessions/, temp/ — never blanket rules

### Two Code Paths for Video Processing
- **URL download path**: Video downloaded via yt-dlp, then processed
- **File upload path**: Video uploaded via multer, then processed
Both paths need fixes when addressing bugs. Always check both.

### Clip Maker to Multi-Clip Editor Import
- Manual Clip Maker stores completed jobs in memory with R2 download URLs
- GET /api/manual-clip/jobs returns list of completed jobs with clip details
- POST /api/combine/from-split/{splitJobId} accepts reactionR2Urls (JSON array of R2 URLs) to import reactions directly from Clip Maker
- Backend downloads reactions from R2 instead of requiring file uploads
- Normal file upload path is preserved as fallback

### Error Handling
- Centralized error handler in errorHandler.js maps FFmpeg errors to friendly messages
- Currently implemented for Split React; needs extending to other features
- All user-facing errors must use warm, non-technical language with "Try Again" prompts
- Never expose FFmpeg errors, HTTP codes, or function names to users

---

## COMMON GOTCHAS & PAST BUGS

1. **Timestamp interpretation matters**: AI-generated reaction data contains scene start times, but split services need end times. Always verify timestamp semantics.

2. **Field name mismatches cause silent failures**: Frontend sends clipIndices but backend expects reactionIndices — causes fallback to sequential mapping. Always verify parameter names match.

3. **R2 lifecycle blanket rules delete everything**: Including permanent library files. Always scope to specific prefixes.

4. **Session isolation for webinars**: Frontend must generate fresh session IDs for each new webinar. Reusing old session IDs causes file contamination.

5. **File sequencing**: Extract the first number in filenames for ordering (not the last). "5-3P.mp4" = position 5.

6. **Concat demuxer vs filter**: Concat demuxer requires identical codecs/timebases. Use concat filter when mixing sources.

7. **Video playback gaps**: Caused by inconsistent encoding between Content and CTA groups. Fix: standardize all clips to same resolution/fps/pix_fmt/audio before joining.

8. **Manual Clip Maker jobs are in-memory**: They don't persist across server restarts. Clips stay on R2 for 7 days regardless.

9. **RANT PRO prompts in database**: The app_settings Supabase table holds AI agent prompts. Remixing the Lovable app copies code but not database data.

---

## ENVIRONMENT VARIABLES

```
PORT=8080
TEMP_DIR=/app/temp
OUTPUT_DIR=/app/outputs

# Cloudflare R2
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
R2_PUBLIC_URL=https://pub-xxx.r2.dev

# OpenAI (for Whisper transcription + GPT-4o)
OPENAI_API_KEY=...
```

---

## DESIGN PREFERENCES

- **Neon glow effects**: box-shadow CSS only (not 3D transforms)
- **Color scheme**: Blue/dark blue/black (not purple)
- **Dark backgrounds**
- **Multi-agent features**: Should look animated and "agentic" for webinar presentations
- **Output filenames**: Include content identifiers + timestamp in GMT+4 (Gulf Standard Time)
- **File replacements only**: Mosh cannot manually edit code — always provide complete file replacements, never partial diffs

---

## DEPLOYMENT

- Push to develop → Railway auto-deploys to staging
- Push to main → Railway auto-deploys to production
- Frontend changes go through Lovable (Claude provides checklists)
- Supabase changes go through Lovable
