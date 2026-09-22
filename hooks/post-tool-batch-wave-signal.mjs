#!/usr/bin/env node
/**
 * post-tool-batch-wave-signal.mjs — PostToolBatch hook.
 *
 * Hook event: PostToolBatch (issue #342).
 * Fires after a batch of tool invocations completes within a single wave
 * turn. Writes a deterministic `last_batch` signal into
 * `.orchestrator/current-session.json` so skills and the coordinator can
 * observe batch-resolution boundaries without parsing the full event log.
 *
 * Also refreshes the session-lock heartbeat (Epic #583, W3-P3 wiring of
 * W2-I3 OQ2). The PostToolBatch event fires on a much more frequent cadence
 * than session-start / inter-wave / session-end, which keeps the heartbeat
 * within the TTL window even during long-running waves. The call is
 * try/catch-wrapped — a heartbeat-refresh failure must never block the
 * coordinator at a tool-batch boundary.
 *
 * Decision flow:
 *   1. shouldRunHook gate — exit 0 immediately when the hook is disabled.
 *   2. Read JSON payload from stdin:
 *        { batch_id, batch_size, batch_completed_at, agent_id?, parent_session_id? }
 *   3. Atomic read-modify-write of .orchestrator/current-session.json:
 *        set `last_batch` to
 *        { batch_id, batch_size, completed_at, agent_id?, parent_session_id? }
 *        (always overwrites — last batch wins, one record per session file).
 *   4. Best-effort: refresh session.lock `last_heartbeat` via updateHeartbeat()
 *      using the session_id read back from current-session.json (or stdin).
 *   5. Output: nothing on stdout. Diagnostic errors to stderr only.
 *
 * Exit codes: 0 always (informational, never blocking).
 *
 * OWNERSHIP RULE for the wave keys (#1193 W4c Q1-MED). `.orchestrator/` is
 * repo-global, so `current-session.json` describes whichever session most
 * recently ran SessionStart — routinely a DIFFERENT, still-live session when
 * two windows share this working copy. `last_wave` and `last_wave_completed`
 * are therefore written ONLY when this batch's RAW stdin `session_id` equals
 * the file's `session_id` (a file without one is legacy and allowed). Writing
 * them unguarded was reproduced both ways with the real hook binaries: session
 * A's batch stamped `last_wave_completed` into B's record, so B's own attested
 * SessionEnd stayed silent (the #1193 gap preserved on B), and A's `last_wave`
 * landed in B's record, so B's SessionEnd emitted `wave.completed` for A's wave
 * under B's identity. `last_batch` stays UNGATED — it is a batch-resolution
 * breadcrumb, not a claim about whose wave lifecycle this is.
 *
 * DIFF-SIZE MEASUREMENT (#980). The mechanical fallback below persists
 * `wave_start_sha` (`git rev-parse HEAD`, best-effort) at every wave-OPEN
 * transition and attaches `files_changed` + `files_changed_source:
 * 'worktree-vs-wave-start-sha'` to the `orchestrator.wave.completed` it emits
 * for the wave that sha opened. `files_changed` counts the DEDUPED union of
 * `git diff --name-only <wave_start_sha>` (working tree vs the wave's start
 * commit — the coordinator normally commits only at close, so uncommitted
 * edits must count) and `git ls-files --others --exclude-standard` (untracked).
 * Every git call is best-effort with a 1.5 s timeout; any failure, or a missing
 * `wave_start_sha`, OMITS the key — the convergence-monitor reader treats an
 * absent key as null and the `shrinking_diff` signal simply does not fire.
 * `wave_start_sha` is written under the SAME ownership gate as the wave keys.
 * OUT OF SCOPE: `hooks/on-session-end.mjs`'s final-wave `.completed` carries no
 * `files_changed` — no wave-open transition runs there, so it has no start sha.
 *
 * MONOTONICITY RULE (#1193 W4c Q3-MED-3). Three writers touch
 * `last_wave_completed` (this hook's explicit branch, this hook's fallback,
 * `hooks/on-session-end.mjs`). Every one of them writes through `maxWave()`,
 * so the mark can only ever rise — an explicit `wave-complete{5}` arriving
 * while `last_wave` is 4 must not be walked BACKWARDS to 4 by a later writer.
 *
 * hooks.json wiring is managed separately (W3-C4 scope).
 */

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { isMainModule } from '../scripts/lib/is-main-module.mjs';

