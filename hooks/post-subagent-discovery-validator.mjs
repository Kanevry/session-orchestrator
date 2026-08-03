#!/usr/bin/env node
/**
 * post-subagent-discovery-validator.mjs — SubagentStop hook that mechanically
 * enforces PSA-006 (distributional claims need adjacent grep transcripts).
 *
 * Issue #567 (v1), Issue #908 (repo-state facts). Non-blocking (log + warn
 * only). EXIT 0 ALWAYS — exit 2 (blocking) is RESERVED for a future hard-gate
 * and MUST NOT be used here.
 *
 * Decision flow:
 *   1. shouldRunHook('post-subagent-discovery-validator') gate — exit 0 when disabled.
 *   2. Read JSON payload from stdin; require hook_event_name === 'SubagentStop'.
 *   3. Read `discovery-validator.enabled` from CLAUDE.md/AGENTS.md Session Config.
 *      Default OFF — exit 0 immediately unless explicitly enabled.
 *   4. Read `input.transcript_path` (whole-session JSONL of assistant/user records),
 *      scan the TAIL (last ~8 `type:"assistant"` records), concat text blocks.
 *   5. Regex-scan the concatenated text for 8 claim patterns — 6 quantifier-
 *      triggered distributional claims, the #908 bare-cardinal repo-state
 *      fact ("14 commits", "92 learnings", "5 dirty files", "412 lines"), and
 *      the #918 numerator/denominator slash form ("12/14 files", "4/4 callers").
 *   6. For each match, check whether a fenced ```bash block containing a
 *      MEASUREMENT command (grep/rg/find/git/wc/jq/ls/node/npm) appears within
 *      ±5 lines. If a claim has NO adjacent measurement block → record a
 *      `discovery_validator_violation` event in events.jsonl + a stderr WARN.
 *   7. ADVISORY (#908 Baustein 2 input): for claims that ARE verified, check
 *      whether the adjacent block also carries a measurement TIMESTAMP (ISO
 *      date, `HEAD`, "as of", "measured at"). Undated-but-verified claims are
 *      counted and reported in the warn text — they are NOT violations in v1.
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

/**
 * Repo-STATE nouns (#908). The four documented #908 drift cases were counts of
 * repository state, not of code locations: "14 commits", "92 learnings",
 * "5 dirty files", "412 lines". None of them contains a CTX noun, so the
 * original six patterns could not see them.
 *
 * Vocabulary taken from this repo's own artefacts (`.orchestrator/metrics/*.jsonl`
 * record kinds, `.claude/rules/`, `skills/`, `agents/`, `hooks/`) rather than a
 * generic English list — a noun that never names a countable repo artefact here
 * only buys false positives.
 */
const STATE = '(?:commits?|learnings?|issues?|branches?|lines?|entries|records?|sessions?|rules?|skills?|probes?|waves?|proposals?|worktrees?)';

/**
 * The noun class the BARE-CARDINAL pattern may use — deliberately a strict
 * subset of STATE ∪ CTX, restricted to the artefact kinds the #908 drift was
 * actually measured in (commit counts, learnings counts, open-issue counts,
 * branch counts, line counts, dirty-file counts).
 *
 * Measured, not guessed: over 32 real agent-stop windows from this repo's own
 * transcripts, admitting the full CTX ∪ STATE set fired 93 times (2.9 per
 * stop — the "validator gets switched off" zone). Every noun below earns its
 * place by naming one of the documented #908 facts; the ones that only cost
 * false positives (`tests`, `references`, `matches`, `agents`, `files` without
 * a state adjective) are excluded here and remain reachable through the six
 * quantifier-triggered patterns above, which have a lexical anchor.
 *
 * `callers` (#918): PSA-006's own canonical noun — the rule text's worked
 * examples ("4 of 4 callers", "100% of callers opt-in") all count callers, yet
 * the cardinal pattern could not see a bare "14 callers". Re-measured with it
 * admitted: 490 real SubagentStop transcripts (2026-07-31), +0 additional
 * firings from the bare form — the noun is free on this corpus (all +3 delta
 * firings came from the #918 slash pattern below).
 */
const CARDINAL_NOUN = '(?:commits?|learnings?|issues?|branches?|lines?|files?|callers?)';

