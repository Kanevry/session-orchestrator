/**
 * subagent-transcript.mjs — the PSA-006 claim-extraction engine (#1218/#1198).
 *
 * Extracted out of `hooks/post-subagent-discovery-validator.mjs`, which kept
 * the whole scanner inline behind a `process.stdin` read: the only way to
 * exercise a claim string was to spawn the hook with a sandbox repo, a
 * CLAUDE.md (or AGENTS.md — transparent aliases, see skills/_shared/instruction-file-resolution.md)
 * and a transcript on disk. That cost made the precision of the
 * matcher — the property the fleet actually complained about — effectively
 * unmeasurable, so it was never measured. This module is the pure half
 * (string in, findings out); the hook keeps stdin, config gate, sidecar
 * resolution, sentinels and the three output channels.
 *
 * Four responsibilities, in the order the hook uses them:
 *   1. `readTranscriptTail()` — the last N assistant records of ONE transcript
 *      JSONL, text blocks concatenated. This is the HOOK'S VIEW: what the
 *      agent SAID.
 *   1b. `readTranscriptObservations()` — the vitest run summaries found in the
 *      `tool_result` blocks of the SAME byte window. This is what the agent
 *      actually RAN. A second reader rather than a second pattern, because
 *      `readTranscriptTail` collects assistant `text` blocks only and a
 *      `tool_result` lives in a `user` record.
 *   2. `findViolations()` — distributional/repo-state claims that carry no
 *      adjacent measurement evidence, gate verdicts that carry no run receipt,
 *      and (R1) a claimed test count that contradicts every run observed.
 *   3. `normalizeClaim()` / `dedupeViolations()` — one record per distinct
 *      claim, with an `occurrences` count (#1198: the fleet's worst repo held
 *      3,360 records over 205 distinct `claim_text` values = duplication
 *      factor 16.4, measured 2026-09-06 over
 *      `extern/aiat-barrierefrei-engine/.orchestrator/metrics/events.jsonl`).
 *
 * @module hooks/_lib/subagent-transcript
 */

import { readTailWindow } from '../../scripts/lib/tail-window.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of trailing assistant records to scan. */
export const TAIL_RECORDS = 8;
/**
 * Byte window `readTranscriptTail()` reads from the END of a transcript (#1388
 * P4) — the ceiling on this deliberate simplification, per BV-004.
 *
 * Measured 2026-09-18 over 1016 real subagent transcripts: the byte span of the
 * last TAIL_RECORDS assistant records was median 41 KB, p99 322 KB, max 1.25 MB
 * (file size median 676 KB, max 8.2 MB). 2 MiB loses zero records in that
 * sample; 1 MiB would already lose one.
 *
 * REVISIT TRIGGER: if TAIL_RECORDS grows, or a re-measurement puts the max span
 * above ~1.5 MB, raise this window — a too-small window silently drops the
 * OLDEST of the eight records rather than failing.
 */
export const TAIL_WINDOW_BYTES = 2 * 1024 * 1024;
/** Proximity window (in lines) for an adjacent grep transcript. */
export const GREP_PROXIMITY_LINES = 5;
/** Max characters of claim text persisted to the event record. */
export const CLAIM_TEXT_MAX = 200;

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
 * disciplined (7/41, see WIDE_DE below) found the WIDE German noun set
 * (Sessions/Repos/Treffer/Stellen/Module/Tests included) firing 39/41
 * (~57% false-positive rate in the labelled sample) when admitted here.
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
 * magnitude as the English CLAIM_PATTERNS.
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
 * (linear-time — the ReDoS-safety the W2 reviewer verified is preserved).
 */
export const CLAIM_PATTERNS = [
  new RegExp(`\\b\\d+ of \\d+\\b${CTX_GAP}\\b${WIDE}\\b`, 'i'),
  new RegExp(`100% of\\b${CTX_GAP}\\b${WIDE}\\b`, 'i'),
  new RegExp(`\\ball \\d+\\b${CTX_GAP}\\b${WIDE}\\b`, 'i'),
  new RegExp(`no remaining\\b${CTX_GAP}\\b${WIDE}\\b`, 'i'),
  new RegExp(`every ${CTX}\\b`, 'i'),
  new RegExp(`none of\\b${CTX_GAP}\\b${WIDE}\\b`, 'i'),

  // German equivalents (#1211). Each mirrors one of the six English patterns
  // above, plus three shapes with no direct English counterpart in this list
  // ("davon" subset-claims, "sämtliche", "kein einziger").
  new RegExp(`\\b\\d+\\s+von\\s+\\d+\\b${CTX_GAP}\\b${WIDE_DE}\\b`, 'i'), // "N von M <noun>"
  new RegExp(`\\b100\\s?%\\s*(?:von|der|aller)\\b${CTX_GAP}\\b${WIDE_DE}\\b`, 'i'), // "100 % von/der/aller <noun>"
  new RegExp(`\\balle\\s+\\d+\\b${CTX_GAP}\\b${WIDE_DE}\\b`, 'i'), // "alle N <noun>"
  new RegExp(`\\bkeine\\s+verbleibenden\\b${CTX_GAP}\\b${WIDE_DE}\\b`, 'i'), // "keine verbleibenden <noun>"
  new RegExp(`\\bjed(?:er|e|es)\\s+${CTX_DE}\\b`, 'i'), // "jeder/jede/jedes <CTX_DE>"
  new RegExp(`\\bkein(?:er|e|es)\\s+(?:von|der)\\b${CTX_GAP}\\b${WIDE_DE}\\b`, 'i'), // "keiner/keine/keins von/der <noun>"
  // "N <noun> … davon N" (#1198 anchor).
  new RegExp(`\\b\\d+\\s+${WIDE_DE}\\b${CTX_GAP}\\bdavon\\s+\\d+\\b`, 'i'),
  new RegExp(`\\bs(?:ä|ae)mtliche\\s+${CTX_DE}\\b`, 'i'), // "sämtliche/saemtliche <CTX_DE>"
  new RegExp(`\\bkein\\w{0,2}\\s+einzige[rs]?\\b${CTX_GAP}\\b${WIDE_DE}\\b`, 'i'), // "kein(e)? einzige[rs]? <noun>"
];

