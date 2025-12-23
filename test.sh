#!/bin/bash

# Video Processor API Test Script
# Usage: ./test.sh https://your-app.up.railway.app

API_URL="${1:-http://localhost:3000}"

echo "=================================="
echo "Video Processor API Test Script"
echo "=================================="
echo "Testing API at: $API_URL"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Health Check
echo -e "${YELLOW}Test 1: Health Check${NC}"
HEALTH=$(curl -s "$API_URL/health")
if echo "$HEALTH" | grep -q "healthy"; then
    echo -e "${GREEN}✓ Health check passed${NC}"
    echo "$HEALTH" | jq .
else
    echo -e "${RED}✗ Health check failed${NC}"
    echo "$HEALTH"
fi
echo ""

# Test 2: Get Supported Platforms
echo -e "${YELLOW}Test 2: Get Supported Platforms${NC}"
PLATFORMS=$(curl -s "$API_URL/api/download/platforms")
if echo "$PLATFORMS" | grep -q "youtube"; then
    echo -e "${GREEN}✓ Platforms endpoint working${NC}"
    echo "$PLATFORMS" | jq '.data.popular'
else
    echo -e "${RED}✗ Platforms endpoint failed${NC}"
    echo "$PLATFORMS"
fi
echo ""

# Test 3: Check yt-dlp Status
echo -e "${YELLOW}Test 3: Check yt-dlp Status${NC}"
STATUS=$(curl -s "$API_URL/api/download/status")
if echo "$STATUS" | grep -q "installed"; then
    echo -e "${GREEN}✓ yt-dlp is installed${NC}"
    echo "$STATUS" | jq .
else
    echo -e "${RED}✗ yt-dlp not found${NC}"
    echo "$STATUS"
fi
echo ""

# Test 4: Validate URL
echo -e "${YELLOW}Test 4: Validate URL${NC}"
VALIDATE=$(curl -s -X POST "$API_URL/api/download/validate" \
    -H "Content-Type: application/json" \
    -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}')
if echo "$VALIDATE" | grep -q "valid"; then
    echo -e "${GREEN}✓ URL validation working${NC}"
    echo "$VALIDATE" | jq .
else
    echo -e "${RED}✗ URL validation failed${NC}"
    echo "$VALIDATE"
fi
echo ""

# Test 5: Download Video (Short test video)
echo -e "${YELLOW}Test 5: Download Video (This may take 30-60 seconds)${NC}"
DOWNLOAD=$(curl -s -X POST "$API_URL/api/download" \
    -H "Content-Type: application/json" \
    -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}')

if echo "$DOWNLOAD" | grep -q "jobId"; then
    echo -e "${GREEN}✓ Video download successful${NC}"
    JOB_ID=$(echo "$DOWNLOAD" | jq -r '.data.jobId')
    VIDEO_PATH=$(echo "$DOWNLOAD" | jq -r '.data.videoPath')
    echo "Job ID: $JOB_ID"
    echo "Video Path: $VIDEO_PATH"
    echo "$DOWNLOAD" | jq '.data'
    
    # Test 6: Check Job Status
    echo ""
    echo -e "${YELLOW}Test 6: Check Job Status${NC}"
    JOB_STATUS=$(curl -s "$API_URL/api/jobs/$JOB_ID")
    if echo "$JOB_STATUS" | grep -q "$JOB_ID"; then
        echo -e "${GREEN}✓ Job status check working${NC}"
        echo "$JOB_STATUS" | jq .
    else
        echo -e "${RED}✗ Job status check failed${NC}"
        echo "$JOB_STATUS"
    fi
    
    # Test 7: Get Video Info
    echo ""
    echo -e "${YELLOW}Test 7: Get Video Info${NC}"
    VIDEO_INFO=$(curl -s -X POST "$API_URL/api/render/info" \
        -H "Content-Type: application/json" \
        -d "{\"videoPath\": \"$VIDEO_PATH\"}")
    if echo "$VIDEO_INFO" | grep -q "duration"; then
        echo -e "${GREEN}✓ Video info retrieval working${NC}"
        echo "$VIDEO_INFO" | jq '.data'
    else
        echo -e "${RED}✗ Video info failed${NC}"
        echo "$VIDEO_INFO"
    fi
    
    # Test 8: Transcribe (if OpenAI key is set)
    if [ -n "$OPENAI_API_KEY" ]; then
        echo ""
        echo -e "${YELLOW}Test 8: Transcribe Video (This may take 1-2 minutes)${NC}"
        TRANSCRIBE=$(curl -s -X POST "$API_URL/api/transcribe" \
            -H "Content-Type: application/json" \
            -d "{\"videoPath\": \"$VIDEO_PATH\", \"jobId\": \"$JOB_ID\"}")
        if echo "$TRANSCRIBE" | grep -q "transcription"; then
            echo -e "${GREEN}✓ Transcription successful${NC}"
            echo "$TRANSCRIBE" | jq '.data.transcription.text' | head -c 200
            echo "..."
        else
            echo -e "${RED}✗ Transcription failed${NC}"
            echo "$TRANSCRIBE"
        fi
    else
        echo ""
        echo -e "${YELLOW}Test 8: Skipping transcription (OPENAI_API_KEY not set)${NC}"
    fi
    
    # Test 9: Cleanup
    echo ""
    echo -e "${YELLOW}Test 9: Cleanup Job${NC}"
    CLEANUP=$(curl -s -X DELETE "$API_URL/api/jobs/$JOB_ID")
    if echo "$CLEANUP" | grep -q "cleaned"; then
        echo -e "${GREEN}✓ Cleanup successful${NC}"
        echo "$CLEANUP" | jq .
    else
        echo -e "${RED}✗ Cleanup failed${NC}"
        echo "$CLEANUP"
    fi
    
else
    echo -e "${RED}✗ Video download failed${NC}"
    echo "$DOWNLOAD"
fi

echo ""
echo "=================================="
echo "Test Summary"
echo "=================================="
echo "API URL: $API_URL"
echo ""
echo "If all tests passed, your API is ready to use!"
echo "Copy your Railway URL and use it in your Lovable frontend."
echo ""
