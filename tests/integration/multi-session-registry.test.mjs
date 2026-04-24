/**
 * tests/integration/multi-session-registry.test.mjs
 *
 * Integration tests for the multi-session registry round-trip (Sub-Epic F, Epic #157).
 * Covers the seam between hooks/on-session-start.mjs (F2, #168) and
 * hooks/on-stop.mjs (F3, #169) — the full subprocess lifecycle, not just the lib.
 *
 * Every test uses an isolated tmp dir for SO_SESSION_REGISTRY_DIR and
 * CLAUDE_PROJECT_DIR to prevent writes to the real user's
 * ~/.config/session-orchestrator/.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK_SESSION_START = path.join(REPO_ROOT, 'hooks', 'on-session-start.mjs');
const HOOK_STOP = path.join(REPO_ROOT, 'hooks', 'on-stop.mjs');

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

const tmpDirs = [];
let origRegistryDir;
let registryDir;

beforeEach(async () => {
  origRegistryDir = process.env.SO_SESSION_REGISTRY_DIR;
  registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-reg-test-'));
  process.env.SO_SESSION_REGISTRY_DIR = registryDir;
  tmpDirs.push(registryDir);
});

afterEach(async () => {
  if (origRegistryDir === undefined) delete process.env.SO_SESSION_REGISTRY_DIR;
  else process.env.SO_SESSION_REGISTRY_DIR = origRegistryDir;
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated git project tmp dir.
 */
