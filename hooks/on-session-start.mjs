#!/usr/bin/env node
/**
 * on-session-start.mjs — SessionStart hook: emit event + optional host/resource banner.
 *
 * Node.js port of hooks/on-session-start.sh. Part of v3.0.0 migration
 * (Epic #124, issue #140). Extended in v3.1.0 (Epic #157):
 *   - #164: host-identity + resource-probe banner surfaced via systemMessage.
 *   - #168: multi-session registry — register this session, detect peers, sweep
 *     zombies. Peer summary is appended to the banner and surfaced in the event.
 *
 * Behaviour:
 *   1. Resolves project name and current git branch.
 *   2. When env-aware libs are available AND enable-host-banner config is true,
 *      collects host fingerprint + resource snapshot and emits a one-line
 *      systemMessage banner. Populates .orchestrator/host.json for skills.
 *   3. Reads session_id from stdin (Claude Code hook contract). Falls back to
 *      a generated uuid-v4 and caches it at .orchestrator/current-session.json
 *      so on-stop can deregister cleanly.
 *   4. Sweeps zombie heartbeats older than the configured threshold, registers
 *      this session, detects live peers on the same host.
 *   5. Emits "orchestrator.session.started" event to .orchestrator/metrics/events.jsonl.
 *   6. Optionally POSTs to Clank Event Bus if CLANK_EVENT_SECRET is set.
 *
 * Exit codes:
 *   0 — always (informational, never blocking)
 *
 * hooks.json wiring (SessionStart, async: true, timeout: 5s) is managed separately.
 * stdin: optional JSON payload from Claude Code containing session_id.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { emitEvent } from '../scripts/lib/events.mjs';
import { SO_PLATFORM, resolveProjectDir } from '../scripts/lib/platform.mjs';
import {
  registerSelf,
  detectPeers,
  sweepZombies,
  logSweepEvent,
} from '../scripts/lib/session-registry.mjs';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in cwd; return trimmed stdout. Returns null on failure.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function gitOutput(args, cwd) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Read `enable-host-banner` from CLAUDE.md / AGENTS.md Session Config. Returns
 * true as the default — missing config or parse errors fall back to enabled,
 * matching the documented behaviour for issue #166.
 */
async function isHostBannerEnabled(projectRoot) {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      const raw = await readFile(path.join(projectRoot, name), 'utf8');
      const m = raw.match(/^\s*enable-host-banner:\s*(true|false)\b/im);
      if (m) return m[1].toLowerCase() === 'true';
    } catch { /* file missing is fine */ }
  }
  return true;
}

/**
 * Read `resource-thresholds.concurrent-sessions-warn` from Session Config.
 * Used to decide when the peer banner should show the WARN icon. Defaults to
 * 5 — matches the documented default in docs/session-config-reference.md.
 */
async function peerWarnThreshold(projectRoot) {
  const DEFAULT = 5;
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      const raw = await readFile(path.join(projectRoot, name), 'utf8');
      // Match `concurrent-sessions-warn: <int>` inside resource-thresholds or top-level.
      const m = raw.match(/^\s*concurrent-sessions-warn:\s*(\d+)\b/im);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!Number.isNaN(n) && n > 0) return n;
      }
    } catch { /* file missing is fine */ }
  }
  return DEFAULT;
}

/**
 * Non-blocking stdin read for Claude Code hook payload. Returns parsed JSON or
 * null if stdin is closed, empty, unparseable, or times out.
 */
async function readStdinJson(timeoutMs = 500) {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded || process.stdin.closed) {
      resolve(null);
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => { resolve(null); }, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      const raw = chunks.join('').trim();
      if (!raw) { resolve(null); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(null); });
    process.stdin.resume();
  });
}

/**
 * Resolve a session_id for this run. Preference order:
 *   1. stdin payload (`session_id` or `sessionId`)
 *   2. generated uuid-v4 via crypto.randomUUID()
 *
 * In both cases, persist the resolved id to
 * `.orchestrator/current-session.json` so on-stop can deregister even when the
 * stop-hook stdin does not carry the same id (Claude Code guarantees this, but
 * Codex/Cursor may not).
 *
 * Best-effort: any persistence failure is swallowed (hook must remain non-blocking).
 */
async function resolveSessionId(input, projectRoot) {
  const fromStdin = (input && (input.session_id || input.sessionId)) ?? null;
  const sessionId =
    typeof fromStdin === 'string' && fromStdin.length > 0 ? fromStdin : randomUUID();

  try {
    const dir = path.join(projectRoot, '.orchestrator');
    await mkdir(dir, { recursive: true });
    const payload = {
      session_id: sessionId,
      pid: process.pid,
      source: fromStdin ? 'stdin' : 'generated',
      timestamp: new Date().toISOString(),
    };
    await writeFile(
      path.join(dir, 'current-session.json'),
      JSON.stringify(payload, null, 2) + '\n',
      'utf8',
    );
  } catch { /* best effort */ }

  return sessionId;
}

