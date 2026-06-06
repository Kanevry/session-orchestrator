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
 *        duration_ms?, transcript_path? }.
 *   3. Discriminate on hook_event_name → event: 'start' | 'stop'.
 *   4. For stop events, parse the subagent transcript at `transcript_path` to
 *        recover token_input / token_output (#624). The harness does NOT send
 *        token_input / token_output on stdin — they must be extracted from the
 *        transcript's per-assistant-turn `message.usage` blocks, deduped by
 *        requestId (streaming snapshots repeat the same requestId ~4-5×).
 *   5. Build canonical record and call appendSubagent().
 *   6. Output: nothing on stdout. Diagnostic errors to stderr only.
 *
 * Exit codes: 0 always (informational, never blocking).
 */

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('subagent-telemetry')) process.exit(0);

import fs from 'node:fs';
import path from 'node:path';
import { appendSubagent } from '../scripts/lib/subagents-schema.mjs';
import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JSONL_PATH = path.join(SO_PROJECT_DIR, '.orchestrator', 'metrics', 'subagents.jsonl');

/**
 * Defense-in-depth byte ceiling for transcript reads (#624). The transcript path
 * is harness-trusted, so this is not an exploitable vector — but the repo follows
 * a bounded-read discipline: a pathologically large transcript is skipped (yields
 * the empty/zero-usage result) rather than read whole into memory.
 */
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // ~50 MB

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
 * Extract deduped token totals from a subagent transcript JSONL file (#624).
 *
 * On SubagentStop the harness supplies `transcript_path`. Each
 * `{"type":"assistant"}` line carries a `message.usage` block with
 * `{ input_tokens, output_tokens, ... }`. Streaming snapshots repeat the SAME
 * `requestId` across consecutive assistant lines, so a naive Σ over every line
 * double-counts (observed ~4-5× on real transcripts). The correct recipe is to
 * group by `requestId`, keep ONE usage block per id (the first), then sum.
 *
 * token_input is the raw `input_tokens` sum (NOT folded with cache_* fields) to
 * match the existing OTel `gen_ai.usage.input_tokens` semantic.
 *
 * Per-turn clamping (#624): a single poisoned usage value (negative, NaN, or a
 * non-integer such as 10.5) MUST NOT discard the otherwise-good turns. Each turn's
 * contribution is added ONLY when it is a non-negative integer; an invalid value
 * is skipped (its turn still counts toward `counted` so a transcript of mixed
 * good/bad turns yields the sum of the GOOD turns, never null). Without per-turn
 * clamping, a final `Number.isInteger(sum) && sum >= 0` aggregate check would
 * nuke the whole input sum to null on one bad value.
 *
 * Dedup assumption (#624): the streaming harness always supplies a `requestId` on
 * assistant turns, so dedup keys on it. A turn with NO requestId is counted
 * individually (no dedup) — this is the documented forward-compat fallback, not a
 * double-count, because the harness never omits requestId in practice.
 *
 * Partial-usage assumption (#624): a turn carrying `input_tokens` but no
 * `output_tokens` (or vice-versa) contributes 0 to the absent side — NOT null —
 * so the present side still sums and the aggregate stays valid.
 *
 * NEVER throws. Any failure (missing/unreadable path, 0 assistant turns, parse
 * error) yields { tokenInput: null, tokenOutput: null } so the hook still exits 0.
 *
 * @param {string|undefined|null} transcriptPath — absolute path from stdin
 * @returns {{ tokenInput: number|null, tokenOutput: number|null }}
 */
function extractTranscriptUsage(transcriptPath) {
  const nullResult = { tokenInput: null, tokenOutput: null };
  try {
    if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return nullResult;
    if (!fs.existsSync(transcriptPath)) return nullResult;

    // Bounded-read guard (#624): skip an oversized transcript gracefully rather
    // than read the whole file into memory. statSync failure (race/unreadable)
    // falls through to the readFileSync attempt below — both stay inside the
    // no-throw try/catch, so the worst case is still nullResult, never a throw.
    const { size } = fs.statSync(transcriptPath);
    if (size > MAX_TRANSCRIPT_BYTES) return nullResult;

    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n');

    const seen = new Set();
    let tokenInput = 0;
    let tokenOutput = 0;
    let counted = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue; // skip a single malformed line, keep parsing the rest
      }
      if (!obj || obj.type !== 'assistant') continue;
      const usage = obj.message?.usage;
      if (!usage || typeof usage !== 'object') continue;

      // Dedup by requestId — keep the first usage block per id.
      const requestId = obj.requestId;
      if (typeof requestId === 'string' && requestId) {
        if (seen.has(requestId)) continue;
        seen.add(requestId);
      }

      // Per-turn clamp (#624): add a turn's value ONLY when it is a non-negative
      // integer. A poisoned value (negative, NaN, float like 10.5) is skipped so
      // the good turns survive. An absent side contributes 0, not null.
      const inTok = usage.input_tokens;
      const outTok = usage.output_tokens;
      if (Number.isInteger(inTok) && inTok >= 0) tokenInput += inTok;
      if (Number.isInteger(outTok) && outTok >= 0) tokenOutput += outTok;
      counted += 1;
    }

    // No assistant turns with usage → leave fields null (forward-compat).
    if (counted === 0) return nullResult;

    // The aggregate is guaranteed a non-negative integer by per-turn clamping
    // above (Σ of non-negative integers), so emit it directly.
    return {
      tokenInput,
      tokenOutput,
    };
  } catch {
    return nullResult;
  }
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

    // Tokens are NOT sent on stdin (#624) — recover them from the transcript's
    // per-assistant-turn usage blocks, deduped by requestId. Any failure → null.
    const { tokenInput, tokenOutput } = extractTranscriptUsage(input.transcript_path);
    if (tokenInput !== null) record.token_input = tokenInput;
    if (tokenOutput !== null) record.token_output = tokenOutput;

    // Cost is best-effort / forward-compat (#624): the native transcript does
    // NOT expose total_cost_usd today, so this is null in practice. No rate
    // table — use the native cost only, default null when absent.
    const totalCostUsd =
      typeof input.total_cost_usd === 'number' && Number.isFinite(input.total_cost_usd) && input.total_cost_usd >= 0
        ? input.total_cost_usd
        : null;
    record.total_cost_usd = totalCostUsd;

    // OTel alias — #411 additive, schema_version=1 backwards-compat
    record['gen_ai.usage.input_tokens'] = tokenInput;
    record['gen_ai.usage.output_tokens'] = tokenOutput;
    record['gen_ai.system'] = 'anthropic';
  }

  await appendSubagent(JSONL_PATH, record);
}

// Exit 0 always — informational hook must never block Claude.
main().catch(() => {}).finally(() => process.exit(0));
