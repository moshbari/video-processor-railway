#!/bin/zsh
# Puts the Apple push key into the Railway server settings (staging), for
# "Your RANT is ready" notifications. Run once. Never prints the key.
set -e
export PATH=$HOME/.npm-global/bin:$PATH
cd "/Volumes/Predator SSD GM& 1TB/Claude Cowork Projects/video-processor-railway"
K=$(base64 < "/Volumes/Predator SSD GM& 1TB/Claude Cowork Projects/share.bizapp.club/share.bizapp.club/AuthKey_52KR593XJJ.p8" | tr -d '\n')
railway variables --set "APNS_KEY=$K" --set "APNS_KEY_ID=52KR593XJJ" --set "APNS_TEAM_ID=G6J9BUHSNH" --set "APNS_TOPIC=com.zpresso.gettranscript" >/dev/null
echo "✅ Push key added. The server restarts by itself in about a minute."
