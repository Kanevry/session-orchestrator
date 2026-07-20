#!/usr/bin/env node
/**
 * skill-invocation-telemetry.mjs — PreToolUse hook for Skill tool selection.
 *
 * Hook event: PreToolUse with matcher:"Skill" (issue #645, epic #643).
 * Fires when the Skill tool is invoked (a skill is selected). Writes a
 * selection record to `.orchestrator/metrics/skill-invocations.jsonl`.
 *
 * Decision flow (when run as the hook, not imported):
 *   1. shouldRunHook gate — exit 0 immediately when the hook is disabled.
 *   2. Read JSON payload from stdin: { tool_name, tool_input: { skill }, session_id }.
 *   3. Belt-and-suspenders guard: if tool_name !== "Skill", exit 0 immediately.
 *   4. Build a 'selected' record and call appendSkillInvocation().
 *   5. Daily-fallback telemetry flush check (Epic #841, #844) — non-blocking:
 *      when a bounded offline queue has aged past 24h AND consent resolves to
 *      send, spawn a detached child that runs `telemetry _flush`. Cheap by
 *      construction (env kill-switch pre-check → queue+state stat → consent)
 *      and never loads the roster on the hot hook path.
 *   6. Output: nothing on stdout. Diagnostic errors to stderr only.
 *
 * Exit codes: 0 always (informational, never blocking).
 *
 * The module is import-safe: the self-execution block below is guarded so that a
 * test can `import { maybeSpawnDailyFlush }` without triggering the hook's
 * stdin-read + exit path.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { appendSkillInvocation } from '../scripts/lib/skill-invocations-schema.mjs';
import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';
import { shouldDailyFlush } from '../scripts/lib/telemetry/sync.mjs';
import { resolveConsent, readTelemetryState } from '../scripts/lib/telemetry/consent.mjs';
import { loadOwnerConfig } from '../scripts/lib/owner-yaml.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JSONL_PATH = path.join(SO_PROJECT_DIR, '.orchestrator', 'metrics', 'skill-invocations.jsonl');

/** Absolute path to the telemetry CLI (carries the hidden `_flush` subcommand). */
const TELEMETRY_CLI_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/telemetry.mjs',
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when an env var carries a truthy "on" signal (present, non-empty, not
 * '0'/'false'). Kept local so the hook does not pull anything extra from consent.mjs.
 * @param {unknown} raw
 * @returns {boolean}
 */
function isTruthyEnvFlag(raw) {
  if (raw === undefined || raw === null) return false;
  const t = String(raw).trim();
  if (t === '' || t === '0') return false;
  return t.toLowerCase() !== 'false';
}

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
 * Non-blocking daily-fallback flush trigger. Ordered cheapest-first:
 *   1. env kill-switches (no I/O) — DO_NOT_TRACK / SO_TELEMETRY_DISABLED.
 *   2. shouldDailyFlush (one telemetry.json read + one queue stat) — the common
 *      case (empty queue) returns here WITHOUT loading owner.yaml or the roster.
 *   3. full consent resolution — spawn a detached `telemetry _flush` only when it
 *      resolves to send.
 *
 * Never throws; the caller's hook must always exit 0.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]  Env source (default process.env).
 * @param {typeof spawn} [opts.spawnFn]   Spawn function (test injection).
 * @param {number} [opts.now]             Reference time epoch-ms (default Date.now()).
 * @param {string} [opts.statePath]       telemetry.json path override (test injection).
 * @param {string} [opts.queuePath]       queue path override (test injection).
 * @returns {{ spawned: boolean, reason: string }}
 */
export function maybeSpawnDailyFlush({
  env = process.env,
  spawnFn = spawn,
  now = Date.now(),
  statePath,
  queuePath,
} = {}) {
  try {
    // 1. Cheapest gate: env kill-switches, no file I/O.
    if (isTruthyEnvFlag(env?.DO_NOT_TRACK) || env?.SO_TELEMETRY_DISABLED === '1') {
      return { spawned: false, reason: 'disabled-env' };
    }

    // 2. Cheap backlog check — bails out before owner.yaml load in the common case.
    if (!shouldDailyFlush({ statePath, queuePath, now })) {
      return { spawned: false, reason: 'not-due' };
    }

    // 3. Authoritative consent gate.
    const ownerConfig = loadOwnerConfig().config;
    const { record } = readTelemetryState({ path: statePath });
    const consent = resolveConsent({ env, ownerConfig, state: record, interactive: false });
    if (consent.send !== true) {
      return { spawned: false, reason: 'gated' };
    }

    const child = spawnFn(process.execPath, [TELEMETRY_CLI_PATH, '_flush'], {
      detached: true,
      stdio: 'ignore',
    });
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
  if (!input) return;

  // Belt-and-suspenders: the hooks.json matcher:"Skill" should already filter,
  // but we guard defensively in case of misconfiguration or future matcher changes.
  if (input.tool_name !== 'Skill') return;

  const skillName = (typeof input.tool_input?.skill === 'string' && input.tool_input.skill.trim())
    ? input.tool_input.skill.trim()
    : 'unknown';

  const sessionId = (typeof input.session_id === 'string' && input.session_id.trim())
    ? input.session_id.trim()
    : null;

  /** @type {object} */
  const record = {
    timestamp: new Date().toISOString(),
    event: 'selected',
    skill: skillName,
    session_id: sessionId,
    schema_version: 1,
  };

  await appendSkillInvocation(JSONL_PATH, record);

  // Daily-fallback telemetry flush — non-blocking, best-effort, never throws.
  maybeSpawnDailyFlush();
}

// ---------------------------------------------------------------------------
// Self-execution guard — run only when invoked directly (not when imported).
// ---------------------------------------------------------------------------

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  // Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
  if (!shouldRunHook('skill-invocation-telemetry')) process.exit(0);

  // Exit 0 always — informational hook must never block the Skill tool.
  main().catch((err) => {
    process.stderr.write(`[skill-invocation-telemetry] ERROR: ${err?.message ?? err}\n`);
  }).finally(() => process.exit(0));
}
