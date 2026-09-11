#!/bin/zsh
# audiobed.sh <video.mp4> <audio-source.mp4> <out.mp4> [silence-from-sec]
# Legt eine durchgehende Werkstatt-Tonspur unter den Schnitt, -14 LUFS (agentic-cutter-Praxis),
# und blendet sie vor den Textkarten auf Stille.
set -e
V=$1; A=$2; OUT=$3; SIL=${4:-0}
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$V")
if [ "$SIL" = "0" ]; then SIL=$(echo "$D - 5.4" | bc -l); fi
ffmpeg -v error -i "$V" -stream_loop -1 -i "$A" -filter_complex \
  "[1:a]atrim=0:$D,asetpts=N/SR/TB,afade=t=in:st=0:d=0.8,afade=t=out:st=$SIL:d=1.2,loudnorm=I=-14:TP=-1.5:LRA=11[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 160k -shortest -movflags +faststart -y "$OUT"
echo "$OUT $(ffprobe -v error -show_entries stream=codec_name -select_streams a:0 -of csv=p=0 $OUT)"
