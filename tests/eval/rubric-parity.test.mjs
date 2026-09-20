/**
 * tests/eval/rubric-parity.test.mjs — the PRE-REGISTERED `instruction-adherence`
 * contract in `skills/eval/rubric-v2.md` against its declared executable copy in
 * `scripts/lib/eval/judge.mjs`.
 *
 * WHY this file exists. `rubric-v2.md` states above its six ordered decision
 * rules: *"Pre-registered verbatim; the executable copy is `JUDGE_RULES` in
 * `scripts/lib/eval/judge.mjs`"* — and `JUDGE_RULES` is what `buildJudgePrompt()`
 * renders into the judge prompt. Nothing checked the two against each other:
 * `rg -n "JUDGE_RULES|rubric-v2.md" tests/` hit only the ux-grill parity test
 * (a different rubric). The gap is not hypothetical — commit `b9ca527a`
 * (2026-09-19) extended decision rule 1 in the rubric and left the executable
 * copy at its old text, so the judge stopped seeing what the rubric
 * pre-registers, silently. Rules 3 and 5 had drifted in wording before that.
 *
 * NAMEABLE BUG: a pre-registered rule edited on one side only — the document an
 * operator reads (and whose full text is the `rubric_sha256` comparability key)
 * then promises a decision rule the judge never receives.
 *
 * THIS IS A MACHINE CONTRACT, NOT A PROSE PIN (`.claude/rules/test-value.md`
 * TV-002c). Nothing here asserts that some sentence exists in a document: every
 * assertion compares a SECOND artefact — an exported constant, or the live
 * return shape of `computeRecordFacts()` — against the first. The census is
 * PARSED out of the markdown, never hand-typed (`.claude/rules/
 * measurement-discipline.md` § "A parity test with a hand-typed list under a
 * census title is a green tick with no cover"), which is why the VACUUM GUARD
 * below must go RED when the parse comes back empty.
 *
 * NORMALISATION (kept as narrow as the two shapes allow — a generous normaliser
 * turns this file into a green tick with no cover). The rubric copy is Markdown,
 * the executable copy is prompt plain-text; three classes of pure MARKUP differ
 * and nothing else may:
 *   1. inline-code backticks — `facts.contradictions` vs facts.contradictions
 *   2. emphasis: the document writes `**never `fail`**`, the prompt copy writes
 *      NEVER "fail" — bold becomes capitals, so CASE carries markup here and is
 *      folded away. (Word-level changes are still caught; only shouting is not.)
 *   3. literal markers around status words — backticks in the document, double
 *      quotes in the prompt copy — plus line-wrap whitespace.
 * Everything else — every word, every number, every other punctuation mark —
 * must match exactly.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { RUBRIC_RELATIVE_PATH } from '../../scripts/lib/eval/engine.mjs';
import { JUDGE_QUESTIONS, JUDGE_RULES, computeRecordFacts } from '../../scripts/lib/eval/judge.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
/** The rubric path the ENGINE declares — so a rubric rename moves this test with it. */
const rubricPath = path.join(repoRoot, RUBRIC_RELATIVE_PATH);
const rubric = fs.readFileSync(rubricPath, 'utf8');
const rubricLines = rubric.split('\n');

/** Anchors — structural, never line numbers. */
const RULES_HEADING = '**Decision rules, applied IN THIS ORDER';
const QUESTION_BULLET = '- **Judge question:**';
const FACTS_PARAGRAPH = '**Facts are pre-computed, not inferred.**';
const FACTS_LIST_MARKER = 'handed to the judge as typed values —';

