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

import { shouldRunHook } from './_lib/profile-gate.mjs';
// #211: exit 0 immediately (silent allow) when this hook is disabled via profile/env
if (!shouldRunHook('on-session-start')) process.exit(0);

import { emitEvent, eventsFilePath } from '../scripts/lib/events.mjs';
import { maybeRotate } from '../scripts/lib/events-rotation.mjs';
import { readConfigFile, parseSessionConfig } from '../scripts/lib/config.mjs';
import { SO_PLATFORM, resolveProjectDir } from '../scripts/lib/platform.mjs';
import {
  registerSelf,
  detectPeers,
  sweepZombies,
  logSweepEvent,
} from '../scripts/lib/session-registry.mjs';
import { detectColdStart, consumeMarker } from '../scripts/lib/cold-start-detector.mjs';

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
 * Read `cold-start.*` block from Session Config with PRD defaults applied.
 *
 * Uses `parseSessionConfig(md)['cold-start']` (wired via I6). Any parse
 * failure returns defaults so the cold-start nudge is never blocked.
 *
 * All keys are optional. Returns:
 *   { enabled: boolean, 'nudge-after-hours': number, 'silence-after-sessions': number }
 *
 * PRD defaults (F1.3): enabled=true, nudge-after-hours=1,
 * silence-after-sessions=1. Any parse failure → defaults.
 */
