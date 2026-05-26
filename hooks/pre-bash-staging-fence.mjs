#!/usr/bin/env node
/**
 * pre-bash-staging-fence.mjs — PreToolUse Bash hook
 *
 * PSA-004 sub-mode C — staging-fence intent log for cross-agent `git add` race
 * detection (issue #552). Companion to hooks/wave-scope-commit-guard.mjs
 * (sub-mode B). Together the two guards cover:
 *
 *   sub-mode B  — lint-staged sweep that re-stages files outside wave-scope
 *                 (the existing guard, caught at pre-commit time).
 *   sub-mode C  — concurrent `git add` from two wave-agents on the same repo
 *                 (this hook records intent; the commit-guard reconciles at
 *                 commit time).
 *
 * Fence file
 * ----------
 * Path:  .orchestrator/staging-fence/<agent-id>.json
 * Shape:
 *   {
 *     "agent_id":    "string",          // ${SO_WAVE_AGENT}-${pid}-${rnd}
 *     "pid":         12345,
 *     "host":        "string",
 *     "started_at":  "2026-05-23T21:30:00.000Z",
 *     "staged_paths": [
 *       { "command": "git add src/foo.ts", "timestamp": "2026-…" },
 *       ...
 *     ]
 *   }
 *
 * The hook does NOT parse the `git add` argv into paths — argv parsing is
 * fragile (globs, pathspec magic, `-A`, `-u`, `--`). Instead it records the
 * raw command string; the commit-guard reconciles staged paths via
 * `git diff --cached --name-only` and cross-checks them against ALL sibling
 * fence files at commit time (where the staged set is unambiguous).
 *
 * Decision flow (G1-G6 early-return ladder):
 *   G1  tool filter — Bash only
 *   G2  command must be a non-empty string
 *   G3  regex match /\bgit\s+add\b/ — only `git add` invocations
 *   G4  context gate — isWaveAgentContext(); exit 0 immediately for
 *       coordinator/manual commits (AC5 safe-default no-op)
 *   G5  derive agent_id, build fence dir + path
 *   G6  read-modify-write the fence file (append the staging-intent entry).
 *       Errors are warned + swallowed — the hook NEVER blocks the Bash call.
 *
 * Bypass / disable
 * ----------------
 *   - SO_DISABLED_HOOKS=pre-bash-staging-fence  → exits 0 immediately
 *   - SO_HOOK_PROFILE=minimal|off               → exits 0 immediately
 *   - Coordinator-thread invocations            → exits 0 immediately (G4)
 *   - `git commit --no-verify`                  → bypasses the commit-guard
 *     entirely; sub-mode C reconciliation never runs (PSA-001/PSA-003 risk
 *     remains; the operator is opting out by name).
 *
 * Fail-safe posture: never blocks the Bash call, even on internal errors.
 * Worst case is a missed enforcement, not a wedged session.
 */

import { readStdin, emitAllow, writeJsonAtomicSync } from '../scripts/lib/io.mjs';
import { isWaveAgentContext } from '../scripts/lib/wave-context.mjs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { shouldRunHook } from './_lib/profile-gate.mjs';
if (!shouldRunHook('pre-bash-staging-fence')) process.exit(0);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Matches `git add ...` invocations with word boundaries on both sides so
 * `gitadd` and `git addremote` (hypothetical) do not match. Anchored to the
 * `git` token, so `echo "git add"` is not matched (echo ≠ verb position).
 *
 * We deliberately accept `git add` anywhere in the command string — operators
 * sometimes prefix env-vars (`GIT_COMMITTER_NAME=foo git add ...`) or chain
 * commands (`cd repo && git add ...`). False positives are tolerable here
 * (the hook only writes a log line, never blocks).
 */