/**
 * Pattern 7 (#908) — the BARE CARDINAL repo-state fact. `14 commits` has no
 * quantifier trigger at all, which is exactly why the #908 drift went unseen.
 *
 * Precision is bought three ways: a TRIGGER whose lookbehind/lookahead reject
 * identifier punctuation (`#906`, `v3`, `3.17`, `70%`, `2026-07-29`), a GAP of
 * at most two adjective-like words with no preposition/article/copula, and a
 * SCOPE restricted to prose lines (see `NON_PROSE_LINE_RE` and `scanFences`).
 *
 * All quantifiers are bounded ({1,9}, {0,2}) — linear-time, ReDoS-safe.
 */
const CARDINAL_TRIGGER = '(?<![\\w#$:/.-])\\d{1,9}(?![\\d.%:/-])';
const CARDINAL_STOPWORDS =
  'of|in|on|at|for|to|the|a|an|and|or|is|are|was|were|from|with|by|that|than|per|out|over|into|onto|via|but|as';
const CARDINAL_GAP = `(?:\\s+(?!(?:${CARDINAL_STOPWORDS})\\b)[A-Za-z][\\w-]*){0,2}`;
export const CARDINAL_PATTERN = new RegExp(`${CARDINAL_TRIGGER}${CARDINAL_GAP}\\s+${CARDINAL_NOUN}\\b`, 'i');

/**
 * Pattern 8 (#918) — the PSA-006 CANONICAL numerator/denominator slash form:
 * "12/14 files", "4/4 callers". Stricter contract than the bare cardinal:
 * exactly two slash-joined numbers, and the noun must follow IMMEDIATELY (no
 * gap), which is what separates a measured ratio from a date or a score
 * ("on 12/14 we shipped", "rated 3/5 overall").
 */
export const CARDINAL_RATIO_PATTERN = new RegExp(
  `(?<![\\w#$:/.-])\\d{1,9}/\\d{1,9}(?![\\d.%:/-])\\s+${CARDINAL_NOUN}\\b`,
  'i'
);

