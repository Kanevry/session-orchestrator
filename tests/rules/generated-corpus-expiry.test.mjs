/**
 * tests/rules/generated-corpus-expiry.test.mjs — #1372.
 *
 * ## The measured defect this file catches
 *
 * `scripts/lib/rule-loader.mjs:381-394` filters an expired generated rule out
 * of a wave's rule set AT READ TIME. Nothing DELETES it. So an expired file
 * keeps sitting in `.claude/rules/`, is counted by every byte ceiling
 * (`bySurface.generated` / `bySurface.pathScoped` in
 * `scripts/lib/instruction-budget-guard.mjs`), and is loaded verbatim by
 * Claude Code — which reads the whole directory and has no notion of
 * `expires-at`. Three generated rule files sat expired on disk for 16-19 days
 * that way until a human removed them in `9b0a555e`; no gate went red, because
 * no gate looked.
 *
 * ## What moved OUT of this file, and why (2026-09-16)
 *
 * The original version asserted the live corpus against TODAY's date. That is a
 * calendar time-bomb inside a BLOCKING gate: with 2 files carrying
 * `expires-at: 2026-10-01` and 4 carrying `2026-10-04` (measured 2026-09-16 @
 * `dd05e0f8`, after the #1367 consolidation), `npm test` — the pre-push hook and CI — would have turned red on
 * 2026-10-02 with zero commits, blocking every unrelated hotfix, and no test run
 * could perform the repair (consolidating a file and moving its provenance pairs
 * is a human decision). The alarm now lives where housekeeping is decided: the
 * session-start `maintenance-due` probe's `generated-rules-expiring` signal
 * (`scripts/lib/maintenance-due-banner.mjs`), which names the files and dates
 * and recommends `/session housekeeping`.
 *
 * What stays here is what is TRUE INDEPENDENT OF THE CALENDAR: the expiry
 * predicate itself (against fixtures and an injected clock), and the structural
 * invariants of the live corpus that a consolidation pass can break at any
 * moment — provenance pairs and the consolidated header's self-agreement.
 *
 * The predicate is IMPORTED, never mirrored. The previous version hand-copied
 * `isMachineGeneratedRule` and promised that "if the guard's population and this
 * file's population ever disagree, the count assertion goes red" — no such
 * assertion existed, and the mirror had already drifted: it tested
 * `meta['auto-generated'] === 'true'` (string) where the guard tests `=== true`
 * (boolean, after `parseGlobsFrontmatter` coercion). The two agreed only because
 * a third clause (`expires-at`) happened to catch every consolidated file.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeInstructionBudget,
  daysUntilGeneratedRuleExpiry,
  isExpiredGeneratedRule,
  isMachineGeneratedRule,
  listMachineGeneratedRules,
} from '@lib/instruction-budget-guard.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const live = listMachineGeneratedRules({ repoRoot: REPO_ROOT });
const generatedRules = live.rules.map((r) => ({
  ...r,
  content: readFileSync(join(REPO_ROOT, '.claude', 'rules', r.file), 'utf8'),
}));

/** A throwaway rules dir; `frontmatter` is inserted verbatim between the fences. */
function fixtureRulesDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'generated-corpus-expiry-'));
  mkdirSync(dir, { recursive: true });
  for (const [name, frontmatter] of Object.entries(files)) {
    writeFileSync(join(dir, name), `---\n${frontmatter}\n---\n\n# ${name}\n\nbody\n`, 'utf8');
  }
  return dir;
}