import { getProjectDir } from '../scripts/lib/platform.mjs';
import { emitEvent } from '../scripts/lib/events.mjs';
import { findScopeFile } from '../scripts/lib/scope-gate.mjs';
import { atomicMutateJson } from './_lib/atomic-json.mjs';
import { _parseReaper } from '../scripts/lib/config/reaper.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read stdin to EOF (best-effort). Returns parsed JSON or null on failure.
 * Uses a 5 s timeout consistent with Claude Code hook contract.
 *
 * @returns {Promise<object|null>}
 */
function readStdinJson() {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded || process.stdin.closed) {
      resolve(null);
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => { resolve(null); }, 5_000);
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
 * Resolve the session-id for the heartbeat refresh.
 * Precedence:
 *   1. stdin payload `session_id` / `sessionId` field (Claude Code contract).
 *   2. parent_session_id from stdin (sub-agent batches).
 *   3. `.orchestrator/current-session.json` (`session_id` written by
 *      on-session-start.mjs).
 * Returns null when no id can be resolved.
 *
 * @param {object|null} input  Parsed stdin payload (may be null).
 * @param {string} sessionFile Absolute path to current-session.json.
 * @returns {Promise<string|null>}
 */
async function resolveSessionIdForHeartbeat(input, sessionFile) {
  if (input) {
    if (typeof input.session_id === 'string' && input.session_id.length > 0) {
      return input.session_id;
    }
    if (typeof input.sessionId === 'string' && input.sessionId.length > 0) {
      return input.sessionId;
    }
    if (typeof input.parent_session_id === 'string' && input.parent_session_id.length > 0) {
      return input.parent_session_id;
    }
  }
  try {
    const raw = await readFile(sessionFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
      return parsed.session_id;
    }
  } catch { /* missing or unparseable is fine */ }
  return null;
}

/**
 * Monotone high-water helper — see the MONOTONICITY RULE in the module
 * docblock. A non-integer `existing` (absent, `null`, or the string `'3'` a
 * hand-edited file can carry) counts as ABSENT, never as a competing value.
 *
 * @param {unknown} existing
 * @param {number} n
 * @returns {number}
 */
function maxWave(existing, n) {
  return Number.isInteger(existing) && existing > n ? existing : n;
}

/**
 * Does THIS batch own `.orchestrator/current-session.json`?
 * See the OWNERSHIP RULE in the module docblock for why the wave keys need it.
 *
 * Decided on the RAW stdin id only — deliberately NOT via
 * `resolveSessionIdForHeartbeat()`, whose current-session.json fallback would
 * make the compare self-fulfilling (the same F-A defect fixed in
 * `hooks/on-session-end.mjs`: an assertion may never be derived from the value
 * it asserts about). A file carrying no `session_id` is a legacy/pre-#587
 * record with no owner to contend with → allowed.
 *
 * @param {object|null} input      Parsed stdin payload.
 * @param {string} sessionFile     Absolute path to current-session.json.
 * @returns {Promise<boolean>}
 */
async function ownsSessionFile(input, sessionFile) {
  let rawStdinId = null;
  if (typeof input?.session_id === 'string' && input.session_id.length > 0) {
    rawStdinId = input.session_id;
  } else if (typeof input?.sessionId === 'string' && input.sessionId.length > 0) {
    rawStdinId = input.sessionId;
  }

  let recordedId = null;
  try {
    const parsed = JSON.parse(await readFile(sessionFile, 'utf8'));
    if (typeof parsed?.session_id === 'string' && parsed.session_id.length > 0) {
      recordedId = parsed.session_id;
    }
  } catch { /* absent or unparseable → no recorded owner */ }

  if (recordedId === null) return true;
  return rawStdinId !== null && rawStdinId === recordedId;
}

/**
 * Resolve the current wave number from the wave-scope manifest's `.wave`.
 * Returns 0 when the file is absent or unparseable, mirroring the
 * pre-bash-memory-propose-audit.mjs G5 precedent ("wave defaults to 0 when
 * wave-scope.json absent"). The file is deleted mid-session at Quality phase
 * transitions and final cleanup, so absence is an expected, non-error state.
 *
 * The manifest is located via `findScopeFile()` (#1082), the same precedence
 * every other consumer uses — `.pi` > `.cursor` > `.codex` > `.claude`. The
 * previous hard-coded `.claude/` path made this hook's whole wave-lifecycle
 * fallback structurally dead on Codex CLI, Cursor and pi: the manifest exists,
 * it just is not under `.claude/`, so every batch read 0 and no
 * wave-lifecycle event was ever emitted there.
 *
 * @param {string} projectDir
 * @returns {Promise<number>}
 */