/** See § NORMALISATION in the file docblock. */
function normalise(text) {
  return text
    .replace(/`/g, '') // 1. inline-code markers
    .replace(/\*+/g, '') // 2a. emphasis markers
    .replace(/["“”]/g, '') // 3. literal markers around status words
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase(); // 2b. bold in the document == capitals in the prompt copy
}

/**
 * The six ordered decision rules, parsed out of the numbered list under the
 * decision-rules heading. Continuation lines (the markdown wrap) are folded
 * into their item; the list ends at the first line that is neither a new item
 * nor an indented continuation.
 *
 * @returns {Array<{n: number, text: string}>}
 */
function parseRubricRules() {
  const anchor = rubricLines.findIndex((line) => line.startsWith(RULES_HEADING));
  if (anchor < 0) throw new Error(`rubric no longer carries the decision-rules heading: ${RULES_HEADING}`);

  /** @type {Array<{n: number, text: string}>} */
  const rules = [];
  // Bounded scan: the heading, two lines of prose, a blank line, then the list.
  for (const line of rubricLines.slice(anchor + 1, anchor + 80)) {
    const item = /^(\d+)\.\s+(.*)$/.exec(line);
    if (item) {
      rules.push({ n: Number(item[1]), text: item[2] });
      continue;
    }
    if (rules.length === 0) continue; // still in the lead-in prose
    if (/^\s+\S/.test(line)) {
      rules[rules.length - 1].text += ` ${line.trim()}`;
      continue;
    }
    break; // blank line or unindented prose — the list is over
  }
  return rules;
}

/** The judge question, parsed out of its `*"…"*` quotation in the bullet. */
function parseRubricQuestion() {
  const anchor = rubricLines.findIndex((line) => line.startsWith(QUESTION_BULLET));
  if (anchor < 0) throw new Error(`rubric no longer carries the judge-question bullet: ${QUESTION_BULLET}`);
  const block = [];
  for (const line of rubricLines.slice(anchor, anchor + 20)) {
    if (line.trim() === '') break;
    if (block.length > 0 && line.startsWith('- ')) break; // next bullet
    block.push(line.trim());
  }
  const quoted = /\*"([\s\S]*?)"\*/.exec(block.join(' '));
  if (quoted === null) throw new Error('rubric judge-question bullet carries no *"…"* quotation');
  return quoted[1];
}

/** The pre-registered fact names, parsed out of the "Facts are pre-computed" paragraph. */
function parseRubricFactNames() {
  const anchor = rubricLines.findIndex((line) => line.startsWith(FACTS_PARAGRAPH));
  if (anchor < 0) throw new Error(`rubric no longer carries the facts paragraph: ${FACTS_PARAGRAPH}`);
  const paragraph = [];
  for (const line of rubricLines.slice(anchor, anchor + 30)) {
    if (line.trim() === '') break;
    paragraph.push(line.trim());
  }
  const joined = paragraph.join(' ');
  const marker = joined.indexOf(FACTS_LIST_MARKER);
  if (marker < 0) throw new Error(`facts paragraph no longer introduces the list with: ${FACTS_LIST_MARKER}`);
  // The enumeration runs to the first sentence break after the marker.
  const listText = joined.slice(marker + FACTS_LIST_MARKER.length).split('. ')[0];
  return [...listText.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\[\]$/, ''));
}

describe('eval rubric-v2 — parity with its executable copy in judge.mjs', () => {
  const rules = parseRubricRules();
  const question = parseRubricQuestion();
  const factNames = parseRubricFactNames();
  const code = JUDGE_RULES['instruction-adherence'];

  // VACUUM GUARD. Bug: a renamed heading, a list converted to prose, or a
  // reworded lead-in silently empties every census above — and each parity
  // assertion below then passes over nothing. An empty parse is a FAILURE of
  // this test, never a pass. The code side is guarded too: an emptied
  // JUDGE_RULES would otherwise satisfy a one-sided check.
  it('parses a non-empty census out of the rubric markdown', () => {
    expect(rules.length).toBeGreaterThan(0);
    expect(question.length).toBeGreaterThan(0);
    expect(factNames.length).toBeGreaterThan(0);
    expect(code.length).toBeGreaterThan(0);
    expect(Object.keys(computeRecordFacts([])).length).toBeGreaterThan(0);
    // The list must be a complete 1..n run — a dropped or renumbered item is a
    // parse failure, not a shorter rubric.
    expect(rules.map((r) => r.n)).toEqual(rules.map((_, i) => i + 1));
  });

  // Bug: a rule added to (or removed from) one side only. Count first, so the
  // per-rule diff below reads as a wording drift rather than an index shift.
  it('pre-registers exactly as many decision rules as JUDGE_RULES executes', () => {
    expect(rules.length).toBe(code.length);
  });

  // Bug: THE one this file exists for — `b9ca527a` extended rule 1 in the
  // rubric and left JUDGE_RULES[0] at its old text, so `buildJudgePrompt()`
  // stopped carrying what the rubric pre-registers. Rule 2 additionally pins
  // GUARD_BLOCKED_CONSPICUOUS_THRESHOLD: the executable copy interpolates the
  // constant, so bumping it without the rubric fails here too.
  it('carries each decision rule verbatim, in the same order', () => {
    for (const [i, rule] of rules.entries()) {
      expect(normalise(code[i] ?? ''), `decision rule ${rule.n}`).toBe(normalise(rule.text));
    }
  });

  // Bug: the judge question is pre-registered in the same block ("Judge
  // question:") and rendered from JUDGE_QUESTIONS — the same one-sided-edit
  // class as the rules.
  it('carries the judge question verbatim', () => {
    expect(normalise(JUDGE_QUESTIONS['instruction-adherence'])).toBe(normalise(question));
  });

  // Bug: a fact added to `computeRecordFacts()` (or dropped from it) without
  // its pre-registration. The code side is the LIVE return shape of the real
  // function, not a list retyped here — order is not compared because object
  // keys carry no pre-registered order, membership does.
  it('pre-registers exactly the facts computeRecordFacts returns', () => {
    const computed = Object.keys(computeRecordFacts([]));
    expect(new Set(factNames)).toEqual(new Set(computed));
    expect(factNames).toHaveLength(computed.length); // a name listed twice is a drift too
  });
});