/**
 * Wide noun class = code-distribution nouns ∪ repo-state nouns. Used by the six
 * QUANTIFIER-triggered patterns ("N of M", "100% of", "all N", "no remaining",
 * "none of") — each of those carries a strong lexical trigger, so widening the
 * noun set there is low-risk.
 *
 * Deliberately NOT used by the `every <noun>` pattern: `every` has no numeric
 * anchor, so `every commit must be signed` / `every rule is always-on` are
 * ordinary prose, not measured claims. That pattern keeps the narrow CTX.
 */
const WIDE = `(?:${CTX}|${STATE})`;

/** Bounded same-line gap between a trigger and its context noun. */
const CTX_GAP = '[^\\n]{0,40}?';

/**
 * Distributional-claim patterns (case-insensitive). A match is a PSA-006 claim
 * that requires an adjacent measurement transcript.
 *
 * Each pattern requires a context noun within a small, bounded same-line window
 * of the trigger. The `[^\n]{0,40}?` gap is a bounded lazy character class
 * (linear-time — the ReDoS-safety the W2 reviewer verified is preserved). True
 * claims ("4 of 4 callers opt-in", "every caller imports X", "no remaining
 * references to Y") still flag; benign strings ("Turn 3 of 25 complete",
 * "every developer should test", "100% of users love it") do not.
 */
const CLAIM_PATTERNS = [
  new RegExp(`\\b\\d+ of \\d+\\b${CTX_GAP}\\b${WIDE}\\b`, 'i'),
  new RegExp(`100% of\\b${CTX_GAP}\\b${WIDE}\\b`, 'i'),
  new RegExp(`\\ball \\d+\\b${CTX_GAP}\\b${WIDE}\\b`, 'i'),
  new RegExp(`no remaining\\b${CTX_GAP}\\b${WIDE}\\b`, 'i'),
  new RegExp(`every ${CTX}\\b`, 'i'),
  new RegExp(`none of\\b${CTX_GAP}\\b${WIDE}\\b`, 'i'),
];

/**
 * Pattern 7 (#908) — the BARE CARDINAL repo-state fact. `14 commits` has no
 * quantifier trigger at all, which is exactly why the #908 drift went unseen.
 *
 * A naive `\d+` would fire on every issue reference, version literal, date,
 * line number and percentage in a normal report — and a validator that fires on
 * every report gets switched off, which is strictly worse than no validator.
 * Precision is therefore bought three ways:
 *
 *   1. TRIGGER: a digit run that is not glued to identifier punctuation.
 *      Lookbehind rejects `#906`, `v3`, `PSA-006`, `W2`, `foo.mjs:123`;
 *      lookahead rejects `3.17`, `70%`, `2026-07-29`, `12615/0`.
 *   2. GAP: at most two intervening ADJECTIVE-like words, and never a
 *      preposition/article/copula. "5 dirty files" matches; "3 of 5 stars" and
 *      "2 sections below the rules" do not.
 *   3. SCOPE: evaluated only on prose lines with inline-code spans masked out —
 *      fenced blocks are skipped entirely (see `findViolations`), because a
 *      number inside a fence is tool OUTPUT (the evidence itself), not an
 *      unverified assertion about it.
 *
 * All quantifiers are bounded ({1,9}, {0,2}) — linear-time, ReDoS-safe.
 */
const CARDINAL_TRIGGER = '(?<![\\w#$:/.-])\\d{1,9}(?![\\d.%:/-])';
const CARDINAL_STOPWORDS =
  'of|in|on|at|for|to|the|a|an|and|or|is|are|was|were|from|with|by|that|than|per|out|over|into|onto|via|but|as';
const CARDINAL_GAP = `(?:\\s+(?!(?:${CARDINAL_STOPWORDS})\\b)[A-Za-z][\\w-]*){0,2}`;
const CARDINAL_PATTERN = new RegExp(`${CARDINAL_TRIGGER}${CARDINAL_GAP}\\s+${CARDINAL_NOUN}\\b`, 'i');

