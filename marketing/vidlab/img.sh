#!/bin/zsh
set -e
NAME=$1; PROMPT=$2
KEY=$(cat ~/.config/ai-gateway/api-key.txt)
jq -n --arg p "$PROMPT" '{model:"gpt-image-2",prompt:$p,n:1,size:"1536x1024"}' > /tmp/vidlab/$NAME-img-req.json
curl -s -m 300 http://127.0.0.1:8319/v1/images/generations -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d @/tmp/vidlab/$NAME-img-req.json \
  | jq -r '.data[0].b64_json' | base64 -d > /tmp/vidlab/$NAME.png
echo "$NAME $(file -b /tmp/vidlab/$NAME.png | head -c 60)"
