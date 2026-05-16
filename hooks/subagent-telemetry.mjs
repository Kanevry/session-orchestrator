#!/usr/bin/env node
/**
 * subagent-telemetry.mjs — SubagentStart + SubagentStop hook handler.
 *
 * Hook events: SubagentStart, SubagentStop (issue #342).
 * Fires when a subagent lifecycle event occurs. Discriminates on
 * `hook_event_name` to write either a 'start' or 'stop' record to
 * `.orchestrator/metrics/subagents.jsonl`.
 *
 * Decision flow:
 *   1. shouldRunHook gate — exit 0 immediately when the hook is disabled.
 *   2. Read JSON payload from stdin: { hook_event_name, agent_id?, subagent_id?,
 *        agent_type?, subagent_type?, parent_session_id?, session_id?,
 *        duration_ms?, token_input?, token_output? }.
 *   3. Discriminate on hook_event_name → event: 'start' | 'stop'.
 *   4. Build canonical record and call appendSubagent().
 *   5. Output: nothing on stdout. Diagnostic errors to stderr only.
 *
 * Exit codes: 0 always (informational, never blocking).
 */

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('subagent-telemetry')) process.exit(0);

import path from 'node:path';
import { appendSubagent } from '../scripts/lib/subagents-schema.mjs';
import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JSONL_PATH = path.join(SO_PROJECT_DIR, '.orchestrator', 'metrics', 'subagents.jsonl');

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

  const eventName = input.hook_event_name;
  const event = eventName === 'SubagentStart' ? 'start' : 'stop';

  // Pick the first non-empty trimmed string from the candidate keys, or the fallback.
  const firstNonEmptyString = (keys, fallback) => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return fallback;
  };

  // Resolve identifiers from either naming convention the harness may use.
  const agentId = firstNonEmptyString(['agent_id', 'subagent_id'], 'unknown');
  const agentType = firstNonEmptyString(['agent_type', 'subagent_type'], null);
  const parentSessionId = firstNonEmptyString(['parent_session_id', 'session_id'], null);

  /** @type {object} */
  const record = {
    timestamp: new Date().toISOString(),
    event,
    agent_id: agentId,
    schema_version: 1,
    ...(agentType !== null ? { agent_type: agentType } : {}),
    ...(parentSessionId !== null ? { parent_session_id: parentSessionId } : {}),
  };

  if (event === 'stop') {
    // duration_ms is required for stop events; default to 0 if harness omits it.
    record.duration_ms =
      typeof input.duration_ms === 'number' && input.duration_ms >= 0
        ? Math.round(input.duration_ms)
        : 0;
    const tokenInput =
      typeof input.token_input === 'number' && Number.isInteger(input.token_input) && input.token_input >= 0
        ? input.token_input
        : null;
    const tokenOutput =
      typeof input.token_output === 'number' && Number.isInteger(input.token_output) && input.token_output >= 0
        ? input.token_output
        : null;
    if (tokenInput !== null) record.token_input = tokenInput;
    if (tokenOutput !== null) record.token_output = tokenOutput;
    // OTel alias — #411 additive, schema_version=1 backwards-compat
    record['gen_ai.usage.input_tokens'] = tokenInput;
    record['gen_ai.usage.output_tokens'] = tokenOutput;
    record['gen_ai.system'] = 'anthropic';
  }

  await appendSubagent(JSONL_PATH, record);
}

// Exit 0 always — informational hook must never block Claude.
main().catch(() => {}).finally(() => process.exit(0));
