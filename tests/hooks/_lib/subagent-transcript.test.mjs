/**
 * tests/hooks/_lib/subagent-transcript.test.mjs
 *
 * PURE-FUNCTION tests for the `gate-verdict` claim class added to
 * `hooks/_lib/subagent-transcript.mjs` `findViolations()` (w4-1).
 *
 * WHY A SECOND FILE rather than more cases in
 * `tests/hooks/post-subagent-discovery-validator.test.mjs`: that file spawns
 * the HOOK (tmp sandbox, CLAUDE.md, transcript JSONL, stdin pipe) — ~1 s per
 * case — and its `findViolations()` block exists only to pin the #908/#1218
 * rates. The module deserves the same `tests/hooks/_lib/` mirror
 * `subagent-paths.test.mjs` already has. The hook-LEVEL proof for the new
 * class (the `kind` field reaching events.jsonl) stays in that file, where the
 * spawn harness lives.
 *
 * THE NAMED BUG (TV-001), measured 2026-09-19 over the 130-case labelled
 * done-claim corpus at `~/.cache/jev-eval/so/tasks/s2-done-claim.json`:
 * `findViolations()` answered "no violation" on 128 of 130 cases — accuracy
 * 30.2%, Cohen κ 0.007, indistinguishable from guessing. Cause:
 * `GATE_SUMMARY_LINE_RE` exempts `STATUS: done|partial|failed` and
 * "N passed / M failed" lines before ANY pattern runs, so the one scanner this
 * repo has for unevidenced claims structurally never looked at the two line
 * shapes where "done" and "green" are actually claimed.
 *
 * Each case below names the bug it catches:
 *   (a) a `STATUS: done` line with no run anywhere → violation, kind
 *       `gate-verdict` (pre-fix: silently exempt).
 *   (b) `STATUS: done` after a quoted `npm test` with counts → NO violation
 *       (the false-positive direction, which is the expensive one: this hook
 *       runs on every SubagentStop).
 *   (c) a German "alles grün" verdict with no evidence → violation.
 *   (d) the existing distributional behaviour, unchanged (regression).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import {
  KIND_CLAIM_MISMATCH,
  KIND_DISTRIBUTIONAL,
  KIND_GATE_VERDICT,
  dedupeViolations,
  findViolations,
  readTranscriptObservations,
} from '../../../hooks/_lib/subagent-transcript.mjs';

describe('findViolations — gate-verdict claim class (w4-1)', () => {
  it('(a) a bare "STATUS: done" with no run anywhere in the report is a gate-verdict violation', () => {
    // bug_caught: GATE_SUMMARY_LINE_RE's `^\s*STATUS:\s*(done|partial|failed)`
    // branch `continue`d before any pattern ran, so this report — the exact
    // shape of the 3 measured "green with no receipt" reports — produced zero
    // findings. The exemption is correct for the DISTRIBUTIONAL patterns (a
    // number on a gate line is a field value); it was never a licence to stop
    // reading the line.
    const text = [
      '## code-implementer — w9-3',
      '',
      'Reworked the resolver so the fallback path no longer swallows the error.',
      '',
      'STATUS: done',
    ].join('\n');

    const { violations } = findViolations(text);

    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe(KIND_GATE_VERDICT);
    expect(violations[0].claim).toBe('STATUS: done');
  });

  it('(b) "STATUS: done" after a quoted npm test run with counts is NOT a violation', () => {
    // bug_caught: the expensive direction. A scanner that flags an honest
    // report is switched off — which is precisely what the #1198 exemption was
    // introduced to prevent (186/400 = 46.5% of sampled violations were the
    // harness's own gate output). The run receipt is report-wide on purpose:
    // the receipt here sits 6 lines above the claim, OUTSIDE the ±5-line
    // adjacency window the distributional class uses, and the claim is still
    // evidenced.
    const text = [
      '## code-implementer — w9-3',
      '',
      '```',
      '$ npm test',
      ' Test Files  612 passed (612)',
      '      Tests  15419 passed | 11 skipped (15430)',
      '```',
      '',
      'Reworked the resolver so the fallback path no longer swallows the error.',
      'Pattern alignment: matched the existing resolver in subagent-paths.mjs.',
      '',
      'STATUS: done',
    ].join('\n');

    expect(findViolations(text).violations).toEqual([]);
  });

  it('(b2) an exit-code receipt alone (no pass count) also clears a gate verdict', () => {
    // bug_caught: a receipt matcher keyed only on "N passed" misses every
    // typecheck/lint report, whose receipt is an exit code — and the shells
    // here emit it as `LINT_EXIT=0`, where `\bexit` does NOT match because `_`
    // is a word character.
    const text = [
      '- `npm run lint` → LINT_EXIT=0',
      '',
      'Lint: clean',
    ].join('\n');

    expect(findViolations(text).violations).toEqual([]);
  });

  it('(c) a German "alles grün" verdict with no measurement is a gate-verdict violation', () => {
    // bug_caught: the German half of the class. The English-lexical patterns
    // could not see it at all, and the `Gate:\s*grün` branch of
    // GATE_SUMMARY_LINE_RE actively exempted its sibling shape.
    const text = [
      '## Welle 4 — Bericht',
      '',
      'Die drei Fixes sind eingebaut, alles grün.',
    ].join('\n');

    const { violations } = findViolations(text);

    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe(KIND_GATE_VERDICT);
    expect(violations[0].claim).toBe('Die drei Fixes sind eingebaut, alles grün.');
  });

  it.each([
    ['past-tense prose about a run, not a verdict', 'The gate ran green on 2026-07-29 across the fleet.'],
    ['pipeline mention with a sha', '**5 Wellen, 20 Agents, 3 Commits, CI-Pipeline #6995 grün auf `1e2ba8b`**'],
    ['task-list intent, not an assertion', '- [ ] make the suite green before the handover'],
    ['status-matrix table cell', '| Lane B | Tests: PASS | offen |'],
  ])('(c2) does NOT flag "%s"', (_label, benign) => {
    // bug_caught: a gap-tolerant trigger (`gate` … `green` with a wildcard
    // between) would fire on all four. The triggers are deliberately gap-free,
    // and table rows / plan items stay excluded for this class too.
    expect(findViolations(benign).violations).toEqual([]);
  });

  it('(d) REGRESSION: an unmeasured distributional claim still flags, and still as kind=distributional', () => {
    // bug_caught: the new class is inserted BEFORE the GATE_SUMMARY_LINE_RE
    // skip, so a restructuring error there would silently disarm the #567
    // patterns this hook was originally built for — the failure would look
    // like a quieter, better-behaved hook.
    const { violations } = findViolations('All 4 callers of resolveSubagentSidecar() pass an agentId.');

    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe(KIND_DISTRIBUTIONAL);
  });

  it('(d2) REGRESSION: a distributional claim WITH an adjacent grep block still does not flag', () => {
    const text = [
      'All 4 callers of resolveSubagentSidecar() pass an agentId.',
      '```bash',
      'grep -rn "resolveSubagentSidecar(" hooks/ scripts/   # 4 matches',
      '```',
    ].join('\n');

    expect(findViolations(text).violations).toEqual([]);
  });

  it('a line that is BOTH a gate verdict and a distributional claim yields one record per class', () => {
    // bug_caught: keying dedup on the normalized text alone would collapse the
    // two classes into one entry, and the coordinator triaging the ledger
    // could no longer tell which rule the line broke.
    const { violations } = findViolations('Alle Tests grün, all 4 callers migriert.');

    expect(violations.map((v) => v.kind).sort()).toEqual([KIND_DISTRIBUTIONAL, KIND_GATE_VERDICT]);
  });

  it('a STATUS: line KEEPS its distributional exemption — only the new class reads it', () => {
    // bug_caught: the inverse of case (d). The #1198 exemption removed 46.5%
    // of sampled false positives by keeping the NUMBER patterns off gate
    // lines, where a number is a field value. Reading that line for a gate
    // VERDICT must not also re-admit the number patterns there, or this change
    // reintroduces the single largest measured false-positive class.
    const { violations } = findViolations('STATUS: done — all 4 callers migrated.');

    expect(violations.map((v) => v.kind)).toEqual([KIND_GATE_VERDICT]);
  });
});

describe('dedupeViolations — kind carried through', () => {
  it('defaults a bare string to the distributional kind (back-compat)', () => {
    expect(dedupeViolations(['14 commits since the ref'])).toEqual([
      { claim: '14 commits since the ref', normalized: '14 commits since the ref', occurrences: 1, kind: KIND_DISTRIBUTIONAL },
    ]);
  });

  it('counts occurrences per (kind, normalized) pair, never across kinds', () => {
    const out = dedupeViolations([
      { claim: 'STATUS: done', kind: KIND_GATE_VERDICT },
      { claim: '- STATUS: done', kind: KIND_GATE_VERDICT },
      { claim: 'STATUS: done', kind: KIND_DISTRIBUTIONAL },
    ]);

    expect(out.map((v) => [v.kind, v.occurrences])).toEqual([
      [KIND_GATE_VERDICT, 2],
      [KIND_DISTRIBUTIONAL, 1],
    ]);
  });

  it('carries a claim-mismatch detail payload through to the deduped entry', () => {
    // bug_caught: dedupeViolations rebuilt each entry from four named fields,
    // so a `detail` added upstream was silently dropped and every
    // claim-mismatch record reached events.jsonl with no numbers in it — a
    // finding the coordinator cannot act on, and indistinguishable from a
    // working one in the ledger.
    const detail = { mismatch: 'count', claimed: { passed: 5129, failed: 0 }, observed: [], observed_n: 0 };

    expect(dedupeViolations([{ claim: '5129 passed', kind: KIND_CLAIM_MISMATCH, detail }])).toEqual([
      { claim: '5129 passed', normalized: '5129 passed', occurrences: 1, kind: KIND_CLAIM_MISMATCH, detail },
    ]);
  });
});

/**
 * #1385 R1 — the claim-mismatch class.
 *
 * THE NAMED BUG (TV-001), measured 2026-09-19 on this module at HEAD before
 * the change, is an INVERSION rather than a gap:
 *
 *   'STATUS: done\nTests pass: 5129 passed / 0 failed.'  ->  []
 *   'STATUS: done\nAlles grün.'                          ->  ['gate-verdict','gate-verdict']
 *
 * `RUN_RECEIPT_RE` is report-wide and matches `\d+\s+passed`, so the number an
 * agent asserts counts as its own evidence: inventing one DISARMS the scanner
 * while reporting honestly without one gets flagged. No existing test could
 * catch it — the whole suite had no notion of what the agent actually ran.
 */