/**
 * Pattern 8 (#918) — the PSA-006 CANONICAL numerator/denominator slash form:
 * "12/14 files", "4/4 callers". PSA-006 literally demands "Quote the numerator
 * AND denominator", and `N/M` is the notation that demand produces — yet the
 * cardinal trigger's lookahead `(?![\d.%:/-])` excludes the slash, making the
 * rule's own canon form structurally invisible (#918).
 *
 * Admitting the slash re-opens the `12615/0/11` gate-summary class the
 * lookahead exists to suppress, so the slash form gets its OWN pattern with a
 * STRICTER contract than the bare cardinal:
 *
 *   1. RATIO: exactly two slash-joined numbers. Both boundary guards stay:
 *      the lookbehind rejects a numerator glued to a path/id (`hooks/12/14`),
 *      the lookahead after the DENOMINATOR rejects a third slash-segment —
 *      `12615/0/11` fails twice over (denominator `0` is followed by `/`, and
 *      the trailing pair `0/11` has a `/`-glued numerator).
 *   2. NOUN IMMEDIATELY AFTER — no CARDINAL_GAP. The noun-after-denominator is
 *      the discriminator that separates a measured ratio ("12/14 files") from
 *      a bare slash pair that is a date or score ("on 12/14 we shipped",
 *      "rated 3/5 overall"): those are followed by anything BUT an artefact
 *      noun. Widening to the gapped form would admit US-date + adjective +
 *      noun collisions with no PSA-006 payoff.
 *
 * FP re-measured on the CORRECT text sort (#918 requirement — the prior 1.07
 * rate was measured on coordinator narration, not on what this hook reads):
 * 490 real SubagentStop subagent transcripts (`~/.claude/projects/<slug>/<session>/
 * subagents/*.jsonl`), spawning THIS hook per transcript, 2026-07-31.
 * Baseline (pre-#918): 345 firings / 0.7041 per stop. With slash form +
 * `callers` admitted: 348 / 0.7102 — +3 firings, of which 1 is a true positive
 * ("0/49 Learnings mit Allow-List-Typ", an unverified canon-form claim), 1
 * quotes the #918 example sentence itself (mention-not-use), and 1 is a
 * before/after line-count pair ("858/857 lines", class-consistent with the
 * bare "412 lines" behaviour of pattern 7).
 *
 * Bounded quantifiers only ({1,9}) — linear-time, ReDoS-safe.
 */
const CARDINAL_RATIO_PATTERN = new RegExp(
  `(?<![\\w#$:/.-])\\d{1,9}/\\d{1,9}(?![\\d.%:/-])\\s+${CARDINAL_NOUN}\\b`,
  'i'
);

