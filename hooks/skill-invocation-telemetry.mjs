#!/usr/bin/env node
/**
 * skill-invocation-telemetry.mjs — PreToolUse hook for Skill tool selection.
 *
 * Hook event: PreToolUse with matcher:"Skill" (issue #645, epic #643).
 * Fires when the Skill tool is invoked (a skill is selected). Writes a
 * selection record to `.orchestrator/metrics/skill-invocations.jsonl`.
 *
 * Decision flow:
 *   1. shouldRunHook gate — exit 0 immediately when the hook is disabled.
 *   2. Read JSON payload from stdin: { tool_name, tool_input: { skill }, session_id }.
 *   3. Belt-and-suspenders guard: if tool_name !== "Skill", exit 0 immediately.
 *   4. Build a 'selected' record and call appendSkillInvocation().
 *   5. Output: nothing on stdout. Diagnostic errors to stderr only.
 *
 * Exit codes: 0 always (informational, never blocking).
 */

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('skill-invocation-telemetry')) process.exit(0);

import path from 'node:path';
import { appendSkillInvocation } from '../scripts/lib/skill-invocations-schema.mjs';
import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JSONL_PATH = path.join(SO_PROJECT_DIR, '.orchestrator', 'metrics', 'skill-invocations.jsonl');

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
}

// Exit 0 always — informational hook must never block the Skill tool.
main().catch((err) => {
  process.stderr.write(`[skill-invocation-telemetry] ERROR: ${err?.message ?? err}\n`);
}).finally(() => process.exit(0));