describe('generated rule expiry — the predicate (#1372)', () => {
  // BUG: a predicate that compares against the process clock cannot be tested
  // for the boundary that matters, so the "expired" verdict was only ever
  // observed on whatever day the suite happened to run. With an injected clock
  // both sides of midnight are checkable, every day of the year.
  it('judges expired / not-yet-expired against an INJECTED clock, not today', () => {
    const now = Date.parse('2026-09-16T11:00:00Z');
    const past = { 'expires-at': '2026-09-15' };
    const today = { 'expires-at': '2026-09-16' };
    const future = { 'expires-at': '2026-10-01' };

    expect(isExpiredGeneratedRule({ meta: past, now })).toBe(true);
    // Same basis as rule-loader's `applyGates`: a bare date is UTC midnight, so
    // a rule dated TODAY is already past at 11:00 — the loader drops it too.
    expect(isExpiredGeneratedRule({ meta: today, now })).toBe(true);
    expect(isExpiredGeneratedRule({ meta: future, now })).toBe(false);

    expect(daysUntilGeneratedRuleExpiry({ meta: past, now })).toBe(-2);
    expect(daysUntilGeneratedRuleExpiry({ meta: today, now })).toBe(-1);
    expect(daysUntilGeneratedRuleExpiry({ meta: future, now })).toBe(14);
  });

  // BUG: an unparseable `expires-at` read as "expired" would have the banner
  // demand the deletion of a live rule over a typo — and read as a number it
  // would poison the day arithmetic with NaN. `rule-loader.mjs` fails OPEN on
  // the same input (warns, ignores the expiry); this must not disagree with it.
  it('returns null for an absent, empty or unparseable expires-at', () => {
    const now = Date.parse('2026-09-16T11:00:00Z');
    expect(daysUntilGeneratedRuleExpiry({ meta: { 'learning-key': 'x' }, now })).toBeNull();
    expect(daysUntilGeneratedRuleExpiry({ meta: { 'expires-at': 'soon' }, now })).toBeNull();
    expect(daysUntilGeneratedRuleExpiry({ meta: {}, now })).toBeNull();
    expect(daysUntilGeneratedRuleExpiry({ now })).toBeNull();
    expect(isExpiredGeneratedRule({ meta: { 'expires-at': 'soon' }, now })).toBe(false);
  });

  // BUG (the drift this file's own mirror carried): `auto-generated` reaches the
  // predicate as a BOOLEAN via parseGlobsFrontmatter's coercion. A predicate
  // testing the string `'true'` classifies a consolidated file that carries only
  // `auto-generated` — no learning-key, no expires-at — as hand-written, and
  // both its bytes and its expiry go unjudged.
  it('classifies on any provenance marker, with auto-generated coerced to boolean', () => {
    expect(isMachineGeneratedRule({ 'auto-generated': true })).toBe(true);
    expect(isMachineGeneratedRule({ 'learning-key': 'anti-pattern/x' })).toBe(true);
    expect(isMachineGeneratedRule({ 'expires-at': '2026-10-01' })).toBe(true);
    expect(isMachineGeneratedRule({ globs: ['**/*.md'] })).toBe(false);
    expect(isMachineGeneratedRule(null)).toBe(false);
  });

  // BUG: a scanner that treats an unreadable directory as an empty one reports
  // "no generated rules, nothing expiring" for a repo it could not read at all —
  // the two-state failure `maintenance-due-banner.mjs` exists to avoid. A
  // MISSING directory is a real answer; an unreadable one is not.
  it('separates "no rules dir" (ok, empty) from "cannot enumerate" (not ok)', () => {
    const empty = listMachineGeneratedRules({ rulesDir: join(tmpdir(), 'no-such-rules-dir-1372') });
    expect(empty).toEqual({ ok: true, rules: [] });

    // A FILE where a directory is expected → ENOTDIR, not ENOENT.
    const dir = fixtureRulesDir({ 'a.md': 'expires-at: 2026-10-01' });
    const notADir = listMachineGeneratedRules({ rulesDir: join(dir, 'a.md') });
    expect(notADir.ok).toBe(false);
    expect(notADir.rules).toEqual([]);
  });

  // BUG: the enumeration must agree with the BYTE ceiling's population, or the
  // banner warns about files no ceiling counts (or stays silent on files it
  // does). Both read the same predicate now; this pins that they keep doing so.
  it('enumerates exactly the population the generated byte ceiling judges', () => {
    const dir = fixtureRulesDir({
      'gen-expiring.md': 'expires-at: 2026-10-01\nlearning-key: anti-pattern/x',
      'gen-consolidated.md': 'auto-generated: true\nglobs:\n  - "**/*.mjs"',
      'hand-written.md': 'globs:\n  - "tests/**"',
      'always-on.md': 'description: no frontmatter keys that mark provenance',
    });
    const listed = listMachineGeneratedRules({ rulesDir: dir });
    expect(listed.ok).toBe(true);
    expect(listed.rules.map((r) => r.file).sort()).toEqual([
      'gen-consolidated.md',
      'gen-expiring.md',
    ]);
    expect(listed.rules.map((r) => r.file).length).toBe(
      computeInstructionBudget({ rulesDir: dir }).bySurface.generated.files,
    );
  });
});