/** Inline-code spans are masked before any pattern runs. */
const INLINE_CODE_RE = /`[^`\n]*`/g;

/**
 * Gate-summary / STATUS-report lines are the HARNESS's own completion output —
 * tool evidence, not an unverified assertion about the codebase. GitLab #1198
 * (Discovery D8, 2026-09-02): a 400-event sample showed 186/400 (46.5%) firing
 * on this exact class — the single largest false-positive source measured to
 * date. Skipped at the LINE level, before ANY pattern runs.
 *
 * Trade named, not fixed: matching anywhere on the line silences the WHOLE
 * line, so a distributional claim sharing a line with a `Gate N/M` mention goes
 * unflagged too — accepted because a gate-summary line is harness evidence.
 */
const GATE_SUMMARY_LINE_RE =
  /\b\d+\s+passed\s*\/\s*\d+\s+failed\b|^\s*STATUS:\s*(?:done|partial|failed)\b|\bFull Gate\b|\bGate:\s*(?:typecheck|grün|gruen|rot)\b|\bGate \d[\d.]*\/\d+\b|\b\d+\s+Wellen?,\s*\d+\s+Agents?\b|\bArbeitsbaum leer\b|\bmit Nachweis geschlossen\b/i;

/**
 * GATE/DONE-VERDICT claim (#1397 w4-1) — the second claim class, and the one
 * the exemption above structurally hid.
 *
 * `GATE_SUMMARY_LINE_RE` is CORRECT for what it was built for: it keeps the
 * DISTRIBUTIONAL patterns off the harness's own completion output, where a
 * number is a field value rather than an assertion (186/400 = 46.5% of sampled
 * violations, #1198 D8). What it did NOT do is look at those lines for a claim
 * of a DIFFERENT kind — so `STATUS: done` and "alles grün" were the two line
 * shapes the scanner could never flag, which is precisely where "done" and
 * "green" get claimed.
 *
 * Measured 2026-09-19 over a 130-case labelled done-claim corpus
 * (`~/.cache/jev-eval/so/tasks/s2-done-claim.json`, gold `qid: "support"`):
 * `findViolations()` answered `supported` on 128 of 130 cases — accuracy 30.2%,
 * Cohen κ 0.007, statistically indistinguishable from guessing. Independent
 * evidence from the same build: of 50 done/partial reports carrying neither a
 * test count nor `exit 0`, 3 carry a bare gate-verdict claim with no command
 * anywhere in the report.
 *
 * TWO separate triggers, both deliberately gap-free (no `[^\n]{0,N}` bridge) so
 * a number or a verb between the noun and the verdict word breaks the match —
 * "The gate ran green on 2026-07-29" and "CI-Pipeline #6995 grün" are prose
 * about a past run, not a verdict being asserted now.
 */
const DONE_STATUS_RE =
  /^\s*(?:[-*+>]\s+|#{1,6}\s+)*\**\s*STATUS\**\s*[:=]\s*\**\s*(?:done|partial|complete|abgeschlossen|fertig)\b/i;

const GATE_GREEN_RE = new RegExp(
  [
    // English verdicts
    '\\b(?:all\\s+)?tests?\\s+(?:now\\s+)?pass(?:es|ed|ing)?\\b',
    '\\b(?:suite|gate|build|pipeline|ci)\\s+(?:is\\s+|are\\s+)?green\\b',
    '\\bgreen\\s+(?:gate|suite|build|pipeline)\\b',
    '\\b(?:typecheck|lint|build|gate|suite)\\s+(?:is\\s+)?(?:clean|passes|passing)\\b',
    '\\beverything\\s+(?:passes|is\\s+green)\\b',
    // "<gate>: PASS|clean|green|OK" — the shape the code-implementer report
    // template itself prescribes ("Verification — Typecheck: pass").
    '\\b(?:tests?|typecheck|lint|gate|build|suite)\\s*:\\s*\\**\\s*(?:pass|passed|clean|green|ok)\\b',
    // German verdicts
    '\\balles\\s+gr(?:ü|ue)n\\b',
    '\\balle\\s+Tests?\\s+gr(?:ü|ue)n\\b',
    '\\bgr(?:ü|ue)ne(?:[rsn]|nes)?\\s+(?:Gate|Suite|Lauf)\\b',
    '\\b(?:Full\\s+Gate|Gate|Suite)\\s*:?\\s*\\**\\s*(?:ist\\s+)?gr(?:ü|ue)n',
  ].join('|'),
  'i'
);

/**
 * A RUN RECEIPT — the counted result PSA-006 item 1-3 asks a gate claim to
 * carry: a pass/fail count, a typecheck file count, an exit code, or a
 * numerator/denominator green ratio. German forms alongside the English ones.
 *
 * Scope is the WHOLE scanned text, not the ±GREP_PROXIMITY_LINES window the
 * distributional class uses, and that asymmetry is the point: a distributional
 * claim is about ONE measurement and needs its transcript adjacent, while a
 * done/gate verdict is about the whole report's work — a report that quotes
 * `npm test` at the top and writes `STATUS: done` forty lines later IS
 * evidenced. The window still applies to the command half via
 * `nearIndex(measurementLines, …)`; this is the counted-result half.
 *
 * Deliberately LENIENT in the false-positive-safe direction: any exit code (not
 * only `0`) counts, because the question this class asks is "was anything run
 * at all?", never "did it pass?". A quoted `exit 1` means a run happened; the
 * verdict's truth is the coordinator's judgement, not a regex's.
 *
 * `(?<![A-Za-z])exit` rather than `\bexit`: the shells here emit `LINT_EXIT=0`
 * / `TYPECHECK_EXIT=0` / `VITEST_EXIT=0`, where `_` is a word character and
 * `\b` would therefore NOT match.
 *
 * All quantifiers bounded ({0,20}) — linear-time, ReDoS-safe.
 */
const RUN_RECEIPT_RE = new RegExp(
  [
    '\\b\\d+\\s+(?:passed|failed|bestanden|fehlgeschlagen|skipped)\\b',
    '\\b\\d+\\s+file(?:\\(s\\)|s)?\\s+OK\\b',
    '(?<![A-Za-z])exit(?:\\s*code)?\\s*[=:]?\\s*\\d+',
    '\\b\\d+\\s*/\\s*\\d+\\b[^\\n]{0,20}?\\b(?:passed|green|gr(?:ü|ue)n|tests?)\\b',
    '\\b(?:passed|failed)\\s*[=:]\\s*\\d+',
  ].join('|'),
  'i'
);

/** Claim-class discriminators carried on every violation record. */
export const KIND_DISTRIBUTIONAL = 'distributional';
export const KIND_GATE_VERDICT = 'gate-verdict';
/**
 * CLAIM-MISMATCH (#1385 R1) — the third class, and the one that closes an
 * INVERSION the other two leave standing.
 *
 * `RUN_RECEIPT_RE` is report-wide and knows `\d+\s+passed`, so the number an
 * agent asserts is accepted as its own receipt. Measured on this module at
 * HEAD before this change:
 *
 *   'STATUS: done\nTests pass: 5129 passed / 0 failed.'  ->  []
 *   'STATUS: done\nAlles grün.'                          ->  ['gate-verdict','gate-verdict']
 *
 * An invented number therefore DISARMS the guard, while an honest report with
 * no number is flagged. This class reads the `tool_result` side of the same
 * window and compares: the claim is only a violation when runs WERE observed
 * and NONE of them carries the asserted pass count.
 *
 * Deliberately NOT built (BV-001.1): the SHA-claim check. Measured 2026-09-19
 * by w1-3 over 1037 real subagent transcripts — 244 carried a SHA claim, 103
 * distinct tokens, 5 unresolvable in-repo, and all 5 were cross-repo
 * artefacts, 0 hallucinations. A check there produces only false alarms.
 */
export const KIND_CLAIM_MISMATCH = 'claim-mismatch';
/** `mismatch` sub-kind: a claimed test COUNT no observed run carries. */
export const MISMATCH_COUNT = 'count';

/**
 * Commands whose `tool_result` may carry a vitest run summary. Restricted to
 * vitest ON PURPOSE: `validate-plugin`'s own tally ("229 passed, 0 failed")
 * supplied 5 of the 12 false-alarm candidates in w1-3's pre-measurement, and
 * admitting a second counter means two number vocabularies in one comparison.
 *
 * Structurally reinforced by OBSERVED_SUMMARY_RE below, which demands vitest's
 * `Tests  N passed (M)` shape — validate-plugin's comma form cannot match it
 * even when it prints inside a `npx vitest` invocation (it is the suite's
 * globalSetup).
 */
const VITEST_CMD_RE = /\b(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|npx\s+vitest|vitest\s+run)\b/;

/**
 * Tools whose `tool_result` may carry a run summary even though the tool is
 * not the runner. Measured 2026-09-19 over 1044 real subagent transcripts:
 * the dominant local idiom is `npm test > run.log 2>&1` followed by a SEPARATE
 * step that surfaces the log — `Read` on the log file (2 of 9 residual
 * firings) or `BashOutput` on a backgrounded run (1 of 9). Keyed on the TOOL
 * NAME because neither carries the runner command in its own input.
 *
 * Admitting these can only ever CLEAR a claim, never raise one — an extra
 * observation adds a number the claim may match. NAMED CEILING (BV-004): an
 * agent that WRITES a file containing a fabricated `Tests N passed (N)` line
 * and then `Read`s it back manufactures its own observation. Accepted: that
 * is a deliberate two-step forgery, where the class's target is the ordinary
 * one-step invented number. REVISIT TRIGGER: one observed case of a claim
 * cleared by a self-authored file.
 */
const RECEIPT_BEARING_TOOLS = new Set(['BashOutput', 'Read']);

/**
 * A vitest run summary line: `Tests  15419 passed | 11 skipped (15430)`.
 *
 * Anchored at line start so `Test Files  612 passed (612)` (a FILE count, not
 * a test count) and vitest's `⎯⎯ Failed Tests 1 ⎯⎯` banner cannot match — the
 * former because `Tests` is not followed by whitespace there, the latter
 * because the line does not begin with it.
 *
 * The optional `30:` / `  30→` prefix is NOT cosmetic: the log-reading idiom
 * above surfaces the summary through `grep -n`, `cat -n` or `Read`, all of
 * which prepend a line number. Without it the anchor missed a real receipt
 * that sat in the window — 2 of the 9 residual firings measured 2026-09-19
 * read `"30:      Tests  1 failed | 1338 passed (1339)"` verbatim.
 *
 * All quantifiers bounded — linear-time, ReDoS-safe.
 */
const OBSERVED_SUMMARY_RE =
  /^[^\S\n]{0,16}(?:\d{1,7}[:|→\t][^\S\n]{0,8})?Tests[^\S\n]{1,8}([^\n(]{0,120}?)[^\S\n]{0,8}\((\d{1,9})\)[^\S\n]{0,8}$/gm;
const PASSED_COUNT_RE = /(\d{1,9})\s+passed\b/i;
const FAILED_COUNT_RE = /(\d{1,9})\s+failed\b/i;

/** ANSI SGR sequences, stripped before a summary line is matched. */
// eslint-disable-next-line no-control-regex
const ANSI_SGR_RE = /\u001b\[[0-9;]{0,16}m/g;

/**
 * Digit-group separators admitted in a claimed count and stripped before it is
 * parsed: ASCII dot/comma plus NO-BREAK SPACE (U+00A0) and NARROW NO-BREAK
 * SPACE (U+202F), the two `toLocaleString` emits for de-AT / fr grouping.
 *
 * Written as ESCAPES inside a plain string, never as the literal characters.
 * Both forms behave identically at runtime and only one survives review: the
 * literal pair tripped `no-irregular-whitespace` AND is invisible on the page,
 * the same property that makes `validate-plugin`'s dangerous-invisible check
 * reject a U+200B. Defined ABOVE its first use — `CLAIMED_COUNT_RE` reads it
 * at module-evaluation time, and a `const` referenced from above is a TDZ
 * ReferenceError that `node --check` does not catch (only an import probe
 * does; see `.claude/rules/toolchain-and-build.md`).
 */
const THOUSANDS_SEP_CLASS = '[.,\\u00a0\\u202f]';

/**
 * A CLAIMED pass count in the agent's own prose: `Tests pass: 5129 passed`,
 * `51 tests passed`, `14,340 passed`. Global — a line routinely names SEVERAL
 * (`2 passed files; 70 tests passed`), and treating only the first as "the"
 * claim is what produced most of the measured false alarms (below).
 *
 * Three shapes the corpus forced, each measured 2026-09-19 over 1044 real
 * subagent transcripts (`~/.claude/projects/<slug>/<session>/subagents/`):
 *
 *   1. THOUSANDS SEPARATORS. `14,340 passed` read as `340` under a bare
 *      `\d{1,9}`, inventing a mismatch out of a parse error — 3 of the first
 *      12 samples. The group admits `1.091` / `14,340` / `14 340` and the
 *      separators are stripped before `Number()`.
 *   2. AN INTERVENING NOUN. `51 tests passed` hid the only number on the line
 *      that WAS observed.
 *   3. `passed` AS AN ORDINARY VERB. "the 8 test call sites at lines 715 …
 *      and 1080 passed bodies" is not a test result at all — `1080` is a line
 *      number and `passed` takes an object. The trailing lookahead therefore
 *      requires a RESULT context after the word: end of line, punctuation, a
 *      digit, or a short connector. The same lookahead subsumes the file
 *      tally (`2 passed files`), whose column-header form `Test Files` is
 *      caught by COUNT_CLAIM_EXCLUSION_RES.
 *
 * All quantifiers bounded — linear-time, ReDoS-safe.
 */
const CLAIMED_COUNT_RE = new RegExp(
  String.raw`(\d{1,3}(?:${THOUSANDS_SEP_CLASS}\d{3})+|\d{1,9})\s{1,4}(?:tests?\s{1,4})?passed\b` +
    String.raw`(?=\s{0,4}(?:$|[,.;:/|)*\]!—-]|\d|(?:and|und|in|with|on|at|after|before|for|across|under|exit)\b))`,
  'gi'
);
const THOUSANDS_SEP_RE = new RegExp(THOUSANDS_SEP_CLASS, 'g');

/**
 * Every pass count asserted on one line, in encounter order.
 *
 * @param {string} line
 * @returns {number[]}
 */
function extractClaimedCounts(line) {
  const out = [];
  CLAIMED_COUNT_RE.lastIndex = 0;
  for (const m of line.matchAll(CLAIMED_COUNT_RE)) {
    const n = Number(m[1].replace(THOUSANDS_SEP_RE, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Lines that carry `N passed` WITHOUT asserting this run's test count. Each
 * entry is one of the four false-alarm forms w1-3 measured; a fifth would go
 * here rather than into a widened threshold (HR-101 / development.md §
 * Guard & Threshold Design — category separation, never a looser number).
 *
 *   1. A DIFFERENT instrument with the same word shape — vitest's own file
 *      tally, `validate-plugin`, the `check-rules`/`check-skills`/`check-docs`
 *      validators, a `Results:` summary line.
 *   2. A QUOTED foreign assertion — "the reviewer claimed 5129 passed".
 *   3. A RED-BEFORE-FIX number — the fake-regression proof a bugfix owes
 *      (`.claude/rules/testing.md` § Negative-Assertion Fake-Regression
 *      Check) names a count that deliberately does NOT match the green run.
 *      The marker list is wider than the briefed four because the corpus said
 *      so: the first real hit read "RED proof: mutated peer-discovery loader
 *      — 2 failed, 0 passed", which `mutation` and `red before` both miss.
 *   4. A JSON key line — a field value, not an assertion (same reasoning as
 *      CONFIG_KEY_LINE_RE above, narrowed to the quoted-key form).
 */
const COUNT_CLAIM_EXCLUSION_RES = [
  /Test\s+Files/i,
  /validate[-_]plugin/i,
  /check[-_](?:rules|skills|docs)/i,
  /Results:/i,
  /^\s*"[^"\n]{1,64}"\s*:/,
  /\b(?:red before|red proof|rot vor|vor dem Fix|before the fix|mutat(?:e|ed|es|ing|ion)|Fake-Regression|baseline|Rot-Lauf|Rot-Beweis)\b/i,
  /\b(?:claimed|stated|behauptet|laut)\b/i,
];

/**
 * Cap on observations carried into the pair-sum search below.
 *
 * NAMED CEILING (BV-004): the partial-run match is O(n²) over this list. 50
 * keeps the worst case at 1,225 additions — free beside the regex passes this
 * module already makes. REVISIT TRIGGER: a transcript whose window holds more
 * than 50 vitest summaries AND a claim that only the dropped ones explain.
 */
const MAX_OBSERVATIONS = 50;

/**
 * NON-PROSE structural lines (#1218 negative-context guard). A PSA-006 claim is
 * an ASSERTION in prose; these four shapes are not prose at all, and every one
 * of them was measured as a live false-positive class.
 *
 * Measured 2026-09-06 over the 205 DISTINCT `claim_text` values in
 * `~/Projects/extern/aiat-barrierefrei-engine/.orchestrator/metrics/events.jsonl`
 * (the fleet's worst-affected repo; command in the module test header):
 * 201/205 re-fire on the pre-#1218 matcher, of which 35 are markdown table
 * rows and 9 are ATX headings — 44 firings, 21.9% of the corpus, with a true
 * positive rate of zero in the independently sampled 60 (2026-09-02).
 *
 *   1. TABLE ROW — `| Lane B | 3 Commits, Baum sauber |`. A status matrix
 *      cell is structured data; the number in it is a field value.
 *   2. TABLE SEPARATOR — `|---|---:|`.
 *   3. ATX HEADING — `## Welle 1 abgeschlossen — 10/10 Lanes, 15 Commits`. A
 *      heading LABELS a section; the claim, if there is one, is restated in
 *      the body below it where it is still caught.
 *      NAMED CEILING (BV-004): a claim that appears ONLY in a heading and
 *      never in the body escapes. Accepted because the class measured zero
 *      true positives; REVISIT TRIGGER: a labelled sample in which a
 *      heading-only claim is a genuine PSA-006 violation.
 *   4. PLAN / INTENT item — a task-list checkbox, or a line whose FIRST token
 *      declares intent rather than a finding (`TODO`, `Next`, `Geplant`,
 *      `Empfehlung`, `Follow-up`, …). An intent is a statement about the
 *      future; PSA-006 governs assertions about the present.
 *
 * All four are anchored at line START (after at most one bullet marker), so a
 * mid-sentence "TODO" or a pipe character inside prose cannot silence a line.
 */