async function mkProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-reg-proj-'));
  tmpDirs.push(dir);
  const { $ } = await import('zx');
  $.verbose = false;
  $.quiet = true;
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} commit --allow-empty -m "init" --no-gpg-sign`;
  return dir;
}

/**
 * Spawn node hooks/on-session-start.mjs as a subprocess.
 * @param {{ projectDir: string, registryDir?: string, stdin?: string|object|null }} opts
 */
async function runSessionStart({ projectDir, registryDir: regDir, stdin = null }) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      SO_SESSION_REGISTRY_DIR: regDir ?? process.env.SO_SESSION_REGISTRY_DIR,
      // Suppress webhook side-effects
      CLANK_EVENT_SECRET: '',
      CLANK_EVENT_URL: '',
    };

    const child = spawn(process.execPath, [HOOK_SESSION_START], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    if (stdin !== null) {
      const raw = typeof stdin === 'string' ? stdin : JSON.stringify(stdin);
      child.stdin.end(raw);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Spawn node hooks/on-stop.mjs as a subprocess.
 * @param {{ projectDir: string, registryDir?: string, stdin?: string|object|null }} opts
 */
async function runStop({ projectDir, registryDir: regDir, stdin = null }) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      SO_SESSION_REGISTRY_DIR: regDir ?? process.env.SO_SESSION_REGISTRY_DIR,
      CLANK_EVENT_SECRET: '',
      CLANK_EVENT_URL: '',
    };

    const child = spawn(process.execPath, [HOOK_STOP], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    if (stdin !== null) {
      const raw = typeof stdin === 'string' ? stdin : JSON.stringify(stdin);
      child.stdin.end(raw);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Return all parsed heartbeat entries from the active/ sub-directory of regDir.
 * @param {string} regDir
 */
async function readRegistry(regDir) {
  const activeDir = path.join(regDir, 'active');
  let names;
  try {
    names = await fs.readdir(activeDir);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(activeDir, name), 'utf8');
      entries.push(JSON.parse(raw));
    } catch { /* skip malformed */ }
  }
  return entries;
}

/**
 * Return all parsed JSONL events from <projectDir>/.orchestrator/metrics/events.jsonl.
 * @param {string} projectDir
 */
async function readEvents(projectDir) {
  const eventsPath = path.join(projectDir, '.orchestrator', 'metrics', 'events.jsonl');
  let raw;
  try {
    raw = await fs.readFile(eventsPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Parse JSON systemMessage lines from a hook's stdout.
 */
function parseBanners(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((l) => l.systemMessage);
}

// ---------------------------------------------------------------------------
// 1. Two-session peer visibility
// ---------------------------------------------------------------------------

describe('two-session peer visibility', { timeout: 15000 }, () => {
  it('second session reports peer_count: 1 and Peers banner with repo name of first session', async () => {
    const dirA = await mkProject();
    const dirB = await mkProject();

    // Start session A — registers itself into the shared registry
    await runSessionStart({ projectDir: dirA });

    // Start session B — should detect A as a peer
    const resultB = await runSessionStart({ projectDir: dirB });

    const eventsB = await readEvents(dirB);
    const startedEvent = eventsB.find((e) => e.event === 'orchestrator.session.started');
    expect(startedEvent).toBeDefined();
    expect(startedEvent.peer_count).toBe(1);

    // Banner must include a Peers line referencing the repo name of session A
    const banners = parseBanners(resultB.stdout);
    const peerBanner = banners.find((b) => /Peers:/i.test(b.systemMessage));
    expect(peerBanner).toBeDefined();
    const repoNameA = path.basename(dirA);
    expect(peerBanner.systemMessage).toContain(repoNameA);
  });
});

// ---------------------------------------------------------------------------
// 2. Clean stop round-trip
// ---------------------------------------------------------------------------

describe('clean stop round-trip', { timeout: 15000 }, () => {
  it('heartbeat file exists after session-start, is removed after stop with same session_id', async () => {
    const dir = await mkProject();
    const sessionId = 'test-session-clean-stop-42';

    await runSessionStart({
      projectDir: dir,
      stdin: { session_id: sessionId },
    });

    // Verify the heartbeat file was written
    const activeDir = path.join(registryDir, 'active');
    const heartbeatPath = path.join(activeDir, `${sessionId}.json`);
    await expect(fs.access(heartbeatPath)).resolves.toBeUndefined();

    // Run stop with the same session_id
    const stopResult = await runStop({
      projectDir: dir,
      stdin: { hook_event_name: 'Stop', session_id: sessionId },
    });

    expect(stopResult.code).toBe(0);

    // Heartbeat file must be gone
    const exists = await fs.access(heartbeatPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Stop without stdin session_id uses current-session.json fallback
// ---------------------------------------------------------------------------

describe('stop without stdin session_id — current-session.json fallback', { timeout: 15000 }, () => {
  it('removes the heartbeat file when stop hook is given empty stdin (fallback via current-session.json)', async () => {
    const dir = await mkProject();

    // Start a session (generates a uuid and writes current-session.json)
    await runSessionStart({ projectDir: dir });

    // Determine the session_id from the written current-session.json
    const currentSessionPath = path.join(dir, '.orchestrator', 'current-session.json');
    const currentSession = JSON.parse(await fs.readFile(currentSessionPath, 'utf8'));
    const { session_id } = currentSession;

    // Verify heartbeat file exists
    const heartbeatPath = path.join(registryDir, 'active', `${session_id}.json`);
    await expect(fs.access(heartbeatPath)).resolves.toBeUndefined();

    // Run stop with empty stdin (no session_id in payload)
    const stopResult = await runStop({
      projectDir: dir,
      stdin: null,
    });

    expect(stopResult.code).toBe(0);

    // The fallback path reads current-session.json to find the session_id and deregisters
    const stillExists = await fs.access(heartbeatPath).then(() => true).catch(() => false);
    expect(stillExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Concurrent session-start calls do not lose entries
// ---------------------------------------------------------------------------

describe('concurrent session-start calls', { timeout: 15000 }, () => {
  it('three parallel session-start subprocesses each create a distinct heartbeat entry', async () => {
    const [dirA, dirB, dirC] = await Promise.all([mkProject(), mkProject(), mkProject()]);

    // Parallel start — atomic writes in session-registry.mjs must prevent data loss
    await Promise.all([
      runSessionStart({ projectDir: dirA }),
      runSessionStart({ projectDir: dirB }),
      runSessionStart({ projectDir: dirC }),
    ]);

    const entries = await readRegistry(registryDir);

    // Exactly 3 entries, all with distinct session_ids
    expect(entries).toHaveLength(3);
    const ids = new Set(entries.map((e) => e.session_id));
    expect(ids.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 5. Zombie sweep clears stale entries on next start
// ---------------------------------------------------------------------------

describe('zombie sweep on session-start', { timeout: 15000 }, () => {
  it('sweeps a 2-hour-old heartbeat and appends to sweep.log', async () => {
    const activeDir = path.join(registryDir, 'active');
    await fs.mkdir(activeDir, { recursive: true });

    // Pre-populate a stale entry (2 hours old)
    const staleTs = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const zombieEntry = {
      session_id: 'zombie-session-stale',
      pid: 1,
      platform: null,
      repo_path_hash: 'a'.repeat(64),
      repo_name: 'crashed-project',
      branch: 'main',
      started_at: staleTs,
      last_heartbeat: staleTs,
      status: 'active',
      current_wave: 0,
      host_class: null,
    };
    await fs.writeFile(
      path.join(activeDir, 'zombie-session-stale.json'),
      JSON.stringify(zombieEntry, null, 2) + '\n',
      'utf8',
    );

    const dir = await mkProject();
    await runSessionStart({ projectDir: dir });

    // Stale entry must be removed
    const remaining = await readRegistry(registryDir);
    const zombieStillPresent = remaining.some((e) => e.session_id === 'zombie-session-stale');
    expect(zombieStillPresent).toBe(false);

    // Sweep log must have an entry for the removed zombie
    const sweepLogPath = path.join(registryDir, 'sweep.log');
    const logExists = await fs.access(sweepLogPath).then(() => true).catch(() => false);
    expect(logExists).toBe(true);
    const logRaw = await fs.readFile(sweepLogPath, 'utf8');
    const logEntries = logRaw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const sweepEntry = logEntries.find((e) => e.session_id === 'zombie-session-stale');
    expect(sweepEntry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Deregister is idempotent across hooks
// ---------------------------------------------------------------------------

describe('deregister idempotency', { timeout: 15000 }, () => {
  it('running stop twice with the same session_id both exit 0 and second run still appends a stop event', async () => {
    const dir = await mkProject();
    const sessionId = 'test-idempotent-stop-99';

    // Register the session first
    await runSessionStart({
      projectDir: dir,
      stdin: { session_id: sessionId },
    });

    // First stop — removes the heartbeat file and writes event
    const stopResult1 = await runStop({
      projectDir: dir,
      stdin: { hook_event_name: 'Stop', session_id: sessionId },
    });
    expect(stopResult1.code).toBe(0);

    const eventsAfterFirst = await readEvents(dir);
    const firstStopEvents = eventsAfterFirst.filter((e) => e.event === 'stop');
    expect(firstStopEvents).toHaveLength(1);

    // Second stop — heartbeat file already gone; hook must still exit 0
    const stopResult2 = await runStop({
      projectDir: dir,
      stdin: { hook_event_name: 'Stop', session_id: sessionId },
    });
    expect(stopResult2.code).toBe(0);

    // Second run must append another stop event (idempotent on registry, not on events)
    const eventsAfterSecond = await readEvents(dir);
    const allStopEvents = eventsAfterSecond.filter((e) => e.event === 'stop');
    expect(allStopEvents).toHaveLength(2);

    // Heartbeat file must still not exist (was never re-created by stop hook)
    const heartbeatPath = path.join(registryDir, 'active', `${sessionId}.json`);
    const exists = await fs.access(heartbeatPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Heartbeat schema validation
// ---------------------------------------------------------------------------

describe('heartbeat file schema', { timeout: 15000 }, () => {
  it('written heartbeat contains all required schema fields with correct types', async () => {
    const dir = await mkProject();
    const sessionId = 'test-schema-validation-01';

    await runSessionStart({
      projectDir: dir,
      stdin: { session_id: sessionId },
    });

    const entries = await readRegistry(registryDir);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(typeof entry.session_id).toBe('string');
    expect(entry.session_id).toBe(sessionId);
    expect(typeof entry.pid).toBe('number');
    expect(Number.isInteger(entry.pid)).toBe(true);
    expect(typeof entry.repo_path_hash).toBe('string');
    expect(entry.repo_path_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof entry.repo_name).toBe('string');
    expect(entry.repo_name).toBe(path.basename(dir));
    expect(typeof entry.started_at).toBe('string');
    expect(entry.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(typeof entry.last_heartbeat).toBe('string');
    expect(entry.last_heartbeat).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(entry.status).toBe('active');
    expect(typeof entry.current_wave).toBe('number');
    expect(entry.current_wave).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Stop event records session_id for registry-linked sessions
// ---------------------------------------------------------------------------

describe('stop event records registry-linked session_id', { timeout: 15000 }, () => {
  it('stop event in events.jsonl carries the session_id that was registered', async () => {
    const dir = await mkProject();
    const sessionId = 'test-stop-event-session-id-77';

    await runSessionStart({
      projectDir: dir,
      stdin: { session_id: sessionId },
    });

    await runStop({
      projectDir: dir,
      stdin: { hook_event_name: 'Stop', session_id: sessionId },
    });

    const events = await readEvents(dir);
    const stopEvent = events.find((e) => e.event === 'stop');
    expect(stopEvent).toBeDefined();
    expect(stopEvent.session_id).toBe(sessionId);
  });
});
