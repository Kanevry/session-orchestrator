#!/bin/zsh
# smooth.sh <out> <xfade-sec> <clip:speed:label:sec> ...
# Wie ladder.sh, aber die Beats werden mit xfade ineinander geblendet statt hart geschnitten.
set -e
OUT=$1; X=$2; shift 2
INPUTS=(); FILT=(); i=0; n=0; DUR=()
for spec in "$@"; do
  clip=${spec%%:*}; rest=${spec#*:}; sp=${rest%%:*}; rest2=${rest#*:}; lab=${rest2%%:*}; sec=${rest2#*:}
  INPUTS+=(-i "$clip" -i "$lab")
  pts=$(echo "1/$sp" | bc -l)
  FILT+=("[$i:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setpts=$pts*PTS,fps=30,trim=0:$sec,setpts=PTS-STARTPTS[s$n]")
  FILT+=("[s$n][$((i+1)):v]overlay=64:H-h-64:format=auto,format=yuv420p[v$n]")
  DUR+=($sec); i=$((i+2)); n=$((n+1))
done
# Kette der xfades: Offset = Summe der bisherigen Dauern minus der bisherigen Überblendungen
prev="[v0]"; off=0
for ((k=1; k<n; k++)); do
  off=$(echo "$off + ${DUR[$k]} - $X" | bc -l)
  out="[x$k]"; [ $k -eq $((n-1)) ] && out="[v]"
  FILT+=("${prev}[v${k}]xfade=transition=fade:duration=$X:offset=${off}${out}")
  prev="[x$k]"
done
ffmpeg -v error ${INPUTS[@]} -filter_complex "${(j:;:)FILT}" -map "[v]" -an \
  -c:v libx264 -crf 22 -preset slow -pix_fmt yuv420p -movflags +faststart -y "$OUT"
echo "$OUT $(ffprobe -v error -show_entries format=duration -of csv=p=0 $OUT)s"
