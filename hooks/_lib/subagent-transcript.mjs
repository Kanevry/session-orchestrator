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
 * Three responsibilities, in the order the hook uses them:
 *   1. `readTranscriptTail()` — the last N assistant records of ONE transcript
 *      JSONL, text blocks concatenated.
 *   2. `findViolations()` — distributional/repo-state claims that carry no
 *      adjacent measurement evidence.
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
export async function readTranscriptTail(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return '';
  let raw;
  let cut;
  try {
    // Bounded read (#1388 P4): the whole transcript used to be decoded and
    // JSON-parsed line by line only to keep the last 8 assistant records.
    ({ text: raw, cut } = readTailWindow(transcriptPath, TAIL_WINDOW_BYTES));
  } catch {
    // Every fs error (ENOENT, /dev/null EACCES, …) maps to '' — readTailWindow
    // THROWS where the former fs.readFile catch swallowed, and the caller
    // (post-subagent-discovery-validator) relies on the '' contract.
    return '';
  }
  if (!raw.trim()) return '';

  const lines = raw.split(/\r?\n/);
  // `cut` means the window did not start at byte 0, so line 0 is (or may be) a
  // record fragment, possibly severed mid-UTF-8. Drop it explicitly rather than
  // leaning on the JSON.parse catch below: a truncated record can still parse.
  if (cut) lines.shift();

  const assistantRecords = [];
  for (const line of lines) {
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
 * `{claim, kind}` record — the two claim classes never merge into one entry
 * even when they land on the identical line, because a coordinator triaging
 * the ledger needs to know WHICH rule the line broke.
 *
 * @param {(string|{claim: string, kind?: string})[]} claims — in encounter order
 * @returns {{claim: string, normalized: string, occurrences: number, kind: string}[]}
 */
export function dedupeViolations(claims) {
  /** @type {Map<string, {claim: string, normalized: string, occurrences: number, kind: string}>} */
  const byKey = new Map();
  for (const entry of claims) {
    const claim = typeof entry === 'string' ? entry : entry?.claim;
    const kind = (typeof entry === 'string' ? undefined : entry?.kind) ?? KIND_DISTRIBUTIONAL;
    if (typeof claim !== 'string') continue;
    const normalized = normalizeClaim(claim);
    if (!normalized) continue;
    const key = `${kind}\u0000${normalized}`;
    const hit = byKey.get(key);
    if (hit) { hit.occurrences += 1; continue; }
    byKey.set(key, { claim, normalized, occurrences: 1, kind });
  }
  return [...byKey.values()];
}

/**
 * Scan concatenated transcript text for claims lacking an adjacent measurement
 * block (within ±GREP_PROXIMITY_LINES).
 *
 * TWO claim classes, reported through one list and told apart by `kind`:
 *   - `distributional` (#567/#908/#1211) — "4 of 4 callers", "14 commits".
 *     Evidence must be ADJACENT (±GREP_PROXIMITY_LINES).
 *   - `gate-verdict` (w4-1) — "STATUS: done", "alles grün", "Tests: PASS".
 *     Evidence is an adjacent measurement command OR a RUN RECEIPT anywhere in
 *     the report (see RUN_RECEIPT_RE for why the scopes differ).
 *
 * @param {string} text
 * @returns {{ violations: {claim: string, normalized: string, occurrences: number, kind: string}[], undatedVerified: number }}
 *   `violations` — deduplicated, truncated claim snippets with an occurrence
 *   count and a claim-class `kind`; `undatedVerified` — count of DISTRIBUTIONAL
 *   claims that ARE verified but carry no measurement timestamp (advisory).
 */
export function findViolations(text) {
  if (!text) return { violations: [], undatedVerified: 0 };
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
