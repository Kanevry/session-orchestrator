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
 * Phantom-stop class (#939, measured 2026-07-31 over the live ledger):
 * the harness fires SubagentStop for an ephemeral agent class that never fires
 * SubagentStart. Those payloads carry a FRESH agent_id per firing, NO
 * agent_type/subagent_type, and a transcript_path that points at the PARENT
 * session transcript (evidence: 1072 of 1395 token-bearing orphan stops share
 * an exact token_input:token_output:parent_session_id fingerprint with a
 * concurrent typed stop; 957 of those 1072 fire BEFORE it, p50 97 s; token
 * totals grow monotonically across the orphan stream). The cause is
 * harness-side, not hook-side: registration (hooks.json) sends exactly
 * SubagentStart|SubagentStop here, and the "missing hook_event_name flips
 * starts to stops" hypothesis is refuted by perfect bimodality — 0 of 1429
 * typed stops are orphaned, 0 of 1494 orphans carry a type. The hook therefore
 * records these firings faithfully but marks every stop with
 * `start_record_found` so readers can filter the phantom class mechanically.
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

/**
 * Tail window scanned backwards to join a stop event to its own start record (#917).
 *
 * The ledger is append-only and grows without bound (1.4 MB / 4201 lines on
 * 2026-07-30), so reading it whole on EVERY SubagentStop would be a hot-path
 * regression that worsens for the life of the repo. A fixed-size tail keeps the
 * join O(1) in file size.
 *
 * Sized from the real distribution, not a guess: measured over the live ledger on
 * 2026-07-30, the byte distance from a start record to its matching stop was
 * p50 1,380 · p90 3,255 · p99 24,229 · max 36,636. 256 KiB is ~7× the observed
 * maximum, so a start that falls outside the window is far rarer than the
 * no-start-record case the null fallback already handles honestly.
 */
const START_JOIN_TAIL_BYTES = 256 * 1024;

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

/**
 * Scan the tail of the ledger backwards for the most recent 'start' record with
 * the given agent_id and return its timestamp in epoch-ms (#917).
 *
 * Reads only the last START_JOIN_TAIL_BYTES rather than the whole file — see that
 * constant for the measured sizing rationale. Scanning backwards means the FIRST
 * hit is the most recent start, which is the correct one when an agent_id is
 * reused across sessions (measured 2026-07-30: 22 of 1420 distinct start ids
 * appeared more than once).
 *
 * NEVER throws. Any failure (missing file, unreadable, no match, unparseable
 * timestamp) yields null so the caller falls back to an honest "unknown".
 *
 * @param {string} filePath — ledger path
 * @param {string} agentId — the stopping agent's id
 * @returns {number|null} epoch-ms of the matching start, or null
 */
function findStartTimestampMs(filePath, agentId) {
  let fd;
  try {
    if (typeof agentId !== 'string' || !agentId.trim()) return null;
    if (!fs.existsSync(filePath)) return null;

    const { size } = fs.statSync(filePath);
    if (size === 0) return null;

    const readLen = Math.min(size, START_JOIN_TAIL_BYTES);
    const from = size - readLen;
    const buf = Buffer.allocUnsafe(readLen);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readLen, from);

    const lines = buf.toString('utf8').split('\n');
    // When the window does not cover the whole file, the first element is a
    // record sliced mid-line (possibly mid-UTF-8-sequence). Drop it rather than
    // feed a corrupt fragment to JSON.parse.
    if (from > 0) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      // Cheap pre-filter — skip JSON.parse for the ~99% of lines that cannot match.
      if (!line.includes(agentId)) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // tolerate a torn/malformed line, keep scanning
      }
      if (!obj || obj.event !== 'start' || obj.agent_id !== agentId) continue;
      const ms = Date.parse(obj.timestamp);
      return Number.isFinite(ms) ? ms : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Resolve duration_ms for a stop event (#917).
 *
 * Precedence:
 *   1. A usable harness-supplied duration_ms — authoritative when present.
 *      In practice Claude Code's SubagentStop payload does NOT carry this field,
 *      which is exactly why every pre-#917 record read 0.
 *   2. Wall-clock join: now − the precomputed timestamp of this agent's own
 *      start record (`startedAtMs`, resolved ONCE by the caller — it also feeds
 *      the #939 `start_record_found` discriminator).
 *   3. null — the honest value when the duration is genuinely unknowable.
 *
 * Why null and not 0: a stop that took zero milliseconds never happened, so a 0
 * is indistinguishable from "we never measured". The no-start branch is the
 * DOMINANT path, not a corner case, and worsening (#939, measured 2026-07-31
 * over the live ledger):
 *   - lifetime mean: 1494 of 2923 stop records (51.1%) have no start record
 *     with their agent_id anywhere in the ledger;
 *   - running traffic is far worse — the lifetime mean flatters it:
 *       since 2026-07-20:        894 stops, 157 matched (17.6%)
 *       since 2026-07-29:        408 stops,  62 matched (15.2%)
 *       since 2026-07-30T17:41:  122 stops,   8 matched ( 6.6%)
 *     i.e. ~93% of CURRENT stop traffic is orphaned (the harness phantom-stop
 *     class — see the file header). Writing 0 there would keep fabricating
 *     exactly the value #917 removed.
 *
 * @param {object} input — raw stdin payload
 * @param {number|null} startedAtMs — epoch-ms of this agent's own start record,
 *   or null when no start record is recoverable (phantom stop, 'unknown' id,
 *   or start outside the tail window)
 * @returns {number|null} duration in ms, or null when unknown
 */
function resolveDurationMs(input, startedAtMs) {
  const supplied = input.duration_ms;
  if (typeof supplied === 'number' && Number.isFinite(supplied) && supplied > 0) {
    return Math.round(supplied);
  }

  if (startedAtMs === null) return null;

  const elapsed = Date.now() - startedAtMs;
  // A non-positive elapsed means a clock jump or a start recorded in the future —
  // not a measurement. Report unknown rather than invent a plausible number.
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null;
  return Math.round(elapsed);
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

  // #939 forensic breadcrumb: registration (hooks.json) sends exactly
  // SubagentStart|SubagentStop to this script, so any OTHER (or missing) event
  // name is a payload anomaly. It is still written as 'stop' for
  // backwards-compat, but the raw name is preserved verbatim so the "missing
  // hook_event_name silently defaults to stop" hypothesis stays decidable from
  // the ledger instead of requiring another inference pass. Never stamped on
  // well-formed payloads — the field's PRESENCE is the anomaly signal.
  if (eventName !== 'SubagentStart' && eventName !== 'SubagentStop') {
    record.hook_event_name = typeof eventName === 'string' ? eventName : null;
  }

  if (event === 'stop') {
    // #939 orphan guard: resolve the start-join ONCE — it feeds both the
    // duration measurement and the explicit orphan discriminator below.
    // 'unknown' is the agent-id fallback for a payload with no usable id —
    // joining on it would collide across unrelated agents, so never scan for it.
    const startedAtMs = agentId === 'unknown' ? null : findStartTimestampMs(JSONL_PATH, agentId);

    // duration_ms (#917): prefer the harness value, else join backwards to this
    // agent's own start record, else null. Never 0 — see resolveDurationMs().
    record.duration_ms = resolveDurationMs(input, startedAtMs);

    // start_record_found (#939): makes the harness phantom-stop class (see file
    // header) mechanically filterable at read time. false = no start record for
    // this agent_id in the tail window — for ~93% of current stop traffic this
    // is the phantom class, whose token fields describe the PARENT transcript,
    // not a real subagent.
    record.start_record_found = startedAtMs !== null;

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
