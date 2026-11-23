#!/usr/bin/env bash
# Generates small synthetic sample assets (no copyrighted media) with ffmpeg.
# Usage: scripts/make-sample-assets.sh <dir> [seconds_per_clip]
set -euo pipefail
D="${1:?dir}"; L="${2:-12}"; mkdir -p "$D"
F="ffmpeg -y -hide_banner -loglevel error"
$F -f lavfi -i "testsrc2=s=1280x720:r=30:d=$L" -f lavfi -i "sine=f=300:d=$L" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$D/presenter.mp4"
$F -f lavfi -i "smptehdbars=s=1920x1080:r=30:d=$L" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$D/screen.mp4"
$F -f lavfi -i "mandelbrot=s=1280x720:r=25" -t "$L" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$D/stock.mp4"
$F -f lavfi -i "sine=f=440:d=$((L*3))" -af "tremolo=f=3:d=0.7" -c:a pcm_s16le "$D/narration.wav"
$F -f lavfi -i "sine=f=220:d=20" -c:a libmp3lame -b:a 128k "$D/music.mp3"
$F -f lavfi -i "sine=f=1200:d=0.4" -c:a pcm_s16le "$D/whoosh.wav"
$F -f lavfi -i "color=c=red:s=240x80,drawbox=x=4:y=4:w=232:h=72:color=white:t=4" -frames:v 1 "$D/logo.png"
echo "sample assets in $D"