async function resolveWaveNumber(projectDir) {
  const waveFile = findScopeFile(projectDir);
  if (waveFile === null) return 0;
  try {
    const raw = await readFile(waveFile, 'utf8');
    const data = JSON.parse(raw);
    const wave = data?.wave;
    return typeof wave === 'number' ? wave : 0;
  } catch {
    // Absent or unparseable — treat as 0 (no active wave).
    return 0;
  }
}

/**
 * The only environment variables forwarded to the `git` children below.
 * Everything else — `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR` above all — is
 * dropped, so an ambient redirect cannot make these probes measure a FOREIGN
 * repository while `cwd` points at this one (`GIT_DIR` outranks `cwd`; that is
 * exactly the 2026-08-19 redirect incident class).
 *
 * Same 6-entry allowlist as `scripts/lib/git-config-drift.mjs:170` and
 * `check-banner-parity.mjs:63`, COPIED rather than imported on purpose: this is
 * a live hook, and importing a scripts/lib module for six strings would add an
 * edge to the hook import graph (`hooks/_lib/hook-import-set.json`) for no
 * behavioural gain — the constant is cheaper to copy than a shared module is to
 * maintain (BV-001, the same call git-config-drift.mjs documents).
 */
const GIT_ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ']);

/** @returns {Record<string,string>} the allowlisted subset of `process.env`. */
function filteredGitEnv() {
  /** @type {Record<string,string>} */
  const out = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Shared spawn options for the best-effort git probes below (#980). */
const GIT_OPTS = (projectDir) => ({
  cwd: projectDir,
  encoding: 'utf8',
  timeout: 1_500,
  stdio: ['ignore', 'pipe', 'ignore'],
  env: filteredGitEnv(),
});

/**
 * `git rev-parse HEAD` in `projectDir`, best-effort (#980).
 * Returns null on ANY failure — not a git repo, detached/empty HEAD, timeout,
 * git absent. A null is persisted as null so a STALE sha from the previous wave
 * can never be mistaken for this wave's start point.
 *
 * @param {string} projectDir
 * @returns {string|null}
 */
function readHeadSha(projectDir) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], GIT_OPTS(projectDir)).trim();
    return /^[0-9a-f]{40}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Count the files this wave touched: the DEDUPED union of the working tree's
 * diff against `sha` and the untracked (non-ignored) files (#980).
 *
 * Working-tree-vs-sha rather than `sha..HEAD` on purpose: the coordinator
 * commits at session close, not per wave, so a commit-only diff reads 0 for
 * every wave of a normal session.
 *
 * @param {string} projectDir
 * @param {unknown} sha  Persisted `wave_start_sha` (may be null/absent).
 * @returns {number|null} null when unmeasurable — caller OMITS the key.
 */
function countFilesChangedSince(projectDir, sha) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) return null;
  try {
    const opts = GIT_OPTS(projectDir);
    const tracked = execFileSync('git', ['diff', '--name-only', sha], opts);
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], opts);
    const paths = new Set(
      `${tracked}\n${untracked}`.split('\n').map((l) => l.trim()).filter((l) => l.length > 0),
    );
    return paths.size;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// orphan-reaper trigger (#1432 B4)
// ---------------------------------------------------------------------------
//
// DUPLICATED VERBATIM in hooks/on-stop.mjs. Deliberate, with a named revisit
// trigger (BV-004): the two hooks are the only two trigger points the PRD
// declares, and a shared `hooks/_lib/reaper-trigger.mjs` would be a third file
// in the hook import graph for ~40 lines of glue. Extract it the moment a THIRD
// hook needs the trigger, or the moment the two copies need to differ.

/**
 * Filesystem path of the scan CLI, spawned as a PLAIN argv call.
 *
 * It used to be a `file://` URL handed to `node --input-type=module -e
 * <program>`, because `scripts/lib/orphan-reaper.mjs` had no entry guard. It
 * has one now (`parseReaperCliArgs` + the `isMainModule` tail), so the child's
 * contract lives in that module instead of as source text duplicated here —
 * and nothing this hook builds is a program any more: every variable part is
 * an argv value, which cannot become code whatever the checkout path contains.
 *
 * `fileURLToPath`, not `new URL(...).pathname`: the latter leaves a
 * percent-encoded path for any checkout directory containing a space.
 */
