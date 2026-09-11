#!/bin/zsh
# ladder.sh <out> <clip:speed:labelpng> ...   speed 0.4 = Zeitlupe, 3 = schnell
set -e
OUT=$1; shift
INPUTS=(); FILT=(); CAT=""; i=0; n=0
for spec in "$@"; do
  clip=${spec%%:*}; rest=${spec#*:}; sp=${rest%%:*}; rest2=${rest#*:}; lab=${rest2%%:*}; sec=${rest2#*:}
  INPUTS+=(-i "$clip" -i "$lab")
  pts=$(echo "1/$sp" | bc -l)
  FILT+=("[$i:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setpts=$pts*PTS,fps=30,trim=0:$sec,setpts=PTS-STARTPTS[s$n]")
  FILT+=("[s$n][$((i+1)):v]overlay=64:H-h-64:format=auto[v$n]")
  CAT="${CAT}[v${n}]"; i=$((i+2)); n=$((n+1))
done
echo "GRAPH: ${(j:;:)FILT};${CAT}concat=n=$n:v=1:a=0[v]" >&2
ffmpeg -v error ${INPUTS[@]} -filter_complex "${(j:;:)FILT};${CAT}concat=n=$n:v=1:a=0[v]" \
  -map "[v]" -an -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart -y "$OUT"
echo "$OUT $(ffprobe -v error -show_entries format=duration -of csv=p=0 $OUT)s"