const TABLE_ROW_RE = /^\s{0,3}\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s{0,3}\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+\S/;
const PLAN_INTENT_RE =
  /^\s*(?:[-*+]\s+)?(?:\[[ xX]\]|TODO\b|FIXME\b|Plan\b|Planned\b|Next\b|Geplant\b|N(?:ä|ae)chste[rs]?\b|Vorschlag\b|Empfehlung\b|Recommendation\b|Follow-?ups?\b|Ziel\b|Aufgabe\b)/i;

const NON_PROSE_LINE_RE = new RegExp(
  `(${TABLE_ROW_RE.source})|(${TABLE_SEPARATOR_RE.source})|(${HEADING_RE.source})|(${PLAN_INTENT_RE.source})`,
  'i'
);

/**
 * The same guard MINUS the heading rule, for the gate/done-verdict class. The
 * #1218 heading exemption was measured on DISTRIBUTIONAL claims, where a
 * heading labels a section and the claim is restated in the body below. A gate
 * verdict is the opposite: `### Tests: PASS` and `## Wave 3 Complete — Gate: …`
 * ARE the verdict, and nothing restates them. Table rows, separators and
 * plan/intent items stay excluded for both classes — a task-list `- [ ] make
 * the suite green` is intent, and a status-matrix cell is structured data.
 */
