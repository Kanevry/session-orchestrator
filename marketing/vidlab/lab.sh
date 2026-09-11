#!/bin/zsh
# lab.sh <name> <provider gateway|or> <model> <prompt-file> [image] [seconds] [aspect]
set -e
NAME=$1; PROV=$2; MODEL=$3; PFILE=$4; IMG=$5; SECS=${6:-8}; AR=${7:-16:9}
OUT=/tmp/vidlab; cd $OUT
PROMPT=$(cat "$PFILE")
if [ -n "$IMG" ]; then
  ffmpeg -v error -i "$IMG" -vf scale=1024:-1 -y "$NAME-src.png"
  printf 'data:image/png;base64,' > "$NAME-src.b64"
  base64 -i "$NAME-src.png" | tr -d '\n' >> "$NAME-src.b64"
fi
if [ "$PROV" = "gateway" ]; then
  KEY=$(cat ~/.config/ai-gateway/api-key.txt); URL=http://127.0.0.1:8319/v1/videos
  if [ -n "$IMG" ]; then jq -n --arg m "$MODEL" --arg p "$PROMPT" --rawfile u "$NAME-src.b64" --arg a "$AR" --argjson d $SECS '{model:$m,prompt:$p,resolution:"720p",aspect_ratio:$a,duration:$d,image:{url:$u}}' > "$NAME-req.json"
  else jq -n --arg m "$MODEL" --arg p "$PROMPT" --arg a "$AR" --argjson d $SECS '{model:$m,prompt:$p,resolution:"720p",aspect_ratio:$a,duration:$d}' > "$NAME-req.json"; fi
  ID=$(curl -s -m 120 $URL -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d @"$NAME-req.json" | jq -r '.request_id // empty')
  [ -z "$ID" ] && { echo "$NAME SUBMIT FAILED"; exit 1; }
  STATUS="http://127.0.0.1:8319/v1/videos/$ID"; AUTH="Authorization: Bearer $KEY"
else
  KEY=$(grep '^OPENROUTER_API_KEY=' ~/Projects/agenticbuilders-site/.env.local | cut -d= -f2- | tr -d '"')
  if [ -n "$IMG" ]; then jq -n --arg m "$MODEL" --arg p "$PROMPT" --rawfile u "$NAME-src.b64" --arg a "$AR" --argjson d $SECS '{model:$m,prompt:$p,duration:$d,aspect_ratio:$a,resolution:"1080p",frame_images:[{type:"image_url",image_url:{url:$u},frame_type:"first_frame"}]}' > "$NAME-req.json"
  else jq -n --arg m "$MODEL" --arg p "$PROMPT" --arg a "$AR" --argjson d $SECS '{model:$m,prompt:$p,duration:$d,aspect_ratio:$a,resolution:"1080p"}' > "$NAME-req.json"; fi
  R=$(curl -s -m 120 https://openrouter.ai/api/v1/videos -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d @"$NAME-req.json")
  ID=$(echo "$R" | jq -r '.id // empty'); [ -z "$ID" ] && { echo "$NAME SUBMIT FAILED: $(echo $R|head -c 300)"; exit 1; }
  STATUS=$(echo "$R" | jq -r ".polling_url // \"https://openrouter.ai/api/v1/videos/$ID\""); AUTH="Authorization: Bearer $KEY"
fi
echo "$NAME job $ID"
for i in {1..120}; do
  R=$(curl -s -m 20 "$STATUS" -H "$AUTH")
  ST=$(echo "$R" | jq -r '.status // "?"')
  case "$ST" in done|completed|succeeded) break;; failed|error) echo "$NAME FAILED: $(echo $R|head -c 300)"; exit 1;; esac
  sleep 5
done
echo "$R" > "$NAME-result.json"
if [ "$PROV" = "gateway" ]; then U=$(echo "$R"|jq -r '.video.url'); curl -sL -o "$NAME.mp4" "$U"
else COST=$(echo "$R"|jq -r '.usage.cost // "?"'); echo "$NAME cost USD $COST"
  curl -sL -o "$NAME.mp4" "https://openrouter.ai/api/v1/videos/$ID/content?index=0" -H "$AUTH"; fi
ffmpeg -v error -i "$NAME.mp4" -vf "select='not(mod(n\,20))',scale=300:-1,tile=4x2" -frames:v 1 -y "$NAME-strip.png"
echo "$NAME ok $(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 $NAME.mp4)"