/** Inline-code spans are masked before the cardinal pattern runs. */
const INLINE_CODE_RE = /`[^`\n]*`/g;

/**
 * Commands that count as a MEASUREMENT inside a fenced block. `grep|rg|find`
 * (the #567 set) only covers text search; the #908 facts are measured with
 * `git log --oneline | wc -l`, `jq` over a JSONL metrics file, `ls | wc -l`,
 * or a `node`/`npm` script. Refusing to recognise those made the honest,
 * evidence-quoting path fail verification.
 */
const MEASUREMENT_CMD_RE = /\b(grep|rg|find|git|wc|jq|ls|node|npm)\b/;

/**
 * Markers that date a measurement (#908 Baustein 2 input). ADVISORY in v1:
 * an undated-but-verified claim is counted and reported, never a violation —
 * a hard contract without an established authoring habit buys friction, not
 * accuracy. Baustein 2 can escalate this to a violation once the habit exists.
 */
const TIMESTAMP_MARKER_RE = /\b\d{4}-\d{2}-\d{2}\b|\bHEAD\b|\bas of\b|\bmeasured (?:at|on)\b|\brev-parse\b/i;

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
 * Single fence walk. Returns two disjoint-purpose index sets:
 *   - `measurementLines`: lines belonging to a fenced block whose body contains
 *     a MEASUREMENT_CMD_RE invocation (the evidence a claim can lean on).
 *   - `fencedLines`: lines belonging to ANY fenced block (evidence or not).
 *     Used only to keep the greedy #908 cardinal pattern out of tool output;
 *     the six quantifier patterns are unchanged and still scan fenced lines.
 *
 * An unterminated trailing fence is treated as fenced-to-EOF (conservative for
 * false-positive suppression) but never as a measurement block (its body was
 * never closed, so we cannot claim it verified anything).
 *
 * @param {string[]} lines
 * @returns {{ measurementLines: Set<number>, fencedLines: Set<number> }}
 */
function scanFences(lines) {
  const measurementLines = new Set();
  const fencedLines = new Set();
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
      const isMeasurement = MEASUREMENT_CMD_RE.test(body);
      for (let j = fenceStart; j <= i; j++) {
        fencedLines.add(j);
        if (isMeasurement) measurementLines.add(j);
      }
      inFence = false;
      fenceStart = -1;
      buffer = [];
    } else {
      buffer.push(lines[i]);
    }
  }

  // Unterminated trailing fence — suppress cardinal matches, grant no evidence.
  if (inFence) {
    for (let j = fenceStart; j < lines.length; j++) fencedLines.add(j);
  }

  // INLINE-code evidence: PSA-006 asks for "the exact pattern executed" to be
  // quoted — an inline `git log --oneline | wc -l` satisfies that exactly as
  // well as a fenced block, and one-line findings are commonly written that
  // way. Refusing to count it would penalise the honest path.
  for (let i = 0; i < lines.length; i++) {
    if (fencedLines.has(i)) continue;
    for (const span of lines[i].match(INLINE_CODE_RE) ?? []) {
      if (MEASUREMENT_CMD_RE.test(span)) { measurementLines.add(i); break; }
    }
  }

  return { measurementLines, fencedLines };
}

/**
 * True when any line in `indices` sits within ±GREP_PROXIMITY_LINES of `i`.
 *
 * @param {Set<number>} indices
 * @param {number} i
 * @returns {boolean}
 */
function nearIndex(indices, i) {
  for (let j = i - GREP_PROXIMITY_LINES; j <= i + GREP_PROXIMITY_LINES; j++) {
    if (indices.has(j)) return true;
  }
  return false;
}

/**
 * True when a measurement TIMESTAMP marker appears within the same proximity
 * window used for the measurement block itself.
 *
 * @param {string[]} lines
 * @param {number} i
 * @returns {boolean}
 */
function hasMeasurementTimestamp(lines, i) {
  const from = Math.max(0, i - GREP_PROXIMITY_LINES);
  const to = Math.min(lines.length - 1, i + GREP_PROXIMITY_LINES);
  for (let j = from; j <= to; j++) {
    if (TIMESTAMP_MARKER_RE.test(lines[j])) return true;
  }
  return false;
}

/**
 * Scan concatenated transcript text for claims lacking an adjacent measurement
 * block (within ±GREP_PROXIMITY_LINES).
 *
 * @param {string} text
 * @returns {{ violations: string[], undatedVerified: number }}
 *   `violations` — truncated claim-text snippets; `undatedVerified` — count of
 *   claims that ARE verified but carry no measurement timestamp (advisory).
 */
function findViolations(text) {
  if (!text) return { violations: [], undatedVerified: 0 };
  const lines = text.split(/\r?\n/);
  const { measurementLines, fencedLines } = scanFences(lines);
  const violations = [];
  let undatedVerified = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let matched = CLAIM_PATTERNS.some((re) => re.test(line));
    if (!matched && !fencedLines.has(i)) {
      const masked = line.replace(INLINE_CODE_RE, ' ');
      matched = CARDINAL_PATTERN.test(masked) || CARDINAL_RATIO_PATTERN.test(masked);
    }
    if (!matched) continue;

    if (nearIndex(measurementLines, i)) {
      if (!hasMeasurementTimestamp(lines, i)) undatedVerified++;
      continue;
    }

    violations.push(line.trim().slice(0, CLAIM_TEXT_MAX));
  }
  return { violations, undatedVerified };
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
  const { violations, undatedVerified } = findViolations(text);
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

  // Advisory only (#908 item 4) — never promoted to a violation in v1.
  const undatedNote = undatedVerified > 0
    ? ` ${undatedVerified} verified claim(s) carry no measurement timestamp (advisory).`
    : '';

  const warnText =
    `⚠ PSA-006: ${violations.length} repo-state/distributional claim(s) from agent "${agent}" ` +
    `lack an adjacent measurement transcript (grep/rg/find/git/wc/jq/ls/node/npm) (non-blocking).` +
    `${undatedNote} ` +
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
