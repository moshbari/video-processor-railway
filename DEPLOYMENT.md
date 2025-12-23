# Railway Deployment Guide - Step by Step

## Prerequisites

- Railway account (railway.app)
- OpenAI API key
- GitHub account (optional but recommended)

---

## Method 1: Deploy via GitHub (Recommended)

### Step 1: Push Code to GitHub

```bash
# Initialize git repository
cd video-processor-railway
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit - Video Processor API"

# Create GitHub repo and push
git remote add origin https://github.com/yourusername/video-processor-railway.git
git branch -M main
git push -u origin main
```

### Step 2: Connect to Railway

1. Go to [railway.app](https://railway.app)
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Authorize Railway to access your GitHub
5. Select your `video-processor-railway` repository
6. Railway will auto-detect the Dockerfile and start building

### Step 3: Add Environment Variables

1. In Railway dashboard, click your service
2. Go to "Variables" tab
3. Click "New Variable"
4. Add these variables:

```
OPENAI_API_KEY = sk-your-key-here
PORT = 3000
NODE_ENV = production
MAX_VIDEO_SIZE_MB = 1024
MAX_DURATION_SECONDS = 1800
CLEANUP_AFTER_HOURS = 24
```

### Step 4: Add Persistent Storage (Optional but Recommended)

1. In Railway dashboard, click "+ New"
2. Select "Volume"
3. Name it "video-storage"
4. Mount path: `/app/data`
5. Size: 5GB (adjust as needed)

### Step 5: Deploy

1. Click "Deploy" or wait for auto-deploy
2. Monitor logs for any errors
3. Once deployed, click "Settings" → "Generate Domain"
4. Your API will be available at: `https://your-app.up.railway.app`

### Step 6: Test Deployment

```bash
# Test health endpoint
curl https://your-app.up.railway.app/health

# Should return:
# {"status":"healthy","timestamp":"...","uptime":...}
```

---

## Method 2: Deploy via Railway CLI

### Step 1: Install Railway CLI

```bash
npm install -g @railway/cli
```

### Step 2: Login

```bash
railway login
```

### Step 3: Initialize Project

```bash
cd video-processor-railway
railway init
```

### Step 4: Set Environment Variables

```bash
railway variables set OPENAI_API_KEY=sk-your-key-here
railway variables set NODE_ENV=production
railway variables set MAX_VIDEO_SIZE_MB=1024
```

### Step 5: Deploy

```bash
railway up
```

### Step 6: Get URL

```bash
railway domain
```

---

## Method 3: Direct Upload (No GitHub)

### Step 1: Create Project

1. Go to [railway.app](https://railway.app)
2. Click "New Project"
3. Select "Empty Project"

### Step 2: Add Service

1. Click "+ New"
2. Select "Empty Service"
3. Name it "video-processor"

### Step 3: Deploy Code

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to your project
railway link

# Deploy
railway up
```

---

## Post-Deployment Checklist

### 1. Test All Endpoints

```bash
# Set your Railway URL
export API_URL="https://your-app.up.railway.app"

# Test health
curl $API_URL/health

# Test download platforms
curl $API_URL/api/download/platforms

# Test yt-dlp status
curl $API_URL/api/download/status
```

### 2. Test Video Download

```bash
curl -X POST $API_URL/api/download \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  }'
```

Expected response:
```json
{
  "success": true,
  "data": {
    "jobId": "...",
    "videoPath": "/app/temp/.../video.mp4",
    "title": "Rick Astley - Never Gonna Give You Up",
    "duration": 212,
    "platform": "youtube"
  }
}
```

### 3. Monitor Logs

```bash
# Via CLI
railway logs

# Or in web dashboard
# Click service → Deployments → View Logs
```

### 4. Check Resource Usage

In Railway dashboard:
- Click "Metrics" tab
- Monitor CPU, Memory, Network usage
- Ensure you're staying within $20 budget

---

## Connecting to Your Existing Transcription Service

If you want to use your existing Railway transcription service instead of OpenAI:

### Option 1: Internal Railway Service Connection

1. Deploy both services in same Railway project
2. Use internal DNS: `http://transcription-service:PORT`
3. No need for public domain

### Option 2: Use Public Endpoint

```javascript
// In Lovable, call your transcription service directly
const transcribeResponse = await fetch('https://your-transcription.railway.app/transcribe', {
  method: 'POST',
  body: formData
});
```

---

## Troubleshooting

### Build Fails

**Error: "Python not found"**
```dockerfile
# Ensure Dockerfile has:
FROM node:20-slim
RUN apt-get update && apt-get install -y python3 python3-pip
```

**Error: "yt-dlp not found"**
```dockerfile
# Ensure Dockerfile has:
RUN pip3 install --break-system-packages yt-dlp
```

**Error: "FFmpeg not found"**
```dockerfile
# Ensure Dockerfile has:
RUN apt-get install -y ffmpeg
```

### Runtime Errors

**Error: "OPENAI_API_KEY not set"**
- Add environment variable in Railway dashboard

**Error: "File too large"**
- Increase MAX_VIDEO_SIZE_MB
- Or compress video before processing

**Error: "Out of memory"**
- Reduce CONCURRENT_JOBS to 1
- Upgrade Railway plan
- Process smaller videos

### Cost Issues

**Exceeding $20/month:**
- Reduce concurrent jobs
- Add aggressive cleanup (reduce CLEANUP_AFTER_HOURS)
- Implement request limits
- Cache popular videos

---

## Scaling Considerations

### Current Setup (Railway Pro $20/month)
- 2 concurrent video processing jobs
- ~40-60 videos per month
- Suitable for MVP and testing

### If You Need More:

**Option 1: Upgrade Railway Plan**
- Pro: $20/month → can handle ~100-150 videos
- Higher: $50-100/month → can handle 500+ videos

**Option 2: Optimize Processing**
- Lower video quality for faster processing
- Implement video caching
- Use smaller audio files for reactions

**Option 3: Multiple Services**
- Deploy multiple instances
- Load balance with Lovable
- Process 200+ videos per month

---

## Security Best Practices

1. **Never commit .env file**
   ```bash
   # Already in .gitignore
   .env
   ```

2. **Rotate API keys regularly**
   - OpenAI dashboard
   - Railway environment variables

3. **Implement rate limiting**
   ```javascript
   // Add to server.js
   const rateLimit = require('express-rate-limit');
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 100
   });
   app.use(limiter);
   ```

4. **Add authentication** (for production)
   ```javascript
   // Add API key middleware
   app.use((req, res, next) => {
     const apiKey = req.headers['x-api-key'];
     if (apiKey !== process.env.API_KEY) {
       return res.status(401).json({ error: 'Unauthorized' });
     }
     next();
   });
   ```

---

## Monitoring & Alerts

### Set Up Monitoring

1. **Railway Dashboard**
   - Check metrics daily
   - Set up budget alerts

2. **Add Logging Service** (Optional)
   - LogTail
   - Papertrail
   - Sentry for error tracking

3. **Health Check Monitoring**
   - UptimeRobot (free)
   - Ping your `/health` endpoint every 5 minutes

---

## Backup & Recovery

### Backup Strategy

1. **Code Backup**
   - GitHub repository (done ✓)

2. **Database Backup** (if you add one later)
   - Railway automatic backups
   - Or export manually

3. **Configuration Backup**
   - Document all environment variables
   - Keep in password manager

### Recovery Plan

If service goes down:

1. Check Railway status page
2. View deployment logs
3. Rollback to previous deployment if needed
4. Contact Railway support (if infrastructure issue)

---

## Next Steps

1. ✅ Deploy to Railway
2. ✅ Test all endpoints
3. ✅ Get Railway URL
4. 🔄 Build Lovable frontend
5. 🔄 Connect Lovable to Railway API
6. 🔄 Test end-to-end flow
7. 🔄 Deploy Lovable app
8. 🔄 Launch MVP!

---

## Support Resources

- **Railway Docs**: https://docs.railway.app
- **yt-dlp Docs**: https://github.com/yt-dlp/yt-dlp
- **FFmpeg Docs**: https://ffmpeg.org/documentation.html
- **OpenAI API Docs**: https://platform.openai.com/docs

---

**Questions?** Check Railway logs first, then review this guide.

**Ready to build the Lovable frontend?** Let me know!