const NON_PROSE_NO_HEADING_RE = new RegExp(
  `(${TABLE_ROW_RE.source})|(${TABLE_SEPARATOR_RE.source})|(${PLAN_INTENT_RE.source})`,
  'i'
);

/**
 * CONFIG / SCORE / VERSION literal line (#1218). A `key: <scalar>` line is a
 * configuration or JSON fragment, not an assertion — the number is a SETTING.
 *
 * The key must be all-lowercase kebab/snake (`agents-per-wave`, `"session_id"`,
 * `enabled`) — which is exactly what distinguishes a YAML/JSON key from a
 * German or English prose label. `Gemessen: 4 von 4 Aufrufern` keeps its
 * capital G and stays a claim; `quota-per-wave: 5` does not.
 *
 * Version literals (`v0.15.0`, `0.18.0`) need no rule of their own: the
 * cardinal trigger's `(?![\d.%:/-])` lookahead already rejects a digit followed
 * by a dot. Score ratios (`PAC bei 23/29`, `rated 3/5 overall`) are likewise
 * already excluded — CARDINAL_RATIO_PATTERN demands an artefact noun
 * immediately after the denominator. This rule closes the remaining third of
 * the class: the config-block line.
 *
 * Suppresses ONLY the cardinal/ratio branch, never the quantifier patterns: a
 * genuine "all 4 callers" inside a config-shaped line is still a claim.
 */
const CONFIG_KEY_LINE_RE =
  /^\s*(?:[-*+]\s+)?["']?[a-z_][a-z0-9_.-]*["']?\s*:\s*(?:["'[{]|-?\d|true\b|false\b|null\b|on\b|off\b|~\s*$)/;

/**
 * A YAML/JSON BLOCK line that is not itself a `key: value` pair — a bare list
 * item or a closing brace/bracket inside an object literal. Only recognised
 * when the surrounding lines are config lines (see `scanConfigBlocks`), so a
 * prose bullet is never mistaken for one.
 */
const CONFIG_CONTINUATION_RE = /^\s*(?:[-*]\s+\S|[}\]],?\s*$)/;

/**
 * Commands that count as a MEASUREMENT inside a fenced or inline-code block.
 * `grep|rg|find` (the #567 set) only covers text search; the #908 facts are
 * measured with `git log --oneline | wc -l`, `jq` over a JSONL metrics file,
 * `ls | wc -l`, or a `node`/`npm` script.
 */
const MEASUREMENT_CMD_RE = /\b(grep|rg|find|git|wc|jq|ls|node|npm)\b/;

/**
 * GERMAN PROSE evidence (#1218). Until now a measurement only counted when it
 * appeared as a COMMAND — fenced or in backticks — so the German evidence
 * forms this repo's own rules prescribe (`Gemessen 2026-09-06 …`,
 * `Verifizierte Zahlen … HEAD <sha>`) were read as unverified prose and the
 * honest author was flagged. PSA-006 item 4 asks for the measurement TIME; a
 * German marker that carries one is evidence by the rule's own definition.
 *
 * The marker alone grants nothing: it must be followed within 80 characters by
 * an ISO date, `HEAD`, or a commit SHA. `Gemessen wurde nichts` therefore does
 * not buy an exemption, while `Gemessen 2026-09-06 @ e4674109: 4 von 4` does.
 * Bounded quantifier ({0,80}) — linear-time, ReDoS-safe.
 */
