# Video Processor API for Railway

Complete video processing service with download (yt-dlp), transcription (OpenAI Whisper), and rendering (FFmpeg).

## Features

✅ Download videos from 1000+ platforms (YouTube, Instagram, TikTok, Facebook, etc.)
✅ Audio transcription with timestamps using OpenAI Whisper
✅ Video rendering with reactions and cuts
✅ Job queue management
✅ Automatic cleanup
✅ REST API endpoints

## Tech Stack

- **Node.js 20** - Runtime
- **Express** - Web framework
- **yt-dlp** - Video downloader
- **FFmpeg** - Video processing
- **OpenAI Whisper** - Transcription
- **Bull + Redis** - Job queue (optional)

## Quick Start

### 1. Local Development

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your API keys
nano .env

# Run locally
npm start

# Or with auto-reload
npm run dev
```

### 2. Deploy to Railway

#### Option A: Using Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login to Railway
railway login

# Create new project
railway init

# Add environment variables
railway variables set OPENAI_API_KEY=your_key_here

# Deploy
railway up
```

#### Option B: Using Railway Web UI

1. Go to [railway.app](https://railway.app)
2. Click "New Project"
3. Select "Deploy from GitHub repo" or "Empty Project"
4. If empty project, connect this repository
5. Railway will auto-detect Dockerfile
6. Add environment variables in Settings
7. Deploy!

### 3. Environment Variables

Required:
```env
OPENAI_API_KEY=sk-...
```

Optional:
```env
PORT=3000
MAX_VIDEO_SIZE_MB=1024
MAX_DURATION_SECONDS=1800
CLEANUP_AFTER_HOURS=24
CONCURRENT_JOBS=2
```

## API Endpoints

### Download Video

```bash
POST /api/download
Content-Type: application/json

{
  "url": "https://youtube.com/watch?v=..."
}

Response:
{
  "success": true,
  "data": {
    "jobId": "uuid",
    "videoPath": "/app/temp/uuid/video.mp4",
    "title": "Video Title",
    "duration": 180,
    "fileSize": 12345678,
    "platform": "youtube"
  }
}
```

### Transcribe Video

```bash
POST /api/transcribe
Content-Type: application/json

{
  "videoPath": "/app/temp/uuid/video.mp4",
  "jobId": "uuid",
  "options": {
    "language": "en"
  }
}

Response:
{
  "success": true,
  "data": {
    "jobId": "uuid",
    "transcription": {
      "text": "Full transcript...",
      "language": "en",
      "duration": 180,
      "segments": [
        {
          "start": 0,
          "end": 5.2,
          "text": "First sentence"
        }
      ]
    }
  }
}
```

### Render Video

```bash
POST /api/render
Content-Type: application/json

{
  "videoPath": "/app/temp/uuid/video.mp4",
  "reactions": [
    {
      "timestamp": 15.5,
      "text": "This is amazing!",
      "audioUrl": "https://...",
      "duration": 3
    }
  ],
  "cuts": [
    {"start": 0, "end": 15.5},
    {"start": 18.5, "end": 45.2}
  ]
}

Response:
{
  "success": true,
  "data": {
    "jobId": "uuid",
    "outputPath": "/app/outputs/rendered_uuid.mp4",
    "filename": "rendered_uuid.mp4"
  }
}
```

### Check Job Status

```bash
GET /api/jobs/:jobId

Response:
{
  "success": true,
  "data": {
    "jobId": "uuid",
    "status": "completed",
    "outputFile": "/app/outputs/rendered_uuid.mp4"
  }
}
```

### Download Result

```bash
GET /api/jobs/:jobId/download

Response: Video file stream (MP4)
```

### Cleanup Job

```bash
DELETE /api/jobs/:jobId

Response:
{
  "success": true,
  "data": {
    "jobId": "uuid",
    "message": "Job files cleaned up"
  }
}
```

### List All Jobs

```bash
GET /api/jobs

Response:
{
  "success": true,
  "data": {
    "total": 5,
    "jobs": [...]
  }
}
```

### Get Supported Platforms

```bash
GET /api/download/platforms

Response:
{
  "success": true,
  "data": {
    "total": 1800,
    "popular": ["youtube", "instagram", "tiktok", ...],
    "all": [...]
  }
}
```

## Usage from Lovable Frontend

```javascript
// 1. Download video
const downloadResponse = await fetch('https://your-railway-app.up.railway.app/api/download', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://youtube.com/watch?v=...'
  })
});
const { data: { jobId, videoPath } } = await downloadResponse.json();

// 2. Transcribe
const transcribeResponse = await fetch('https://your-railway-app.up.railway.app/api/transcribe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ videoPath, jobId })
});
const { data: { transcription } } = await transcribeResponse.json();

// 3. Render with reactions
const renderResponse = await fetch('https://your-railway-app.up.railway.app/api/render', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    videoPath,
    reactions: [
      {
        timestamp: 10.5,
        text: "Wow!",
        audioUrl: "https://elevenlabs.io/...",
        duration: 2
      }
    ],
    cuts: [
      { start: 0, end: 30 }
    ]
  })
});
const { data: { jobId: renderJobId } } = await renderResponse.json();

// 4. Download result
window.open(`https://your-railway-app.up.railway.app/api/jobs/${renderJobId}/download`);
```

## Supported Platforms

**Major platforms:**
- YouTube (videos, shorts, livestreams)
- Instagram (posts, reels, stories, IGTV)
- TikTok
- Facebook (videos, watch)
- Twitter/X
- Vimeo
- Reddit
- LinkedIn
- Dailymotion
- Twitch

**Plus 1000+ more platforms!**

## Cost Estimates (Railway Pro $20/month)

Per video processing:
- Download: ~$0.05
- Transcription (OpenAI): ~$0.06 per minute
- Rendering: ~$0.10-0.30

Total: **~$0.30-0.50 per video**

With $20/month you can process **40-60 videos**.

## File Size Limits

- Max video size: 1GB (configurable)
- Max duration: 30 minutes (configurable)
- Max concurrent jobs: 2 (configurable)

## Troubleshooting

### yt-dlp not found
```bash
# In Dockerfile, ensure:
RUN pip3 install --break-system-packages yt-dlp
```

### FFmpeg errors
```bash
# Check FFmpeg installation:
ffmpeg -version

# In Dockerfile:
RUN apt-get install -y ffmpeg
```

### OpenAI API errors
- Check your API key is valid
- Ensure you have credits
- File size must be under 25MB for direct upload

### Railway deployment fails
- Check logs: `railway logs`
- Ensure all environment variables are set
- Check Railway volume is attached for persistent storage

## Project Structure

```
video-processor-railway/
├── server.js              # Main server
├── package.json           # Dependencies
├── Dockerfile            # Docker configuration
├── .env.example          # Environment template
├── routes/               # API routes
│   ├── download.js       # Video download endpoints
│   ├── transcribe.js     # Transcription endpoints
│   ├── render.js         # Rendering endpoints
│   └── jobs.js           # Job management endpoints
├── services/             # Business logic
│   ├── downloadService.js    # yt-dlp wrapper
│   ├── transcriptionService.js  # OpenAI Whisper
│   └── renderService.js      # FFmpeg processing
└── README.md             # This file
```

## Railway Deployment Checklist

- [ ] Create Railway account
- [ ] Create new project
- [ ] Connect GitHub repository
- [ ] Add environment variables:
  - [ ] OPENAI_API_KEY
  - [ ] (Optional) ELEVENLABS_API_KEY
- [ ] Add Railway volume for persistent storage (recommended)
- [ ] Deploy
- [ ] Test health endpoint: `https://your-app.up.railway.app/health`
- [ ] Test download endpoint
- [ ] Copy Railway URL to use in Lovable

## Support

For issues or questions:
1. Check Railway logs
2. Test endpoints with curl/Postman
3. Verify environment variables
4. Check OpenAI API credits

## License

MIT

---

Built for Mosh's Video Reaction App 🎬
