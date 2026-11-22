#!/usr/bin/env node
/**
 * ux-grill-offload-host.mjs — the HOST side of `scripts/ux-grill-offload.mjs`.
 *
 * Runs inside an `offload run` job whose working directory is the target-repo
 * image. Never started by hand: the caller-side CLI builds the argv. It
 *   1. installs the app directory (`npm ci`) when the image carries a lockfile,
 *      because offload installs a root package but not a nested-only tree
 *      (measured 2026-11-21: `NODE_MODULES=n/a` for a repo whose app lives in
 *      `website/`),
 *   2. builds the app, then serves it on loopback as an ordinary CHILD of this
 *      process — never `nohup`/`setsid`: offload tears down the job's process
 *      group when the caller dies (REMOTE-OFFLOAD.md #736), and a detached
 *      server would survive that,
 *   3. bootstraps a manifest by a deterministic crawl of the landing page when
 *      none exists (no login: credentials do not travel to the host),
 *   4. runs `collect()` and `compareRuns()` — never `reconcileFindings()`, issue
 *      filing stays with the caller,
 *   5. prints one RESULT line and the artefacts as framed base64 on stdout.
 *
 * Everything human-readable goes to stderr; stdout carries only the protocol
 * lines from `scripts/lib/ux-grill/offload.mjs`.
 *
 * Usage (built by the caller):
 *   node <so>/scripts/ux-grill-offload-host.mjs --app-dir <rel> [--build <cmd>|--no-build] [--start <cmd>]
 */

import { execFile as execFileCb, spawn } from './lib/native-command.mjs';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { digestSha256 } from './lib/crypto-digest-utils.mjs';
import { collect, defaultExec, readEvalPayload } from './lib/ux-grill/collect.mjs';
import { compareRuns } from './lib/ux-grill/compare.mjs';
import {
  DEFAULT_MANIFEST_PATH,
  buildBootstrapManifest,
  isLoopbackUrl,
  loadManifest,
  parseManifest,
  writeBootstrapManifest,
} from './lib/ux-grill/manifest.mjs';
import {
  FRAME_PREFIX,
  OffloadGrillError,
  RESULT_TAG,
  commandArgv,
  defaultAppCommands,
  encodeArtefactFrames,
  portFromBaseUrl,
  routesFromLinks,
} from './lib/ux-grill/offload.mjs';
import { UX_GRILL_LEDGER, makeRunId, runRecordPath } from './lib/ux-grill/paths.mjs';
import { countBySeverity } from './lib/ux-grill/schema.mjs';

const execFile = promisify(execFileCb);
const SO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const READY_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 900_000;

/** JS evaluated on the landing page: hrefs inside nav landmarks first, then every visible link. */
const LINKS_EVAL = `(() => {
  const pick = (root) => [...root.querySelectorAll('a[href]')]
    .filter((a) => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map((a) => a.href);
  const navs = [...document.querySelectorAll('nav, [role="navigation"]')].flatMap(pick);
  return { title: document.title, hrefs: [...navs, ...pick(document)] };
})()`;

function log(line) {
  process.stderr.write(`ux-grill-offload-host: ${line}\n`);
}

function emit(line) {
  process.stdout.write(`${line}\n`);
}

/** @param {string[]} argv */
function parseHostArgs(argv) {
  const out = { appDir: '.', build: undefined, start: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new OffloadGrillError('usage', `${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--app-dir') out.appDir = next();
    else if (arg === '--build') out.build = next();
    else if (arg === '--no-build') out.build = null;
    else if (arg === '--start') out.start = next();
    else throw new OffloadGrillError('usage', `unknown argument ${arg}`);
  }
  return out;
}

/** A port on loopback the kernel currently hands out, or a check that `port` is free. */
function probePort(port = 0, host = 'localhost') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => reject(err));
    server.listen({ port, host }, () => {
      const chosen = server.address().port;
      server.close(() => resolve(chosen));
    });
  });
}

/** Run a command to completion, inheriting stderr so build output stays in the job log. */
async function runToEnd(argv, cwd, timeout) {
  log(`run: ${argv.join(' ')} (cwd ${cwd})`);
  await execFile(argv[0], argv.slice(1), {
    cwd,
    timeout,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
}

/** Poll until the server answers HTTP at all (any status), or the child exits. */
async function waitForServer(url, child, spawnError) {
  // Only ever probes the loopback server this job started (same check as the manifest).
  if (!isLoopbackUrl(url)) throw new OffloadGrillError('base-url-not-loopback', 'base-url must be loopback');
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError.error) {
      throw new OffloadGrillError('server-spawn-failed', `start command could not run: ${spawnError.error.code ?? spawnError.error.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new OffloadGrillError('server-exited', `server exited before it answered (code ${child.exitCode}, signal ${child.signalCode})`);
    }
    try {
      // nosemgrep: unsafe-fetch-user-url -- loopback asserted above; the URL is this job's own server
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
      log(`server answered ${res.status} at ${url}`);
      return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new OffloadGrillError('server-not-ready', `server did not answer within ${READY_TIMEOUT_MS / 1000}s at ${url}`);
}

function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5_000);
    child.once('exit', () => { clearTimeout(kill); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(kill); resolve(); }
  });
}