const ORPHAN_REAPER_SCRIPT = fileURLToPath(
  new URL('../scripts/lib/orphan-reaper.mjs', import.meta.url),
);

/**
 * Read the `reaper:` block from the project's Session Config host file.
 * Sync + inline, mirroring `hooks/loop-guard.mjs` `loadConfig()` — a hot hook
 * path must not import the full config orchestrator. A missing or unreadable
 * file yields the parser defaults, i.e. DISABLED.
 *
 * @param {string} projectDir
 * @returns {ReturnType<typeof _parseReaper>}
 */
function loadReaperConfig(projectDir) {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      return _parseReaper(readFileSync(path.join(projectDir, name), 'utf8'));
    } catch {
      // missing or unreadable — try the next candidate
    }
  }
  return _parseReaper('');
}

/**
 * Trigger the orphan scan, throttled and NON-BLOCKING (PRD FA4).
 *
 * The hook itself does exactly two pieces of I/O — one config read and one
 * `stat` of the throttle marker — and then hands the work to a DETACHED,
 * unref'd child. The scan is never run inline: one `ps` round-trip out of Node
 * was measured at ~47 ms over 287 KB of output, which alone would blow the
 * 50 ms `reaper.max-hook-latency-ms` budget this hook has to stay inside.
 *
 * The marker is stamped BEFORE the spawn, so a spawn that fails still consumes
 * the throttle window — otherwise a broken spawn would be retried on every
 * single tool batch.
 *
 * Never throws: any failure degrades silently (PRD FA4 "lautlos degradieren").
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir]  Repo root; defaults to `getProjectDir()`.
 * @param {number} [opts.now]         Injected clock (ms).
 * @param {Function} [opts.spawnFn]   Injected `spawn` (tests).
 * @param {Function} [opts.statFn]    Injected `statSync` (tests).
 * @param {Function} [opts.writeFn]   Injected marker writer (tests).
 * @returns {Promise<{spawned: boolean, reason: string}>}
 */
