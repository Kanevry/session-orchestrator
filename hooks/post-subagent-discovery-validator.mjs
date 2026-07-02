#!/usr/bin/env node
/**
 * post-subagent-discovery-validator.mjs — SubagentStop hook that mechanically
 * enforces PSA-006 (distributional claims need adjacent grep transcripts).
 *
 * Issue #567. Non-blocking v1 (log + warn only). EXIT 0 ALWAYS — exit 2
 * (blocking) is RESERVED for a future hard-gate and MUST NOT be used here.
 *
 * Decision flow:
 *   1. shouldRunHook('post-subagent-discovery-validator') gate — exit 0 when disabled.
 *   2. Read JSON payload from stdin; require hook_event_name === 'SubagentStop'.
 *   3. Read `discovery-validator.enabled` from CLAUDE.md/AGENTS.md Session Config.
 *      Default OFF — exit 0 immediately unless explicitly enabled.
 *   4. Read `input.transcript_path` (whole-session JSONL of assistant/user records),
 *      scan the TAIL (last ~8 `type:"assistant"` records), concat text blocks.
 *   5. Regex-scan the concatenated text for 6 distributional-claim patterns.
 *   6. For each match, check whether a fenced ```bash block containing grep/rg/find
 *      appears within ±5 lines. If a claim has NO adjacent grep block → record a
 *      `discovery_validator_violation` event in events.jsonl + a stderr WARN.
 *
 * Why read the transcript: the SubagentStop stdin payload has NO output_text
 * field. The agent's text lives in `input.transcript_path`.
 *
 * Exit codes: 0 always (informational, never blocking).
 */

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('post-subagent-discovery-validator')) process.exit(0);

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendJsonl } from '../scripts/lib/common.mjs';
import { eventsFilePath } from '../scripts/lib/events.mjs';
import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';
import { _parseDiscoveryValidator } from '../scripts/lib/config/discovery-validator.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of trailing assistant records to scan. */
const TAIL_RECORDS = 8;
/** Proximity window (in lines) for an adjacent grep transcript. */
const GREP_PROXIMITY_LINES = 5;
/** Max characters of claim text persisted to the event record. */
const CLAIM_TEXT_MAX = 200;

/**
 * Code-distribution context nouns (singular or plural). A distributional claim
 * is only a PSA-006 *code* claim when one of these appears near the trigger —
 * this is what separates "4 of 4 callers" (a real claim) from "Turn 3 of 25"
 * (a turn counter) and "every caller imports X" from "every developer should
 * test" (generic advice). Tightening per W2-review LOW finding (#567).
 *
 * Single optional `\s?` only (call site / callsite) — no nested quantifiers,
 * so the alternation stays linear-time / ReDoS-safe.
 */
const CTX = '(?:call\\s?sites?|callers?|sites?|references?|instances?|files?|consumers?|imports?|matches|match|occurrences?|usages?|modules?|tests?|places?|functions?|dependenc(?:y|ies)|endpoints?|hooks?)';

/** Bounded same-line gap between a trigger and its context noun. */
const CTX_GAP = '[^\\n]{0,40}?';

/**
 * Distributional-claim patterns (case-insensitive). A match is a PSA-006 claim
 * that requires an adjacent grep/rg/find transcript.
 *
 * Each pattern requires a code-distribution context noun (CTX) within a small,
 * bounded same-line window of the trigger. The `[^\n]{0,40}?` gap is a bounded
 * lazy character class (linear-time — the ReDoS-safety the W2 reviewer verified
 * is preserved). True claims ("4 of 4 callers opt-in", "every caller imports X",
 * "no remaining references to Y") still flag; benign strings ("Turn 3 of 25
 * complete", "every developer should test", "100% of users love it") do not.
 */
const CLAIM_PATTERNS = [
  new RegExp(`\\b\\d+ of \\d+\\b${CTX_GAP}\\b${CTX}\\b`, 'i'),
  new RegExp(`100% of\\b${CTX_GAP}\\b${CTX}\\b`, 'i'),
  new RegExp(`\\ball \\d+\\b${CTX_GAP}\\b${CTX}\\b`, 'i'),
  new RegExp(`no remaining\\b${CTX_GAP}\\b${CTX}\\b`, 'i'),
  new RegExp(`every ${CTX}\\b`, 'i'),
  new RegExp(`none of\\b${CTX_GAP}\\b${CTX}\\b`, 'i'),
];