/** Deterministic bootstrap crawl: one page, its links, its title. */
async function crawlLanding(baseUrl, runId) {
  const session = `uxgrill-crawl-${runId}`;
  try {
    const opened = await defaultExec(['open', baseUrl, '--session', session]);
    if (opened.code !== 0) throw new OffloadGrillError('crawl-open-failed', `agent-browser open failed (exit ${opened.code})`);
    // Same call shape as collect(): `--json` envelope, read by readEvalPayload().
    // Best effort: a page that never reaches network idle is still crawled.
    await defaultExec(['wait', '--load', 'networkidle', '--session', session]);
    const payload = readEvalPayload(await defaultExec(['eval', LINKS_EVAL, '--json', '--session', session]));
    if (!payload.ok || !Array.isArray(payload.value?.hrefs)) {
      // A crawl that silently yields only "/" looks like a one-page site; refuse instead.
      throw new OffloadGrillError('crawl-eval-unreadable', 'agent-browser eval of the landing page returned no readable link list');
    }
    log(`bootstrap crawl: ${payload.value.hrefs.length} links on the landing page`);
    return routesFromLinks(payload.value.hrefs, baseUrl);
  } finally {
    await defaultExec(['close', '--session', session]);
  }
}

function packArtefacts(repoRoot, runId) {
  // ledger-root: packs the job image's own copy; main() refused a ledger outside the image (ledger-outside-image)
  const members = [UX_GRILL_LEDGER, `.orchestrator/metrics/ux-grill/${runId}`];
  if (existsSync(path.join(repoRoot, DEFAULT_MANIFEST_PATH))) members.unshift(DEFAULT_MANIFEST_PATH);
  return execFile('tar', ['-czf', '-', '-C', repoRoot, ...members.filter((m) => existsSync(path.join(repoRoot, m)))], {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 1024,
  }).then(({ stdout }) => stdout);
}

