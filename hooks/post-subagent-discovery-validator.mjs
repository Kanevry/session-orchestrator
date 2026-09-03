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
 *      Default OFF (opt-in) — exit 0 immediately unless explicitly enabled.
 *   4. Resolve the STOPPING SUBAGENT's OWN transcript (never the parent):
 *      `input.agent_transcript_path` when the harness sends it, else
 *      `<dir(transcript_path)>/<base>/subagents/agent-<agent_id>.jsonl`. Scan its
 *      TAIL (last ~8 `type:"assistant"` records), concat text blocks. When no
 *      `agent_id` is derivable (or the file is absent) the hook exits 0 and
 *      records NOTHING — see the scope note below.
 *   5. Regex-scan the concatenated text for 17 claim patterns — 6 English
 *      quantifier-triggered distributional claims, 9 German equivalents
 *      (#1211 — "N von M", "alle N", "davon", "sämtliche", …), the #908
 *      bare-cardinal repo-state fact ("14 commits", "92 learnings",
 *      "5 dirty files", "412 lines", "8 Einträge"), and the #918
 *      numerator/denominator slash form ("12/14 files", "4/4 callers").
 *   6. For each match, check whether a fenced ```bash block containing a
 *      MEASUREMENT command (grep/rg/find/git/wc/jq/ls/node/npm) appears within
 *      ±5 lines. If a claim has NO adjacent measurement block → record a
 *      `discovery_validator_violation` event in events.jsonl + a stderr WARN.
 *   7. ADVISORY (#908 Baustein 2 input): for claims that ARE verified, check
 *      whether the adjacent block also carries a measurement TIMESTAMP (ISO
 *      date, `HEAD`, "as of", "measured at"). Undated-but-verified claims are
 *      counted and reported in the warn text — they are NOT violations in v1.
 *
 * Why read a transcript at all: the SubagentStop stdin payload has NO
 * output_text field — the agent's text only exists on disk.
 *
 * WHICH transcript (#1191, the root cause behind the fleet false-positive
 * flood): `input.transcript_path` is the PARENT/MAIN session transcript, not
 * the subagent's. Scanning it flagged the COORDINATOR's own prose — wave plans,
 * TL;DRs, complexity scores. Measured 2026-09-02 on a seeded random sample of
 * 60 violations: 100% coordinator text, scope-adjusted precision 0%, and
 * `agent` was `"unknown"` in 90.8% of 1,541 vault events. The hook therefore
 * reads `<transcriptDir>/<session>/subagents/agent-<agent_id>.jsonl` (the same
 * layout `hooks/subagent-telemetry.mjs` and `scripts/lib/wave-transcript-tail.mjs`
 * read) and NEVER falls back to the parent path: a scan of the wrong transcript
 * is worse than no scan.
 *
 * Output channels — THREE writes, TWO different recipients:
 *   - `discovery_validator_violation` in .orchestrator/metrics/events.jsonl,
 *     and the stderr WARN → the COORDINATOR's only copy of the finding. PSA-006
 *     makes REJECTING the unverified claim his duty, so these two are the
 *     channels that carry the rule's enforcement path.
 *   - stdout `hookSpecificOutput.additionalContext` → the STOPPING SUBAGENT
 *     (which continues and may self-correct), NOT the coordinator — a hook is
 *     structurally unable to address him. See the measured delivery note at the
 *     hookSpecificOutput write below for the shipped-binary evidence.
 *   All three are pinned together by the "all three channels fire" test in
 *   tests/hooks/post-subagent-discovery-validator.test.mjs — do not collapse
 *   the coordinator-visible pair into additionalContext.
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

import { resolveSubagentSidecar } from './_lib/subagent-paths.mjs';
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
 *
 * German extension (#1211): `zeilen?|dateien?|datei|aufrufer|eintr(?:ag|(?:ä|ae)ge)`
 * only — the same D3 measurement that found the quantifier patterns
 * disciplined (7/41, see WIDE_DE above) found the WIDE German noun set
 * (Sessions/Repos/Treffer/Stellen/Module/Tests included) firing 39/41
 * (~57% false-positive rate in the labelled sample) when admitted here. Those
 * six nouns are deliberately excluded from this bare-cardinal set; they
 * remain reachable through the quantifier-triggered German patterns above,
 * which carry a lexical anchor.
 *
 * The `eintr…` alternation covers both number forms: `(?:ä|ae)ge` for the
 * plural `Einträge`/`Eintraege`, `ag` for the singular `Eintrag` — the
 * original `eintr(?:ä|ae)ge?` made the trailing `e` optional but never
 * touched the stem, so it matched `einträg`/`eintraeg` (not a real word) and
 * missed the actual singular `Eintrag` entirely (e.g. "1 Eintrag ohne Beleg").
 */
const CARDINAL_NOUN =
  '(?:commits?|learnings?|issues?|branches?|lines?|files?|callers?|zeilen?|dateien?|datei|aufrufer|eintr(?:ag|(?:ä|ae)ge))';

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

/**
 * German counterparts of CTX/STATE/WIDE (#1211). D3 (Discovery, 2026-09-03)
 * measured these against 41 real German claim lines pulled from this repo's
 * own `.orchestrator/metrics/events.jsonl`: the quantifier-triggered patterns
 * built from WIDE_DE below flagged 7/41 — the same "disciplined" order of
 * magnitude as the English CLAIM_PATTERNS — so the noun set here can stay as
 * wide as its English sibling. The bare-cardinal noun set is a SEPARATE,
 * deliberately narrower list — see CARDINAL_NOUN below, which measured a
 * ~57% false-positive rate on the same corpus when widened this far.
 */
const CTX_DE =
  '(?:Aufrufer|Stellen?|Module?|Tests?|Treffer|Zeilen?|Aufrufstellen?|Referenzen?|Instanzen?|Konsumenten?|Verweise?)';
const STATE_DE =
  '(?:Commits?|Learnings?|Issues?|Branches?|Zeilen?|Eintr(?:ag|(?:ä|ae)ge)|Sessions?|Repos?|Dateien?|Datei|Waves?|Wellen?)';
const WIDE_DE = `(?:${CTX_DE}|${STATE_DE})`;

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

  // German equivalents (#1211). Each mirrors one of the six English patterns
  // above, plus three shapes with no direct English counterpart in this list
  // ("davon" subset-claims, "sämtliche", "kein einziger") — all measured at
  // 7/41 on the D3 German corpus (see WIDE_DE header comment above).
  new RegExp(`\\b\\d+\\s+von\\s+\\d+\\b${CTX_GAP}\\b${WIDE_DE}\\b`, 'i'), // "N von M <noun>"
  new RegExp(`\\b100\\s?%\\s*(?:von|der|aller)\\b${CTX_GAP}\\b${WIDE_DE}\\b`, 'i'), // "100 % von/der/aller <noun>"
  new RegExp(`\\balle\\s+\\d+\\b${CTX_GAP}\\b${WIDE_DE}\\b`, 'i'), // "alle N <noun>"
  new RegExp(`\\bkeine\\s+verbleibenden\\b${CTX_GAP}\\b${WIDE_DE}\\b`, 'i'), // "keine verbleibenden <noun>"
  new RegExp(`\\bjed(?:er|e|es)\\s+${CTX_DE}\\b`, 'i'), // "jeder/jede/jedes <CTX_DE>"
  new RegExp(`\\bkein(?:er|e|es)\\s+(?:von|der)\\b${CTX_GAP}\\b${WIDE_DE}\\b`, 'i'), // "keiner/keine/keins von/der <noun>"
  // "N <noun> … davon N" (#1198 anchor) — the shape the D3 sample sentence
  // uses: "8 Einträge, davon 4 aus dem eigenen Dateiscope".
  new RegExp(`\\b\\d+\\s+${WIDE_DE}\\b${CTX_GAP}\\bdavon\\s+\\d+\\b`, 'i'),
  new RegExp(`\\bs(?:ä|ae)mtliche\\s+${CTX_DE}\\b`, 'i'), // "sämtliche/saemtliche <CTX_DE>"
  new RegExp(`\\bkein\\w{0,2}\\s+einzige[rs]?\\b${CTX_GAP}\\b${WIDE_DE}\\b`, 'i'), // "kein(e)? einzige[rs]? <noun>"
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
 * Gate-summary / STATUS-report lines are the HARNESS's own completion output —
 * tool evidence, not an unverified assertion about the codebase — yet carried
 * no exemption of their own: they were caught only incidentally, by whichever
 * individual claim pattern happened not to fire on that exact phrasing. GitLab
 * #1198 (Discovery D8, 2026-09-02): a 400-event sample of
 * `discovery_validator_violation` records showed 186/400 (46.5%) firing on
 * this exact class — the single largest false-positive source measured to
 * date. Skipped at the LINE level, before ANY pattern runs, rather than by
 * narrowing `CARDINAL_NOUN`: narrowing the noun set would ALSO silence a true
 * "N files" claim appearing outside a gate-summary line, which is not this
 * bug's fix.
 *
 * Four alternatives cover the measured shapes: an N-passed/M-failed count
 * ("14904 passed / 0 failed"), a `STATUS:` report line (`skills/wave-executor`
 * agent-report convention), a "Full Gate" heading, and a `Gate: <verdict>`
 * summary line (English "typecheck" or German "grün"/"gruen"/"rot").
 *
 * German gate/status shapes (#1211), added after the English four: a
 * `Gate N[.N]/M` ratio ("Gate 14.118/0"), an "N Wellen, M Agents" session
 * tally, "Arbeitsbaum leer" (clean-tree report), and "mit Nachweis
 * geschlossen" (session-close issue-disposition heading) — all measured on
 * this repo's own German session-report prose, the same corpus D3 sampled
 * for the noun-set decisions above.
 *
 * Trade named, not fixed: `\bGate \d[\d.]*\/\d+\b` matching anywhere on the
 * line silences the WHOLE line, so a distributional claim that happens to
 * share a line with a `Gate N/M` mention goes unflagged too — the same
 * per-line skip the English `passed/failed` alternative above already makes,
 * accepted here for the same reason (a gate-summary line is harness evidence,
 * not an unverified assertion, and false positives on it were the single
 * largest measured class — see #1198 above).
 */
const GATE_SUMMARY_LINE_RE =
  /\b\d+\s+passed\s*\/\s*\d+\s+failed\b|^\s*STATUS:\s*(?:done|partial|failed)\b|\bFull Gate\b|\bGate:\s*(?:typecheck|grün|gruen|rot)\b|\bGate \d[\d.]*\/\d+\b|\b\d+\s+Wellen?,\s*\d+\s+Agents?\b|\bArbeitsbaum leer\b|\bmit Nachweis geschlossen\b/i;

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
    // #1198 FIX 2: gate-summary/STATUS lines are tool OUTPUT, not a claim —
    // skipped before any pattern runs (see GATE_SUMMARY_LINE_RE header).
    if (GATE_SUMMARY_LINE_RE.test(line)) continue;

    // #1198 FIX 3 (masking-order bug): mask inline-code spans ONCE, then test
    // BOTH the six CLAIM_PATTERNS and the cardinal/ratio patterns against the
    // masked text. Previously only the cardinal branch masked — a claim
    // quoted entirely inside backticks (evidence/example text, not an
    // assertion) still tripped CLAIM_PATTERNS via the raw, unmasked line.
    const masked = line.replace(INLINE_CODE_RE, ' ');
    let matched = CLAIM_PATTERNS.some((re) => re.test(masked));
    if (!matched && !fencedLines.has(i)) {
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
 * Resolve the STOPPING SUBAGENT's own sidecar pair (#1191, #1196).
 *
 * Thin wrapper over the consolidated derivation —
 * `hooks/_lib/subagent-paths.mjs` `resolveSubagentSidecar()` — which now ALSO
 * containment-checks the `agent_transcript_path` override this file used to
 * return unvalidated (see that module's header divergence table). Returns
 * null when the derivation is impossible — the caller must then scan
 * NOTHING. Falling back to `input.transcript_path` is the defect this
 * function exists to remove: that path is the coordinator's transcript.
 *
 * @param {object} input — SubagentStop stdin payload
 * @param {string|null} agentId
 * @returns {{base: string, transcript: string, meta: string}|null}
 */
function resolveAgentTranscriptPath(input, agentId) {
  const agentTranscriptPath = firstNonEmptyString(input, ['agent_transcript_path'], null);
  return resolveSubagentSidecar({ transcriptPath: input.transcript_path, agentId, agentTranscriptPath });
}

/**
 * Agent types carry a plugin qualifier, so the COLON is part of the real shape:
 * `session-orchestrator:code-implementer` (37 chars, measured on-disk in a real
 * sidecar meta.json 2026-09-02). Same constant as `AGENT_TYPE_META_RE` in
 * hooks/on-stop.mjs — kept local because the two hooks share no module.
 */
const AGENT_TYPE_META_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Read the agent TYPE from the sidecar `agent-<id>.meta.json` the harness writes
 * next to the subagent transcript. Used only when the stdin payload omits
 * `agent_type` — the reason `agent` read `"unknown"` on ~91% of events.
 *
 * @param {string} metaPath — `resolveSubagentSidecar(...).meta`
 * @returns {Promise<string|null>}
 */
async function readAgentTypeFromMeta(metaPath) {
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    const t = meta?.agentType;
    if (typeof t !== 'string' || !t.trim()) return null;
    // Clamped with the same shape hooks/on-stop.mjs applies to `agentType`
    // (colon included — `session-orchestrator:code-implementer` is the real
    // shape). This value reaches BOTH the ledger event and the model-visible
    // `additionalContext` string, so a mismatch is OMITTED rather than
    // truncated: the caller then falls back to the honest `'unknown'`.
    return AGENT_TYPE_META_RE.test(t.trim()) ? t.trim() : null;
  } catch {
    return null;
  }
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
 * Build the dedup sentinel path for real project/session/agent/claim contexts.
 * Missing fallback IDs intentionally return null so unrelated hooks/tests do
 * not collide on a global "unknown" key.
 *
 * #1198 FIX 1: the key used to be `(projectRoot, sessionId, agent_type)` —
 * `agent_type` is a CLASS ("discovery"), not an individual agent, so two
 * DIFFERENT real subagents of the same type running in the same session
 * collided on the same sentinel: the second agent's own `additionalContext`
 * feedback was silently suppressed even though it never received a copy of
 * the first agent's warning. Keying on `agentId` (the harness's per-process
 * `agent_id`/`subagent_id`) instead removes that cross-agent collision. The
 * claim-text hash is ADDITIVE: it lets a genuinely SECOND, DISTINCT claim
 * from the same real agent still surface its own suppression check, rather
 * than being silenced merely because that agent already triggered once for a
 * different claim.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string|null} opts.sessionId
 * @param {string|null} opts.agentId
 * @param {string|null} opts.claimText
 * @returns {string|null}
 */
function dedupSentinelPath({ projectRoot, sessionId, agentId, claimText }) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  if (typeof agentId !== 'string' || !agentId.trim()) return null;
  if (typeof claimText !== 'string' || !claimText.trim()) return null;

  const claimHash = createHash('sha256').update(claimText).digest('hex').slice(0, 16);
  return path.join(
    tmpdir(),
    `psa006-${projectRootHash(projectRoot)}-${safeSentinelComponent(sessionId)}-${safeSentinelComponent(agentId)}-${claimHash}.lock`
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

  // #1191: scan the SUBAGENT's own transcript, never the parent. No agent_id
  // (or no derivable path) → scan nothing and record nothing.
  const agentId = firstNonEmptyString(input, ['agent_id', 'subagent_id'], null);
  const sidecar = resolveAgentTranscriptPath(input, agentId);
  if (sidecar === null) return;

  const text = await readTranscriptTail(sidecar.transcript);
  const { violations, undatedVerified } = findViolations(text);
  if (violations.length === 0) return;

  const agentForDedup =
    firstNonEmptyString(input, ['agent_type', 'subagent_type'], null) ??
    (await readAgentTypeFromMeta(sidecar.meta));
  const agent = agentForDedup ?? 'unknown';
  // session_id precedence: parent_session_id first, mirroring the sibling hook
  // hooks/subagent-telemetry.mjs (firstNonEmptyString(['parent_session_id',
  // 'session_id'])). W2-review LOW finding (#567) — the prior `session_id ||
  // parent_session_id` order disagreed with telemetry and could log the wrong id.
  const sessionId = firstNonEmptyString(input, ['parent_session_id', 'session_id'], null);

  // Project/session/agent/claim deduplication: only emit additionalContext
  // once for repeated real contexts. Missing session IDs never create/read a
  // sentinel, so fallback traffic still surfaces warnings and cannot collide
  // globally. Keyed on agentId (not agent TYPE, #1198 FIX 1) plus the first
  // violation's claim text so distinct real agents and distinct claims never
  // share a sentinel.
  const sentinel = dedupSentinelPath({
    projectRoot: SO_PROJECT_DIR,
    sessionId,
    agentId,
    claimText: violations[0],
  });

  const filePath = eventsFilePath();
  for (const claim of violations) {
    await appendJsonl(filePath, {
      event: 'discovery_validator_violation',
      timestamp: new Date().toISOString(),
      agent,
      ...(agentId !== null ? { agent_id: agentId } : {}),
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
    // Events logged above; suppress the repeat additionalContext for this
    // already-warned real context. (Recipient is the stopping subagent, not the
    // coordinator — see the delivery note at the hookSpecificOutput write below.)
    return;
  }

  // v2.1.163+ additionalContext: surface the finding inline, not just in
  // stderr + events.jsonl.
  //
  // The recipient is the SUBAGENT that just stopped — NOT the coordinator.
  // Measured in the shipped binary (Claude Code 2.1.241, 2026-08-23): the
  // SubagentStop hookSpecificOutput schema reads "additionalContext is
  // non-error feedback delivered to the subagent; the subagent continues so it
  // can act on it", and the emitter picks its target with
  // `i.agentId ? "SubagentStop" : "Stop"`, yielding a `hook_additional_context`
  // message into that agent's own loop. So this text lands in the transcript of
  // the agent whose claims it is about, one moment after that agent is done.
  //
  // Worth knowing before "fixing" the path: PSA-006 asks the COORDINATOR to
  // reject unverified distributional claims, and this channel never reaches
  // him. His copy of the finding is events.jsonl + stderr, not this write.
  // Whether he SHOULD receive it is a product question (#1116) — changing the
  // route is not a comment edit.
  //
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
