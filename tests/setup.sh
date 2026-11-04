#!/usr/bin/env bash
# Builds the test lab: test videos in every format the extension handles, npm deps,
# and a copy of the extension with an OPEN shadow root so Playwright can click the UI.
set -e
cd "$(dirname "$0")"
mkdir -p media hls_fmp4 hls_ts dl
q="-loglevel error -y"
# 20 s test video with sound (direct file)
ffmpeg $q -f lavfi -i "testsrc2=duration=20:size=640x360:rate=30" -f lavfi -i "sine=frequency=440:duration=20" \
  -c:v libx264 -preset veryfast -profile:v baseline -level 3.0 -pix_fmt yuv420p -g 30 -c:a aac -b:a 128k -shortest -movflags +faststart media/progressive.mp4
# Facebook-style split streams (fragmented MP4 + sidx), and two older fragment layouts
ffmpeg $q -i media/progressive.mp4 -map 0:v -c copy -movflags dash+global_sidx media/fb_video.mp4
ffmpeg $q -i media/progressive.mp4 -map 0:a -c copy -movflags dash+global_sidx media/fb_audio.mp4
ffmpeg $q -i media/progressive.mp4 -map 0:v -c copy -movflags frag_keyframe+empty_moov+default_base_moof media/dash_video.mp4
ffmpeg $q -i media/progressive.mp4 -map 0:a -c copy -movflags frag_keyframe+empty_moov+default_base_moof media/dash_audio.mp4
# X-style HLS: fMP4 segments with a separate audio rendition
( cd hls_fmp4 && ffmpeg $q -i ../media/progressive.mp4 -map 0:v -map 0:a -c copy -f hls -hls_time 4 -hls_playlist_type vod \
  -hls_segment_type fmp4 -var_stream_map "v:0,agroup:aud a:0,agroup:aud,default:yes" -master_pl_name master.m3u8 \
  -hls_segment_filename "s_%v_%03d.m4s" "p_%v.m3u8" )
# HLS with TS segments
( cd hls_ts && ffmpeg $q -i ../media/progressive.mp4 -c copy -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_filename "seg_%03d.ts" index.m3u8 )
# Store screenshot clip
ffmpeg $q -f lavfi -i "mandelbrot=s=1280x720:rate=30:end_scale=0.05" -f lavfi -i "sine=frequency=330:duration=15" -t 15 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest media/demo.mp4
ffmpeg $q -i media/demo.mp4 -map 0:v -c copy -movflags dash+global_sidx media/demo_v.mp4
ffmpeg $q -i media/demo.mp4 -map 0:a -c copy -movflags dash+global_sidx media/demo_a.mp4
npm install --silent
npx playwright install chromium
# Test copy of the extension with an open shadow root
rm -rf .ext-open && cp -r ../extension .ext-open
sed -i.bak "s/attachShadow({ mode: 'closed' })/attachShadow({ mode: 'open' })/" .ext-open/src/content.js && rm -f .ext-open/src/content.js.bak
echo "Lab ready. Run: ./run.sh"