async function main() {
  const args = parseHostArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const appDir = path.resolve(repoRoot, args.appDir);
  if (appDir !== repoRoot && !appDir.startsWith(repoRoot + path.sep)) {
    throw new OffloadGrillError('usage', '--app-dir must stay inside the target repo');
  }
  // The ledger follows #1722 into a main checkout when the run sits in a linked
  // worktree. On the host that would be a write into the host's main checkout,
  // so the run refuses unless the ledger stays inside the job image.
  const ledger = runRecordPath(repoRoot);
  if (!ledger.startsWith(repoRoot + path.sep)) {
    throw new OffloadGrillError('ledger-outside-image', 'the ux-grill ledger would resolve outside the job worktree; refusing to write into a host checkout');
  }
  const pkgPath = path.join(appDir, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : null;
  const defaults = defaultAppCommands(pkg);
  const buildLine = args.build === undefined ? defaults.build : args.build;
  const startLine = args.start ?? defaults.start;
  if (!startLine) {
    throw new OffloadGrillError('no-start-command', `no start command: ${path.relative(repoRoot, pkgPath) || 'package.json'} is not a Next.js app — pass --start "<cmd with {port}>"`);
  }

  const manifestAbs = path.join(repoRoot, DEFAULT_MANIFEST_PATH);
  const hadManifest = existsSync(manifestAbs);
  let port;
  let baseUrl;
  if (hadManifest) {
    // Checked on the raw frontmatter BEFORE loadManifest(): the env file is
    // untracked, so it is never in the image, and loadManifest() would fail
    // with env-file-missing first.
    const { frontmatter } = parseManifest(readFileSync(manifestAbs, 'utf8'));
    // BV-004: credentials never travel to the offload host, so a manifest that
    // names an env file cannot log in here. Revisit when a secret channel to the
    // host exists (keychain route) and a login manifest needs a remote run.
    if (frontmatter['env-file'] || frontmatter['login-command']) {
      throw new OffloadGrillError('needs-credentials', 'manifest names an env-file or login-command; the offload run carries no credentials — run /ux-grill on a machine that holds the env file');
    }
    loadManifest({ repoRoot });
    baseUrl = String(frontmatter['base-url']).replace(/\/+$/, '');
    port = portFromBaseUrl(baseUrl);
    try { await probePort(port, new URL(baseUrl).hostname.replace(/^\[|\]$/g, '')); } catch {
      throw new OffloadGrillError('port-busy', `port ${port} from the manifest base-url is busy on this host; the port is part of the manifest hash, so it is not changed silently`);
    }
  } else {
    port = await probePort(0);
    baseUrl = `http://${defaults.hostName}:${port}`;
  }

  if (pkg && existsSync(path.join(appDir, 'package-lock.json')) && !existsSync(path.join(appDir, 'node_modules'))) {
    // No lifecycle scripts: the image may come from a foreign origin, and offload's
    // own hardened install (#884) does not reach a nested app dir.
    await runToEnd(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], appDir, BUILD_TIMEOUT_MS);
  }
  if (buildLine) await runToEnd(commandArgv(buildLine, port), appDir, BUILD_TIMEOUT_MS);

  const startArgv = commandArgv(startLine, port);
  log(`start: ${startArgv.join(' ')}`);
  const server = spawn(startArgv[0], startArgv.slice(1), {
    cwd: appDir,
    // stderr too: offload merges the job's stderr into stdout, and a server that
    // printed a protocol line could otherwise spoof the RESULT the caller reads.
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', PORT: String(port) },
  });
  const spawnError = { error: null };
  server.once('error', (err) => { spawnError.error = err; });
  const onSignal = (sig) => { stopServer(server).finally(() => process.exit(sig === 'SIGINT' ? 130 : 143)); };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    await waitForServer(`${baseUrl}/`, server, spawnError);
    const runId = makeRunId();
    let bootstrapped = false;
    if (!hadManifest) {
      const routes = await crawlLanding(baseUrl, runId);
      log(`bootstrap crawl: ${routes.length} routes`);
      const text = buildBootstrapManifest({ baseUrl, build: buildLine ? 'prod' : 'dev', routes });
      writeBootstrapManifest({ repoRoot, text });
      bootstrapped = true;
    }
    const manifest = loadManifest({ repoRoot });
    const rubricHash = digestSha256(readFileSync(path.join(SO_ROOT, 'skills/ux-grill/rubric-v2.md'), 'utf8'));
    const collected = await collect({ repoRoot, manifest, envMap: manifest.envMap, rubricHash, runId });
    const compared = compareRuns({
      repoRoot,
      runId: collected.runId,
      manifestHash: manifest.manifestHash,
      build: manifest.frontmatter.build,
      rubricHash,
      skipped: collected.skipped,
    });
    emit(`${FRAME_PREFIX} ${RESULT_TAG} ${JSON.stringify({
      runId: collected.runId,
      bootstrapped,
      baseUrl,
      routes: (manifest.frontmatter.routes ?? []).length,
      findings: collected.findings.length,
      bySeverity: countBySeverity(collected.findings),
      compare: compared?.counts ?? null,
      rubricChanged: compared?.rubricChanged ?? false,
      skipSummary: collected.skipSummary,
    })}`);
    const tarball = await packArtefacts(repoRoot, collected.runId);
    for (const line of encodeArtefactFrames(tarball)) emit(line);
  } finally {
    if (!spawnError.error) await stopServer(server);
  }
}

// Never process.exit() after the artefact frames: stdout to a pipe is
// asynchronous, and exit drops what is still buffered above the pipe size —
// a multi-MB frame stream would arrive cut. exitCode lets the stream drain.
main().then(
  () => { process.exitCode = 0; },
  (err) => {
    const code = err?.code ?? 'error';
    log(`FAILED [${code}] ${err?.message ?? String(err)}`);
    emit(`${FRAME_PREFIX} ${RESULT_TAG} ${JSON.stringify({ error: { code, message: String(err?.message ?? err) } })}`);
    process.exitCode = 3;
  },
);

