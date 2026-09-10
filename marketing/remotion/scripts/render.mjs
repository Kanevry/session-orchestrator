import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {prepareAssets, projectRoot, repoRoot} from './prepare-assets.mjs';

const mode = process.argv[2] ?? 'all';
if (!['all', 'release', 'loop', 'posters'].includes(mode)) throw new Error(`Unknown render: ${mode}`);
const propsFile = path.resolve(projectRoot, process.env.CAMPAIGN_PROPS ?? 'campaign.json');
const props = JSON.parse(await readFile(propsFile, 'utf8'));
if (!/^[\d.]+$/.test(props.version)) throw new Error('Campaign version must contain digits and dots');
await prepareAssets();
const output = path.join(repoRoot, 'site/video');
await mkdir(output, {recursive: true});
const temporaryOutput = path.join(projectRoot, 'out');
await mkdir(temporaryOutput, {recursive: true});

function cli(args) {
  console.log(`Rendering ${args[2]} → ${path.basename(args[3])}`);
  const result = spawnSync(process.execPath, [path.join(projectRoot, 'node_modules/@remotion/cli/remotion-cli.js'), ...args], {cwd: projectRoot, encoding: 'utf8', maxBuffer: 20_000_000});
  writeFileSync(path.join(temporaryOutput, `${path.basename(args[3])}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Remotion failed with exit ${result.status}\n${result.stderr}\n${result.stdout}`);
  console.log(`Rendered ${path.basename(args[3])}`);
}

const common = ['--concurrency=2', '--log=warn'];
const browser = process.env.REMOTION_BROWSER ? [`--browser-executable=${process.env.REMOTION_BROWSER}`] : [];
common.push(...browser);
if (mode === 'all' || mode === 'release') {
  cli(['render', 'src/index.ts', 'ReleaseFilm', path.join(output, `session-orchestrator-${props.version}${props.planned ? '-preview' : ''}.mp4`), '--codec=h264', '--crf=18', '--pixel-format=yuv420p', `--props=${propsFile}`, ...common]);
}
if (mode === 'all' || mode === 'loop') {
  cli(['render', 'src/index.ts', 'ProductionLoop', path.join(output, 'agent-production-loop.mp4'), '--codec=h264', '--crf=23', '--pixel-format=yuv420p', ...common]);
  cli(['render', 'src/index.ts', 'ProductionLoop', path.join(output, 'agent-production-loop.webm'), '--codec=vp9', '--crf=35', '--pixel-format=yuv420p', ...common]);
}
if (mode === 'all' || mode === 'posters') {
  cli(['still', 'src/index.ts', 'ReleasePoster', path.join(repoRoot, 'site/img/release-poster.png'), `--props=${propsFile}`, '--log=warn', ...browser]);
  const posterFrame = path.join(temporaryOutput, 'production-poster.png');
  cli(['still', 'src/index.ts', 'ProductionLoop', posterFrame, '--frame=0', '--log=warn', ...browser]);
  const webp = spawnSync('cwebp', ['-quiet', '-q', '86', posterFrame, '-o', path.join(output, 'agent-production-poster.webp')], {stdio: 'inherit'});
  if (webp.error) throw webp.error;
  if (webp.status !== 0) throw new Error('WebP poster encoding failed');
}
await writeFile(path.join(projectRoot, 'render-receipt.json'), JSON.stringify({mode, props, remotion: '4.0.523', entry: 'src/index.ts', campaignDurationSeconds: 22, loopDurationSeconds: 9, frameRate: 30, silent: true}, null, 2) + '\n');
