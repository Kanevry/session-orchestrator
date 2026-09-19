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

import { describe, it, expect } from 'vitest';

import {
  KIND_DISTRIBUTIONAL,
  KIND_GATE_VERDICT,
  dedupeViolations,
  findViolations,
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
});
