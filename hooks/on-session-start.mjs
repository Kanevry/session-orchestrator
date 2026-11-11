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
 * hooks.json wiring (SessionStart, async: true, timeout: 10s) is managed separately.
 * stdin: optional JSON payload from Claude Code containing session_id.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, writeSync } from 'node:fs';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { ensureOrchestratorIgnore } from './_lib/orchestrator-ignore.mjs';
import { resolveSessionStartRoot } from './_lib/hook-root.mjs';

import { emitEvent, eventsFilePath } from '../scripts/lib/events.mjs';
import { readNavigatorLease, fleetIntegrationEnabled } from '../scripts/lib/fleet-protocol.mjs';
import { maybeRotate } from '../scripts/lib/events-rotation.mjs';
import { readConfigFile, parseSessionConfig } from '../scripts/lib/config.mjs';
import { getPlatform, resolveProjectDir, resolveSessionRoot } from '../scripts/lib/platform.mjs';
import {
  registerSelf,
  detectPeers,
  countRecentStarts,
  sweepZombies,
  logSweepEvent,
  repoPathHash,
} from '../scripts/lib/session-registry.mjs';
import { detectColdStart, consumeMarker } from '../scripts/lib/cold-start-detector.mjs';
import { parseSessionId } from '../scripts/lib/session-id.mjs';
import { readTelemetryState, resolveConsent, isCiEnv } from '../scripts/lib/telemetry/consent.mjs';
import { loadOwnerConfig } from '../scripts/lib/owner-yaml.mjs';
import { isMainModule } from '../scripts/lib/is-main-module.mjs';
// SSOT for the "is this a re-entry into the same logical session?" question
// (#1091). Defined in the lock-bootstrap leaf module, which this hook already
// loads, so the preservation branch below and the lock force-refresh gate can
// never drift apart. readClaudePid() is the process witness current-session.json
// carries next to the raw id (#1746).
import { SAME_LOGICAL_SESSION_SOURCES, readClaudePid } from './_lib/lock-bootstrap.mjs';
import { execFile, execFileSync } from '../scripts/lib/native-command.mjs';

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
 * Coordinator-directed context for the single end-of-hook flush (#1138).
 *
 * The banner above is for the OPERATOR (`systemMessage`); this is for the
 * MODEL (`hookSpecificOutput.additionalContext`). Both leave in the SAME JSON
 * object for the same reason the banner was consolidated: Claude Code surfaces
 * only the FIRST JSON object a SessionStart hook writes to stdout, so a second
 * `writeSync` would be silently discarded.
 *
 * @type {string|null}
 */
let pendingAdditionalContext = null;

/** Byte budget of the navigator line (#1462, PRD 4.5 row "Bannerzeile B6"). */
const NAVIGATOR_BANNER_MAX_BYTES = 120;

/**
 * Render the one-line navigator status (#1462, fleet protocol v1). The verdict
 * comes from `readNavigatorLease()`: only a VALID lease is "aktiv"; a missing or
 * expired one is "nicht nachweisbar" (ADR-004: absence is no proof of a free
 * seat), an unreadable one says so instead of guessing. A long id is cut from
 * the label — never from the fixed text — so the whole line stays ≤ 120 bytes.
 * Same wording on every harness (Codex runs this hook too).
 */
export function navigatorBannerLine(verdict) {
  if (verdict?.state === 'active') {
    const lease = verdict.lease ?? {};
    const prefix = '🧭 Navigator aktiv: ';
    const suffix = ', Check-in nach ~/.config/navigator/checkin/';
    const room = NAVIGATOR_BANNER_MAX_BYTES - Buffer.byteLength(prefix + suffix, 'utf8');
    // Defence in depth: the lease reader already refuses control bytes in these
    // two fields; a newline / ANSI / bidi byte must still never reach systemMessage.
    let shown = String(lease.adresse ?? lease.session_id ?? 'unknown')
      .replace(/[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, '?');
    if (Buffer.byteLength(shown, 'utf8') > room) {
      const chars = [...shown];
      while (chars.length > 0 && Buffer.byteLength(`${chars.join('')}…`, 'utf8') > room) chars.pop();
      shown = `${chars.join('')}…`;
    }
    return `${prefix}${shown}${suffix}`;
  }
  if (verdict?.state === 'unreadable') return '🧭 Navigator: Lease unlesbar, Status nicht nachweisbar';
  return '🧭 Navigator: keiner nachweisbar (keine gültige Lease)';
}

/**
 * Queue one or more banner lines for the single end-of-hook flush.
 * @param {string|null|undefined} line — multi-line strings are pushed verbatim
 */
function pushBanner(line) {
  if (typeof line !== 'string' || line.length === 0) return;
  bannerLines.push(line);
}

/**
 * Render a session id compactly for a banner line.
 *
 * Semantic ids (`main-2026-08-23-deep-1`) are already short and are printed
 * verbatim — they carry the branch and the mode, which is exactly what an
 * operator needs to recognise a peer. A UUID (Claude Code's `session_id` on
 * hosts where no semantic id was resolved) is truncated to its first 8 chars:
 * long enough to disambiguate the handful of peers a repo can have, short
 * enough that three of them fit on one banner line.
 *
 * Ceiling: 8 chars is ~4 billion values against at most a few dozen live
 * sessions per host — revisit only if two peers ever collide in a banner.
 *
 * @param {string} id
 * @returns {string}
 */
function shortSessionId(id) {
  if (typeof id !== 'string' || id.length === 0) return '?';
  return id.length > 24 ? id.slice(0, 8) : id;
}

/**
 * #1850 — liveness of a registry-only peer, from the registry's own heartbeat.
 * Reuses `registryEntryLiveness()` (same threshold as discovery's freshness
 * filter), so the banner can never call a peer "finished" while the registry
 * says it is alive. `entry` is the registry record for the peer's session id,
 * or undefined when it was not readable (→ `unknown`).
 *
 * @param {object|undefined} entry
 * @param {Function} livenessFn  `registryEntryLiveness` from session-registry.
 * @returns {{state:'live'|'stale'|'unknown', ageMin:number|null}}
 */
function registryPeerLiveness(entry, livenessFn) {
  if (!entry || typeof livenessFn !== 'function') return { state: 'unknown', ageMin: null };
  return livenessFn(entry);
}

/**
 * GH#67 — render the provenance marker for ONE mechanically-detected peer.
 *
 * `discoverActiveSessions()` annotates registry-sourced peers additively
 * (`registryOnly` / `lockSuperseded` / `lockOwnerId`); lock-sourced peers carry
 * none of the three, so they render byte-identically to the pre-GH#67 banner.
 *
 * `lockSuperseded: true` means a LIVE lock at THIS root is held by a different
 * raw session_id than the registry entry — the common cause is a finished task
 * whose SessionEnd never ran, leaving a fresh-but-orphaned registry record.
 * It is a HINT, never a verdict: the session lock is advisory, so the entry may
 * equally be a live peer that lost the acquire race (#1085). The marker is
 * therefore purely additive — it never removes the peer, and never changes the
 * count or the WARN decision (HR-106).
 *
 * @param {{registryOnly?:boolean, lockSuperseded?:boolean, lockOwnerId?:string|null}} peer
 * @returns {string} '' for a lock-sourced peer, else a bracketed marker.
 */
function supersessionMarker(peer, liveness = { state: 'unknown', ageMin: null }) {
  if (!peer || peer.registryOnly !== true) return '';
  if (peer.lockSuperseded !== true) return ' [registry-only]';
  // #1850 — "superseded" alone read as "finished" and an operator acted on it
  // while the peer was alive. The heartbeat decides the wording; the lock hint
  // only names who holds the lock.
  if (liveness.state === 'live') {
    const owner = shortSessionId(peer.lockOwnerId ?? '');
    return ` [registry-only, lock held by ${owner}; peer heartbeat ${Math.floor(liveness.ageMin)} min ago — LIVE, coordinate before editing]`;
  }
  if (liveness.state === 'stale') return ' [registry-only, superseded]';
  return ' [registry-only, superseded; liveness not measurable]';
}

/**
 * Queue text for the ONE `additionalContext` string of the single end-of-hook
 * flush. Two writers exist (the consent nudge, the #1635 lead notice) and both
 * are needed by the model, so a second text is appended on its own line; an
 * identical text is not repeated. Every character costs context on every
 * session start, so writers stay terse and conditional.
 * @param {string|null|undefined} text
 */
function setAdditionalContext(text) {
  if (typeof text !== 'string' || text.length === 0) return;
  if (typeof pendingAdditionalContext !== 'string' || pendingAdditionalContext.length === 0) {
    pendingAdditionalContext = text;
  } else if (!pendingAdditionalContext.split('\n').includes(text)) {
    pendingAdditionalContext = `${pendingAdditionalContext}\n${text}`;
  }
}

/**
 * Emit the queued banner lines AND any queued additionalContext as ONE JSON
 * envelope.
 *
 * Both keys are valid siblings of one hook-output object: the shipped Claude
 * Code binary (v2.1.241) documents `systemMessage` ("Display a message to the
 * user (all hooks)") and `hookSpecificOutput.additionalContext` ("Text injected
 * into model context") as fields of the same "Hook JSON Output" object, and its
 * output validator recognises both keys on that one object.
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
  const hasBanner = bannerLines.length > 0;
  const hasContext = typeof pendingAdditionalContext === 'string' && pendingAdditionalContext.length > 0;
  if (!hasBanner && !hasContext) return;

  const envelope = {};
  if (hasBanner) envelope.systemMessage = bannerLines.join('\n');
  if (hasContext) {
    envelope.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext: pendingAdditionalContext,
    };
  }
  bannerLines.length = 0;
  pendingAdditionalContext = null;
  try {
    writeSync(1, `${JSON.stringify(envelope)}\n`);
  } catch { /* stdout closed — the hook is informational and never blocks */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in cwd; return trimmed stdout. Returns null on failure
 * (including a timeout, when `timeoutMs` is given).
 *
 * #1934 — null alone cannot tell a timeout from "no repository" or "git
 * missing" (all three yield `branch: 'unknown'`), so a timeout additionally
 * calls `onTimeout`. `err.killed === true` is what execFile sets when it
 * killed the child for exceeding `timeout` (measured git 2.56.0: SIGTERM after
 * the bound); an exit code or ENOENT leaves it false.
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeoutMs] — kill the git child after this many ms (0 = no limit)
 * @param {(() => void)|null} [onTimeout] — called once when the child was killed by the timeout
 * @returns {Promise<string|null>}
 */
async function gitOutput(args, cwd, timeoutMs = 0, onTimeout = null) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: timeoutMs });
    return stdout.trim();
  } catch (err) {
    if (err?.killed === true) onTimeout?.();
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
 * Start-wave rule (#1650): WARN when at least START_WAVE_MIN foreign registry
 * entries started within the last START_WAVE_WINDOW_MIN minutes.
 *
 * Why not `peer_count >= concurrent-sessions-warn` (the previous WARN trigger):
 * that is a permanent state, not an event. Measured 2026-10-17 08:08Z/08:09Z
 * over `orchestrator.session.started` since 2026-08-24, dedup session_id +
 * timestamp, per `host_class`: peer_count >= 5 fired on 880/1305 = 67.4% (M4)
 * and 255/991 = 25.7% (M5) of starts — a broken instrument per HR-101.
 * This rule, reconstructed from the start timestamps themselves, fires on
 * 35/1305 = 2.7% (M4) and 52/991 = 5.2% (M5). Neighbouring candidates:
 * >=3 in 2 min 4.0% / 7.1%, >=5 in 2 min 1.7% / 3.3%, >=3 in 5 min 6.3% / 10.7%.
 * 5 min was chosen over 2 min so a wave spread over a few minutes still shows.
 *
 * Ceiling (BV-004): fixed constants, no config key; the reconstruction is an
 * upper bound (sessions that ended inside the window leave the registry).
 * Revisit when either host's firing rate on `recent_starts_count >= 5` in the
 * event ledger exceeds 10%, or a start wave that hurt was not flagged.
 * Report only — this single soft signal caps nothing (HR-104).
 */
const START_WAVE_WINDOW_MIN = 5;
const START_WAVE_MIN = 5;

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
 *
 * @param {object|null} input — the parsed SessionStart payload.
 * @param {string} projectRoot
 * @param {number|null} [claudePid=null] — readClaudePid(); recorded with the
 *   host as the writer's process witness (#1746).
 */
async function resolveSessionId(input, projectRoot, claudePid = null) {
  const nativeSource = typeof input?.source === 'string' && input.source.length > 0
    ? input.source
    : null;
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

  const sessionFilePath = path.join(projectRoot, '.orchestrator', 'current-session.json');

  // Read the PREVIOUS current-session.json BEFORE minting a semantic id: on a
  // same-logical-session re-entry it decides whether a new id is minted at all
  // (#1091 F1 below). Best-effort — absent/unparseable leaves prev = null.
  let prev = null;
  try {
    prev = JSON.parse(await readFile(sessionFilePath, 'utf8'));
    if (typeof prev !== 'object' || prev === null) prev = null;
  } catch { /* absent / unparseable → no linkage, no preservation */ }

  // #1091 F1 — raw-id linkage on a same-logical-session re-entry.
  //
  // resolveSemanticSessionId() has NO self-exclusion: it projects every active
  // session (including OUR OWN lock and registry entry) to n and returns
  // maxN + 1. So a second SessionStart of the SAME session mints
  // `…-session-31` where the first minted `…-session-30`, the
  // `prev.semantic_session_id === semanticSessionId` preservation branch below
  // is FALSE, and last_wave / last_batch / last_wave_completed /
  // wave_start_sha are dropped — re-opening #612, #980 and #1193. Before
  // #1091 that path was unreachable on Claude Code because `resume` was absent
  // from the SessionStart matcher; adding it made it live.
  //
  // The trustworthy linkage is the RAW id: Claude Code preserves `session_id`
  // across a native resume, and current-session.json records the raw id the
  // previous invocation of this hook resolved. When it matches, this is
  // provably the same logical session and its semantic label is REUSED rather
  // than re-minted. When it does NOT match, today's behaviour stands (fresh
  // id, no preservation) — that is the "unverified restart" #1091 defines, and
  // guessing continuity there would adopt a foreign session's high-water marks
  // (`.claude/rules/identity-and-locks.md` — a working-copy artefact is not an
  // identity witness).
  //
  // Sources: `clear` and `compact` are re-entries into the same logical
  // session for exactly the reason the comment block below states (the UUID
  // changes, the semantic label does not); `resume` is the third per #1091.
  // `startup` is deliberately absent — a fresh process start must never
  // inherit a predecessor's markers.
  let resumeLinkage = 'none';
  if (
    nativeSource !== null
    && SAME_LOGICAL_SESSION_SOURCES.has(nativeSource)
    && prev
    && prev.session_id === sessionId
    && typeof prev.semantic_session_id === 'string'
    && prev.semantic_session_id.length > 0
  ) {
    semanticSessionId = prev.semantic_session_id;
    resumeLinkage = 'raw-id';
  }

  // Derive a descriptive semantic label for either raw-id source. Best-effort:
  // a failure leaves it null without changing the physical raw session_id.
  if (semanticSessionId === null) {
    try {
      const semCandidate = await deriveSemanticCandidate({
        projectRoot,
        mode: normalizedMode,
      });
      if (semCandidate) semanticSessionId = semCandidate;
    } catch { /* best effort — leave semanticSessionId = null */ }
  }

  try {
    await mkdir(path.dirname(sessionFilePath), { recursive: true });

    // High-water-mark preservation (#612 root-cause fix).
    // SessionStart fires once per source in the matcher of the platform's
    // hooks file — `startup|resume|clear|compact` on Claude Code and Codex
    // (`resume` was ABSENT from hooks.json until #1091, so on Claude Code this
    // hook never ran on a native resume), `startup|reload|new|resume|fork` on
    // pi, and every source on Cursor (empty matcher). Several of those sources
    // are re-entries into the SAME logical session. The `semantic_session_id`
    // (branch+date+mode+n) is meant to stay stable across them. The raw UUID
    // `session_id` does not behave alike per source: on Claude Code `compact`
    // KEEPS it (12/12 compact events in events.jsonl carry
    // `resume_linkage: raw-id`, measured 2026-10-14), while `clear` showed
    // 6/6 `resume_linkage: none`. Whether Claude Code PRESERVES the raw
    // `session_id` across a native resume is what #1091 measures via
    // `native_source` + `resume_linkage` on `orchestrator.session.started` —
    // nothing here ASSUMES either answer, it only reacts to the raw id it can
    // observe. A naive full overwrite of current-session.json drops the
    // `last_wave` / `last_batch` markers written mid-session by
    // post-tool-batch-wave-signal.mjs, which makes the next PostToolBatch
    // re-read last_wave as absent→0 and RE-OPEN wave N mid-wave, re-stamping
    // wave_start_sha and so moving the #980 files_changed start point. (Until
    // 2026-09-19 it also re-emitted a duplicate wave.started{N}; that event
    // has since been removed.)
    //
    // Three cases, exactly one of which preserves nothing:
    //   'raw-id'   — same-logical-session source AND the recorded raw
    //                session_id equals ours → the semantic label was reused
    //                above, markers PRESERVED. (#1091 F1)
    //   'semantic' — the freshly minted label equals the recorded one →
    //                markers PRESERVED. The pre-#1091 behaviour, unchanged.
    //   'none'     — a genuinely new session, or an unverified restart
    //                (raw id changed, label re-minted) → markers RESET.
    // Best-effort throughout: `prev` is null on a read/parse failure, which
    // lands in 'none' and therefore on the reset path.
    const preserved = {};
    if (typeof semanticSessionId === 'string' && semanticSessionId.length > 0) {
      // Two ways into the SAME logical session, both preserving:
      //   1. `resumeLinkage === 'raw-id'` — the raw session_id matched on a
      //      resume/clear/compact re-entry, so the label above was REUSED
      //      (#1091 F1). Reachable since `resume` entered the matcher.
      //   2. semantic match — the freshly minted label equals the recorded
      //      one. This is the case the branch already covered (a clear or
      //      compact whose discovery view happened to re-mint the same n),
      //      and it stays untouched.
      // Anything else (different or absent semantic id, unparseable prior
      // file, `startup`) is a genuinely new session and RESETS the markers.
      if (resumeLinkage === 'none' && prev && prev.semantic_session_id === semanticSessionId) {
        resumeLinkage = 'semantic';
      }
      if (prev && (resumeLinkage === 'raw-id' || prev.semantic_session_id === semanticSessionId)) {
        if (Object.prototype.hasOwnProperty.call(prev, 'last_wave')) {
          preserved.last_wave = prev.last_wave;
        }
        if (Object.prototype.hasOwnProperty.call(prev, 'last_batch')) {
          preserved.last_batch = prev.last_batch;
        }
        // #1193 — the final-wave completion marker must survive a
        // clear/compact too: dropping it re-arms a duplicate SessionEnd
        // `orchestrator.wave.completed` for a wave already closed.
        if (Object.prototype.hasOwnProperty.call(prev, 'last_wave_completed')) {
          preserved.last_wave_completed = prev.last_wave_completed;
        }
        // #980 — the OPEN half of the wave-diff pair, written by
        // post-tool-batch-wave-signal.mjs. Dropping it across a /clear leaves
        // the running wave with no start point, so the next
        // `orchestrator.wave.completed` silently omits `files_changed`.
        if (Object.prototype.hasOwnProperty.call(prev, 'wave_start_sha')) {
          preserved.wave_start_sha = prev.wave_start_sha;
        }
      }
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
      // #1746 — `pid` above is this short-lived hook process, no witness of
      // anything after it exits. The Claude Code process survives /clear, so
      // the next run can tell its own predecessor from a peer that started
      // later in this checkout. Absent without a readable CLAUDE_PID.
      ...(typeof claudePid === 'number' ? { claude_pid: claudePid, host: hostname() } : {}),
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

  return {
    sessionId,
    semanticSessionId,
    mode: normalizedMode,
    nativeSource,
    resumeLinkage,
    // The raw session_id the LAST session start in this checkout recorded, or
    // null. Every session start rewrites the file, so it is our own previous
    // run only when no peer started here since (#1746). Surfaced (rather than
    // kept local) because bootstrapLock() needs it as the third conjunct of
    // the #1091 F2 force-refresh — see the call site in main().
    predecessorSessionId: typeof prev?.session_id === 'string' && prev.session_id.length > 0
      ? prev.session_id
      : null,
    // #1746 — the process witness that writer recorded, unvalidated: the
    // consumer compares it with isSameClaudeProcess(), which admits only an
    // exact pid match on this host.
    predecessorProcess: prev ? { claude_pid: prev.claude_pid, host: prev.host } : null,
  };
}

/**
 * Shared helper: derive a semantic session-id candidate for the current
 * (branch, date, mode) tuple by consulting resolveSemanticSessionId() with
 * a merged active-sessions view (worktree-local + host-wide registry).
 *
 * Returns the candidate string on success, null on any failure. Never throws.
 *
 * Contract (#1066, "Minimal"): the semantic id is a best-effort, host-wide
 * monotonic LABEL, never an ownership key — ownership stays `(raw session_id,
 * owner proof)`, and the two identity forms are never interchangeable.
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
    const { resolveSemanticSessionId, parseSessionId } = await import('../scripts/lib/session-id.mjs');
    const { discoverActiveSessions } = await import('../scripts/lib/session-discovery.mjs');

    // Derive branch from git (cheap, ~5ms). Fall back to 'main' if outside a repo.
    let branch = 'main';
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
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
    // Worktree-local discovery stays best-effort. The registry read is strict
    // (#1946): an unlistable registry (EACCES, ENOTDIR, EMFILE) would drop every
    // cross-repo candidate and could mint a label another live session already
    // holds. On that failure the label stays null (the documented best-effort
    // state the caller already handles) rather than risking a collision; a
    // never-created registry (ENOENT) is a measured empty set.
    const { readRegistryStrict } = await import('../scripts/lib/session-registry.mjs');
    const [localSessions, registryEntries] = await Promise.all([
      discoverActiveSessions(projectRoot).catch(() => []),
      readRegistryStrict().catch(() => null),
    ]);
    if (registryEntries === null) return null;

    // Registry census (#1066 AC1): the registry keeps the two identity forms in
    // SEPARATE fields — `session_id` is the RAW id (a UUID on Claude Code) and
    // `semantic_session_id` is the label. resolveSemanticSessionId counts only
    // semantic candidates, so projecting `session_id` alone made the host-wide
    // registry contribute NOTHING to the n-increment, and two sessions on one
    // host could mint the same label. Preference order per entry:
    //   1. `semantic_session_id`, when it parses as semantic;
    //   2. `session_id`, ONLY when it itself parses as semantic (Codex/Cursor
    //      may write a semantic raw id).
    // A legacy v1 entry (no `semantic_session_id`, UUID `session_id`) matches
    // neither and is dropped — a UUID is never reintroduced as a candidate.
    const semanticLabelOf = (entry) => {
      for (const candidate of [entry?.semantic_session_id, entry?.session_id]) {
        if (parseSessionId(candidate)?.format === 'semantic') return candidate;
      }
      return null;
    };
    const registrySessions = registryEntries.flatMap((r) => {
      const label = semanticLabelOf(r);
      return label === null ? [] : [{ sessionId: label, mode: r.mode ?? 'session' }];
    });
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
async function emitHostBanner(projectRoot, sessionId) {
  try {
    const [{ getHostFingerprint }, { probe }] = await Promise.all([
      import('../scripts/lib/host-identity.mjs'),
      import('../scripts/lib/resource-probe.mjs'),
    ]);
    const [host, resources] = await Promise.all([
      getHostFingerprint(projectRoot).catch(() => null),
      probe({ skipProcessCounts: false, sessionId }).catch(() => null),
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

/**
 * The one-time telemetry-consent instruction handed to the coordinator (#1138).
 *
 * Deliberately terse: it is injected into the model context on EVERY session
 * start until the operator decides, so every character is a recurring cost.
 * It names the phase rather than restating it, so the AUQ wording stays
 * single-sourced in `skills/session-start/SKILL.md` § Phase 6.8.
 */
const CONSENT_NUDGE = {
  en: 'Telemetry consent is undecided on this host. NOW, before any other work, ask exactly once the '
    + 'consent-neutral AskUserQuestion from skills/session-start/SKILL.md § Phase 6.8 '
    + '(two options, no "(Recommended)" marker; Codex/Cursor: numbered list), then call '
    + 'grantConsent() or denyConsent() from scripts/lib/telemetry/consent.mjs. Never ask again afterwards.',
  de: 'Telemetrie-Consent ist auf diesem Host unentschieden. Stelle JETZT, vor jeder anderen Arbeit, '
    + 'genau einmal die consent-neutrale AskUserQuestion aus skills/session-start/SKILL.md § Phase 6.8 '
    + '(zwei Optionen, keine "(Recommended)"-Markierung; Codex/Cursor: nummerierte Liste) und rufe danach '
    + 'grantConsent() bzw. denyConsent() aus scripts/lib/telemetry/consent.mjs. Danach nie wieder fragen.',
};

/**
 * #1872 — is there an operator who could answer an AskUserQuestion in this run?
 *
 * Not when CI is detected, and not when Claude Code runs headless: the
 * entrypoint is `cli` interactively and `sdk-cli` under `claude -p` (measured
 * in a tool child process, 2026-10-28; other SDK hosts use further `sdk-*`
 * values). That the SessionStart hook sees the same value is the best signal
 * available, not a measured fact. Revisit trigger (BV-004): a headless run
 * that still shows the nudge, or a harness that exports a different marker.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function isInteractiveSession(env) {
  if (isCiEnv(env)) return false;
  const entrypoint = String(env.CLAUDE_CODE_ENTRYPOINT ?? '').trim().toLowerCase();
  return !entrypoint.startsWith('sdk');
}

/**
 * #1138 — queue the consent nudge when, and only when, this host has no
 * telemetry decision on record.
 *
 * WHY A HOOK AT ALL. Phase 6.8 was prose only: it fired when the coordinator
 * happened to reach line ~1060 of a 1230-line skill, after 24 other phases.
 * Measured 2026-08-23: 0 records from any host other than the author's.
 *
 * WHY `isCiEnv` AND NOT `isHeadless`. `isHeadless()` answers "can THIS process
 * prompt on a TTY?" — and this process is a hook whose stdout is a pipe, so it
 * would answer `true` unconditionally and the nudge could never fire. Measured
 * in a plain non-TTY subprocess on this host, 2026-08-23:
 *   `isHeadless()=true isCiEnv()=false stdout.isTTY=undefined`
 * The question that actually matters here is a different one: "is there an
 * operator who can answer an AskUserQuestion?" The prompting happens in the
 * live session, not in this process, so TTY-ness of the hook is irrelevant and
 * `isCiEnv()` — the fail-closed "this is unattended automation" probe — is the
 * correct gate, together with the headless entrypoint (#1872,
 * `isInteractiveSession`). (The same trap sits in the Phase 6.8 prose, which passes
 * `interactive: !isHeadless()` from a `node -e` subprocess whose stdout is also
 * a pipe: it would have resolved `prompt:false` every time even if executed.)
 *
 * `resolveConsent` remains the single decision point: `prompt` is true only for
 * a host with no stored decision, no env override, and no fleet flag.
 *
 * Never throws — a failure here must not affect session start.
 */
function maybeQueueConsentNudge() {
  try {
    const interactive = isInteractiveSession(process.env);
    if (!interactive) return;
    const ownerConfig = loadOwnerConfig().config;
    const consent = resolveConsent({
      env: process.env,
      ownerConfig,
      state: readTelemetryState().record,
      interactive,
    });
    if (consent.prompt !== true) return;
    // owner.yaml `owner.language` (default 'en'); German only when set to 'de'.
    setAdditionalContext(ownerConfig?.owner?.language === 'de' ? CONSENT_NUDGE.de : CONSENT_NUDGE.en);
  } catch { /* best effort — the nudge is informational, never blocks */ }
}

// ---------------------------------------------------------------------------
// Time budget (#1920)
// ---------------------------------------------------------------------------

/**
 * The SessionStart kill timeout of each harness, in ms — the `timeout` (s) of
 * the `on-session-start.mjs` entry in that harness's manifest: `hooks/hooks.json`
 * (claude, 10), `hooks/hooks-codex.json` (codex, 5 — Codex runs these hooks
 * synchronously), `hooks/hooks-cursor.json` (cursor, 5), `hooks/hooks-pi.json`
 * (pi, 5). `tests/hooks/on-session-start-budget.test.mjs` reads the four
 * manifests and fails when this table drifts from them.
 */
export const SESSION_START_TIMEOUT_MS = Object.freeze({ claude: 10000, codex: 5000, cursor: 5000, pi: 5000 });

/**
 * The harness timeout and the deadline in force for `platform`: the point (ms
 * since process start, `performance.now()`) after which no OPTIONAL step is
 * started any more, so the started event and the banner are written before
 * the harness kills the hook. An unknown platform gets the SMALLEST timeout
 * (fail toward skipping earlier, never toward being killed).
 *
 * Derivation: deadline = 0.75 × timeout (claude 7500, the 5 s harnesses 3750).
 * On a loaded Windows host (2026-11-03, Claude, 10 s) 8 of 15 fresh starts ran
 * past 10 s and lost both the event and the banner; the successful ones took
 * 7.4–9.4 s. The 25 % reserve covers the required tail (payload, emit, flush,
 * heartbeat), the `sh` launcher in front of node and the overrun of an
 * admitted step past its admission estimate (see the CEILING below).
 * `performance.now()` counts from process start, so Node boot and the imports
 * are inside the budget.
 *
 * CEILING: one share for every host and harness, judged against advisory
 * bounds. Revisit on either measurable signal: (a) `fresh SessionStart` runs
 * of `scripts/ci/windows-smoke.mjs` still ending with exit 124 (the hook was
 * killed although the deadline fired — reserve too small), or (b) more than
 * ~10 % of `orchestrator.session.started` events carrying `hook_skipped`
 * (HR-101: the deadline fires as routine and starves the optional steps).
 * A killed start writes no event, so (a) is the only record of the kills.
 *
 * @param {string} platform  the resolved harness (`getPlatform()`)
 * @returns {{ timeoutMs: number, deadlineMs: number }}
 */
export function hookBudget(platform) {
  const timeoutMs = SESSION_START_TIMEOUT_MS[platform] ?? Math.min(...Object.values(SESSION_START_TIMEOUT_MS));
  return { timeoutMs, deadlineMs: Math.round(timeoutMs * 0.75) };
}

/** Timeout for the git calls the hook needs before the event (#1920). */
const GIT_TIMEOUT_MS = 2000;

/** Timeout for each of the two upstream git calls (#1668). */
const UPSTREAM_TIMEOUT_MS = 1000;

/*
 * CEILING (#1920): the bounds the steps are admitted with are ADVISORY
 * admission estimates, not enforced limits — nothing stops a step at its
 * bound. `BACKFILL_BOUND_MS` is declared here, not enforced by the module;
 * `cold_start`, `reap` and `sweep` are admitted with 0 (no bound known);
 * `PROBE_BUDGET_MS` is per-probe WORK time, and probes that block
 * synchronously overrun it (`scripts/lib/session-start-probes.mjs`, its
 * 2026-09-11 note: 17 non-network probes reported ≈5.8 s `durationMs`).
 * Measured wall time of the whole probe run on this repo's ledger (macOS,
 * unloaded, 2026-11-03, `orchestrator.probes.completed` `duration_ms`, n=130):
 * p50 918 ms, p90 1080 ms, max 2170 ms — inside `PROBE_BUDGET_MS` +
 * `PROBE_MARGIN_MS` = 2500 ms there; a loaded host can exceed it. The overrun
 * is what the deadline's 25 % reserve absorbs; revisit with the signals named
 * at `hookBudget()`.
 */

/**
 * Admission estimate for `backfillOnSessionStart()`. The module exports no
 * total bound (only `SESSION_START_ARCHIVE_SCAN_BUDGET_MS` = 500 for its
 * archive scan); ~2000 ms is the cost #1920 measured and declared for it.
 */
const BACKFILL_BOUND_MS = 2000;

/**
 * Added to `PROBE_BUDGET_MS`: the synchronous probes block the event loop and
 * cannot be stopped once started, so they need room beyond their own budget.
 */
const PROBE_MARGIN_MS = 500;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // #1920 — per-phase durations for the started event. Each key holds the ms
  // since the previous mark (the first, `boot`, since process start).
  const phaseMs = {};
  let phaseMark = 0;
  const markPhase = (key) => {
    const now = performance.now();
    phaseMs[key] = Math.round(now - phaseMark);
    phaseMark = now;
  };
  // #1920 — optional steps not started because they would end past the
  // deadline. `boundMs` is the step's declared upper bound; an unknown bound
  // (a module without the constant) counts as 0, i.e. skip only once the
  // deadline has passed.
  //
  // getPlatform() ALREADY implements the SO_PLATFORM override as step 1 of its
  // precedence — and, unlike a bare `??`, it validates the value against the
  // four-platform allowlist and trims it. The former `process.env.SO_PLATFORM ??
  // getPlatform()` therefore added nothing except the empty-string trap
  // (`.claude/rules/development.md` § Env-var fallback whitespace trap): a key
  // exported as `SO_PLATFORM=` is not nullish, so `??` short-circuited and this
  // hook stamped `platform: ''` on the session event and handed '' down to the
  // update probe. Measured 2026-09-06 by the codex test below.
  // #1920: resolved here, before the first gate, because the deadline is the
  // harness's own SessionStart timeout (Codex/Cursor/Pi kill at 5 s, Claude 10 s).
  const platform = getPlatform();
  const { timeoutMs: hookTimeoutMs, deadlineMs: hookDeadlineMs } = hookBudget(platform);
  const skipped = [];
  const overBudget = (step, boundMs) => {
    const bound = Number.isFinite(boundMs) ? boundMs : 0;
    if (performance.now() + bound <= hookDeadlineMs) return false;
    skipped.push(step);
    return true;
  };
  markPhase('boot');

  // #1605 — the root depends on the payload `source`/`cwd`/`session_id`, so the
  // optional stdin payload is read BEFORE the first writer below. Best-effort:
  // readStdinJson resolves null on a closed/empty/unparseable stdin and caps
  // itself at 500 ms. The rule (entered worktree only for clear/compact/resume,
  // only a verified linked worktree, never over another live session's state)
  // lives in hooks/_lib/hook-root.mjs, beside the readers' own-lock lookup.
  const input = await readStdinJson();
  const projectRoot = await resolveSessionStartRoot(input, resolveProjectDir());

  // #1515 Pkt 5 — before this hook's own writers (host.json, session.lock,
  // events.jsonl) run: an un-bootstrapped repo gets `.orchestrator/.gitignore`
  // so the runtime state never shows up in `git status`. Bootstrapped repos
  // pay two existsSync and nothing else. Never throws.
  await ensureOrchestratorIgnore(projectRoot);
  markPhase('input');

  // #1934 — which git call (required toplevel/branch, deadline-gated head_sha/upstream) hit its timeout, in call order, from the
  // vocabulary toplevel|branch|head_sha|upstream. OMITTED from the event when
  // empty (absent ≠ measured-empty), like `hook_skipped`. `branch` keeps its
  // 'unknown' fallback; this field is what tells a timeout apart from no repo.
  // Ceiling: a toplevel timeout leaves `topLevel` null, so `needsBootstrap`
  // below reads false and an un-bootstrapped repo gets the "Next step" line
  // instead of the /bootstrap hint on that start. Revisit when an event with
  // `hook_git_timeouts` containing `toplevel` is seen on an un-bootstrapped repo.
  const gitTimeouts = [];
  const recordGitTimeout = (step) => () => { if (!gitTimeouts.includes(step)) gitTimeouts.push(step); };

  // Resolve project name: basename of git toplevel, falling back to cwd basename.
  // #1920: bounded — a timeout returns null like any git failure (cwd basename).
  const topLevel = await gitOutput(['rev-parse', '--show-toplevel'], projectRoot, GIT_TIMEOUT_MS, recordGitTimeout('toplevel'));
  const projectName = topLevel
    ? topLevel.split(/[/\\]/).filter(Boolean).pop() ?? 'unknown'
    : projectRoot.split(/[/\\]/).filter(Boolean).pop() ?? 'unknown';

  // Resolve current branch; fall back to "unknown" when detached HEAD or no git.
  const branch = (await gitOutput(['branch', '--show-current'], projectRoot, GIT_TIMEOUT_MS, recordGitTimeout('branch'))) ?? 'unknown';

  // #1443 — the commit this session started on, the fallback source for
  // `session_start_ref` (STATE.md's `session-start-ref` had no writer). Kept
  // only when it is a full object name; no repo, an unborn HEAD or a missing
  // git leaves it null and the payload key is OMITTED, never fabricated.
  const rawHeadSha = overBudget('head_sha', GIT_TIMEOUT_MS)
    ? null
    : await gitOutput(['rev-parse', 'HEAD'], projectRoot, GIT_TIMEOUT_MS, recordGitTimeout('head_sha'));
  const headSha = rawHeadSha && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(rawHeadSha) ? rawHeadSha : null;

  // #1668 — the upstream state at start, so emit-session can tell a stale
  // head_sha (checkout behind its upstream: a later pull drags foreign commits
  // into `<head_sha>..HEAD`) from a current one. Local refs only — no fetch, no
  // network — and bounded at 1 s per call. No upstream configured, a timeout or
  // a non-numeric count → BOTH keys omitted (not measured), never 0.
  let upstreamSha = null;
  let behind = null;
  if (headSha && !overBudget('upstream', UPSTREAM_TIMEOUT_MS)) {
    const [rawUpstream, rawBehind] = await Promise.all([
      gitOutput(['rev-parse', '--verify', '--quiet', '@{u}^{commit}'], projectRoot, UPSTREAM_TIMEOUT_MS, recordGitTimeout('upstream')),
      gitOutput(['rev-list', '--count', 'HEAD..@{u}'], projectRoot, UPSTREAM_TIMEOUT_MS, recordGitTimeout('upstream')),
    ]);
    if (rawUpstream && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(rawUpstream) && rawBehind && /^\d+$/.test(rawBehind)) {
      upstreamSha = rawUpstream;
      behind = Number(rawBehind);
    }
  }
  markPhase('git');

  // v3.1.0 multi-session registry (#168). All steps best-effort — failures
  // must never break the hook, which is informational-only.
  // #1091 — the native SessionStart `source` (Claude Code: startup|resume|
  // clear|compact), plus the linkage decision resolveSessionId() derived from
  // it (see SAME_LOGICAL_SESSION_SOURCES). Both are surfaced on the event so
  // #1091 gets its measurement instead of an inference.
  // #1641: the Claude Code process survives /clear while the raw id and the
  // semantic label are minted anew — its pid is the witness that a live lock,
  // or the current-session.json entry (#1746), is our own predecessor's.
  // Admitted only as this hook's direct parent: a Codex child of a Claude
  // session inherits the variable.
  const claudePid = readClaudePid();
  const { sessionId, semanticSessionId, mode, nativeSource, resumeLinkage, predecessorSessionId, predecessorProcess } =
    await resolveSessionId(input, projectRoot, claudePid);

  // v3.1.0 env-aware banner (opt-out via enable-host-banner: false in Session Config).
  // The ask-via-tool nudge rides the same opt-out flag — both are coordinator
  // reminders shown at session start; users who silence one expect silence.
  // Hoisted because the cold-start DISPLAY below rides the same opt-out (#1133)
  // and `bannerData` is not a usable proxy for it: `emitHostBanner()` returns
  // null on its own error paths, which would silently re-open the nudge.
  const hostBannerEnabled = await isHostBannerEnabled(projectRoot);
  let bannerData = null;
  // #1559: a git repository with no bootstrap.lock — neither at its toplevel
  // nor under projectRoot (a bootstrapped sub-project) — has one first step,
  // /bootstrap; /go and /close do not work before it. Judged at the toplevel
  // too, so a session started in a subdirectory of a bootstrapped repo is not
  // told to bootstrap again; outside a git repository there is nothing to set up.
  const needsBootstrap = Boolean(topLevel)
    && !existsSync(path.join(topLevel, '.orchestrator', 'bootstrap.lock'))
    && !existsSync(path.join(projectRoot, '.orchestrator', 'bootstrap.lock'));
  if (hostBannerEnabled) {
    bannerData = await emitHostBanner(projectRoot, sessionId);
    // AUQ-001 in plain words (#1559): name the command when nothing is
    // blocked, read available answers from config / STATE.md / git, and ask
    // only when blocked — then with the question tool, never as a prose list.
    // Before bootstrap, the setup step replaces it as the first action.
    pushBanner(needsBootstrap
      ? 'ℹ New here? Start with /bootstrap — it sets up this repo for session-orchestrator.'
      : '🎯 Next step: name the command (/go, /close) when nothing is blocked; read answers from config, STATE.md or git; when blocked, ask with the question tool, never as a prose list.');
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
    // #1920: past the deadline the marker stays and re-arms on the next start.
    if (coldStartCfg.enabled !== false && !overBudget('cold_start', 0)) {
      const decision = await detectColdStart({
        repoRoot: projectRoot,
        nudgeAfterHours: coldStartCfg['nudge-after-hours'] ?? 1,
        silenceAfterSessions: coldStartCfg['silence-after-sessions'] ?? 1,
        enabled: coldStartCfg.enabled !== false,
      });
      if (decision.shouldEmit) {
        // #1133 — the DISPLAY rides the enable-host-banner opt-out like every
        // other start-of-session emitter ("users who silence one expect
        // silence"). The one-shot marker consumption below does NOT: the
        // opt-out silences the display, never the measurement or the state
        // transition. Consuming it unconditionally is what keeps the nudge
        // one-shot for an operator who has banners off — otherwise it re-arms
        // on every start forever.
        if (hostBannerEnabled) pushBanner(decision.bannerLines.join('\n'));
        if (decision.markerPath) {
          await consumeMarker(decision.markerPath).catch(() => false);
        }
      }
    }
  } catch { /* silent — cold-start nudge must never block the hook */ }
  markPhase('banner');

  // `platform` is resolved at the top of main() (#1920: the deadline needs it).

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
      // #1889/#1919 — on Codex (minimum 0.160) a one-shot `codex exec` run
      // releases its lock at its Stop (on-stop.mjs, keyed on the rollout
      // marker in scripts/lib/codex/rollout-meta.mjs), and every session,
      // interactive ones included, releases and deregisters at SessionEnd
      // (on-session-end.mjs, wired in hooks-codex.json; fired on codex-cli
      // 0.160.1, measured 2026-11-02). A crash or a kill skips SessionEnd, and
      // then only the TTL reaps the lock (`isLockLive` reads
      // `lock.ttl_hours`), so 0.5 h bounds a leaked lock. CEILING: a
      // single Codex turn, or an idle gap between two turns, longer than
      // 30 min makes a live interactive session look stale — Stop is the
      // only heartbeat on Codex (no UserPromptSubmit is wired there).
      ttlHours: platform === 'codex' ? 0.5 : 4,
      nativeSource,
      // The raw session_id the last session start in this checkout recorded —
      // our own previous run unless a peer started here since. It is the
      // third conjunct of the same-logical-session force-refresh (#1091 F2): a
      // semantic-label match alone is collidable on one host (#1066), so the
      // live lock must ALSO carry our predecessor's raw id before we take it
      // over. `prev` is read above, before the semantic id is minted.
      predecessorSessionId,
      // #1746: who wrote that raw id — the lead yield trusts it as "our own
      // predecessor" only when this same Claude process did.
      predecessorProcess,
      claudePid,
      // #1635: a fleet lead holds this main checkout — no lock was taken; the
      // model and the operator are told to work in a worktree instead.
      onNotice: (context, banner) => {
        setAdditionalContext(context);
        pushBanner(banner);
      },
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
  if (!overBudget('reap', 0)) {
    try {
      const { reapRepoLock } = await import('../scripts/lib/lock-reaper.mjs');
      await reapRepoLock({
        repoRoot: projectRoot,
        currentSessionId: sessionId,
        dryRun: false,
        reapMode: 'auto-own-repo',
      });
    } catch { /* hook must remain non-blocking */ }
  }
  markPhase('lock');

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
  // is excluded by our own in-memory ids below — lock or no lock, since a lead
  // yield (#1635) or a kept-released lock (#1651) runs lockless (#1748). Never
  // re-read current-session.json for them: it is repo-global (#1746).) A live
  // FOREIGN session is protected by its live lock or, when lockless, by a fresh
  // host-registry entry, both checked against the CANDIDATE.
  //
  // Best-effort like every other probe here: any failure is swallowed so a
  // backfill problem can never block a session start.
  // #1920: skipped when it could end past the deadline — the next start or
  // SessionEnd backfills instead.
  if (!overBudget('backfill', BACKFILL_BOUND_MS)) {
    try {
      const { backfillOnSessionStart } = await import('../scripts/backfill-abandoned-sessions.mjs');
      await backfillOnSessionStart({ repoRoot: projectRoot, ownSessionIds: [sessionId, semanticSessionId] });
    } catch { /* hook must remain non-blocking */ }
  }
  markPhase('backfill');

  let peers = [];
  let peersMeasured = false;
  // GH#67 consumer half — how many mechanically-detected peers were registry-
  // sourced entries that a LIVE lock at this root supersedes. Counted for the
  // session.started payload below; NEVER subtracted from any peer count
  // (HR-106: the banner reports the number the verdict judged).
  // #1934: null = not measured (discovery did not run or failed) → the payload
  // OMITS `peers_superseded`; only a completed discoverActiveSessions() sets it.
  let mechanicalPeersSuperseded = null;
  try {
    if (!overBudget('sweep', 0)) await sweepZombies().catch(() => ({ removed: [], logged: 0 }));
    try {
      await registerSelf({
        sessionId,
        semanticSessionId,         // Epic #583 W5-F1c — registry entry carries semantic id (Q5 H1)
        projectRoot,
        branch,
        platform,
        mode,
        hostClass: bannerData?.host?.host_class ?? null,
        // #1605 — the pointer the readers (Stop, PostToolBatch, SessionEnd, the
        // current-session.json side writers) follow to THIS session's lock,
        // whatever their cwd; and the working copy, so a later relocation
        // into it by another session sees this one (B4). Stop refreshes it.
        sessionRoot: path.resolve(projectRoot),
        workRoot: path.resolve(resolveSessionRoot(input?.cwd)),
      });
    } catch (err) {
      // Registration failed — emit an observability breadcrumb to sweep.log.
      // Do NOT throw, do NOT write to stderr: the hook is informational-only.
      logSweepEvent({ event: 'register-failed', session_id: sessionId, error: err?.message ?? String(err) });
    }
    // #1946 — strict read: an unlistable registry (EACCES, ENOTDIR, EMFILE)
    // leaves `peersMeasured` false, so `peer_count` and `recent_starts_count`
    // are OMITTED from the event instead of reporting the empty list as 0.
    peers = await detectPeers({ sessionId, strict: true });
    peersMeasured = true;
  } catch { /* swallow — hook must remain non-blocking; not measured */ }
  // #1650 — foreign starts inside the window. detectPeers() already excludes
  // self, and its 15-min freshness covers the 5-min window (see helper JSDoc).
  const recentStarts = peersMeasured ? countRecentStarts(peers, { windowMin: START_WAVE_WINDOW_MIN }) : null;

  // Append a peer line to the host banner when a banner was already emitted
  // and at least one peer is live on this host.
  //
  // #1934 — why the display gates here and below (peer lines, navigator,
  // mechanical peer lines, probe lines, update line, deadline line) key on
  // `bannerData` and not on `hostBannerEnabled`: NOT a technical need —
  // pushBanner()/flushBanner() assemble the systemMessage without it. It is a
  // display choice: these lines extend the Host/Resources header and stay
  // silent with it, so `bannerData` null (opt-out OR `emitHostBanner()` failing
  // on its own) silences them too. Only the measurements must not ride it.
  // Ceiling: on a failed host probe the peer-collision lines are lost along
  // with the header. Switching to `hostBannerEnabled` would show them headless
  // and changes behaviour on that path. Revisit on an operator report or a
  // measurement of a peer-collision line lost to a failed host probe.
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

    // WARN on any peer in THIS working copy — one is already enough to collide
    // — or on a start wave (#1650). The host-wide peer count stays on the line
    // as information only: as a WARN trigger it fired on 67.4% of starts.
    const startWave = recentStarts >= START_WAVE_MIN;
    const icon = sameCopy.length > 0 || startWave ? '⚠️ ' : '';

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
    if (startWave) {
      pushBanner(`   ⚠️  Start wave: ${recentStarts} sessions started or resumed in the last ${START_WAVE_WINDOW_MIN} min — stagger further starts`);
    }
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

  // #1462 — Navigator line (fleet protocol v1). Exactly one line, read from the
  // lease file only (`~/.config/navigator/leases/navigator.json`, override
  // NAVIGATOR_CONFIG_DIR); registry `role` and ListAgents are hints, never proof.
  // Gated like the peer lines above: no host banner → no navigator line. A read
  // failure must never block the hook — the helper is fail-closed itself, the
  // try/catch only guards against the unexpected.
  // #1559: solo users without fleet integration see no fleet line.
  if (bannerData && fleetIntegrationEnabled()) {
    try {
      pushBanner(navigatorBannerLine(await readNavigatorLease()));
    } catch { /* swallow — hook must remain non-blocking */ }
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
  // #1934: the MEASUREMENT runs whatever the display preference, like the
  // probes below — `enable-host-banner: false` (or a failed host probe, both
  // leave `bannerData` null) silences only the `pushBanner` lines and the
  // display-only registry liveness read. Before, the whole block was gated on
  // `bannerData` and the event carried an unmeasured `peers_superseded: 0`.
  // The mechanical lock + STATE.md peer-guard remain active regardless.
  // Best-effort: any failure (import, discovery throws) is swallowed and
  // leaves `peers_superseded` OMITTED (not measured), never 0.
  //
  // #1920: skipped when its race timeout could end past the deadline; the
  // payload then OMITS `peers_superseded` too.
  markPhase('peers');
  let discoveryMod = null;
  try {
    discoveryMod = await import('../scripts/lib/session-discovery.mjs');
  } catch { /* best effort — not measured, never blocks */ }
  if (discoveryMod && !overBudget('discovery', discoveryMod.DEFAULT_DISCOVERY_TIMEOUT_MS)) {
    try {
      const { discoverActiveSessionsMeasured } = discoveryMod;
      const { sessions: allActive, registryRead, worktreesListed } = await discoverActiveSessionsMeasured(projectRoot);
      const mechanicalPeers = allActive.filter((s) => s.sessionId !== sessionId);
      // #1941: discovery resolves with a PARTIAL set when its worktree listing
      // loses the race (lock-only fallback, registry never read) or the
      // registry read fails. Only registry-sourced peers can carry
      // `lockSuperseded`, so a count over that subset is not a measurement:
      // leave it null → `peers_superseded` OMITTED. The banner lines below keep
      // showing whatever was found.
      if (registryRead && worktreesListed) {
        mechanicalPeersSuperseded = mechanicalPeers.filter((p) => p.lockSuperseded === true).length;
      }
      // #1850 — the registry heartbeat of every superseded registry-only peer,
      // read once. A read failure leaves the map empty → `unknown`, never
      // "finished". Display only, so skipped without a banner.
      let registryById = new Map();
      let livenessFn = null;
      if (bannerData && mechanicalPeersSuperseded > 0) {
        try {
          const reg = await import('../scripts/lib/session-registry.mjs');
          livenessFn = reg.registryEntryLiveness;
          registryById = new Map((await reg.readRegistry()).map((e) => [e.session_id, e]));
        } catch { /* best effort — unknown liveness */ }
      }
      const livenessOf = (p) => registryPeerLiveness(registryById.get(p.sessionId), livenessFn);
      const supersededLiveness = mechanicalPeers
        .filter((p) => p.registryOnly === true && p.lockSuperseded === true)
        .map((p) => livenessOf(p).state);
      if (bannerData && mechanicalPeers.length > 0) {
        // #1137 part 1 — say WHERE, not just how many. discoverActiveSessions()
        // walks EVERY path `git worktree list` reports, which includes worktrees
        // another coordinator parked outside this working copy (e.g. under
        // /private/tmp/…). Measured 2026-08-23: all 4 reported "peers" were the
        // 4 registered worktrees, none of them in this checkout — and the old
        // wording ("active in same repo") read as 4 sessions competing for THIS
        // directory. The surface is deliberately unchanged (a foreign-worktree
        // session IS a peer of this repo); only the label and the per-peer
        // detail are, so the operator can tell the two apart at a glance.
        const summary = mechanicalPeers
          .slice(0, 3)
          .map((p) => {
            const where = p.worktreePath ? path.basename(p.worktreePath) : '?';
            // #1151 — carry the peer's MODE when the source recorded one.
            // `worktree:id` says where a peer sits but not what it is doing,
            // and the operator's next decision (wait / promote / proceed)
            // turns on exactly that: a `deep` peer holding this worktree set
            // is a different situation from a `discovery` one. Guarded rather
            // than assumed — sessionFromLock() passes `lock.mode` verbatim, so
            // a lock written without the field yields undefined here, while
            // sessionFromRegistryEntry() always defaults it to 'session'.
            const mode = typeof p.mode === 'string' && p.mode.length > 0 ? `:${p.mode}` : '';
            return `${where}:${shortSessionId(p.sessionId)}${mode}${supersessionMarker(p, livenessOf(p))}`;
          })
          .join(', ');
        const overflow = mechanicalPeers.length > 3 ? ` +${mechanicalPeers.length - 3} more` : '';
        pushBanner(`🔍 Mechanical peer-detection: ${mechanicalPeers.length} active in this repo's worktree set (${summary}${overflow})`);
        // #1850 — one explanation line per liveness class, so this block never
        // contradicts the "coordinate before editing" line above: only a
        // MEASURED stale heartbeat may be called a likely finished task.
        const nLive = supersededLiveness.filter((st) => st === 'live').length;
        const nStale = supersededLiveness.filter((st) => st === 'stale').length;
        const nUnknown = supersededLiveness.filter((st) => st === 'unknown').length;
        if (nLive > 0) {
          pushBanner(`   ${nLive} of them registry-only without this root's lock, but the registry heartbeat is fresh — LIVE: coordinate before editing, do not treat as finished (#1850).`);
        }
        if (nStale > 0) {
          pushBanner(`   ${nStale} of them registry-only and superseded by this root's live lock — likely a finished task without SessionEnd (GH#67). Still counted above: the session lock is advisory.`);
        }
        if (nUnknown > 0) {
          pushBanner(`   ${nUnknown} of them registry-only and superseded by this root's live lock; liveness not measurable — treat as live until shown otherwise. Still counted above: the session lock is advisory.`);
        }
      }
    } catch { /* best effort — banner is informational, never blocks */ }
  }
  markPhase('discovery');

  // Phase 4 measurement probes — the mechanical caller (#1128).
  //
  // `skills/session-start/SKILL.md` § Phase 4 names 20 probes with module paths
  // and entry functions (2026-10-02; the `PROBES` registry in
  // `scripts/lib/session-start-probes.mjs` is the count's source of truth).
  // Measured 2026-08-23 at `4f6404e` (a smaller family then), not one of them had
  // a caller anywhere in hooks/, npm scripts, .gitlab-ci.yml or .husky/ — the
  // only caller was the prose itself, and across 336 recorded session starts
  // there was no event proving any of them had ever run. Built, documented,
  // never wired.
  //
  // Placement is deliberate: AFTER the backfill (so `sessions-staleness` and
  // `sessions-integrity` measure the reconstructed ledger, not the stale one)
  // and BEFORE flushBanner() (so probe findings ride the single systemMessage
  // envelope instead of adding a second stdout object Claude Code would
  // discard — see the bannerLines docstring and HR-106).
  //
  // Best-effort exactly like `backfillOnSessionStart` above: the runner has no
  // rejecting path of its own, and this try/catch is defence-in-depth so a
  // future regression inside it still cannot block a session start.
  // Escape hatch: SO_DISABLE_STARTUP_PROBES=1.
  //
  // `enable-host-banner: false` silences the DISPLAY, never the MEASUREMENT.
  // The documented opt-out ("a user who silenced session-start banners has
  // opted out of ALL session-start banners") governs `pushBanner` and nothing
  // else: the probes still run and `orchestrator.probes.completed` is still
  // written, because the defect this wiring repairs is precisely that nobody
  // could tell whether the probes had ever run (HR-105). Gating the run on a
  // display preference would rebuild that blind spot behind a config key.
  if (process.env.SO_DISABLE_STARTUP_PROBES !== '1') {
    try {
      const { runSessionStartProbes, PROBE_BUDGET_MS } = await import('../scripts/lib/session-start-probes.mjs');
      // #1920: the synchronous probes cannot be stopped once started — start
      // them only when their budget plus a margin still fits.
      if (!overBudget('probes', PROBE_BUDGET_MS + PROBE_MARGIN_MS)) {
        const probeRun = await runSessionStartProbes({ repoRoot: projectRoot });
        if (bannerData) {
          for (const line of probeRun.bannerLines) pushBanner(line);
        }
      }
    } catch { /* hook must remain non-blocking */ }
  }
  markPhase('probes');

  // Plugin-update probe (#nnn, d7 R2) — "is the plugin that is RUNNING behind
  // the plugin that is PUBLISHED?".
  //
  // MEASURED 2026-09-06: this host ran the marketplace-cache copy at 3.19.0
  // (installed 2026-08-09) while repo and npm stood at the 3.24 line — five minors,
  // four weeks, zero warnings, because NO code anywhere compared installed
  // against available (`grep -rln "registry.npmjs.org\|dist-tags" scripts/
  // hooks/ skills/` → only scripts/release.mjs, the publisher).
  //
  // Placement mirrors the probe block above: BEFORE the payload (the event
  // carries both versions) and BEFORE flushBanner(), so the line rides the ONE
  // systemMessage envelope. A second stdout object would be silently discarded
  // (HR-106) — the failure mode the bannerLines docstring describes.
  //
  // Same measurement/display split as the probes: the request and the event
  // fields happen regardless, `pushBanner` is gated on `bannerData`. Network,
  // cache and kill-switch behaviour live in the module.
  let pluginUpdate = null;
  try {
    const { checkPluginUpdate, isUpdateCheckDisabled, readCachedLatest, FETCH_TIMEOUT_MS } =
      await import('../scripts/lib/plugin-update-banner.mjs');
    const updateCacheDir = path.join(projectRoot, '.orchestrator', 'runtime');
    const updateNow = Date.now();
    // #1934: a fresh cache answers without the network, so it needs no fetch
    // time — the fetch bound is reserved only on a cache miss. Before, a start
    // at 6 s skipped the check although the cache could have answered.
    const cacheFresh = !isUpdateCheckDisabled() && readCachedLatest({ cacheDir: updateCacheDir, now: updateNow }) !== null;
    // #1920: a switched-off check is not a skipped one — it runs (and returns
    // at once) as before; only a wanted check is gated on the deadline.
    if (isUpdateCheckDisabled() || cacheFresh || !overBudget('update_check', FETCH_TIMEOUT_MS)) {
      pluginUpdate = await checkPluginUpdate({
        cacheDir: updateCacheDir,
        now: updateNow,
        // Admitted on the cache alone: a cache-only fetcher, so a file that
        // vanishes between the two reads can never start a request past the
        // deadline (the check then stays silent, as on any fetch failure).
        ...(cacheFresh ? { fetchImpl: async () => null } : {}),
        // The probe's own fallback is env-only (SO_PLATFORM, then each harness's
        // compat var) and cannot run detectPlatform()'s step 4, the marker-
        // directory walk from cwd. This hook already resolved the platform at the
        // top of run() through exactly that full precedence, so handing it over
        // makes the remedy instruction MEASURED rather than guessed — a Codex or
        // Cursor consumer with no compat var set would otherwise be told to run
        // `/plugin update`, a command its harness does not have.
        platform,
      });
    }
    if (pluginUpdate && bannerData) pushBanner(pluginUpdate.message);
  } catch { /* hook must remain non-blocking */ }
  markPhase('update_check');

  // #1920 — one line naming what the deadline skipped, gated like every other
  // section (the measurement in the event is not).
  if (skipped.length > 0 && bannerData) {
    const steps = skipped.map((s) => s.replace('_', ' ')).join(', ');
    const atSec = (performance.now() / 1000).toFixed(1);
    const budgetSec = hookTimeoutMs / 1000;
    pushBanner(`ℹ SessionStart: ${steps} skipped — hook at ${atSec} s of its ${budgetSec} s budget (#1920)`);
  }

  const payload = {
    platform,
    project: projectName,
    branch,
    session_id: sessionId,
    // #1946: OMITTED when the registry could not be read (not measured).
    ...(peersMeasured ? { peer_count: peers.length } : {}),
    // GH#67 — additive: how many mechanically-detected peers a live lock at
    // this root supersedes. `peer_count` is deliberately unchanged; this field
    // makes the supersession rate measurable instead of inferred (HR-105).
    // #1934: OMITTED whenever discovery did not complete (not measured).
    ...(mechanicalPeersSuperseded !== null ? { peers_superseded: mechanicalPeersSuperseded } : {}),
    // #1650 — start-wave signal (HR-105): foreign registry entries whose
    // started_at lies within the last `recent_starts_window_min` minutes.
    // #1946: OMITTED together with its window when the registry was unread.
    ...(recentStarts !== null
      ? { recent_starts_count: recentStarts, recent_starts_window_min: START_WAVE_WINDOW_MIN }
      : {}),
  };
  if (headSha) payload.head_sha = headSha;
  // #1889 — measurement for the Codex lock leak: which root the lock went to
  // relative to the hook's cwd, and whether an inherited launch-dir variable
  // (read first by resolveProjectDir) was present. Booleans only — never the
  // values. Codex-only, OMITTED elsewhere.
  if (platform === 'codex') {
    payload.claude_project_dir_set = Boolean(process.env.CLAUDE_PROJECT_DIR);
    payload.codex_project_dir_set = Boolean(process.env.CODEX_PROJECT_DIR);
    try {
      payload.lock_root_matches_cwd = path.resolve(projectRoot) === path.resolve(resolveSessionRoot(input?.cwd));
    } catch { /* unmeasurable — omitted */ }
  }
  if (upstreamSha !== null) {
    payload.upstream_sha = upstreamSha;
    payload.behind = behind;
  }

  // #1091 — record the native SessionStart source so "does the same raw
  // session_id repeat under source=resume?" becomes answerable from
  // events.jsonl instead of guessed. OMITTED when the harness sends no source
  // (docs/events-schema.md optional-field convention: absent ≠ measured-empty).
  if (nativeSource) payload.native_source = nativeSource;

  // #1091 F1 — WHICH linkage the source produced: 'raw-id' (prior raw
  // session_id matched → semantic label reused, high-water marks preserved),
  // 'semantic' (the freshly minted label happened to equal the recorded one),
  // or 'none' (a new session, or an unverified restart whose continuity is
  // deliberately not guessed). Same optional-field convention as
  // `native_source`: OMITTED when the harness sends no source at all, so a
  // Codex/Cursor row is never read as a measured 'none'.
  if (nativeSource) payload.resume_linkage = resumeLinkage;

  // #nnn — installed/latest plugin version on the session record.
  //
  // HR-105: a verdict nothing records is unfalsifiable. `installed` is stamped
  // on EVERY start (it is a local file read that cannot fail for network
  // reasons), and `latest` whenever it is known — including the runs where
  // checkPluginUpdate() stayed silent because the versions matched. Those runs
  // are the DENOMINATOR of the probe's firing rate; without them the fleet can
  // only ever see how often it warned, never how often it could have.
  //
  // Both keys are OMITTED rather than nulled when unknown (docs/events-schema.md
  // optional-field convention: absent ≠ zero) — a kill-switched or offline
  // session must not read as "latest is 0/unknown-but-measured".
  try {
    const { readInstalledPluginVersion, readCachedLatest, isUpdateCheckDisabled } =
      await import('../scripts/lib/plugin-update-banner.mjs');
    const installedVersion = readInstalledPluginVersion();
    if (installedVersion) payload.plugin_version_installed = installedVersion;
    // `latest` is gated on the kill switch, `installed` is not: reading this
    // repo's own package.json is not the thing an operator switched off.
    if (!isUpdateCheckDisabled()) {
      const latestVersion =
        pluginUpdate?.latest
        ?? readCachedLatest({ cacheDir: path.join(projectRoot, '.orchestrator', 'runtime') })?.version
        ?? null;
      if (latestVersion) payload.plugin_version_latest = latestVersion;
    }
  } catch { /* telemetry never blocks the hook */ }
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
    // #1946: null from the probe = registry not readable → key OMITTED, so a
    // reader never sees an unmeasured count; a number (0 included) is written.
    if (typeof bannerData.resources.peer_sessions_count === 'number') {
      payload.peer_sessions_count = bannerData.resources.peer_sessions_count;
    }
  }
  // #1183 — a malformed record throws EventValidationError BEFORE any side
  // effect (scripts/lib/events.mjs); this hook must never abort on that, so
  // the emit is wrapped rather than left to propagate.
  // #1920 — where the time went, and what the deadline skipped. `hook_skipped`
  // is OMITTED when nothing was skipped (absent ≠ measured-empty).
  payload.hook_phase_ms = { ...phaseMs, total: Math.round(performance.now()) };
  if (skipped.length > 0) payload.hook_skipped = [...skipped];
  if (gitTimeouts.length > 0) payload.hook_git_timeouts = [...gitTimeouts];
  try {
    await emitEvent('orchestrator.session.started', payload);
  } catch { /* telemetry never blocks the hook (#1183) */ }

  // #1138 — one-time telemetry-consent nudge. Queued (never written) here so it
  // rides the single stdout envelope below.
  maybeQueueConsentNudge();

  // Single flush — see the bannerLines docstring for why this must stay the
  // only stdout write in the hook.
  flushBanner();

  // #1229 — refresh the session-lock heartbeat at the END of this hook's run.
  //
  // MEASURED (STATE.md deviation 2026-09-05T06:08:46Z): session-20's lock was
  // reaped as stale at 06:06Z by an UNRELATED session's SessionEnd, its
  // heartbeat 11.3 h old against a 4 h TTL. The session was not idle — it was
  // still inside session-start / session-plan, where no heartbeat writer
  // existed: `updateHeartbeat()` was called only from the wave loop, from
  // on-stop and from session-end. A session that never reached /go therefore
  // aged out of its own lock while working.
  //
  // bootstrapLock() above stamps `last_heartbeat = started_at` at LOCK GENESIS,
  // i.e. before the peer scan, the backfill and the Phase-4 probes have run.
  // Stamping again here moves the clock to the end of the hook and — more
  // importantly — makes session-start a heartbeat CALL SITE at all, so the
  // cadence no longer begins only when the first wave starts.
  //
  // `updateHeartbeat()` already carries the same-session guard this needs (it
  // returns false without writing when the lock belongs to another session),
  // so no `touchIfOwn()` wrapper is warranted — see scripts/lib/session-lock.mjs.
  try {
    const { updateHeartbeat } = await import('../scripts/lib/session-lock.mjs');
    updateHeartbeat({ repoRoot: projectRoot, sessionId });
  } catch { /* hook must remain non-blocking */ }

  // Size-based rotation of events.jsonl (#251). Session-start is the single
  // rotation trigger — per-append overhead is rejected design. Any failure
  // is swallowed: rotation must NEVER block the hook.
  //
  // #1401 — the DURABLE record of a rotation is no longer this block. Until
  // 2026-09-19 the only evidence a rotation had happened was the `console.error`
  // below, and this hook's stderr is discarded by the harness: a rotation and a
  // DELETED archive were byte-identical from outside. `maybeRotate()` now writes
  // an `orchestrator.events.rotated` record as the first line of the new active
  // file, so the ledger carries its own break whatever happens to this stderr
  // line. The line stays as an operator convenience only — never as the record.
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
      const pruned = result.pruned?.length ? `, pruned ${result.pruned.length}` : '';
      const ledger = result.recordWritten ? '' : ' [WARN: rotation record NOT written]';
      console.error(
        `events-rotation: archived ${result.archivedAs} ` +
          `(${result.sizeBefore} bytes, ${result.lines ?? '?'} lines, ` +
          `${result.firstTs ?? 'unknown'} → ${result.lastTs ?? 'unknown'}${pruned})${ledger}`,
      );
    }
  } catch (err) {
    console.error(`events-rotation: skipped (${err?.message ?? err})`);
  }
}

// Top-level guard — always exit 0 (non-blocking informational hook).
// flushBanner() runs here too so a throw partway through main() still surfaces
// whatever was already collected; it is idempotent, so the normal path (which
// flushes at the end of main) does not double-emit.
//
// Entry guard (#1298 P7): every harness execs this file as the node script
// (`sh run-node.sh <this file>` → `exec node "$@"`), so argv[1] IS this module
// on every real path. A bare `import()` — a probe, a test, a curious agent —
// must not run main() against the live repo: incident W4-FX1 overwrote
// `.orchestrator/current-session.json` exactly that way.
if (isMainModule(import.meta.url)) {
  // #1393: the profile gate sits INSIDE the entry guard — at module top level
  // its `process.exit(0)` exited every process that merely imported this hook.
  if (!shouldRunHook('on-session-start')) process.exit(0);
  main().catch(() => {}).finally(() => {
    flushBanner();
    process.exit(0);
  });
}