const GERMAN_EVIDENCE_RE =
  /\b(?:gemessen|nachgemessen|nachgez(?:ä|ae)hlt|ausgez(?:ä|ae)hlt|verifizierte\s+zahlen|verifiziert\s+(?:gegen|an|auf))\b[^\n]{0,80}?(?:\b\d{4}-\d{2}-\d{2}\b|\bHEAD\b|\b[0-9a-f]{7,40}\b)/i;

/**
 * Markers that date a measurement (#908 Baustein 2 input). ADVISORY: an
 * undated-but-verified claim is counted and reported, never a violation.
 * German markers (#1218) sit alongside the English ones for the same reason
 * the evidence rule above admits them.
 */
const TIMESTAMP_MARKER_RE =
  /\b\d{4}-\d{2}-\d{2}\b|\bHEAD\b|\bas of\b|\bmeasured (?:at|on)\b|\brev-parse\b|\bgemessen (?:am|an|auf|gegen)\b|\bStand vom\b/i;

/** Leading list-bullet / heading / blockquote markers stripped by `normalizeClaim`. */
const LEADING_MARKER_RE = /^(?:\s*(?:[-*+•]|\d{1,3}[.)]|#{1,6}|>)\s+)+/;

// ---------------------------------------------------------------------------
// transcript reading
// ---------------------------------------------------------------------------

/**
 * Read the transcript JSONL at `transcriptPath`, take the last `TAIL_RECORDS`
 * `type:"assistant"` records, and concatenate their text content blocks.
 * Returns '' on any failure (missing file, /dev/null, malformed lines).
 *
 * @param {string} transcriptPath
 * @returns {Promise<string>}
 */
/**
 * Parse the bounded tail window of `transcriptPath` into JSONL records.
 *
 * Shared by both readers below; each still performs its own window read, so a
 * hook that wants both pays two ≤2 MiB reads. Accepted (BV-004): the hook runs
 * once per SubagentStop and the page cache serves the second read.
 *
 * @param {string} transcriptPath
 * @returns {object[]} parsed records, oldest first; `[]` on any failure
 */
function readTailRecords(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return [];
  let raw;
  let cut;
  try {
    // Bounded read (#1388 P4): the whole transcript used to be decoded and
    // JSON-parsed line by line only to keep the last 8 assistant records.
    ({ text: raw, cut } = readTailWindow(transcriptPath, TAIL_WINDOW_BYTES));
  } catch {
    // Every fs error (ENOENT, /dev/null EACCES, …) maps to empty —
    // readTailWindow THROWS where the former fs.readFile catch swallowed, and
    // the callers (post-subagent-discovery-validator) rely on that contract.
    return [];
  }
  if (!raw.trim()) return [];

  const lines = raw.split(/\r?\n/);
  // `cut` means the window did not start at byte 0, so line 0 is (or may be) a
  // record fragment, possibly severed mid-UTF-8. Drop it explicitly rather than
  // leaning on the JSON.parse catch below: a truncated record can still parse.
  if (cut) lines.shift();

  const records = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (rec) records.push(rec);
  }
  return records;
}

export async function readTranscriptTail(transcriptPath) {
  const assistantRecords = readTailRecords(transcriptPath).filter((r) => r.type === 'assistant');
  if (assistantRecords.length === 0) return '';

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

/**
 * Flatten a `tool_result` block's content to text. Measured on a real
 * transcript (2026-09-19, `~/.claude/projects/<slug>/<session>/subagents/`):
 * `content` is a plain STRING on the Bash results sampled, and the array-of-
 * blocks form is the documented alternative — both are handled, because a
 * reader that knows only one shape silently observes nothing and every claim
 * then reads as unobserved (the fail-OPEN direction is correct here, but a
 * shape gap would make this whole class inert without saying so).
 *
 * @param {*} content
 * @returns {string}
 */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Read the vitest run summaries the agent ACTUALLY produced inside the same
 * bounded tail window `readTranscriptTail()` reads.
 *
 * A second reader rather than a second pattern: `readTranscriptTail()`
 * collects assistant `text` blocks, and a `tool_result` lives in a `user`
 * record — the two never meet. The `tool_use` → `tool_result` join is by
 * `tool_use_id`, so only the results of a vitest Bash command (or of the
 * receipt-bearing tools above) are read; a `git log` result that happens to
 * contain the word "passed" is not an observation.
 *
 * Returns at most `MAX_OBSERVATIONS` entries, newest last.
 *
 * @param {string} transcriptPath
 * @returns {Promise<{passed: number, failed: number, total: number}[]>}
 */
export async function readTranscriptObservations(transcriptPath) {
  const records = readTailRecords(transcriptPath);
  if (records.length === 0) return [];

  /** @type {Set<string>} tool_use ids whose result may carry a run summary */
  const receiptToolUseIds = new Set();
  for (const rec of records) {
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      if (typeof block.id !== 'string' || !block.id) continue;
      if (RECEIPT_BEARING_TOOLS.has(block.name)) { receiptToolUseIds.add(block.id); continue; }
      if (block.name !== 'Bash') continue;
      const cmd = block?.input?.command;
      if (typeof cmd === 'string' && VITEST_CMD_RE.test(cmd)) receiptToolUseIds.add(block.id);
    }
  }
  if (receiptToolUseIds.size === 0) return [];

  const observations = [];
  for (const rec of records) {
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_result') continue;
      if (!receiptToolUseIds.has(block.tool_use_id)) continue;
      const text = toolResultText(block.content).replace(ANSI_SGR_RE, '');
      if (!text) continue;
      OBSERVED_SUMMARY_RE.lastIndex = 0;
      for (const m of text.matchAll(OBSERVED_SUMMARY_RE)) {
        const body = m[1] ?? '';
        const passedMatch = PASSED_COUNT_RE.exec(body);
        if (!passedMatch) continue; // `Tests  no tests (0)` and friends
        const failedMatch = FAILED_COUNT_RE.exec(body);
        observations.push({
          passed: Number(passedMatch[1]),
          failed: failedMatch ? Number(failedMatch[1]) : 0,
          total: Number(m[2]),
        });
      }
    }
  }
  return observations.slice(-MAX_OBSERVATIONS);
}