async function readColdStartConfig(projectRoot) {
  const defaults = {
    enabled: true,
    'nudge-after-hours': 1,
    'silence-after-sessions': 1,
  };

  try {
    const md = await readConfigFile(projectRoot);
    try {
      const config = parseSessionConfig(md);
      const block = config['cold-start'];
      if (block && typeof block === 'object') {
        return {
          enabled: block.enabled !== false,
          'nudge-after-hours':
            typeof block['nudge-after-hours'] === 'number'
              ? block['nudge-after-hours']
              : defaults['nudge-after-hours'],
          'silence-after-sessions':
            typeof block['silence-after-sessions'] === 'number'
              ? block['silence-after-sessions']
              : defaults['silence-after-sessions'],
        };
      }
    } catch { return defaults; }
  } catch {
    return defaults;
  }
  return defaults;
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

  // Mode normalization is shared by both branches (stdin-UUID + semantic-gen)
  // so the semantic-id derivation works identically regardless of how
  // sessionId was sourced. Epic #583 D4 #587: a semantic id is ALWAYS surfaced.
  const rawMode = (input && (input.mode || input.session_type)) || 'session';
  const normalizedMode =
    String(rawMode).toLowerCase().replace(/[^a-z-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'session';

  let sessionId;
  let source;
  // Epic #583 D4 #587: semanticSessionId is computed on BOTH branches so the
  // session.lock + downstream consumers always see the semantic form, even
  // when Claude Code's stdin payload provided a UUID-v4. Defaults to null
  // and is populated below; the lock-bootstrap helper falls back to mirroring
  // sessionId when this stays null.
  let semanticSessionId = null;

  if (typeof fromStdin === 'string' && fromStdin.length > 0) {
    sessionId = fromStdin;
    source = 'stdin';

    // D4 #587: even on the stdin-UUID path, ALSO compute a semantic
    // session-id so the lock and registry can surface it downstream.
    // Best-effort: any failure leaves semanticSessionId = null which is
    // handled gracefully by the lock-bootstrap helper.
    try {
      const semCandidate = await deriveSemanticCandidate({
        projectRoot,
        mode: normalizedMode,
      });
      if (semCandidate) semanticSessionId = semCandidate;
    } catch { /* best effort — leave semanticSessionId = null */ }
  } else {
    // No stdin id — generate a semantic session-id via P2.2 #573 (PRD §3 P2).
    // Falls back to randomUUID() on any failure to keep the hook non-blocking.
    try {
      const candidate = await deriveSemanticCandidate({
        projectRoot,
        mode: normalizedMode,
      });
      if (!candidate) throw new Error('semantic-derivation-empty');

      // Race-free host-wide uniqueness: try to atomically claim the registry slot
      // for this sessionId via O_CREAT|O_EXCL. If another process won the race
      // (EEXIST), fall back to UUID-v4 to guarantee distinct sessionIds across
      // parallel hook invocations. The empty file is immediately overwritten by
      // registerSelf() with the real entry — _validEntry() in readers filters
      // any zero-content artifact during the millisecond gap.
      try {
        // entryPath() is NOT exported from session-registry.mjs (it is an
        // internal helper); replicate its body inline so the race-free slot
        // claim actually succeeds. Without this inline build, the
        // destructuring on `entryPath` returns undefined and calling it
        // throws TypeError → silent UUID-fallback, defeating the semantic-id
        // generation path entirely. Pre-existing bug pre-dating Epic #583 P3.
        const { activeDir } = await import('../scripts/lib/session-registry.mjs');
        const fsAsync = await import('node:fs/promises');
        await fsAsync.mkdir(activeDir(), { recursive: true });
        const claimPath = path.join(activeDir(), `${candidate}.json`);
        const handle = await fsAsync.open(claimPath, 'wx'); // O_CREAT|O_EXCL — fails with EEXIST on collision
        await handle.close();
        sessionId = candidate;
        semanticSessionId = candidate;
        source = 'generated-semantic';
      } catch (claimErr) {
        if (claimErr.code === 'EEXIST') {
          // Collision with another parallel hook — fall back to UUID-v4 silently.
          // Hook is informational-only; never write to stderr per existing convention.
          sessionId = randomUUID();
          source = 'generated-uuid-fallback-collision';
          // We still surface the semantic candidate as semanticSessionId so the
          // lock reflects what this session would have been called — useful for
          // forensics even when the UUID won the registry-slot race.
          semanticSessionId = candidate;
        } else {
          throw claimErr; // surfaces to outer catch → UUID fallback
        }
      }
    } catch {
      // Semantic id generation failed for any reason — silently fall back to UUID-v4.
      // Hook is informational-only; never write to stderr per existing convention.
      sessionId = randomUUID();
      source = 'generated-uuid-fallback';
    }
  }

  try {
    const dir = path.join(projectRoot, '.orchestrator');
    await mkdir(dir, { recursive: true });
    // Epic #583 W5-F1c — surface semantic_session_id (Q5 H1 / Issue #587 completion).
    // current-session.json now carries BOTH the UUID session_id (Claude Code default)
    // AND the semantic_session_id derived from branch+date+mode+history.
    const payload = {
      session_id: sessionId,
      semantic_session_id: semanticSessionId,
      pid: process.pid,
      source,
      timestamp: new Date().toISOString(),
    };
    await writeFile(
      path.join(dir, 'current-session.json'),
      JSON.stringify(payload, null, 2) + '\n',
      'utf8',
    );
  } catch { /* best effort */ }

  return { sessionId, semanticSessionId, mode: normalizedMode };
}

/**
 * Shared helper: derive a semantic session-id candidate for the current
 * (branch, date, mode) tuple by consulting resolveSemanticSessionId() with
 * a merged active-sessions view (worktree-local + host-wide registry).
 *
 * Returns the candidate string on success, null on any failure. Never throws.
 *
 * Used by both branches of resolveSessionId() so the semantic_session_id
 * field on the session.lock is consistently populated regardless of whether
 * the SessionStart stdin payload provided a UUID (Claude Code) or nothing
 * (Codex / Cursor).
 *
 * @param {{ projectRoot: string, mode: string }} opts
 * @returns {Promise<string|null>}
 */
async function deriveSemanticCandidate({ projectRoot, mode }) {
  try {
    const { resolveSemanticSessionId } = await import('../scripts/lib/session-id.mjs');
    const { discoverActiveSessions } = await import('../scripts/lib/session-discovery.mjs');
    const { execSync } = await import('node:child_process');

    // Derive branch from git (cheap, ~5ms). Fall back to 'main' if outside a repo.
    let branch = 'main';
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        timeout: 1000,
      }).trim();
      if (!branch || branch === 'HEAD') branch = 'main';
    } catch { /* keep default 'main' */ }

    // Discover other active sessions for n-incrementing. We merge two sources:
    //   1. worktree-local: discoverActiveSessions(projectRoot) reads each worktree's session.lock
    //   2. host-wide:      readRegistry() reads the per-host multi-session registry
    // The merge is necessary because the host-wide registry is the single source
    // of truth for cross-repo uniqueness — two unrelated repos on the same host
    // would otherwise collide on the same default `<branch>-<date>-<mode>-1` id.
    // Best-effort: both sources may fail; we proceed with whatever we get.
    const { readRegistry } = await import('../scripts/lib/session-registry.mjs');
    const [localSessions, registryEntries] = await Promise.all([
      discoverActiveSessions(projectRoot).catch(() => []),
      readRegistry().catch(() => []),
    ]);
    const registrySessions = registryEntries.map((r) => ({
      sessionId: r.session_id,
      mode: r.mode ?? 'session',
    }));
    const activeSessions = [...localSessions, ...registrySessions];

    return await resolveSemanticSessionId({
      branch,
      mode,
      activeSessions,
      repoRoot: projectRoot,
    });
  } catch {
    return null;
  }
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
  // The ask-via-tool nudge rides the same opt-out flag — both are coordinator
  // reminders shown at session start; users who silence one expect silence.
  let bannerData = null;
  if (await isHostBannerEnabled(projectRoot)) {
    bannerData = await emitHostBanner(projectRoot);
    // Always-on nudge: user decisions must go through AskUserQuestion, not inline
    // markdown lists. The coordinator chat stream is dense and prose questions
    // are reliably missed. Full rationale + exceptions in .claude/rules/ask-via-tool.md.
    try {
      console.log(JSON.stringify({
        systemMessage: '🎯 User decisions → AskUserQuestion tool. Inline choice lists = bug (.claude/rules/ask-via-tool.md).',
      }));
    } catch { /* best effort */ }
  }

  // F1.3 cold-start abandonment fix (PRD 2026-05-21). Emit a one-shot
  // "first session not yet" banner when bootstrap.lock is older than
  // cold-start.nudge-after-hours AND sessions.jsonl has fewer than
  // cold-start.silence-after-sessions entries. Auto-silences after the
  // first session. Master switch: cold-start.enabled (default true).
  //
  // Config keys read with PRD-default fallbacks — I6 wires these into
  // parseSessionConfig(). Until then the detector uses the documented
  // defaults so this code is safe to ship before the config schema lands.
  try {
    const coldStartCfg = await readColdStartConfig(projectRoot);
    if (coldStartCfg.enabled !== false) {
      const decision = await detectColdStart({
        repoRoot: projectRoot,
        nudgeAfterHours: coldStartCfg['nudge-after-hours'] ?? 1,
        silenceAfterSessions: coldStartCfg['silence-after-sessions'] ?? 1,
        enabled: coldStartCfg.enabled !== false,
      });
      if (decision.shouldEmit) {
        try {
          console.log(JSON.stringify({
            systemMessage: decision.bannerLines.join('\n'),
          }));
        } catch { /* best effort — stdout may be closed */ }
        if (decision.markerPath) {
          await consumeMarker(decision.markerPath).catch(() => false);
        }
      }
    }
  } catch { /* silent — cold-start nudge must never block the hook */ }

  // v3.1.0 multi-session registry (#168). All steps best-effort — failures
  // must never break the hook, which is informational-only.
  const input = await stdinPromise;
  const { sessionId, semanticSessionId, mode } = await resolveSessionId(input, projectRoot);
  const platform = process.env.SO_PLATFORM ?? SO_PLATFORM;

  // Epic #583 P3 — mechanical session.lock writer (closes D1+D2+D4 gaps).
  // Bootstrap the session-lock so discoverActiveSessions() picks us up even
  // when the coordinator-LLM skips the prose Phase 1.2 acquire-call. The
  // semantic-id is surfaced even when stdin provided a UUID (D4 fix #587).
  // Wrapped in try/catch as a defence-in-depth: bootstrapLock() is already
  // best-effort, but this outer guard ensures the hook stays non-blocking
  // regardless of any future regression in the helper itself.
  try {
    const { bootstrapLock } = await import('./_lib/lock-bootstrap.mjs');
    await bootstrapLock({
      repoRoot: projectRoot,
      sessionId,
      semanticSessionId,
      mode,
      ttlHours: 4,
    });
  } catch { /* hook must remain non-blocking */ }

  let peers = [];
  try {
    await sweepZombies().catch(() => ({ removed: [], logged: 0 }));
    try {
      await registerSelf({
        sessionId,
        semanticSessionId,         // Epic #583 W5-F1c — registry entry carries semantic id (Q5 H1)
        projectRoot,
        branch,
        platform,
        mode,
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

  // Epic #583 W3-P3 — Mechanical peer-detection banner (independent of the
  // v3.1.0 registry-driven detectPeers() output). discoverActiveSessions()
  // reads every worktree's session.lock and the host registry; this is the
  // canonical source of truth and fires even when the v3.1.0 path returned
  // an empty set (e.g., the peer's registry write failed but its session.lock
  // was successfully bootstrapped by the lock-bootstrap hook). The two
  // banners coexist: the v3.1.0 line above is per-host; this one is per-repo
  // (mechanical, worktree-scoped) and uses the merged lock + registry source.
  //
  // Gated on `bannerData` (i.e., enable-host-banner: true) to respect the
  // documented opt-out semantics — a user who silenced session-start
  // banners has opted out of ALL session-start banners, including this one.
  // The mechanical lock + STATE.md peer-guard remain active regardless;
  // only the operator-visibility banner is silenced.
  // Best-effort: any failure (import, listWorktrees timeout, etc.) is
  // swallowed — the banner is purely informational.
  if (bannerData) {
    try {
      const { discoverActiveSessions } = await import('../scripts/lib/session-discovery.mjs');
      const allActive = await discoverActiveSessions(projectRoot);
      const mechanicalPeers = allActive.filter((s) => s.sessionId !== sessionId);
      if (mechanicalPeers.length > 0) {
        const summary = mechanicalPeers
          .slice(0, 3)
          .map((p) => `${p.sessionId}:${p.mode ?? 'session'}`)
          .join(', ');
        const overflow = mechanicalPeers.length > 3 ? ` +${mechanicalPeers.length - 3} more` : '';
        const mechanicalLine = `🔍 Mechanical peer-detection: ${mechanicalPeers.length} active in same repo (${summary}${overflow})`;
        try {
          console.log(JSON.stringify({ systemMessage: mechanicalLine }));
        } catch { /* best effort */ }
      }
    } catch { /* best effort — banner is informational, never blocks */ }
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

  // Size-based rotation of events.jsonl (#251). Session-start is the single
  // rotation trigger — per-append overhead is rejected design. Any failure
  // is swallowed: rotation must NEVER block the hook.
  try {
    let rotCfg = { enabled: true, 'max-size-mb': 10, 'max-backups': 5 };
    try {
      const md = await readConfigFile(projectRoot);
      const config = parseSessionConfig(md);
      if (config['events-rotation']) rotCfg = config['events-rotation'];
    } catch { /* missing config → defaults */ }

    const result = maybeRotate({
      logPath: eventsFilePath(),
      maxSizeMb: rotCfg['max-size-mb'] ?? 10,
      maxBackups: rotCfg['max-backups'] ?? 5,
      enabled: rotCfg.enabled !== false,
    });
    if (result.rotated) {
      console.error(`events-rotation: archived ${result.archivedAs} (${result.sizeBefore} bytes)`);
    }
  } catch (err) {
    console.error(`events-rotation: skipped (${err?.message ?? err})`);
  }
}

// Top-level guard — always exit 0 (non-blocking informational hook).
main().catch(() => {}).finally(() => {
  process.exit(0);
});