describe('findViolations — claim-mismatch (count) class (#1385 R1)', () => {
  const OBS = [{ passed: 5127, failed: 2, total: 5129 }];

  it('flags a claimed pass count that NO observed run carries', () => {
    // bug_caught: the inversion above. `5129 passed` satisfied RUN_RECEIPT_RE
    // with its own digits while the only run in the window reported 5127
    // passed and 2 failed.
    const { violations } = findViolations('Tests pass: 5129 passed / 0 failed.', { observations: OBS });

    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe(KIND_CLAIM_MISMATCH);
    expect(violations[0].detail).toEqual({
      mismatch: 'count',
      claimed: { passed: 5129, failed: 0 },
      observed: [{ passed: 5127, failed: 2, total: 5129 }],
      observed_n: 1,
    });
  });

  it('does NOT flag the honest number the run actually reported', () => {
    expect(findViolations('Tests: 5127 passed / 2 failed.', { observations: OBS }).violations).toEqual([]);
  });

  it('does NOT flag a total that is the SUM of two partial runs', () => {
    // bug_caught: splitting a suite over two `npx vitest run <files>` calls
    // and reporting the total is normal here; a per-run-only comparison would
    // flag every one of them.
    const observations = [
      { passed: 5000, failed: 0, total: 5000 },
      { passed: 127, failed: 0, total: 127 },
    ];

    expect(findViolations('Insgesamt 5127 passed.', { observations }).violations).toEqual([]);
  });

  it('does NOT flag when the window holds NO observation at all', () => {
    // bug_caught: evidence ABSENCE is the gate-verdict class's job. Treating
    // "nothing observed" as a mismatch would fire on every agent that reports
    // a count it ran before the 2 MiB window — the opposite of a measurement.
    expect(findViolations('Tests pass: 5129 passed / 0 failed.', { observations: [] }).violations).toEqual([]);
  });

  it('defaults to disabled when no observations option is passed at all', () => {
    // bug_caught: every pre-R1 caller (and the #1218 precision corpus below)
    // calls findViolations(text) with one argument. A required-by-accident
    // second parameter would make the class fire on all of them.
    expect(findViolations('Tests pass: 5129 passed / 0 failed.').violations).toEqual([]);
  });

  it.each([
    // The four false-alarm forms w1-3 measured over 1037 transcripts…
    ['another instrument, same word shape (vitest file tally)', 'Test Files  612 passed (612)'],
    ['another instrument, named (validate-plugin)', 'validate-plugin: 229 passed, 0 failed'],
    ['another instrument, named (check-rules)', 'check-rules → 41 passed, 0 failed'],
    ['a QUOTED foreign assertion', 'The reviewer claimed 9999 passed; I could not reproduce it.'],
    ['a RED-before-fix count', 'Rot vor dem Fix: 4711 passed, 3 failed; nach dem Fix grün.'],
    ['a RED-proof count naming a mutation', 'RED proof: mutated the loader — 2 failed, 0 passed.'],
    // …plus three more this repo's own 1044-transcript corpus produced.
    ['a JSON key line (a field value, not an assertion)', '  "passed": 8888,'],
    ['a file tally in prose word order', 'Focused run: **2 passed files; 5127 tests passed**'],
    ['"passed" used as an ordinary verb after a line number', 'the 8 call sites at lines 715 and 1080 passed bodies'],
  ])('does NOT raise a claim-mismatch for %s', (_label, benign) => {
    // Scoped to THIS class on purpose: `2 passed files` legitimately trips the
    // pre-existing #908 bare-cardinal pattern ("2 … files" with no measurement
    // beside it), and asserting an empty violations list would make this case
    // a test of the distributional matcher instead of the new one.
    const { violations } = findViolations(benign, { observations: OBS });

    expect(violations.filter((v) => v.kind === KIND_CLAIM_MISMATCH)).toEqual([]);
  });

  it('reads a thousands-separated claim as one number, not as its last group', () => {
    // bug_caught: `14,340 passed` parsed as `340` under a bare \d{1,9}, which
    // manufactured a mismatch out of a parse error — 3 of the first 12 corpus
    // hits. Here 14340 IS observed, so the honest report must stay silent.
    const observations = [{ passed: 14340, failed: 0, total: 14351 }];

    expect(findViolations('Full suite — `npm test` completed with 14,340 passed / 0 failed.', { observations }).violations).toEqual([]);
  });

  it('does NOT flag a run summary quoted inside a fenced block', () => {
    // bug_caught: a pasted summary is quoted tool output, not an assertion.
    // Scanning it would flag the honest report that quotes a run older than
    // the window — the expensive direction for a hook on every SubagentStop.
    const text = ['```', 'Tests  9999 passed (9999)', '```'].join('\n');

    expect(findViolations(text, { observations: OBS }).violations).toEqual([]);
  });

  it('REGRESSION: the distributional and gate-verdict classes are unchanged', () => {
    // bug_caught: the new class is inserted BEFORE the GATE_SUMMARY_LINE_RE
    // skip, beside the gate class. A restructuring error there would disarm
    // the two older classes, and the failure would look like a quieter hook.
    expect(findViolations('All 4 callers of resolveSubagentSidecar() pass an agentId.').violations.map((v) => v.kind))
      .toEqual([KIND_DISTRIBUTIONAL]);
    expect(findViolations('STATUS: done').violations.map((v) => v.kind)).toEqual([KIND_GATE_VERDICT]);
  });
});