// ---------------------------------------------------------------------------
// claim scanning
// ---------------------------------------------------------------------------

/**
 * Single fence walk. Returns two disjoint-purpose index sets:
 *   - `measurementLines`: lines belonging to a fenced block whose body contains
 *     a MEASUREMENT_CMD_RE invocation (the evidence a claim can lean on), plus
 *     lines carrying an inline-code measurement or a German prose measurement.
 *   - `fencedLines`: lines belonging to ANY fenced block (evidence or not).
 *     Used only to keep the greedy #908 cardinal pattern out of tool output.
 *
 * An unterminated trailing fence is treated as fenced-to-EOF (conservative for
 * false-positive suppression) but never as a measurement block.
 *
 * @param {string[]} lines
 * @returns {{ measurementLines: Set<number>, fencedLines: Set<number> }}
 */
export function scanFences(lines) {
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
  // well as a fenced block. GERMAN PROSE evidence (#1218) is admitted on the
  // same line-level footing: `Gemessen 2026-09-06 @ e4674109` is a dated
  // measurement declaration, which is what the rule asks for.
  for (let i = 0; i < lines.length; i++) {
    if (fencedLines.has(i)) continue;
    if (GERMAN_EVIDENCE_RE.test(lines[i])) { measurementLines.add(i); continue; }
    for (const span of lines[i].match(INLINE_CODE_RE) ?? []) {
      if (MEASUREMENT_CMD_RE.test(span)) { measurementLines.add(i); break; }
    }
  }

  return { measurementLines, fencedLines };
}

/**
 * Index set of lines that belong to a YAML/JSON block (#1218). A `key: scalar`
 * line always qualifies; a bare list item or a closing brace qualifies only
 * when an adjacent line is already a config line, so an ordinary prose bullet
 * is never swept in.
 *
 * @param {string[]} lines
 * @returns {Set<number>}
 */
