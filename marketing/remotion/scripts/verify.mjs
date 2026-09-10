import {spawnSync} from 'node:child_process';
import {readFile, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {projectRoot, repoRoot} from './prepare-assets.mjs';

const props = JSON.parse(await readFile(path.resolve(projectRoot, process.env.CAMPAIGN_PROPS ?? 'campaign.json'), 'utf8'));
const campaign = `site/video/session-orchestrator-${props.version}${props.planned ? '-preview' : ''}.mp4`;
const loopOnly = process.argv.includes('--loop-only');
const expectations = [
  [campaign, 1920, 1080, 22, 'h264'],
  ['site/video/agent-production-loop.mp4', 960, 640, 9, 'h264'],
  ['site/video/agent-production-loop.webm', 960, 640, 9, 'vp9'],
];

const receipt = [];
for (const [name, width, height, duration, codec] of expectations) {
  if (loopOnly && !name.includes('-loop.')) continue;
  const file = path.join(repoRoot, name);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {encoding: 'utf8'});
  if (probe.status !== 0) throw new Error(probe.stderr || 'ffprobe failed');
  const data = JSON.parse(probe.stdout);
  const video = data.streams.find((s) => s.codec_type === 'video');
  const audio = data.streams.filter((s) => s.codec_type === 'audio');
  const actualDuration = Number(data.format.duration);
  const bytes = (await stat(file)).size;
  if (video.width !== width || video.height !== height || video.codec_name !== codec) throw new Error(`${name}: video format mismatch`);
  if (video.avg_frame_rate !== '30/1' || audio.length !== 0 || Math.abs(actualDuration - duration) > 0.04) throw new Error(`${name}: timing or audio mismatch`);
  if (name.includes('-loop.') && bytes >= 3_000_000) throw new Error(`${name}: exceeds the 3 MB loop budget`);
  const result = {file: name, codec, width, height, fps: 30, seconds: actualDuration, audioTracks: audio.length, bytes};
  if (name.includes('-loop.')) {
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=96:64,format=gray', '-f', 'rawvideo', '-'], {maxBuffer: 8_000_000});
    if (decoded.status !== 0) throw new Error(`${name}: frame decoding failed`);
    const size = 96 * 64;
    const frames = Math.floor(decoded.stdout.length / size);
    const delta = (a, b) => {
      let sum = 0;
      for (let i = 0; i < size; i++) sum += Math.abs(decoded.stdout[a * size + i] - decoded.stdout[b * size + i]);
      return sum / size;
    };
    const seam = delta(frames - 1, 0);
    const neighbours = Array.from({length: frames - 1}, (_, i) => delta(i, i + 1));
    const maximumNeighbour = Math.max(...neighbours);
    if (frames !== 270 || seam > Math.max(0.8, maximumNeighbour * 2)) throw new Error(`${name}: loop seam discontinuity`);
    Object.assign(result, {frames, seamMeanLumaDifference: +seam.toFixed(4), largestAdjacentMeanLumaDifference: +maximumNeighbour.toFixed(4)});
  }
  receipt.push(result);
}
await writeFile(path.join(projectRoot, loopOnly ? 'verification-loop.json' : 'verification.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