describe('readTranscriptObservations — the run side of the window (#1385 R1)', () => {
  let box;

  afterEach(() => {
    if (box) rmSync(box, { recursive: true, force: true });
    box = undefined;
  });

  /** Write a transcript of raw records and return its path. */
  function writeRecords(records) {
    box = mkdtempSync(join(tmpdir(), 'subagent-observations-'));
    const file = join(box, 'transcript.jsonl');
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return file;
  }

  const bashUse = (id, command) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
  // Golden-record shape (testing.md § Fixtures Mirror Production Data):
  // measured 2026-09-19 on real sidecars, `content` is a plain STRING.
  const result = (id, content) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content }] },
  });

  it('extracts the vitest summary from a Bash tool_result', async () => {
    const file = writeRecords([
      bashUse('t1', 'npx vitest run tests/lib/ > /tmp/r.log 2>&1; tail -5 /tmp/r.log'),
      result('t1', ' Test Files  612 passed (612)\n      Tests  2 failed | 5127 passed (5129)\n'),
    ]);

    // Only the `Tests` line is an observation — `Test Files` is a FILE count,
    // and reading it as a test count puts a wrong number into the comparison.
    await expect(readTranscriptObservations(file)).resolves.toEqual([
      { passed: 5127, failed: 2, total: 5129 },
    ]);
  });

  it('ignores a Bash result whose command is not a test run', async () => {
    // bug_caught: without the tool_use→tool_result join on the COMMAND, a
    // `git log` output containing the word "passed" becomes an observation
    // and silently clears (or contradicts) an unrelated claim.
    const file = writeRecords([
      bashUse('t1', 'git log --oneline -5'),
      result('t1', '      Tests  999 passed (999)\n'),
    ]);

    await expect(readTranscriptObservations(file)).resolves.toEqual([]);
  });

  it('reads a summary carrying a grep/Read line-number prefix', async () => {
    // bug_caught: the dominant local idiom is `npm test > run.log` followed
    // by `grep -n`/`Read` on the log, which prepends `30:`. The line-start
    // anchor missed those receipts, and 2 of 9 residual firings measured
    // 2026-09-19 were honest reports flagged for exactly that reason.
    const file = writeRecords([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/run.log' } }] },
      },
      result('t1', '30:      Tests  1 failed | 1338 passed (1339)\n'),
    ]);

    await expect(readTranscriptObservations(file)).resolves.toEqual([
      { passed: 1338, failed: 1, total: 1339 },
    ]);
  });

  it('returns [] for a missing transcript rather than throwing', async () => {
    // bug_caught: readTailWindow THROWS on fs errors. An unmapped throw here
    // reaches the SubagentStop hook, which then records nothing at all —
    // including the two OTHER claim classes that have nothing to do with it.
    box = mkdtempSync(join(tmpdir(), 'subagent-observations-'));

    await expect(readTranscriptObservations(join(box, 'nope.jsonl'))).resolves.toEqual([]);
  });
});
