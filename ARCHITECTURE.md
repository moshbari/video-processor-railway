# System Architecture Diagram

## Complete Video Reaction App Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER DEVICE                              │
│                    (Phone / Desktop / Tablet)                   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ HTTPS
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      LOVABLE FRONTEND                            │
│                    (React + TypeScript)                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Components:                                              │  │
│  │  • Video Import UI                                        │  │
│  │  • Timeline Editor                                        │  │
│  │  • Transcript Display                                     │  │
│  │  • Reaction Creator                                       │  │
│  │  • Render Progress                                        │  │
│  │  • Download Manager                                       │  │
│  └──────────────────────────────────────────────────────────┘  │
└───────┬─────────────────┬─────────────────┬─────────────────────┘
        │                 │                 │
        │ API Calls       │ API Calls       │ API Calls
        ▼                 ▼                 ▼
┌───────────────┐  ┌──────────────┐  ┌─────────────────────────┐
│  11Labs API   │  │ Railway API  │  │  Lovable Cloud         │
│  (Text-to-    │  │ (Your Video  │  │  (Supabase Storage)    │
│   Speech)     │  │  Processor)  │  │                         │
└───────────────┘  └──────┬───────┘  └─────────────────────────┘
                          │
                          │
        ┌─────────────────┴─────────────────┐
        │                                    │
        ▼                                    ▼
┌───────────────────────┐        ┌──────────────────────┐
│   RAILWAY SERVICE     │        │   OpenAI Whisper    │
│  Video Processor API  │───────▶│   (Transcription)    │
│                       │        └──────────────────────┘
│  ┌─────────────────┐ │
│  │  Express Server │ │
│  │    (Node.js)    │ │
│  └────────┬────────┘ │
│           │          │
│  ┌────────┴────────┐ │
│  │   yt-dlp        │ │◀────── Downloads from 1000+ platforms
│  │  (Download)     │ │        (YouTube, Instagram, TikTok, etc.)
│  └─────────────────┘ │
│                      │
│  ┌─────────────────┐ │
│  │   FFmpeg        │ │◀────── Video processing & rendering
│  │  (Rendering)    │ │
│  └─────────────────┘ │
│                      │
│  ┌─────────────────┐ │
│  │  File System    │ │◀────── Temporary storage
│  │   /app/temp     │ │        (Auto-cleanup after 24h)
│  │   /app/outputs  │ │
│  └─────────────────┘ │
└──────────────────────┘
    Railway Pro $20/mo


═══════════════════════════════════════════════════════════════════

## Data Flow

### Step 1: Video Import
┌──────┐    paste URL    ┌─────────┐    POST     ┌─────────┐
│ User │───────────────▶│ Lovable │───────────▶│ Railway │
└──────┘                 └─────────┘  /download  └────┬────┘
                                                       │
                                                  yt-dlp runs
                                                       │
                         ┌─────────┐   jobId +        │
                         │ Lovable │◀─── videoPath ───┘
                         └─────────┘

### Step 2: Transcription
┌─────────┐    POST         ┌─────────┐   send video  ┌─────────┐
│ Lovable │────────────────▶│ Railway │──────────────▶│ OpenAI  │
└─────────┘  /transcribe    └─────────┘               └────┬────┘
                                 ▲                          │
                                 │      transcript +        │
                                 └───── timestamps ─────────┘

### Step 3: Reaction Generation
┌──────┐   types text   ┌─────────┐   POST text   ┌─────────┐
│ User │───────────────▶│ Lovable │──────────────▶│ 11Labs  │
└──────┘                └─────────┘               └────┬────┘
                             ▲                          │
                             │       audio URL          │
                             └──────────────────────────┘

### Step 4: Video Rendering
┌─────────┐    POST        ┌─────────┐
│ Lovable │───────────────▶│ Railway │
└─────────┘   /render      └────┬────┘
    config:                     │
    • videoPath                 │ FFmpeg processes:
    • reactions                 │ • Cuts video
    • cuts                      │ • Adds text overlays
    • timestamps                │ • Mixes audio
                                │ • Renders final MP4
                                │
                         ┌──────▼────┐
                         │  /outputs │
                         │  video.mp4│
                         └──────┬────┘
                                │
┌─────────┐   GET         ┌────▼────┐
│ Lovable │◀──────────────│ Railway │
└─────────┘  /download    └─────────┘
     │
     ▼
┌──────┐
│ User │ Downloads final video
└──────┘

═══════════════════════════════════════════════════════════════════

## Component Responsibilities

┌────────────────────────────────────────────────────────┐
│ LOVABLE (Frontend)                                      │
├────────────────────────────────────────────────────────┤
│ • UI/UX                                                 │
│ • User input handling                                   │
│ • Timeline editor                                       │
│ • Project management                                    │
│ • API orchestration                                     │
│ • File upload/download                                  │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ RAILWAY (Backend Processing)                            │
├────────────────────────────────────────────────────────┤
│ • Video downloading (yt-dlp)                           │
│ • Audio transcription (OpenAI)                          │
│ • Video processing (FFmpeg)                             │
│ • Job queue management                                  │
│ • File storage & cleanup                                │
│ • API endpoints                                         │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ 11LABS (External API)                                   │
├────────────────────────────────────────────────────────┤
│ • Text-to-speech conversion                             │
│ • Multiple voice options                                │
│ • Audio file generation                                 │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ OPENAI WHISPER (External API)                          │
├────────────────────────────────────────────────────────┤
│ • Audio transcription                                   │
│ • Timestamp generation                                  │
│ • Multi-language support                                │
└────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════════

## Technology Stack Summary

Frontend (Lovable):
├── React 18
├── TypeScript
├── Tailwind CSS
├── Lovable Cloud (Supabase)
└── Custom Components
    ├── Video Player
    ├── Timeline Editor
    ├── Transcript Display
    └── Reaction Creator

Backend (Railway):
├── Node.js 20
├── Express
├── yt-dlp (Python)
├── FFmpeg
└── Docker Container

External Services:
├── OpenAI Whisper API
├── 11Labs API
└── Railway Hosting

═══════════════════════════════════════════════════════════════════

## File Storage Flow

┌──────────────┐
│ User uploads │
│   video URL  │
└──────┬───────┘
       │
       ▼
┌─────────────────┐
│   yt-dlp        │
│  downloads to   │
│  /app/temp/     │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ FFmpeg renders  │
│   video to      │
│ /app/outputs/   │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ User downloads  │
│  final video    │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│  Auto cleanup   │
│  after 24 hours │
└─────────────────┘

═══════════════════════════════════════════════════════════════════

## Scalability Considerations

Current Setup (Railway Pro $20/mo):
• 2 concurrent video processing jobs
• ~40-60 videos per month
• Suitable for MVP

To Scale:
• Upgrade Railway plan ($50-100/mo) → 200+ videos/month
• Add Redis for job queue
• Implement video caching
• Use CDN for downloads
• Add load balancing
• Multiple Railway instances
```
