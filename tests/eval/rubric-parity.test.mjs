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

import {
  RUBRIC_RELATIVE_PATH,
  RUBRIC_DIMENSION_IDS,
  RUBRIC_SCORERS,
} from '../../scripts/lib/eval/engine.mjs';
import { JUDGE_QUESTIONS, JUDGE_RULES, computeRecordFacts } from '../../scripts/lib/eval/judge.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
/**
 * The rubric path the ENGINE declares — so a rubric rename moves this test with it.
 *
 * `SO_RUBRIC_PATH` is a TEST-ONLY injection point (nothing in `scripts/` or
 * `hooks/` reads it): it lets a fake-regression run point this file at a
 * MODIFIED COPY of the rubric under $TMPDIR and watch the parity assertions go
 * red, without ever touching the hash-bound `skills/eval/rubric-v2.md`.
 */
const rubricPath = process.env.SO_RUBRIC_PATH || path.join(repoRoot, RUBRIC_RELATIVE_PATH);
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

// ---------------------------------------------------------------------------
// Part 2 — the DETERMINISTIC SCORER TABLES (#1418)
// ---------------------------------------------------------------------------

/**
 * `rubric-v2.md:6` calls `scripts/lib/eval/engine.mjs` *"the executable scorers
 * this document mirrors verbatim"*, and each deterministic dimension
 * pre-registers a CONDITION TABLE whose rows are explicitly "evaluated in
 * order". Part 1 above checks the judge half of that promise; nothing checked
 * the scorer half — the same one-sided-edit class that `b9ca527a` produced in
 * `JUDGE_RULES`, at a second site.
 *
 * NAMEABLE BUG: a scorer branch changed (or reordered) on the code side only —
 * e.g. the peer-contamination row moved below the gate rows, so a contaminated
 * window silently starts producing `pass` while the hash-bound document still
 * pre-registers `cannot-determine` for it.
 *
 * THIS IS NOT A TEXT COMPARISON. The table rows are DECISION BRANCHES, so each
 * row is DRIVEN: the expected status (and `score`) is PARSED out of the
 * markdown row, the input is the minimal `{record, events, window, peer,
 * rawSessionIds}` context that satisfies that row's condition, and the actual
 * comes from calling the scorer. The row→case binding is pinned by a regex on
 * the CONDITION cell, so a reordered or reworded row fails rather than
 * silently re-pairing.
 */

/** The four statuses the rubric admits (`status ∈ …`, rubric-v2 § head). */
const STATUS_WORDS = new Set(['pass', 'fail', 'not-applicable', 'cannot-determine']);

/** The one status word inside a rubric table cell. */
function statusOfCell(cell) {
  const found = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((t) => STATUS_WORDS.has(t));
  if (found.length === 0) throw new Error(`rubric table cell carries no status word: ${cell}`);
  return found[0];
}

/**
 * Parse the six `### N. \`<dimension>\`` sections of § Deterministic Dimensions:
 * each one's condition table (header + rows, in document order) and the
 * `Scorer: \`scoreX\`` line beneath it.
 *
 * @returns {Map<string, {id: string, header: string[]|null, rows: Array<{cells: string[], condition: string, status: string}>, scorer: string|null}>}
 */