export async function maybeTriggerOrphanScan({
  projectDir,
  now,
  spawnFn = spawn,
  statFn,
  writeFn,
} = {}) {
  try {
    const root = typeof projectDir === 'string' && projectDir ? projectDir : getProjectDir();
    const cfg = loadReaperConfig(root);
    // Cheapest gate first: disabled means no stat, no spawn, no module load.
    if (cfg.enabled !== true) return { spawned: false, reason: 'disabled' };

    const reaper = await import('../scripts/lib/orphan-reaper.mjs');
    const markerPath = reaper.scanMarkerPath(root);
    const nowMs = typeof now === 'number' ? now : Date.now();

    if (!reaper.shouldScanNow(markerPath, nowMs, cfg['min-scan-interval-seconds'], { statFn })) {
      return { spawned: false, reason: 'throttled' };
    }
    reaper.touchScanMarker(markerPath, { writeFn });

    const child = spawnFn(
      process.execPath,
      [
        ORPHAN_REAPER_SCRIPT,
        '--repo-root', root,
        '--mode', cfg.mode,
        '--min-age-seconds', String(cfg['min-age-seconds']),
        '--kill-grace-ms', String(cfg['kill-grace-ms']),
        '--verify-wait-ms', String(cfg['verify-wait-ms']),
      ],
      { detached: true, stdio: 'ignore' },
    );
    if (child && typeof child.unref === 'function') child.unref();
    return { spawned: true, reason: 'spawned' };
  } catch {
    return { spawned: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdinJson();

  // Extract fields from the hook payload.
  const batchId = typeof input?.batch_id === 'string' ? input.batch_id : null;
  const batchSize =
    typeof input?.batch_size === 'number' ? input.batch_size : null;
  const completedAt =
    typeof input?.batch_completed_at === 'string'
      ? input.batch_completed_at
      : new Date().toISOString();
  const agentId =
    typeof input?.agent_id === 'string' ? input.agent_id : undefined;
  const parentSessionId =
    typeof input?.parent_session_id === 'string'
      ? input.parent_session_id
      : undefined;
  // wave_signal is set by the orchestrator when a wave completes.
  const waveSignal =
    typeof input?.wave_signal === 'string' ? input.wave_signal : null;
  const nextWaveRole =
    typeof input?.next_wave_role === 'string' ? input.next_wave_role : null;
  const waveNumber =
    typeof input?.wave_number === 'number' ? input.wave_number : null;

  // Build the last_batch signal. Only include optional fields when present
  // to keep the session file lean.
  const lastBatch = {
    batch_id: batchId,
    batch_size: batchSize,
    completed_at: completedAt,
    ...(agentId !== undefined ? { agent_id: agentId } : {}),
    ...(parentSessionId !== undefined ? { parent_session_id: parentSessionId } : {}),
    ...(waveSignal !== null ? { wave_signal: waveSignal } : {}),
  };

  const sessionFile = path.join(getProjectDir(), '.orchestrator', 'current-session.json');

  const lastBatchResult = await atomicMutateJson(sessionFile, {}, (current) => ({
    ...current,
    last_batch: lastBatch,
  }), 'ptb');
  // Non-ENOENT failure only drops this turn's last_batch signal — the
  // heartbeat refresh and wave-lifecycle logic below are independent and
  // must still run (a throw here would silently skip both).
  if (!lastBatchResult.ok) {
    console.error(`post-tool-batch-wave-signal: last_batch write skipped (${lastBatchResult.reason})`);
  }

  // ----------------------------------------------------------------------
  // Heartbeat refresh (Epic #583 W3-P3, wires W2-I3 OQ2).
  // ----------------------------------------------------------------------
  // The session.lock liveness rule is heartbeat-based (Epic #583, W2-I3):
  //   (now - last_heartbeat) < ttl_hours
  // The default TTL is 4h; PostToolBatch fires far more often than that,
  // so refreshing here keeps every active session perpetually live to
  // discoverActiveSessions() while a coordinator is making tool calls.
  // Resolve the session-id from stdin first, falling back to the just-
  // written current-session.json so the refresh stays decoupled from the
  // hook payload shape. Wrapped in try/catch — same defence-in-depth
  // posture as the rest of this hook (must NEVER block).
  try {
    const sessionId = await resolveSessionIdForHeartbeat(input, sessionFile);
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      const { updateHeartbeat } = await import('../scripts/lib/session-lock.mjs');
      updateHeartbeat({ repoRoot: getProjectDir(), sessionId });
    }
  } catch { /* best effort — hook must remain non-blocking */ }

  // Emit the wave-completion event via the canonical stream when the
  // orchestrator populates wave_signal 'wave-complete'. Mechanical seam — see
  // docs/events-schema.md. Best-effort; never blocks the hook. A 'wave-start'
  // signal is still ACCEPTED — it keeps suppressing the fallback below, as
  // before — but emits nothing: the `started` sibling event was removed
  // 2026-09-19, having no reader once the convergence monitor stopped
  // admitting it.
  //
  // Live path today: the `wave_signal === null` branch below provides the
  // mechanical wave-lifecycle fallback (#612). It fires live by diffing
  // `.claude/wave-scope.json` `.wave` against the persisted `last_wave` — no
  // payload injection required. This explicit-signal branch remains as the
  // preferred path for whenever the harness DOES inject `wave_signal` into the
  // batch payload (it takes precedence over the fallback when present).
  if (waveSignal === 'wave-complete') {
    try {
      await emitEvent('orchestrator.wave.completed', {
        ...(waveNumber !== null ? { wave_number: waveNumber } : {}),
        ...(nextWaveRole !== null ? { next_wave_role: nextWaveRole } : {}),
        ...(batchId !== null ? { batch_id: batchId } : {}),
        ...(batchSize !== null ? { batch_size: batchSize } : {}),
      });
      // #1193 review F2 — this branch is a SECOND emitter of
      // `wave.completed`, so it must feed the same high-water mark the other
      // two read; otherwise SessionEnd (and the fallback below) would close the
      // very wave this signal just closed. Only a numbered completion can be
      // recorded — an unnumbered signal marks nothing.
      //
      // W4c Q2-F1 — this branch also advances `last_wave`. Without it an
      // explicit `wave-complete{5}` left the marker AHEAD of `last_wave: 4`,
      // and SessionEnd then read `4 !== 5`, emitted a duplicate completed(4)
      // and walked the marker BACKWARDS to 4. Both keys go through maxWave().
      // W4c Q1-MED — and neither is written into a PEER's record.
      if (
        typeof waveNumber === 'number'
        && waveNumber > 0
        && await ownsSessionFile(input, sessionFile)
      ) {
        const waveResult = await atomicMutateJson(sessionFile, {}, (current) => ({
          ...current,
          last_wave: maxWave(current?.last_wave, waveNumber),
          last_wave_completed: maxWave(current?.last_wave_completed, waveNumber),
        }), 'ptb');
        if (!waveResult.ok) {
          console.error(`post-tool-batch-wave-signal: last_wave write skipped (${waveResult.reason})`);
        }
      }
    } catch { /* best-effort — hook must remain non-blocking */ }
  } else if (waveSignal === null) {
    // ------------------------------------------------------------------
    // Mechanical wave-lifecycle fallback (#612, Option b).
    // ------------------------------------------------------------------
    // When the harness does NOT inject an explicit wave_signal (the common
    // case today — nothing populates it), detect wave boundaries from the
    // coordinator-written .claude/wave-scope.json `.wave` number, diffed
    // against `last_wave` persisted in current-session.json. The explicit
    // path above takes precedence — this branch only runs when wave_signal
    // is absent (backward-compatible).
    //
    // Only a STRICT INCREASE (wave > last_wave AND wave > 0) is a real wave
    // boundary. wave-scope.json is deleted mid-session at Quality phase
    // transitions and final cleanup, so resolveWaveNumber() returns 0 in
    // those windows — a drop to 0 (or any non-increase) is NOT a wave change
    // and is ignored, preventing spurious emissions on every batch.
    //
    // Final wave (#1193): no N+1 transition exists for the LAST wave, so its
    // `completed` is emitted by `hooks/on-session-end.mjs` at SessionEnd, not
    // here — and not by the coordinator, which never did (the prose claim this
    // comment used to make was false from #612 until #1193, costing exactly one
    // missing completion per wave run fleet-wide). The two emitters are made
    // idempotent by the `last_wave_completed` high-water mark persisted below:
    // when an N+1 transition already closed wave N, SessionEnd sees
    // last_wave_completed === last_wave and stays silent.
    try {
      const wave = await resolveWaveNumber(getProjectDir());
      if (wave > 0) {
        // Read last_wave from the just-written session file (after the
        // last_batch RMW above, so we observe the latest persisted value).
        let lastWave = 0;
        let lastWaveCompleted = 0;
        let waveStartSha = null;
        try {
          const raw = await readFile(sessionFile, 'utf8');
          const parsed = JSON.parse(raw);
          if (typeof parsed.last_wave === 'number') lastWave = parsed.last_wave;
          // #980 — the sha persisted when THIS `last_wave` was opened.
          if (typeof parsed.wave_start_sha === 'string') waveStartSha = parsed.wave_start_sha;
          // #1193 review F2 — read in the SAME read as `last_wave`: a `/clear`
          // mid-wave already emitted `completed(lastWave)` via SessionEnd, and
          // `on-session-start.mjs` preserves that marker across the restart, so
          // guarding on `wave > lastWave` alone would emit it a second time.
          if (Number.isInteger(parsed.last_wave_completed)) {
            lastWaveCompleted = parsed.last_wave_completed;
          }
        } catch { /* absent/unparseable → both stay 0 */ }

        if (wave > lastWave) {
          // Close the prior wave first — unless it was already closed. The
          // compare is `>` and not `!==` (W4c Q3-MED-3): a marker AHEAD of
          // `last_wave` (an explicit wave-complete for a higher wave) means the
          // prior wave is already closed too, and a non-integer marker counts
          // as absent rather than as "different".
          if (lastWave > lastWaveCompleted) {
            // #980 — measure the closing wave's diff size BEFORE the new wave's
            // start sha is persisted below. Unmeasurable → both keys omitted.
            const filesChanged = countFilesChangedSince(getProjectDir(), waveStartSha);
            await emitEvent('orchestrator.wave.completed', {
              wave_number: lastWave,
              ...(filesChanged !== null
                ? {
                  files_changed: filesChanged,
                  files_changed_source: 'worktree-vs-wave-start-sha',
                }
                : {}),
              ...(batchId !== null ? { batch_id: batchId } : {}),
              ...(batchSize !== null ? { batch_size: batchSize } : {}),
            });
          }
          // Open the new wave. There is no event for this (the `started`
          // sibling was removed 2026-09-19); opening IS the high-water marks
          // persisted below, so the next batch does not re-close the prior
          // wave, and SessionEnd can tell whether it was already closed here
          // (#1193). `last_wave_completed` is only advanced when a `completed`
          // was actually emitted above (lastWave > 0).
          // W4c Q1-MED — never stamp these into a PEER session's record. The
          // event above is still emitted (it carries THIS session's
          // attribution via emitEvent); only the shared-file claim is withheld.
          // NAMED CEILING: for a non-owning session the marks therefore never
          // advance, so each of its batches re-emits completed{lastWave} while
          // the file's `last_wave` is ahead of its `last_wave_completed`, until
          // that session's own SessionStart takes over the file. The revisit
          // trigger (repeated emissions for one wave) HAS FIRED — measured
          // 2026-09-19 @ 8f6ac022 over this repo's
          // `.orchestrator/metrics/events.jsonl{.1,}`, timestamps >= 2026-09-12,
          // grouped by (session_id, wave_number) with jq:
          //   started   — 1936 emissions / 48 groups, 19 duplicated, max 274
          //   completed —  650 emissions / 28 groups,  2 duplicated, max 579
          // The `started` half is GONE (#1202 §11): its only reader,
          // `scripts/lib/convergence-monitor.mjs`, no longer admits it — it
          // carried no measurement and, sharing a tail tick with completed{N},
          // masked the (N-1, N) shrinking_diff pair. The `completed` half is
          // OPEN: that event has readers, so the fix is a mark a non-owning
          // session can keep for itself, not a removal.
          if (await ownsSessionFile(input, sessionFile)) {
            // #980 — the OPEN half: stamp the sha this new wave starts from.
            // Written as null (not omitted) when git is unreadable, so the
            // PREVIOUS wave's sha can never linger and inflate the next count.
            const startSha = readHeadSha(getProjectDir());
            const markResult = await atomicMutateJson(sessionFile, {}, (current) => ({
              ...current,
              wave_start_sha: startSha,
              last_wave: maxWave(current?.last_wave, wave),
              ...(Math.max(lastWave, lastWaveCompleted) > 0
                ? {
                  last_wave_completed: maxWave(
                    current?.last_wave_completed,
                    Math.max(lastWave, lastWaveCompleted),
                  ),
                }
                : {}),
            }), 'ptb');
            if (!markResult.ok) {
              console.error(`post-tool-batch-wave-signal: last_wave mark skipped (${markResult.reason})`);
            }
          }
        }
      }
    } catch { /* best-effort — hook must remain non-blocking */ }
  }

  // If a wave-complete signal is present, surface it as additionalContext so
  // Claude sees the state change at the next turn boundary.
  // PostToolBatch hookSpecificOutput shape per CC docs:
  //   { hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "<string>" } }
  if (waveSignal === 'wave-complete') {
    const waveLabel = waveNumber !== null ? `Wave ${waveNumber}` : 'Wave';
    const nextRole = nextWaveRole ?? 'unknown';
    const context = `${waveLabel} complete. Next agent role: ${nextRole}. ` +
      `Batch ${batchId ?? 'n/a'} (${batchSize ?? 'n/a'} tools) resolved at ${completedAt}.`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolBatch',
        additionalContext: context,
      },
    }));
  }

  // Orphan-reaper trigger (#1432 B4). LAST, after this hook's own contract is
  // fulfilled — the stdout envelope above must never wait on the watchdog.
  // Awaited (not fired and forgotten) because the entry guard calls
  // `process.exit(0)` in a `finally`: an un-awaited spawn would race the exit.
  // The await is bounded by design — one config read, one stat, one detached
  // spawn, all measured under `reaper.max-hook-latency-ms` (50 ms).
  await maybeTriggerOrphanScan();
}

// Entry guard (#1393): run only as the node script the harness execs — a bare
// `import()` must run no handler and must not exit the importing process.
if (isMainModule(import.meta.url)) {
  // Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
  if (!shouldRunHook('post-tool-batch-wave-signal')) process.exit(0);

  // Exit 0 always — informational hook must never block Claude.
  main().catch(() => {}).finally(() => process.exit(0));
}
