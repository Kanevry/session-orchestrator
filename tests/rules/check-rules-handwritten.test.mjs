/**
 * tests/rules/check-rules-handwritten.test.mjs
 *
 * Tests for the #880 FA5 extension to scripts/lib/validate/check-rules.mjs:
 * a WARN-only, non-fatal symmetric check on HANDWRITTEN rules (rules without
 * `auto-generated: true`).
 *
 * NOTE on scope vs. tests/lib/validate/check-rules.test.mjs: that file
 * already covers the pre-existing AUTO-GENERATED invariants (a/b/c) in full
 * (11 describe blocks, byte-for-byte unchanged by #880 — see the "auto-generated
 * regression" case below, which re-pins one of those invariants from THIS
 * file's scope so the #880 change is verified self-contained). This file
 * covers ONLY the new handwritten-rule branch, to avoid duplicating that
 * existing coverage.
 *
 * Handwritten-rule invariant (WARN-only, never affects exit code):
 *   (a) activation axis — a non-empty `globs`/`paths` array, a `host-class`
 *       key, OR a `tier` key.
 *   (b) `review-date` (ISO 8601) — an inert periodic-review marker, distinct
 *       from `expires-at` (see check-rules.mjs module doc for the rationale:
 *       `expires-at` is a live rule-loader.mjs EXPIRY gate, `review-date` is
 *       not — rule-loader.mjs never reads it).
 *
 * Strategy: spawn the CLI via spawnSync against a hermetic tmpdir plugin-root
 * — never assert against the live .claude/rules/ directory (this session's
 * own migration touches it, and a sibling wave-agent reads its live byte
 * totals this same wave — see .claude/rules/parallel-sessions.md § PSA-001).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-rules.mjs');

// ---------------------------------------------------------------------------
// Fixture helpers (mirrors tests/lib/validate/check-rules.test.mjs)
// ---------------------------------------------------------------------------

const tmpRoots = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'check-rules-handwritten-'));
  tmpRoots.push(root);
  const rulesDir = join(root, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  return { root, rulesDir };
}

function writeRule(rulesDir, name, content) {
  writeFileSync(join(rulesDir, name), content, 'utf8');
}

function run(pluginRoot) {
  return spawnSync('node', [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 15_000 });
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Positive case: handwritten rule WITH an axis (globs) + review-date → no
// warning for that file, and the file earns a PASS line.
// ---------------------------------------------------------------------------

describe('check-rules — handwritten rule with axis + review-date', () => {
  it('emits PASS, no WARN, and exits 0 for a fully-compliant handwritten rule', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'compliant.md',
      '---\nglobs:\n  - "src/**"\nreview-date: 2026-10-23\n---\n# Compliant Rule\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'PASS: .claude/rules/compliant.md — handwritten rule has an activation axis and a review-date',
    );
    expect(r.stdout).not.toMatch(/WARN:.*compliant\.md/);
  });
});

// ---------------------------------------------------------------------------
// Negative case: handwritten rule with NEITHER an axis NOR a review-date →
// two WARN lines, but exit code stays 0 (warn mode is non-fatal).
// ---------------------------------------------------------------------------

describe('check-rules — handwritten rule with neither axis nor review-date', () => {
  it('emits two WARN lines and still exits 0', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'bare.md',
      '---\ndescription: No axis, no review-date\n---\n# Bare Rule\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WARN:.*bare\.md.*no activation axis/);
    expect(r.stdout).toMatch(/WARN:.*bare\.md.*missing a review-date/);
    const warnLines = r.stdout
      .split('\n')
      .filter((l) => l.includes('WARN:') && l.includes('bare.md'));
    expect(warnLines).toHaveLength(2);
    expect(r.stdout).not.toMatch(/FAIL:.*bare\.md/);
  });
});

// ---------------------------------------------------------------------------
// Auto-generated regression case (re-pins one existing invariant from THIS
// file's scope — see file-header note — proving #880 did not weaken the
// pre-existing hard-fail branch).
// ---------------------------------------------------------------------------

describe('check-rules — auto-generated branch still hard-fails (regression pin)', () => {
  it('exits 1 when an auto-generated rule has no activation axis', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'generated-broken.md',
      '---\nauto-generated: true\nlearning-key: anti-pattern/broken\nexpires-at: 2099-01-01\n---\n# Broken\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL: .claude/rules/generated-broken.md');
    expect(r.stdout).toContain('never-always-on');
  });
});

// ---------------------------------------------------------------------------
// tier: alone satisfies the axis requirement.
// ---------------------------------------------------------------------------

describe('check-rules — tier: alone satisfies the handwritten axis requirement', () => {
  it('does not warn about a missing axis when only tier: is present (with review-date)', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'tier-only.md',
      '---\ntier: always\nreview-date: 2026-10-23\n---\n# Tier-Only Rule\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'PASS: .claude/rules/tier-only.md — handwritten rule has an activation axis and a review-date',
    );
    expect(r.stdout).not.toMatch(/WARN:.*tier-only\.md/);
  });

  it('warns ONLY about the missing review-date (not the axis) when tier: is present alone', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'tier-no-review.md',
      '---\ntier: coordinator-only\n---\n# Tier Only, No Review-Date\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/WARN:.*tier-no-review\.md.*no activation axis/);
    expect(r.stdout).toMatch(/WARN:.*tier-no-review\.md.*missing a review-date/);
  });
});

// ---------------------------------------------------------------------------
// review-date is NOT expires-at — a rule using expires-at instead is still
// flagged as missing a review-date (the two keys are deliberately distinct;
// see check-rules.mjs module doc for the rule-loader.mjs expiry-gate hazard).
// ---------------------------------------------------------------------------

describe('check-rules — review-date is distinct from expires-at', () => {
  it('still warns about a missing review-date when only expires-at is present', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'uses-expires-at.md',
      '---\ntier: always\nexpires-at: 2099-01-01\n---\n# Uses expires-at, not review-date\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WARN:.*uses-expires-at\.md.*missing a review-date/);
  });
});

// ---------------------------------------------------------------------------
// `review-date` format is deliberately UNVALIDATED (v1 scoping choice, not a
// bug — see the QA review notes for #880 FA5). `hasFrontmatterKey()` only
// checks for a non-empty value, never a parseable/plausible ISO 8601 date or
// a not-in-the-past date. Pinning this here so the next author sees a
// deliberate choice, not an oversight, if they consider tightening it.
// ---------------------------------------------------------------------------

describe('check-rules — review-date value is not format- or date-validated (deliberate v1 scoping)', () => {
  it('accepts a non-ISO-8601, non-date review-date string with no warning', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'garbled-review-date.md',
      '---\ntier: always\nreview-date: soon\n---\n# Garbled Review-Date\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'PASS: .claude/rules/garbled-review-date.md — handwritten rule has an activation axis and a review-date',
    );
    expect(r.stdout).not.toMatch(/WARN:.*garbled-review-date\.md/);
  });

  it('accepts a syntactically-invalid calendar date (2026-13-45) with no warning', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'invalid-calendar-date.md',
      '---\ntier: always\nreview-date: 2026-13-45\n---\n# Invalid Calendar Date\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'PASS: .claude/rules/invalid-calendar-date.md — handwritten rule has an activation axis and a review-date',
    );
    expect(r.stdout).not.toMatch(/WARN:.*invalid-calendar-date\.md/);
  });

  it('accepts a review-date far in the past with no staleness warning (no date-comparison logic exists)', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'stale-review-date.md',
      '---\ntier: always\nreview-date: 2000-01-01\n---\n# Stale Review-Date\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'PASS: .claude/rules/stale-review-date.md — handwritten rule has an activation axis and a review-date',
    );
    expect(r.stdout).not.toMatch(/WARN:.*stale-review-date\.md/);
  });
});

// ---------------------------------------------------------------------------
// WARN lines never flip the exit code, even for a fully-non-compliant
// handwritten rule that ALSO coexists with a passing auto-generated rule.
// ---------------------------------------------------------------------------

describe('check-rules — handwritten WARNs never affect the exit code', () => {
  it('exits 0 when a non-compliant handwritten rule coexists with a valid auto-generated rule', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(rulesDir, 'bare.md', '---\ndescription: no axis, no review-date\n---\n# Bare\n');
    writeRule(
      rulesDir,
      'valid-gen.md',
      '---\nauto-generated: true\nglobs: ["src/**"]\nlearning-key: anti-pattern/ok\nexpires-at: 2099-01-01\n---\n# Gen\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('FAIL:');
    expect(r.stdout).toMatch(/WARN:.*bare\.md/);
  });
});

// ---------------------------------------------------------------------------
// `paths:` alone satisfies the axis requirement (#795 alias). Previously
// UNTESTED (QA Defect 2) despite being the axis form the primary downstream
// consumer (projects-baseline: 26 rule files, all `paths:`, 0 `globs:` — see
// rule-loader.mjs module doc) relies on exclusively.
// ---------------------------------------------------------------------------

describe('check-rules — paths: alone satisfies the handwritten axis requirement (#795 alias)', () => {
  it('does not warn about a missing axis when only paths: is present (with review-date)', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'paths-only.md',
      '---\npaths:\n  - "src/**"\nreview-date: 2026-10-23\n---\n# Paths-Only Rule\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'PASS: .claude/rules/paths-only.md — handwritten rule has an activation axis and a review-date',
    );
    expect(r.stdout).not.toMatch(/WARN:.*paths-only\.md/);
  });
});

// ---------------------------------------------------------------------------
// `globs:` and `paths:` both present → `globs:` wins silently (#795
// precedence, rule-loader.mjs ~line 313: `globsValue !== null ? globsValue :
// pathsValue`). Previously UNTESTED (QA Defect 2). Exercised via BOTH a
// non-empty-globs case (trivial precedence, still worth pinning) and an
// empty-globs case (the load-bearing one — proves check-rules.mjs reflects
// the SAME precedence rule-loader.mjs applies, ignoring a non-empty `paths:`
// once `globs:` — even an empty one — is present).
// ---------------------------------------------------------------------------

describe('check-rules — globs: wins over paths: when both present (#795 precedence)', () => {
  it('treats a non-empty globs: as authoritative when paths: also present (globs wins)', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'globs-wins-nonempty.md',
      '---\nglobs:\n  - "lib/**"\npaths:\n  - "src/**"\nreview-date: 2026-10-23\n---\n# Globs Wins (Non-Empty)\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'PASS: .claude/rules/globs-wins-nonempty.md — handwritten rule has an activation axis and a review-date',
    );
    expect(r.stdout).not.toMatch(/WARN:.*globs-wins-nonempty\.md/);
  });

  it('treats an empty globs: [] as authoritative even when paths: is a non-empty array (globs wins)', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'globs-wins-empty.md',
      '---\nglobs: []\npaths:\n  - "src/**"\nreview-date: 2026-10-23\n---\n# Globs Wins (Empty)\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    // globs: [] wins over the non-empty paths: per #795 precedence — the
    // rule matches nothing, not "src/**". Must earn the distinct empty-globs
    // WARN, never a PASS.
    expect(r.stdout).toMatch(/WARN:.*globs-wins-empty\.md.*matches NOTHING/);
    expect(r.stdout).not.toMatch(/PASS:.*globs-wins-empty\.md/);
  });
});

// ---------------------------------------------------------------------------
// `globs: []` (present but empty) — QA Defect 1 fix. Must produce an
// accurate "dead rule, never loads" WARN, NEVER the inverted "loads
// always-on" message, and must never earn a PASS line — even when a
// co-present tier:/host-class: key would otherwise satisfy the axis, since
// rule-loader.mjs's empty-globs exclusion is unconditional and cannot be
// rescued by another axis (see check-rules.mjs module doc + the WARN body
// for the full rule-loader.mjs citation).
// ---------------------------------------------------------------------------

describe('check-rules — globs: [] produces an accurate, distinct WARN (not "always-on") — Defect 1', () => {
  it('warns that the rule matches nothing and never loads, not that it is always-on', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'empty-globs.md',
      '---\nglobs: []\nreview-date: 2026-10-23\n---\n# Empty Globs\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WARN:.*empty-globs\.md.*matches NOTHING/);
    expect(r.stdout).toMatch(/WARN:.*empty-globs\.md.*never loads/);
    // The OLD (inverted, pre-fix) branch's message text must NOT appear for
    // this file — that message asserted the rule "loads always-on", the
    // exact opposite of the true "matches nothing, never loads" outcome.
    expect(r.stdout).not.toMatch(/WARN:.*empty-globs\.md.*no activation axis/);
    expect(r.stdout).not.toMatch(/WARN:.*empty-globs\.md.*loads always-on/);
    expect(r.stdout).not.toMatch(/PASS:.*empty-globs\.md/);
  });

  it('still warns the empty-globs message when a co-present tier: key would otherwise satisfy the axis', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'empty-globs-with-tier.md',
      '---\nglobs: []\ntier: wave-only\nreview-date: 2026-10-23\n---\n# Empty Globs, Tiered\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    // tier: cannot rescue an empty globs array from rule-loader.mjs's
    // unconditional globs.length === 0 exclusion — the rule still never
    // loads, so it must still earn the distinct WARN, not a silent PASS.
    expect(r.stdout).toMatch(/WARN:.*empty-globs-with-tier\.md.*matches NOTHING/);
    expect(r.stdout).not.toMatch(/PASS:.*empty-globs-with-tier\.md/);
  });

  it('emits an empty-globs WARN via the paths: [] form too (same merged-globs value)', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'empty-paths.md',
      '---\npaths: []\nreview-date: 2026-10-23\n---\n# Empty Paths\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WARN:.*empty-paths\.md.*matches NOTHING/);
    expect(r.stdout).not.toMatch(/PASS:.*empty-paths\.md/);
  });
});

// ---------------------------------------------------------------------------
// Results summary line includes the warned count.
// ---------------------------------------------------------------------------

describe('check-rules — Results summary reports the warned count', () => {
  it('reports "0 warned" when every handwritten rule is compliant', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'compliant.md',
      '---\ntier: always\nreview-date: 2026-10-23\n---\n# Compliant\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    // 2 passed = 1 "no auto-generated rules found" bookkeeping PASS + 1
    // compliant-handwritten PASS (no auto-generated fixture file exists here).
    expect(r.stdout).toContain('Results: 2 passed, 0 failed, 0 warned');
  });

  it('reports "2 warned" for a single fully-non-compliant handwritten rule', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(rulesDir, 'bare.md', '---\ndescription: nothing\n---\n# Bare\n');

    const r = run(root);

    expect(r.status).toBe(0);
    // 1 passed = the "no auto-generated rules found" bookkeeping PASS only —
    // bare.md earns no PASS since it fails both the axis and review-date checks.
    expect(r.stdout).toContain('Results: 1 passed, 0 failed, 2 warned');
  });
});