describe('generated rule corpus — live invariants (#1372)', () => {
  // BUG: the promised-but-absent parity assertion. If the enumeration and the
  // ceiling's population ever disagree on the LIVE corpus — a new provenance
  // key, a changed frontmatter parser — the banner and the ceiling start
  // judging different sets while both look healthy.
  it('the live enumeration matches the generated byte ceiling population', () => {
    expect(live.ok).toBe(true);
    expect(generatedRules.length).toBe(
      computeInstructionBudget({ repoRoot: REPO_ROOT }).bySurface.generated.files,
    );
  });

  it('every body `- learning-key:` in a generated file has a sibling `- learning-id:`', () => {
    // Catches a HALF-DROPPED provenance pair during a consolidation pass: the
    // dedupe in `scripts/lib/reconcile/engine.mjs` (readMaterializedProvenance)
    // matches on EITHER key or id, so a lone key still dedupes today — and
    // silently stops doing so the moment the learning's key is re-kebabbed.
    /** @type {string[]} */
    const orphans = [];
    for (const { file, content } of generatedRules) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!/^- learning-key:\s*`[^`]+`/.test(lines[i])) continue;
        if (!/^- learning-id:\s*`[^`]+`/.test(lines[i + 1] ?? '')) {
          orphans.push(`${file}:${i + 1} ${lines[i].slice(0, 80)}`);
        }
      }
    }
    expect(orphans, `learning-key without a sibling learning-id:\n  ${orphans.join('\n  ')}`).toEqual([]);
  });

  it('a consolidated file states an expires-at its own frontmatter agrees with', () => {
    // (c) as briefed — "the EARLIEST of the absorbed dates" — is NOT checkable
    // against the absorbed dates: they are not stored per entry anywhere in the
    // file or in the provenance block (measured 2026-09-16 @ ca214376 — a
    // `## Provenance` pair is `learning-key` + `learning-id`, no date). What IS
    // checkable is the file's own claim: the header sentence
    // "`expires-at` <date> = the EARLIEST of the N absorbed dates" must quote
    // the frontmatter date, and N must equal the number of provenance pairs.
    // That catches the real consolidation slip — absorbing entries and leaving
    // the header's date/count stale.
    /** @type {string[]} */
    const mismatches = [];
    for (const { file, content, expiresAt } of generatedRules) {
      const claim = /`expires-at` (\d{4}-\d{2}-\d{2}) = the EARLIEST of the (\d+) absorbed dates/.exec(content);
      if (!claim) continue; // not a consolidated file — nothing claimed, nothing to check
      const pairs = (content.match(/^- learning-key: `/gm) ?? []).length;
      if (claim[1] !== expiresAt) {
        mismatches.push(`${file}: header says ${claim[1]}, frontmatter says ${expiresAt}`);
      }
      if (Number(claim[2]) !== pairs) {
        mismatches.push(`${file}: header claims ${claim[2]} absorbed dates, ${pairs} provenance pairs on disk`);
      }
    }
    expect(mismatches, `consolidated-file header drift:\n  ${mismatches.join('\n  ')}`).toEqual([]);
  });
});