const GIT_ADD_REGEX = /\bgit\s+add\b/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a per-agent identifier for the fence filename.
 *
 * Composition: `${SO_WAVE_AGENT}-${pid}-${rnd6hex}`.
 * - SO_WAVE_AGENT is always "1" inside a wave-agent context (per
 *   wave-context.mjs strict-equality contract), so the prefix is fixed.
 * - PID disambiguates concurrent agents on the same host.
 * - 6 hex chars (24 bits) defends against PID reuse within a long-running
 *   session, even though that race is vanishingly rare.
 *
 * The same PID may invoke `git add` repeatedly in one wave; the hook reads
 * the existing fence file (matched by composing the same agent_id), appends,
 * and rewrites. The random suffix is therefore frozen per process via
 * lazy-init: the first call computes it; subsequent calls reuse it.
 *
 * NOTE: Because each hook subprocess is a fresh Node process, the random
 * suffix is unique per `git add` invocation — there is no in-process cache
 * to reuse. We accept N fence files per agent (one per `git add` call) and
 * the commit-guard scans ALL fence files at commit time.
 *
 * @returns {string}
 */
function deriveAgentId() {
  const waveAgent = process.env.SO_WAVE_AGENT ?? '1';
  const pid = process.pid;
  const rnd = crypto.randomBytes(3).toString('hex');
  return `${waveAgent}-${pid}-${rnd}`;
}

/**
 * Resolve the project directory the hook should operate against. Mirrors
 * pre-bash-memory-propose-audit.mjs resolution: prefer CLAUDE_PROJECT_DIR /
 * CODEX_PROJECT_DIR env-vars, fall back to cwd.
 *
 * @returns {string}
 */
function resolveProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR
    ?? process.env.CODEX_PROJECT_DIR
    ?? process.cwd();
}

/**
 * Append a staging-intent entry to the fence file. Reads the existing file
 * (if any), appends the entry, and rewrites atomically via the shared
 * {@link writeJsonAtomicSync} helper from scripts/lib/io.mjs (extracted in
 * #558 M1). The first call for a given agent_id creates the file with a
 * fresh body.
 *
 * @param {{ fenceFile: string, agentId: string, command: string }} args
 * @returns {{ ok: true } | { ok: false, reason: 'fs-error', error: string }}
 */
function appendIntent({ fenceFile, agentId, command }) {
  const timestamp = new Date().toISOString();

  let body;
  if (existsSync(fenceFile)) {
    try {
      const raw = readFileSync(fenceFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.staged_paths)) {
        body = parsed;
      }
    } catch {
      // Malformed existing fence file — overwrite with a fresh one.
      body = undefined;
    }
  }

  if (!body) {
    body = {
      agent_id: agentId,
      pid: process.pid,
      host: os.hostname(),
      started_at: timestamp,
      staged_paths: [],
    };
  }

  body.staged_paths.push({ command: command.slice(0, 512), timestamp });

  return writeJsonAtomicSync(fenceFile, body, { tmpPrefix: '.fence.tmp' });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdin();
  if (!input) return emitAllow();

  // G1 — only Bash is gated.
  if (input.tool_name !== 'Bash') return emitAllow();

  // G2 — command must be a non-empty string.
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return emitAllow();

  // G3 — regex gate. Non-`git add` commands pass through unconditionally.
  if (!GIT_ADD_REGEX.test(command)) return emitAllow();

  // G4 — context gate. Coordinator/manual commits are not fenced.
  if (!isWaveAgentContext()) return emitAllow();

  // G5 — derive paths.
  const projectDir = resolveProjectDir();
  const agentId = deriveAgentId();
  const fenceFile = path.join(
    projectDir,
    '.orchestrator',
    'staging-fence',
    `${agentId}.json`,
  );

  // G6 — append intent. Never blocks the Bash call on failure.
  const result = appendIntent({ fenceFile, agentId, command });
  if (!result.ok) {
    process.stderr.write(
      `⚠ pre-bash-staging-fence: failed to write fence file — ${result.error}\n`,
    );
  }

  return emitAllow();
}

// Top-level error handler — never let exit 1 leak. Fail-open on internal
// errors to avoid blocking legitimate work (mirrors the destructive-guard
// posture).
main().catch((e) => {
  process.stderr.write(
    `⚠ pre-bash-staging-fence: internal error — ${e?.message || e}\n`,
  );
  process.exit(0);
});