// ---------------------------------------------------------------------------
// stdin reading (inline — Stop-family hooks exit 0 always, never deny)
// ---------------------------------------------------------------------------

/**
 * Read stdin to EOF (best-effort). Returns parsed JSON or null on failure.
 * Uses a 5 s timeout consistent with the Claude Code hook contract.
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
// config gate
// ---------------------------------------------------------------------------

/**
 * Read `discovery-validator.enabled` from CLAUDE.md (or AGENTS.md) at the
 * project root. Cheap inline read — avoids importing the full config orchestrator
 * from a hot hook path. Default OFF: any read failure resolves to disabled.
 *
 * @returns {Promise<boolean>}
 */
async function isEnabled() {
  const candidates = [
    path.join(SO_PROJECT_DIR, 'CLAUDE.md'),
    path.join(SO_PROJECT_DIR, 'AGENTS.md'),
  ];
  for (const file of candidates) {
    try {
      const content = await fs.readFile(file, 'utf8');
      return _parseDiscoveryValidator(content).enabled === true;
    } catch {
      // missing or unreadable — try next candidate
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// transcript reading
// ---------------------------------------------------------------------------

/**
 * Read the transcript JSONL at `transcriptPath`, take the last TAIL_RECORDS
 * `type:"assistant"` records, and concatenate their text content blocks.
 * Returns '' on any failure (missing file, /dev/null, malformed lines).
 *
 * @param {string} transcriptPath
 * @returns {Promise<string>}
 */
async function readTranscriptTail(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return '';
  let raw;
  try {
    raw = await fs.readFile(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  if (!raw.trim()) return '';

  const assistantRecords = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (rec && rec.type === 'assistant') assistantRecords.push(rec);
  }

  const tail = assistantRecords.slice(-TAIL_RECORDS);
  const textBlocks = [];
  for (const rec of tail) {
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        textBlocks.push(block.text);
      }
    }
  }
  return textBlocks.join('\n');
}

// ---------------------------------------------------------------------------
// claim scanning
// ---------------------------------------------------------------------------

/**
 * Identify the 0-based line indices that open or close a fenced ```bash (or ```sh
 * / bare ```) block whose body contains a grep/rg/find invocation. Returns the
 * set of line indices that belong to such a verification block.
 *
 * @param {string[]} lines
 * @returns {Set<number>} indices of lines inside a grep/rg/find fenced block
 */
function grepBlockLineIndices(lines) {
  const indices = new Set();
  let fenceStart = -1;
  let buffer = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const isFence = /^\s*```/.test(lines[i]);
    if (!inFence) {
      if (isFence) { inFence = true; fenceStart = i; buffer = []; }
      continue;
    }
    // inside a fence
    if (isFence) {
      // closing fence — evaluate the buffered body
      const body = buffer.join('\n');
      if (/\b(grep|rg|find)\b/.test(body)) {
        for (let j = fenceStart; j <= i; j++) indices.add(j);
      }
      inFence = false;
      fenceStart = -1;
      buffer = [];
    } else {
      buffer.push(lines[i]);
    }
  }
  return indices;
}

/**
 * Scan concatenated transcript text for distributional claims lacking an
 * adjacent grep/rg/find fenced block (within ±GREP_PROXIMITY_LINES).
 *
 * @param {string} text
 * @returns {string[]} truncated claim-text snippets for each violation
 */
function findViolations(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const grepLines = grepBlockLineIndices(lines);
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matched = CLAIM_PATTERNS.some((re) => re.test(line));
    if (!matched) continue;

    // A claim is verified if any grep-block line sits within the proximity window.
    let verified = false;
    for (let j = i - GREP_PROXIMITY_LINES; j <= i + GREP_PROXIMITY_LINES; j++) {
      if (grepLines.has(j)) { verified = true; break; }
    }
    if (verified) continue;

    violations.push(line.trim().slice(0, CLAIM_TEXT_MAX));
  }
  return violations;
}

// ---------------------------------------------------------------------------
// payload helpers
// ---------------------------------------------------------------------------

/**
 * Pick the first non-empty trimmed string value from `input` across the given
 * candidate keys, in order. Returns `fallback` when none match. Mirrors the
 * helper in hooks/subagent-telemetry.mjs so the two hooks resolve session ids
 * identically (parent_session_id first).
 *
 * @param {object} input
 * @param {string[]} keys
 * @param {*} fallback
 * @returns {string|*}
 */
function firstNonEmptyString(input, keys, fallback) {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return fallback;
}

/**
 * Sanitize a user/runtime-provided string for use in a tmp sentinel filename.
 *
 * @param {string} s
 * @returns {string}
 */
function safeSentinelComponent(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * Produce a short stable hash for project-root isolation in tmp sentinels.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function projectRootHash(projectRoot) {
  return createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

/**
 * Build the dedup sentinel path for real project/session/agent contexts.
 * Missing fallback IDs intentionally return null so unrelated hooks/tests do
 * not collide on a global "unknown" key.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string|null} opts.sessionId
 * @param {string|null} opts.agent
 * @returns {string|null}
 */
function dedupSentinelPath({ projectRoot, sessionId, agent }) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  if (typeof agent !== 'string' || !agent.trim()) return null;

  return path.join(
    tmpdir(),
    `psa006-${projectRootHash(projectRoot)}-${safeSentinelComponent(sessionId)}-${safeSentinelComponent(agent)}.lock`
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdinJson();
  if (!input) return;
  if (input.hook_event_name !== 'SubagentStop') return;

  if (!(await isEnabled())) return;

  const text = await readTranscriptTail(input.transcript_path);
  const violations = findViolations(text);
  if (violations.length === 0) return;

  const agentForDedup = firstNonEmptyString(input, ['agent_type'], null);
  const agent = agentForDedup ?? 'unknown';
  // session_id precedence: parent_session_id first, mirroring the sibling hook
  // hooks/subagent-telemetry.mjs (firstNonEmptyString(['parent_session_id',
  // 'session_id'])). W2-review LOW finding (#567) — the prior `session_id ||
  // parent_session_id` order disagreed with telemetry and could log the wrong id.
  const sessionId = firstNonEmptyString(input, ['parent_session_id', 'session_id'], null);

  // Project/session/agent deduplication: only emit additionalContext once for
  // repeated real contexts. Missing session IDs never create/read a sentinel,
  // so fallback traffic still surfaces warnings and cannot collide globally.
  const sentinel = dedupSentinelPath({ projectRoot: SO_PROJECT_DIR, sessionId, agent: agentForDedup });

  const filePath = eventsFilePath();
  for (const claim of violations) {
    await appendJsonl(filePath, {
      event: 'discovery_validator_violation',
      timestamp: new Date().toISOString(),
      agent,
      ...(sessionId !== null ? { session_id: sessionId } : {}),
      claim_text: claim,
    });
  }

  const warnText =
    `⚠ PSA-006: ${violations.length} distributional claim(s) from agent "${agent}" ` +
    `lack an adjacent grep/rg/find transcript (non-blocking). ` +
    `See .claude/rules/parallel-sessions.md § PSA-006.`;
  process.stderr.write(warnText + '\n');

  let alreadyWarned = false;
  if (sentinel !== null) {
    try {
      await fs.writeFile(sentinel, '', { flag: 'wx' });
    } catch (err) {
      // EEXIST means another hook process already won this real-context key.
      // Other filesystem errors should not suppress the inline warning.
      alreadyWarned = err && err.code === 'EEXIST';
    }
  }

  if (alreadyWarned) {
    // Events logged above; suppress additionalContext to prevent coordinator loop.
    return;
  }

  // v2.1.163+ additionalContext: feed the warning back to the coordinator turn
  // so the finding is visible inline, not just in stderr + events.jsonl.
  // Non-blocking — exit 0 always. Decision:"block" must never be set here.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SubagentStop',
      additionalContext: warnText,
    },
  }));
}

// Exit 0 always — informational hook must never block Claude (#567 v1).
main().catch(() => {}).finally(() => process.exit(0));
