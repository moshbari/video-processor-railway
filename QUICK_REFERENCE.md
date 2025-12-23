# Quick Reference Card

## Essential Commands

### Deploy to Railway
```bash
railway login
railway init
railway up
```

### View Logs
```bash
railway logs
# Or live logs:
railway logs --follow
```

### Set Environment Variable
```bash
railway variables set KEY=value
```

### Get Railway URL
```bash
railway domain
```

---

## API Endpoints Quick Reference

### Base URL
```
https://your-app.up.railway.app
```

### Download Video
```bash
POST /api/download
Body: { "url": "https://youtube.com/..." }
```

### Transcribe
```bash
POST /api/transcribe
Body: { "videoPath": "...", "jobId": "..." }
```

### Render
```bash
POST /api/render
Body: { 
  "videoPath": "...",
  "reactions": [...],
  "cuts": [...]
}
```

### Get Job
```bash
GET /api/jobs/:jobId
```

### Download Result
```bash
GET /api/jobs/:jobId/download
```

### Cleanup
```bash
DELETE /api/jobs/:jobId
```

---

## Environment Variables

### Required
```
OPENAI_API_KEY=sk-...
```

### Optional
```
PORT=3000
MAX_VIDEO_SIZE_MB=1024
MAX_DURATION_SECONDS=1800
CLEANUP_AFTER_HOURS=24
CONCURRENT_JOBS=2
```

---

## Testing

### Quick Test
```bash
curl https://your-app.up.railway.app/health
```

### Full Test Suite
```bash
./test.sh https://your-app.up.railway.app
```

---

## Troubleshooting Quick Fixes

### Build Failed
1. Check Dockerfile has Python, FFmpeg, yt-dlp
2. Check logs: `railway logs`
3. Rebuild: `railway up --detach`

### API Not Responding
1. Check Railway dashboard metrics
2. Restart service in Railway dashboard
3. Check environment variables set correctly

### Video Download Failed
1. Test yt-dlp: `curl YOUR_URL/api/download/status`
2. Try different video URL
3. Check platform is supported

### Transcription Failed
1. Verify OPENAI_API_KEY is set
2. Check OpenAI account has credits
3. Ensure video file < 25MB

### Out of Memory
1. Reduce CONCURRENT_JOBS to 1
2. Process smaller videos
3. Add Railway volume for temp storage

---

## Cost Monitoring

### Check Usage
- Railway Dashboard → Metrics
- Set budget alert at $15 (leaves $5 buffer)

### Reduce Costs
- Lower MAX_VIDEO_SIZE_MB
- Reduce CLEANUP_AFTER_HOURS
- Limit concurrent jobs
- Implement request rate limits

---

## Support

- Railway Docs: https://docs.railway.app
- GitHub Issues: Create issue in your repo
- Railway Community: community.railway.app

---

## Next Steps After Deployment

1. ✅ Test all endpoints
2. ✅ Save Railway URL
3. 🔄 Build Lovable frontend
4. 🔄 Connect to API
5. 🔄 Test end-to-end
6. 🔄 Launch!

---

**Keep this card handy for quick reference!**