export function scanConfigBlocks(lines) {
  const configLines = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (CONFIG_KEY_LINE_RE.test(lines[i])) configLines.add(i);
  }
  // One widening pass: continuation lines glued to a config line above them.
  for (let i = 1; i < lines.length; i++) {
    if (configLines.has(i)) continue;
    if (configLines.has(i - 1) && CONFIG_CONTINUATION_RE.test(lines[i])) configLines.add(i);
  }
  return configLines;
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
 * Normalise a claim line into its dedup key (#1198): trim, strip leading
 * bullet / ordered-list / heading / blockquote markers, collapse all internal
 * whitespace runs to one space, lowercase.
 *
 * The marker strip is what makes the key stable across the re-formatting an
 * agent does between a bullet in its progress note and the same sentence in
 * its final report — the two shapes that produced the measured duplication.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeClaim(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(LEADING_MARKER_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Collapse repeated claims into one entry per distinct (kind, normalized key),
 * preserving first-seen order and counting `occurrences` (#1198).
 *
 * Accepts a bare string (kind defaults to `distributional`) or a
 * `{claim, kind, detail?}` record — the claim classes never merge into one
 * entry even when they land on the identical line, because a coordinator
 * triaging the ledger needs to know WHICH rule the line broke.
 *
 * `detail` (the `claim-mismatch` class's `{mismatch, claimed, observed,
 * observed_n}` payload) rides along FIRST-SEEN-WINS: a repeat of the same
 * normalized line was compared against the same observation set, so a second
 * copy would carry identical numbers.
 *
 * @param {(string|{claim: string, kind?: string, detail?: object})[]} claims — in encounter order
 * @returns {{claim: string, normalized: string, occurrences: number, kind: string, detail?: object}[]}
 */
export function dedupeViolations(claims) {
  /** @type {Map<string, {claim: string, normalized: string, occurrences: number, kind: string, detail?: object}>} */
  const byKey = new Map();
  for (const entry of claims) {
    const claim = typeof entry === 'string' ? entry : entry?.claim;
    const kind = (typeof entry === 'string' ? undefined : entry?.kind) ?? KIND_DISTRIBUTIONAL;
    const detail = typeof entry === 'string' ? undefined : entry?.detail;
    if (typeof claim !== 'string') continue;
    const normalized = normalizeClaim(claim);
    if (!normalized) continue;
    const key = `${kind}\u0000${normalized}`;
    const hit = byKey.get(key);
    if (hit) { hit.occurrences += 1; continue; }
    byKey.set(key, {
      claim,
      normalized,
      occurrences: 1,
      kind,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
  return [...byKey.values()];
}

/**
 * ANY-MATCH test for a claimed pass count against the observed runs (R1).
 *
 * "Any" is the whole design: a report legitimately quotes ONE of several runs
 * it made, so a claim is evidenced the moment a single observation carries its
 * number. Only a claim that matches NONE of them is a mismatch.
 *
 * PARTIAL RUNS: two observations may be summed, because splitting a suite over
 * two `npx vitest run <files>` invocations and reporting the total is normal
 * here. NAMED CEILING (BV-004): PAIRS ONLY — three-way sums are not searched,
 * since admitting them makes almost any number reachable from a handful of
 * runs and the class stops discriminating. REVISIT TRIGGER: one documented
 * report whose honest total is the sum of three separate runs.
 *
 * @param {number} claimedPassed
 * @param {{passed: number}[]} observations
 * @returns {boolean} true when some observation (or observation PAIR) carries it
 */
function observationsCarryCount(claimedPassed, observations) {
  for (const o of observations) {
    if (o.passed === claimedPassed) return true;
  }
  for (let i = 0; i < observations.length; i++) {
    for (let j = i + 1; j < observations.length; j++) {
      if (observations[i].passed + observations[j].passed === claimedPassed) return true;
    }
  }
  return false;
}

/**
 * Scan concatenated transcript text for claims lacking an adjacent measurement
 * block (within ±GREP_PROXIMITY_LINES).
 *
 * THREE claim classes, reported through one list and told apart by `kind`:
 *   - `distributional` (#567/#908/#1211) — "4 of 4 callers", "14 commits".
 *     Evidence must be ADJACENT (±GREP_PROXIMITY_LINES).
 *   - `gate-verdict` (w4-1) — "STATUS: done", "alles grün", "Tests: PASS".
 *     Evidence is an adjacent measurement command OR a RUN RECEIPT anywhere in
 *     the report (see RUN_RECEIPT_RE for why the scopes differ).
 *   - `claim-mismatch` (#1385 R1) — "5129 passed" where every vitest run in
 *     the window reported a different count. Evidence is the `tool_result`
 *     side of the transcript, supplied by the caller as `observations`.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {{passed: number, failed: number, total: number}[]} [opts.observations]
 *   vitest run summaries from `readTranscriptObservations()`. DEFAULT EMPTY,
 *   and an empty list disables the `claim-mismatch` class entirely — absence
 *   of evidence is `gate-verdict`'s job, never this one's. (Measured
 *   2026-09-19: 488 of 503 transcripts carrying a count claim had at least one
 *   vitest summary in the window, so the disabled case is the rare one.)
 * @returns {{ violations: {claim: string, normalized: string, occurrences: number, kind: string, detail?: object}[], undatedVerified: number }}
 *   `violations` — deduplicated, truncated claim snippets with an occurrence
 *   count and a claim-class `kind`; `undatedVerified` — count of DISTRIBUTIONAL
 *   claims that ARE verified but carry no measurement timestamp (advisory).
 */
export function findViolations(text, opts = {}) {
  if (!text) return { violations: [], undatedVerified: 0 };
  const observations = Array.isArray(opts.observations) ? opts.observations : [];
  const lines = text.split(/\r?\n/);
  const { measurementLines, fencedLines } = scanFences(lines);
  const configLines = scanConfigBlocks(lines);
  // Report-wide, computed ONCE: the counted-result half of the gate class's
  // evidence test. Costs one regex pass over the tail, not one per line.
  const hasRunReceipt = RUN_RECEIPT_RE.test(text);
  const raw = [];
  let undatedVerified = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // #1198 FIX 3 (masking-order bug): mask inline-code spans ONCE, then test
    // every pattern against the masked text, so a claim quoted entirely inside
    // backticks (evidence or example text, not an assertion) cannot trip one.
    const masked = line.replace(INLINE_CODE_RE, ' ');

    // --- gate/done-verdict class -------------------------------------------
    // Runs BEFORE the GATE_SUMMARY_LINE_RE skip BY DESIGN: that skip exists to
    // keep the DISTRIBUTIONAL patterns off harness gate output, and the two
    // line shapes it exempts are exactly the ones this class must see.
    if (
      !fencedLines.has(i) &&
      !NON_PROSE_NO_HEADING_RE.test(line) &&
      (DONE_STATUS_RE.test(masked) || GATE_GREEN_RE.test(masked)) &&
      !hasRunReceipt &&
      !nearIndex(measurementLines, i)
    ) {
      raw.push({ claim: line.trim().slice(0, CLAIM_TEXT_MAX), kind: KIND_GATE_VERDICT });
    }

    // --- claim-mismatch class (#1385 R1) -----------------------------------
    // Also BEFORE the GATE_SUMMARY_LINE_RE skip, and for the same reason the
    // gate class is: that skip exempts exactly the `N passed / M failed` line
    // shape this class must read. The distributional patterns keep the skip
    // untouched (#1198 — 46.5% of a 400-event false-positive sample).
    //
    // FENCED LINES ARE NOT CLAIMS: a pasted run summary inside ``` is quoted
    // tool output. Scanning it would flag the honest report that quotes a run
    // older than the window, which is the expensive direction.
    if (
      observations.length > 0 &&
      !fencedLines.has(i) &&
      !NON_PROSE_NO_HEADING_RE.test(line) &&
      !COUNT_CLAIM_EXCLUSION_RES.some((re) => re.test(line))
    ) {
      // ANY-MATCH ON BOTH SIDES. A line names several counts routinely
      // (`2 passed files; 70 tests passed`, `40 passed (40) / Tests 1091
      // passed (1091)`), and treating the FIRST as "the" claim flagged
      // reports whose observed number sat later on the same line — 5 of the
      // first 12 corpus hits. The line is a mismatch only when NOT ONE of the
      // counts it names is carried by any observed run.
      const claimedCounts = extractClaimedCounts(masked);
      if (claimedCounts.length > 0) {
        if (!claimedCounts.some((n) => observationsCarryCount(n, observations))) {
          const failedMatch = FAILED_COUNT_RE.exec(masked);
          raw.push({
            claim: line.trim().slice(0, CLAIM_TEXT_MAX),
            kind: KIND_CLAIM_MISMATCH,
            detail: {
              mismatch: MISMATCH_COUNT,
              claimed: {
                passed: claimedCounts[0],
                failed: failedMatch ? Number(failedMatch[1]) : null,
              },
              // The three most recent runs — enough for the coordinator to see
              // WHAT was actually measured without copying the whole window
              // into the ledger. NO raw command text: precedent is `8f15f77b`
              // (`command_hash` instead of the raw command).
              observed: observations.slice(-3),
              observed_n: observations.length,
            },
          });
        }
      }
    }

    // --- distributional class (unchanged) ----------------------------------
    // #1198 FIX 2: gate-summary/STATUS lines are tool OUTPUT, not a
    // distributional claim — skipped before any pattern runs.
    if (GATE_SUMMARY_LINE_RE.test(line)) continue;
    // #1218: table rows, headings and plan/intent items are not prose
    // assertions at all — skipped before any pattern runs.
    if (NON_PROSE_LINE_RE.test(line)) continue;

    let matched = CLAIM_PATTERNS.some((re) => re.test(masked));
    if (!matched && !fencedLines.has(i) && !configLines.has(i)) {
      matched = CARDINAL_PATTERN.test(masked) || CARDINAL_RATIO_PATTERN.test(masked);
    }
    if (!matched) continue;

    if (nearIndex(measurementLines, i)) {
      if (!hasMeasurementTimestamp(lines, i)) undatedVerified++;
      continue;
    }

    raw.push({ claim: line.trim().slice(0, CLAIM_TEXT_MAX), kind: KIND_DISTRIBUTIONAL });
  }
  return { violations: dedupeViolations(raw), undatedVerified };
}
