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
import { writeSync } from 'node:fs';
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
  repoPathHash,
} from '../scripts/lib/session-registry.mjs';
import { detectColdStart, consumeMarker } from '../scripts/lib/cold-start-detector.mjs';
import { parseSessionId } from '../scripts/lib/session-id.mjs';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Banner buffer (#1089 / #1052 A3a)
// ---------------------------------------------------------------------------
//
// MEASURED 2026-08-21: this hook emitted FIVE independent
// `console.log(JSON.stringify({ systemMessage }))` calls, and Claude Code
// surfaces only the FIRST JSON object a SessionStart hook writes to stdout.
// A live run against a copied 5-peer registry produced four stdout lines of
// which the operator saw exactly one — the host/resource line. The three that
// were silently discarded included:
//
//   ⚠️ 👥 Peers: 5 active (… session-orchestrator:main:wave-0 …)
//   🔍 Mechanical peer-detection: 1 active in same repo (…)
//
// i.e. the two lines whose entire job is to warn that ANOTHER SESSION HOLDS
// THIS WORKING COPY. The information was computed correctly, formatted
// correctly, and thrown away by the transport — the "built but not wired"
// class, with the wiring defect one layer below where anyone was looking.
//
// The fix is structural: every banner line goes into one buffer and leaves as
// ONE systemMessage. Adding a sixth banner in future therefore cannot
// re-introduce the bug.
const bannerLines = [];

/**
 * Queue one or more banner lines for the single end-of-hook flush.
 * @param {string|null|undefined} line — multi-line strings are pushed verbatim
 */
function pushBanner(line) {
  if (typeof line !== 'string' || line.length === 0) return;
  bannerLines.push(line);
}

/**
 * Emit every queued banner line as ONE systemMessage envelope.
 *
 * Uses `fs.writeSync(1, …)` rather than `console.log`: the top-level guard
 * calls `process.exit(0)`, which discards anything still sitting in libuv's
 * async write queue when stdout is a pipe (see
 * `.claude/rules/anti-pattern-console-log-process-exit-drops-stdout…`). The
 * banner is far below the 64 KiB pipe buffer today, but a synchronous write
 * costs nothing and removes the failure mode rather than staying under it.
 *
 * Idempotent: a second call after a flush is a no-op.
 */
function flushBanner() {
  if (bannerLines.length === 0) return;
  const payload = JSON.stringify({ systemMessage: bannerLines.join('\n') });
  bannerLines.length = 0;
  try {
    writeSync(1, `${payload}\n`);
  } catch { /* stdout closed — the hook is informational and never blocks */ }
}

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
export async function readColdStartConfig(projectRoot) {
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
  const parsedStdinId = parseSessionId(fromStdin);
  const rawStdinSessionId = parsedStdinId?.format === 'uuid' ? fromStdin : null;

  // Mode normalization is shared by both branches so semantic attribution is
  // derived independently of the raw session identity. A semantic id is always
  // descriptive metadata, never the physical lock/registry session_id.
  const rawMode = (input && (input.mode || input.session_type)) || 'session';
  const normalizedMode =
    String(rawMode).toLowerCase().replace(/[^a-z-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'session';

  let sessionId;
  let source;
  // The lock and downstream consumers surface this independently-derived
  // semantic attribution alongside the physical raw session id.
  let semanticSessionId = null;

  if (rawStdinSessionId !== null) {
    sessionId = rawStdinSessionId;
    source = 'stdin';
  } else {
    // A missing, malformed, or semantic stdin value is not a trustworthy raw
    // identity. Generate the physical id locally; semantic derivation below is
    // attribution only and must never become the lock/registry key.
    sessionId = randomUUID();
    source = 'generated-uuid';
  }

  // Derive a descriptive semantic label for either raw-id source. Best-effort:
  // a failure leaves it null without changing the physical raw session_id.
  try {
    const semCandidate = await deriveSemanticCandidate({
      projectRoot,
      mode: normalizedMode,
    });
    if (semCandidate) semanticSessionId = semCandidate;
  } catch { /* best effort — leave semanticSessionId = null */ }

  try {
    const dir = path.join(projectRoot, '.orchestrator');
    await mkdir(dir, { recursive: true });
    const sessionFilePath = path.join(dir, 'current-session.json');

    // High-water-mark preservation (#612 root-cause fix).
    // SessionStart fires on startup|clear|compact|resume of the SAME logical
    // session. On clear/compact/resume the UUID `session_id` changes but the
    // `semantic_session_id` (branch+date+mode+n) stays stable. A naive full
    // overwrite of current-session.json drops the `last_wave` / `last_batch`
    // markers written mid-session by post-tool-batch-wave-signal.mjs, which
    // makes the next PostToolBatch re-read last_wave as absent→0 and re-emit a
    // duplicate orchestrator.wave.started{N} with no intervening
    // wave.completed. To prevent that, PRESERVE last_wave/last_batch across a
    // SessionStart of the SAME logical session (matching semantic id), while
    // still RESETTING them for a genuinely new session (different/absent
    // semantic id, or an unparseable prior file). Best-effort: a read failure
    // must never throw — we simply fall through to the reset path.
    const preserved = {};
    if (typeof semanticSessionId === 'string' && semanticSessionId.length > 0) {
      try {
        const prevRaw = await readFile(sessionFilePath, 'utf8');
        const prev = JSON.parse(prevRaw);
        if (prev && prev.semantic_session_id === semanticSessionId) {
          if (Object.prototype.hasOwnProperty.call(prev, 'last_wave')) {
            preserved.last_wave = prev.last_wave;
          }
          if (Object.prototype.hasOwnProperty.call(prev, 'last_batch')) {
            preserved.last_batch = prev.last_batch;
          }
        }
      } catch { /* absent / unparseable → no preservation (reset) */ }
    }

    // Epic #583 W5-F1c — surface semantic_session_id (Q5 H1 / Issue #587 completion).
    // current-session.json now carries BOTH the UUID session_id (Claude Code default)
    // AND the semantic_session_id derived from branch+date+mode+history.
    const payload = {
      session_id: sessionId,
      semantic_session_id: semanticSessionId,
      pid: process.pid,
      source,
      timestamp: new Date().toISOString(),
      // Spread AFTER the base fields so the preserved high-water marks survive
      // (and never clobber the identity fields above).
      ...preserved,
    };
    await writeFile(
      sessionFilePath,
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

    // #1089: report the memory number a human can ACT on.
    //
    // The old line printed `ram_free_gb`, which on Darwin is `os.freemem()` =
    // `Pages free` only. Median across 1477 measured session starts: 0.4 GB —
    // on hosts with 24-128 GB installed. So this banner spent four months
    // telling the operator the machine was seconds from death while the same
    // machine reported 40%+ memory free and ran full waves clean. Six repos
    // logged that false alarm as a learning; one capped agents for five
    // consecutive sessions off this number.
    //
    // Precedence mirrors evaluate()'s memorySignal(): pressure > available >
    // free. `free` survives only as the last resort — on Linux/Windows it is
    // genuinely accurate, which is exactly where nothing better is published.
    const memLine = (() => {
      if (resources.memory_pressure_pct_free !== null && resources.memory_pressure_pct_free !== undefined) {
        return `${resources.memory_pressure_pct_free}% memory free (OS pressure)`;
      }
      if (resources.ram_available_gb !== null && resources.ram_available_gb !== undefined) {
        return `${resources.ram_available_gb.toFixed(1)} GB available`;
      }
      return `${resources.ram_free_gb.toFixed(1)} GB free`;
    })();

    // Peer SESSIONS, not Claude PROCESSES. Measured ratio 6.0:1 — the old
    // suffix read "17 Claude processes running" on a host carrying 3 sessions,
    // which is alarming and means nothing actionable.
    const peerSuffix = resources.peer_sessions_count === null || resources.peer_sessions_count === undefined
      ? ''
      : ` · ${resources.peer_sessions_count} peer session${resources.peer_sessions_count === 1 ? '' : 's'}`;
    const resourceLine = `📊 Resources: ${memLine} · CPU ${resources.cpu_load_pct}%${peerSuffix}`;

    // systemMessage envelope is the Claude Code hook contract; buffered so all
    // banner lines leave as ONE object (see flushBanner — Claude Code reads
    // only the first).
    pushBanner(hostLine);
    pushBanner(resourceLine);

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
    // Always-on nudge: a user decision has three legitimate forms and AUQ-001
    // routes between them in order — operator verb first (nothing is blocked
    // while the operator picks his moment), then derive-and-report from Session
    // Config / STATE.md / git, and only then the tool. The banner carries the
    // ORDER, not an absolute; full routing + exceptions in
    // .claude/rules/ask-via-tool.md.
    pushBanner('🎯 Decide: operator verb (/go) > derive+report > AUQ if blocking (.claude/rules/ask-via-tool.md).');
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
        pushBanner(decision.bannerLines.join('\n'));
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

  // Epic #724 C7 — own-repo orphaned-lock reaper (reconciliation net). If a
  // dead-lease session.lock survived a crash-before-SessionEnd (the case that
  // blocked this repo's start this morning until a manual force-takeover),
  // archive-move it so it stops blocking. SINGLE-REPO only: no host-wide scan
  // here (that stays CLI-only, scripts/lock-reaper.mjs) to keep hook latency
  // small. Our own freshly-bootstrapped lock (written just above) is protected
  // by the reaper's live-lock guard (fresh heartbeat) AND the currentSessionId
  // guard, so this can never touch it. Best-effort: any failure is swallowed —
  // the hook is informational-only and must never block.
  try {
    const { reapRepoLock } = await import('../scripts/lib/lock-reaper.mjs');
    await reapRepoLock({
      repoRoot: projectRoot,
      currentSessionId: sessionId,
      dryRun: false,
      reapMode: 'auto-own-repo',
    });
  } catch { /* hook must remain non-blocking */ }

  // Epic #926 — close-through backfill at SessionStart (decoupled from /close).
  // hooks/on-session-end.mjs already backfills, but SessionEnd only fires on a
  // REGULAR close: a session killed by Ctrl-C, a timeout or a crash leaves no
  // ledger entry, and the backfill then waits for the NEXT clean close. Running
  // it here reconstructs the PREVIOUS abandoned session whatever killed it.
  //
  // ORDERING IS LOAD-BEARING — this MUST stay before the
  // `orchestrator.session.started` emit at the end of main(). That ordering is
  // this session's structural self-exclusion: our own started-event is not in
  // events.jsonl yet, so we are not a backfill candidate at all. (On a
  // clear/compact/resume re-fire an earlier started-event IS present; that case
  // is caught by the core's own `skipped-own-live-lock` guard against the lock
  // bootstrapped above.) A live FOREIGN session is likewise protected: the core
  // evaluates lock ownership against the CANDIDATE, so a candidate holding a
  // live lock is skipped before the dead-by-age relaxation is consulted.
  //
  // Best-effort like every other probe here: any failure is swallowed so a
  // backfill problem can never block a session start.
  try {
    const { backfillOnSessionStart } = await import('../scripts/backfill-abandoned-sessions.mjs');
    await backfillOnSessionStart({ repoRoot: projectRoot });
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
    // #1052 A3a — split peers by the axis that actually decides behaviour.
    //
    // `.claude/rules/parallel-sessions.md` defines the operator-session axis by
    // the WORKING COPY, not by reachability: a peer in this checkout contends
    // for one git index, one filesystem, one STATE.md, and can hold the
    // wave-scope guard. A peer in another repo contends only for host capacity.
    // Those are different problems and the old single-line summary blurred them
    // into one comma-separated list sorted by nothing.
    //
    // Correlate on `repo_path_hash` rather than `repo_name`: a sibling worktree
    // of this repo carries a DIFFERENT working copy (and a different hash) while
    // often sharing a similar name, and it is the checkout — not the name — that
    // can collide. Falls back to name comparison only if the hash is missing.
    let selfRepoHash = null;
    try { selfRepoHash = repoPathHash(projectRoot); } catch { /* best effort */ }
    const sameCopy = peers.filter((p) =>
      selfRepoHash && p.repo_path_hash ? p.repo_path_hash === selfRepoHash : false);
    const elsewhere = peers.filter((p) => !sameCopy.includes(p));

    const threshold = await peerWarnThreshold(projectRoot);
    // WARN on any peer in THIS working copy — one is already enough to collide
    // — or on host-wide count crossing the configured threshold.
    const icon = sameCopy.length > 0 || peers.length >= threshold ? '⚠️ ' : '';

    // Semantic ids are NOT unique — several live sessions routinely share e.g.
    // `main-2026-08-21-session-2`, which makes a bare semantic label unusable
    // for addressing a specific peer. Append a short uuid discriminator so two
    // rows can be told apart (and so the id can be pasted into a lookup).
    const fmt = (p) => {
      const label = p.semantic_session_id ?? p.session_id ?? 'unknown';
      const disc = p.session_id ? `#${String(p.session_id).slice(0, 8)}` : '';
      return `${label}${disc}:${p.branch ?? 'unknown'}:wave-${p.current_wave ?? 0}`;
    };
    pushBanner(`${icon}👥 Peers: ${peers.length} live on this host`);
    if (sameCopy.length > 0) {
      const list = sameCopy.slice(0, 3).map(fmt).join(', ');
      const more = sameCopy.length > 3 ? ` +${sameCopy.length - 3} more` : '';
      // This is the line that matters. A peer here means PSA-002 territory:
      // it may hold .claude/wave-scope.json, carry uncommitted work in files
      // you are about to edit, or switch the branch under you.
      pushBanner(`   ⚠️  ${sameCopy.length} in THIS working copy — coordinate before editing (${list}${more})`);
    }
    if (elsewhere.length > 0) {
      const list = elsewhere
        .slice(0, 4)
        .map((p) => `${p.repo_name ?? 'unknown'}:${p.branch ?? 'unknown'}`)
        .join(', ');
      const more = elsewhere.length > 4 ? ` +${elsewhere.length - 4} more` : '';
      pushBanner(`   other repos (host capacity only): ${list}${more}`);
    }
    // #1052 A3a acceptance criterion: state the limit, never imply a status we
    // cannot read. `ListAgents` is a MODEL-side tool; this hook is a Node
    // process and structurally cannot call it, so busy/waiting/idle is
    // unavailable here. The coordinator half (A3b) overlays it later.
    pushBanner('   (registry view: repo/branch/wave. Liveness (busy/idle) is model-side — not available in this hook.)');
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
        pushBanner(`🔍 Mechanical peer-detection: ${mechanicalPeers.length} active in same repo (${summary}${overflow})`);
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
    // #1089 — record the signals the verdict is actually computed from, so the
    // firing rate of each rule class is measurable AFTER the fact.
    //
    // This is the defect that let the old rule set fire on 99.0% of starts for
    // four months undetected: `resource_verdict` was written to sessions.jsonl
    // for exactly 15 of 1734 sessions, all inside one week in April 2026, and
    // the fields logged here were the two MISLEADING ones (`ram_free_gb`,
    // `claude_processes_count`) — so even the surviving telemetry could not
    // have falsified the thresholds. The three added below are the ones the
    // rules now judge on. `.claude/rules/host-resources.md` HR-005 turns them
    // into a standing 10%-firing-rate audit.
    payload.ram_available_gb = bannerData.resources.ram_available_gb ?? null;
    payload.memory_pressure_pct_free = bannerData.resources.memory_pressure_pct_free ?? null;
    payload.peer_sessions_count = bannerData.resources.peer_sessions_count ?? null;
  }
  await emitEvent('orchestrator.session.started', payload);

  // Single flush — see the bannerLines docstring for why this must stay the
  // only stdout write in the hook.
  flushBanner();

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
// flushBanner() runs here too so a throw partway through main() still surfaces
// whatever was already collected; it is idempotent, so the normal path (which
// flushes at the end of main) does not double-emit.
main().catch(() => {}).finally(() => {
  flushBanner();
  process.exit(0);
});
