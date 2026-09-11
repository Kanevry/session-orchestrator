#!/bin/zsh
# loopify.sh <in.mp4> <outbase> [width] [xfade-seconds]
set -e
IN=$1; OUT=$2; W=${3:-960}; X=${4:-1.0}
D=$(ffprobe -v error -select_streams v:0 -show_entries format=duration -of csv=p=0 "$IN")
BODY=$(echo "$D - $X" | bc -l)
# crossfade the tail back over the head: result length = D - X, seamless at the seam
ffmpeg -v error -an -i "$IN" -filter_complex \
 "[0:v]scale=$W:-2,split=2[a][b];\
  [a]trim=0:$BODY,setpts=PTS-STARTPTS[main];\
  [b]trim=$BODY,setpts=PTS-STARTPTS[tail];\
  [main][tail]xfade=transition=fade:duration=$X:offset=$(echo "$BODY - $X"|bc -l)[v]" \
 -map "[v]" -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart -y "$OUT.mp4"
ffmpeg -v error -an -i "$OUT.mp4" -c:v libvpx-vp9 -crf 34 -b:v 0 -row-mt 1 -y "$OUT.webm"
ffmpeg -v error -i "$OUT.mp4" -vf "fps=12,scale=640:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" -loop 0 -y "$OUT.gif"
ffmpeg -v error -i "$OUT.mp4" -frames:v 1 -y "$OUT-poster.png"
cwebp -quiet -q 82 "$OUT-poster.png" -o "$OUT-poster.webp"
ls -la "$OUT".{mp4,webm,gif} "$OUT-poster.webp" | awk '{print $9, $5}'