function parseDimensionSections() {
  const sections = new Map();
  let current = null;
  let tableDone = false;
  for (const line of rubricLines) {
    const heading = /^###\s+\d+\.\s+`([^`]+)`/.exec(line);
    if (heading) {
      current = { id: heading[1], header: null, rows: [], scorer: null };
      tableDone = false;
      sections.set(current.id, current);
      continue;
    }
    if (current === null) continue;
    if (/^##\s/.test(line) || /^---\s*$/.test(line)) {
      current = null; // § Deterministic Dimensions is over
      continue;
    }
    if (line.startsWith('|') && !tableDone) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
      if (current.header === null) {
        current.header = cells;
        continue;
      }
      current.rows.push({ cells, condition: cells[0], status: statusOfCell(cells[1]) });
      continue;
    }
    if (current.rows.length > 0) tableDone = true; // prose after the table
    const scorer = /^Scorer:\s+`([^`]+)`/.exec(line);
    if (scorer) current.scorer = scorer[1];
  }
  return sections;
}

// --- Minimal inputs, one per pre-registered row -----------------------------

const WINDOW = Object.freeze({
  start: Date.parse('2026-09-20T10:00:00.000Z'),
  end: Date.parse('2026-09-20T11:00:00.000Z'),
});
/** An ISO timestamp `minutes` into the window. */
const at = (minutes) => new Date(WINDOW.start + minutes * 60_000).toISOString();
const NO_PEER = Object.freeze({ count: 0, peers: [] });
const ONE_PEER = Object.freeze({ count: 1, peers: ['main-2026-09-20-session-2'] });

/** The engine's evaluation context (`engine.mjs → evaluateSession`, ctx literal). */
function ctxOf({ record = {}, events = [], window = WINDOW, peer = NO_PEER, rawSessionIds = [] } = {}) {
  return { record, events, window, peer, rawSessionIds };
}

/** One quality_gate event, optionally a full-gate one. */
const gateEvent = (minutes, exitCode, variant = null) => ({
  event: exitCode === 0 ? 'orchestrator.quality_gate.passed' : 'orchestrator.quality_gate.failed',
  timestamp: at(minutes),
  exit_code: exitCode,
  ...(variant ? { variant } : {}),
});

/**
 * Per dimension, one case per pre-registered row IN DOCUMENT ORDER.
 * `condition` pins the binding to the row it was written for; `ctx` is the
 * minimal input that satisfies exactly that row (earlier rows deliberately not
 * satisfied — the order guard below covers the overlap case separately).
 * `rate` is carried where the row pre-registers a `score`.
 */
const ROW_CASES = {
  'verification-evidence': [
    {
      condition: /^`peer\.count > 0`/,
      ctx: () => ctxOf({ record: { total_files_changed: 4 }, peer: ONE_PEER }),
    },
    {
      condition: /`total_files_changed === 0`/,
      ctx: () => ctxOf({ record: { total_files_changed: 0 } }),
    },
    {
      condition: /`total_files_changed !== 0`/,
      ctx: () => ctxOf({ record: { total_files_changed: 4 } }),
    },
    {
      condition: /all `exit_code === 0`/,
      ctx: () => ctxOf({
        record: { total_files_changed: 4 },
        events: [gateEvent(10, 0), gateEvent(30, 0)],
      }),
    },
    {
      condition: /any `exit_code !== 0`/,
      ctx: () => ctxOf({
        record: { total_files_changed: 4 },
        events: [gateEvent(10, 0), gateEvent(30, 1)],
      }),
    },
  ],
  'plan-fidelity': [
    {
      condition: /present \*\*AND\*\* `>= 0\.8`/,
      // The threshold BOUNDARY: `>= 0.8` passes at exactly 0.8, so this input
      // fails the moment the comparison is weakened to `>`.
      ctx: () => ctxOf({ record: { effectiveness: { completion_rate: 0.8, planned_issues: 5, carryover: 1 } } }),
      rate: 0.8,
    },
    {
      condition: /present \*\*AND\*\* `< 0\.8`/,
      ctx: () => ctxOf({ record: { effectiveness: { completion_rate: 0.5, planned_issues: 4, carryover: 2 } } }),
      rate: 0.5,
    },
    {
      condition: /absent \*\*AND\*\* \(`planned_issues` absent/,
      ctx: () => ctxOf({ record: { effectiveness: { carryover: 0 } } }),
      rate: null,
    },
    {
      condition: /absent \*\*AND\*\* `planned_issues > 0`/,
      ctx: () => ctxOf({ record: { effectiveness: { planned_issues: 3 } } }),
      rate: null,
    },
  ],
  'gate-health': [
    {
      condition: /^`peer\.count > 0`/,
      ctx: () => ctxOf({ record: { total_waves: 2, waves: [{ role: 'Impl' }, { role: 'Impl' }] }, peer: ONE_PEER }),
    },
    {
      condition: /no waves ran/,
      ctx: () => ctxOf({ record: { total_waves: 0, waves: [] } }),
    },
    {
      condition: /\*\*AND\*\* waves ran$/,
      ctx: () => ctxOf({ record: { total_waves: 2, waves: [{ role: 'Impl' }, { role: 'Quality' }] } }),
    },
    {
      condition: /\*\*last by timestamp\*\* has `exit_code === 0`/,
      // Two full-gates, the EARLIER one red: pins "last by timestamp", not
      // "first" and not "any".
      ctx: () => ctxOf({
        record: { total_waves: 2, waves: [{ role: 'Impl' }, { role: 'Quality' }] },
        events: [gateEvent(10, 1, 'full-gate'), gateEvent(40, 0, 'full-gate')],
      }),
    },
    {
      condition: /\*\*last by timestamp\*\* has `exit_code !== 0`/,
      ctx: () => ctxOf({
        record: { total_waves: 2, waves: [{ role: 'Impl' }, { role: 'Quality' }] },
        events: [gateEvent(10, 0, 'full-gate'), gateEvent(40, 1, 'full-gate')],
      }),
    },
  ],
  'process-safety': [
    {
      condition: /`events\.jsonl` absent or empty/,
      ctx: () => ctxOf({ record: { agent_summary: { spiral: 0 } }, events: [] }),
    },
    {
      condition: /`agent_summary\.spiral > 0`/,
      ctx: () => ctxOf({ record: { agent_summary: { spiral: 2 } }, events: [gateEvent(10, 0)] }),
    },
    {
      condition: /^otherwise/,
      ctx: () => ctxOf({ record: { agent_summary: { spiral: 0 } }, events: [gateEvent(10, 0)] }),
    },
  ],
  'guard-friction': [
    {
      condition: /`events\.jsonl` absent or empty/,
      ctx: () => ctxOf({ record: { session_id: 'main-2026-09-20-session-1' }, events: [] }),
    },
    {
      condition: /^otherwise/,
      ctx: () => ctxOf({
        record: { session_id: 'main-2026-09-20-session-1' },
        events: [
          { event: 'orchestrator.destructive_guard.blocked', timestamp: at(10), session_id: 'raw-uuid-1' },
          { event: 'orchestrator.loop.warning', timestamp: at(20), session_id: 'raw-uuid-1' },
        ],
        rawSessionIds: ['raw-uuid-1'],
      }),
    },
  ],
};

describe('eval rubric-v2 — parity with the executable scorers in engine.mjs (#1418)', () => {
  const sections = parseDimensionSections();
  const tables = [...sections.values()].filter((s) => s.rows.length > 0);
  const totalRows = tables.reduce((n, s) => n + s.rows.length, 0);

  // VACUUM GUARD. Bug: a renamed heading, a table converted to prose, or a
  // changed column layout empties the census — and every row-driven assertion
  // below then iterates over nothing while reporting green. Measured
  // 2026-09-21 on `skills/eval/rubric-v2.md`: 6 dimension sections, 5 condition
  // tables, 19 rows (5/4/5/3/2). FEWER than that is a parse failure, never a
  // shorter rubric; MORE is caught by the per-dimension case-count check.
  it('parses a non-empty census of scorer tables out of the rubric markdown', () => {
    expect([...sections.keys()]).toEqual([...RUBRIC_DIMENSION_IDS]);
    expect(tables.length).toBeGreaterThanOrEqual(5);
    expect(totalRows).toBeGreaterThanOrEqual(19);
    for (const section of tables) {
      expect(section.rows.length, `${section.id} rows`).toBeGreaterThan(0);
      expect(section.header?.[0], `${section.id} header`).toMatch(/^Condition/);
    }
    // The ONE tableless dimension is pre-registered as always not-applicable,
    // so a second tableless section means a table was lost, not skipped.
    const tableless = [...sections.values()].filter((s) => s.rows.length === 0).map((s) => s.id);
    expect(tableless).toEqual(['efficiency-kpis']);
  });

  // Bug: the rubric names a scorer the engine does not export under that name
  // (renamed function, moved dimension) — the "reference engine" pointer at
  // rubric-v2.md:6 then points at nothing and nobody notices.
  it('names, per dimension, the scorer engine.mjs actually registers', () => {
    for (const [id, section] of sections) {
      expect(section.scorer, `${id} Scorer: line`).not.toBeNull();
      expect(RUBRIC_SCORERS[id], `RUBRIC_SCORERS[${id}]`).toBeTypeOf('function');
      expect(RUBRIC_SCORERS[id].name, `${id} scorer name`).toBe(section.scorer);
    }
    expect(Object.keys(RUBRIC_SCORERS)).toEqual([...RUBRIC_DIMENSION_IDS]);
  });

  // Bug: a row added to (or removed from) the rubric with no driven case — the
  // new branch would be pre-registered and unchecked, which is this issue.
  it('drives every pre-registered row of every table', () => {
    for (const section of tables) {
      const cases = ROW_CASES[section.id] ?? [];
      expect(cases.length, `${section.id} cases vs rows`).toBe(section.rows.length);
    }
  });

  for (const section of tables) {
    const cases = ROW_CASES[section.id] ?? [];
    const scoreColumn = (section.header ?? []).findIndex((h) => /^`?score`?$/i.test(h));

    describe(`${section.id} — ${section.rows.length} pre-registered rows`, () => {
      section.rows.forEach((row, i) => {
        const testCase = cases[i];
        it(`row ${i + 1}: ${row.condition} → ${row.status}`, () => {
          // The binding is pinned: a reordered or reworded condition cell fails
          // here rather than silently pairing with the wrong input.
          expect(testCase, `no case for ${section.id} row ${i + 1}`).toBeTruthy();
          expect(row.condition).toMatch(testCase.condition);

          const result = RUBRIC_SCORERS[section.id](testCase.ctx());
          expect(result.id).toBe(section.id);
          expect(result.method).toBe('deterministic');
          expect(result.status, `${section.id} row ${i + 1} status`).toBe(row.status);

          if (scoreColumn > 0) {
            // The `score` column pre-registers either `null` or the literal
            // `completion_rate`; anything else is an unmodelled formula and
            // must fail loudly rather than pass unchecked.
            const cell = row.cells[scoreColumn];
            if (/`null`|^null$/.test(cell)) expect(result.score).toBeNull();
            else if (/`completion_rate`/.test(cell)) expect(result.score).toBe(testCase.rate);
            else throw new Error(`unmodelled score cell in ${section.id} row ${i + 1}: ${cell}`);
          }

          // Where the row pre-registers an evidence template with counted
          // placeholders (`blocked=N, …`), the emitted evidence must carry a
          // real number under each of those keys.
          const evidenceColumn = (section.header ?? []).findIndex((h) => /^evidence$/i.test(h));
          if (evidenceColumn > 0) {
            for (const [, key] of row.cells[evidenceColumn].matchAll(/([a-z_.]+)=[NMK]\b/g)) {
              expect(result.evidence, `${section.id} row ${i + 1} evidence key ${key}`)
                .toMatch(new RegExp(`${key.replace(/\./g, '\\.')}=\\d+`));
            }
          }
        });
      });
    });
  }

  // ORDER GUARD. Bug: "evaluated in order" silently stops holding — a later
  // branch shadows an earlier one after a refactor, exactly the class
  // `b9ca527a` produced on the judge side. Each case below satisfies TWO rows
  // at once, and the EARLIER row must decide. Both statuses are read from the
  // parsed table, and the assertion that they DIFFER is what makes the case a
  // real order test rather than a coincidence.
  describe('rows are evaluated in the pre-registered order', () => {
    it('verification-evidence: contamination (row 1) beats a green gate (row 4)', () => {
      const rows = sections.get('verification-evidence').rows;
      expect(rows[0].status).not.toBe(rows[3].status);
      const result = RUBRIC_SCORERS['verification-evidence'](
        ctxOf({ record: { total_files_changed: 4 }, events: [gateEvent(10, 0)], peer: ONE_PEER }),
      );
      expect(result.status).toBe(rows[0].status);
    });

    it('gate-health: contamination (row 1) beats a green last full-gate (row 4)', () => {
      const rows = sections.get('gate-health').rows;
      expect(rows[0].status).not.toBe(rows[3].status);
      const result = RUBRIC_SCORERS['gate-health'](
        ctxOf({
          record: { total_waves: 2, waves: [{ role: 'Impl' }, { role: 'Quality' }] },
          events: [gateEvent(10, 0, 'full-gate'), gateEvent(40, 0, 'full-gate')],
          peer: ONE_PEER,
        }),
      );
      expect(result.status).toBe(rows[0].status);
    });

    it('process-safety: an unmeasurable stream (row 1) beats a spiral (row 2)', () => {
      const rows = sections.get('process-safety').rows;
      expect(rows[0].status).not.toBe(rows[1].status);
      const result = RUBRIC_SCORERS['process-safety'](
        ctxOf({ record: { agent_summary: { spiral: 3 } }, events: [] }),
      );
      expect(result.status).toBe(rows[0].status);
    });
  });

  // The tableless dimension still pre-registers a verdict in prose ("Status:
  // always `not-applicable`"). Bug: efficiency-kpis starts grading. Its scorer
  // takes the extracted kpis block, not the context — see RUBRIC_SCORERS.
  it('efficiency-kpis is always not-applicable, as its section pre-registers', () => {
    const line = rubricLines.find((l) => l.startsWith('Scorer: `scoreEfficiencyKpis`'));
    expect(line).toMatch(/always `not-applicable`/);
    const result = RUBRIC_SCORERS['efficiency-kpis']({
      duration_seconds: 42,
      total_waves: 3,
      total_agents: 9,
      token_input: null,
      token_output: null,
      carryover: 1,
      _duration_source: 'recorded',
    });
    expect(result.status).toBe('not-applicable');
    expect(result.score).toBeUndefined();
  });
});