/**
 * Attempt to collect and emit the host + resource banner. Pure best-effort:
 * any failure (missing lib, no home dir, probe throws) is swallowed so the
 * session-start hook never blocks.
 * @returns {Promise<{host: object, resources: object}|null>}
 */
async function emitHostBanner(projectRoot) {
  try {
    const [{ getHostFingerprint }, { probe }] = await Promise.all([
      import('../scripts/lib/host-identity.mjs'),
      import('../scripts/lib/resource-probe.mjs'),
    ]);
    const [host, resources] = await Promise.all([
      getHostFingerprint(projectRoot).catch(() => null),
      probe({ skipProcessCounts: false }).catch(() => null),
    ]);
    if (!host || !resources) return null;

    const hostLine = `🖥️  Host: ${host.host_class} · ${host.ram_total_gb} GB RAM · ${host.platform ?? 'unknown'} · ${host.is_ssh ? 'ssh' : 'local'}`;
    const procSuffix = resources.claude_processes_count === null
      ? ''
      : ` · ${resources.claude_processes_count} Claude process${resources.claude_processes_count === 1 ? '' : 'es'} running`;
    const resourceLine = `📊 Resources: ${resources.ram_free_gb.toFixed(1)} GB free · CPU ${resources.cpu_load_pct}%${procSuffix}`;
    const banner = `${hostLine}\n${resourceLine}`;

    // systemMessage envelope is the Claude Code hook contract; ignored by
    // consumers that do not read stdout, harmless in all cases.
    console.log(JSON.stringify({ systemMessage: banner }));

    return { host, resources };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectRoot = resolveProjectDir();

  // Read optional stdin payload in parallel with git info so we don't stall
  // the hook. Both are best-effort and the promise races against a 500 ms cap
  // inside readStdinJson itself.
  const stdinPromise = readStdinJson();

  // Resolve project name: basename of git toplevel, falling back to cwd basename.
  const topLevel = await gitOutput(['rev-parse', '--show-toplevel'], projectRoot);
  const projectName = topLevel
    ? topLevel.split(/[/\\]/).filter(Boolean).pop() ?? 'unknown'
    : projectRoot.split(/[/\\]/).filter(Boolean).pop() ?? 'unknown';

  // Resolve current branch; fall back to "unknown" when detached HEAD or no git.
  const branch = (await gitOutput(['branch', '--show-current'], projectRoot)) ?? 'unknown';

  // v3.1.0 env-aware banner (opt-out via enable-host-banner: false in Session Config).
  let bannerData = null;
  if (await isHostBannerEnabled(projectRoot)) {
    bannerData = await emitHostBanner(projectRoot);
  }

  // v3.1.0 multi-session registry (#168). All steps best-effort — failures
  // must never break the hook, which is informational-only.
  const input = await stdinPromise;
  const sessionId = await resolveSessionId(input, projectRoot);
  const platform = process.env.SO_PLATFORM ?? SO_PLATFORM;

  let peers = [];
  try {
    await sweepZombies().catch(() => ({ removed: [], logged: 0 }));
    try {
      await registerSelf({
        sessionId,
        projectRoot,
        branch,
        platform,
        hostClass: bannerData?.host?.host_class ?? null,
      });
    } catch (err) {
      // Registration failed — emit an observability breadcrumb to sweep.log.
      // Do NOT throw, do NOT write to stderr: the hook is informational-only.
      logSweepEvent({ event: 'register-failed', session_id: sessionId, error: err?.message ?? String(err) });
    }
    peers = await detectPeers({ sessionId }).catch(() => []);
  } catch { /* swallow — hook must remain non-blocking */ }

  // Append a peer line to the host banner when a banner was already emitted
  // and at least one peer is live on this host.
  if (bannerData && peers.length > 0) {
    const threshold = await peerWarnThreshold(projectRoot);
    const icon = peers.length >= threshold ? '⚠️ ' : '';
    const summary = peers
      .map((p) => `${p.repo_name ?? 'unknown'}:${p.branch ?? 'unknown'}:wave-${p.current_wave ?? 0}`)
      .slice(0, 5)
      .join(', ');
    const overflow = peers.length > 5 ? ` +${peers.length - 5} more` : '';
    const peerLine = `${icon}👥 Peers: ${peers.length} active (${summary}${overflow})`;
    try {
      console.log(JSON.stringify({ systemMessage: peerLine }));
    } catch { /* best effort */ }
  }

  const payload = {
    platform,
    project: projectName,
    branch,
    session_id: sessionId,
    peer_count: peers.length,
  };
  if (bannerData) {
    payload.host_class = bannerData.host.host_class;
    payload.ram_free_gb = bannerData.resources.ram_free_gb;
    payload.cpu_load_pct = bannerData.resources.cpu_load_pct;
    payload.claude_processes_count = bannerData.resources.claude_processes_count;
  }
  await emitEvent('orchestrator.session.started', payload);
}

// Top-level guard — always exit 0 (non-blocking informational hook).
main().catch(() => {}).finally(() => {
  process.exit(0);
});
