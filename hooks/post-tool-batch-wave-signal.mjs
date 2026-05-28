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
 * hooks.json wiring is managed separately (W3-C4 scope).
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('post-tool-batch-wave-signal')) process.exit(0);

import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';
import { emitEvent } from '../scripts/lib/events.mjs';

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
 * Atomic read-modify-write of a JSON file via temp + rename.
 * Reads the existing file (or starts with `defaultValue` when absent),
 * applies `mutate`, writes to a tmp file, then renames over the original.
 * Atomic on POSIX (same-filesystem rename). Best-effort on Windows.
 *
 * @param {string} filePath
 * @param {object} defaultValue — used when the file does not exist or is unparseable
 * @param {function(object): object} mutate — synchronous pure transformer
 */
async function atomicMutateJson(filePath, defaultValue, mutate) {
  let current = defaultValue;
  try {
    const raw = await readFile(filePath, 'utf8');
    current = JSON.parse(raw);
  } catch {
    // File absent or unparseable — start from defaultValue.
  }

  const updated = mutate(current);
  const tmp = `${filePath}.tmp-ptb-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tmp, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  await rename(tmp, filePath);
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
 * Resolve the current wave number from .claude/wave-scope.json `.wave`.
 * Returns 0 when the file is absent or unparseable, mirroring the
 * pre-bash-memory-propose-audit.mjs G5 precedent ("wave defaults to 0 when
 * wave-scope.json absent"). The file is deleted mid-session at Quality phase
 * transitions and final cleanup, so absence is an expected, non-error state.
 *
 * @param {string} projectDir
 * @returns {Promise<number>}
 */
async function resolveWaveNumber(projectDir) {
  const waveFile = path.join(projectDir, '.claude', 'wave-scope.json');
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

  const sessionFile = path.join(SO_PROJECT_DIR, '.orchestrator', 'current-session.json');

  await atomicMutateJson(sessionFile, {}, (current) => ({
    ...current,
    last_batch: lastBatch,
  }));

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
      updateHeartbeat({ repoRoot: SO_PROJECT_DIR, sessionId });
    }
  } catch { /* best effort — hook must remain non-blocking */ }

  // Emit wave-lifecycle events via the canonical stream when the orchestrator
  // populates wave_signal ('wave-start' | 'wave-complete'). Mechanical seam —
  // see docs/events-schema.md. Best-effort; never blocks the hook.
  //
  // Live path today: the `wave_signal === null` branch below provides the
  // mechanical wave-lifecycle fallback (#612). It fires live by diffing
  // `.claude/wave-scope.json` `.wave` against the persisted `last_wave` — no
  // payload injection required. This explicit-signal branch remains as the
  // preferred path for whenever the harness DOES inject `wave_signal` into the
  // batch payload (it takes precedence over the fallback when present).
  if (waveSignal === 'wave-start' || waveSignal === 'wave-complete') {
    try {
      await emitEvent(
        waveSignal === 'wave-start'
          ? 'orchestrator.wave.started'
          : 'orchestrator.wave.completed',
        {
          ...(waveNumber !== null ? { wave_number: waveNumber } : {}),
          ...(nextWaveRole !== null ? { next_wave_role: nextWaveRole } : {}),
          ...(batchId !== null ? { batch_id: batchId } : {}),
          ...(batchSize !== null ? { batch_size: batchSize } : {}),
        },
      );
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
    // Final-wave limitation: the LAST wave never receives a `completed` event
    // here because there is no N+1 transition to trigger it. The coordinator
    // emits the final orchestrator.wave.completed at session close.
    try {
      const wave = await resolveWaveNumber(SO_PROJECT_DIR);
      if (wave > 0) {
        // Read last_wave from the just-written session file (after the
        // last_batch RMW above, so we observe the latest persisted value).
        let lastWave = 0;
        try {
          const raw = await readFile(sessionFile, 'utf8');
          const parsed = JSON.parse(raw);
          if (typeof parsed.last_wave === 'number') lastWave = parsed.last_wave;
        } catch { /* absent/unparseable → lastWave stays 0 */ }

        if (wave > lastWave) {
          // Close the prior wave first (only when there was one).
          if (lastWave > 0) {
            await emitEvent('orchestrator.wave.completed', {
              wave_number: lastWave,
              ...(batchId !== null ? { batch_id: batchId } : {}),
              ...(batchSize !== null ? { batch_size: batchSize } : {}),
            });
          }
          // Open the new wave.
          await emitEvent('orchestrator.wave.started', {
            wave_number: wave,
            ...(nextWaveRole !== null ? { next_wave_role: nextWaveRole } : {}),
            ...(batchId !== null ? { batch_id: batchId } : {}),
            ...(batchSize !== null ? { batch_size: batchSize } : {}),
          });
          // Persist the high-water mark so the next batch does not re-emit.
          await atomicMutateJson(sessionFile, {}, (current) => ({
            ...current,
            last_wave: wave,
          }));
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
}

// Exit 0 always — informational hook must never block Claude.
main().catch(() => {}).finally(() => process.exit(0));
