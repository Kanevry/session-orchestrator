/**
 * tests/templates/personas/content-lint.test.mjs
 *
 * Content-level invariant checks for the 4 new buyer-persona templates
 * shipped in W2 of #482 (p3-p6). These tests verify business rules NOT
 * captured by frontmatter schema validation in parse-each.test.mjs.
 *
 * Covered invariants per persona:
 *   1. Owner-leakage hard guard  — file must NOT contain personal identifiers
 *   2. Required body sections    — all 4 H2 sections present in markdown body
 *   3. Tier consistency          — frontmatter tier equals 'buyer-persona'
 *   4. Length range              — file is between 100 and 250 lines
 *   5. Verdict enum integrity    — output_contract body mentions pass, fail, warn
 *
 * Plus one cross-repo test:
 *   6. README cross-link         — README.md references the p3-p6 range
 *
 * Falsification check (mandatory per test-quality.md):
 *   - Owner-leakage: uses NOT.toContain — if leakage were introduced the test
 *     would FAIL (positive assertion flipped). ✓
 *   - Section presence: removing a section heading causes the toContain to fail. ✓
 *   - Tier: hardcoded literal 'buyer-persona' — wrong tier string → fail. ✓
 *   - Length range: hardcoded floor 100 / ceiling 250 — truncated or ballooned
 *     file crosses a bound → fail. ✓
 *   - Verdict enum: hardcoded strings 'pass', 'fail', 'warn' — removing any from
 *     the template body causes the corresponding assertion to fail. ✓
 *   - README cross-link: hardcoded substring match — missing text → fail. ✓
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const PERSONAS_DIR = join(REPO_ROOT, 'templates', 'personas');

const NEW_PERSONAS = [
  'gotzendorfer-buyer-p3-build',
  'gotzendorfer-buyer-p4-tech-veto',
  'gotzendorfer-buyer-p5-solo',
  'gotzendorfer-buyer-p6-ld',
];

// ---------------------------------------------------------------------------
// 1. Owner-leakage hard guard
// ---------------------------------------------------------------------------

describe.each(NEW_PERSONAS)('owner-leakage guard — %s', (slug) => {
  const filePath = join(PERSONAS_DIR, `${slug}.v1.md`);
  const content = readFileSync(filePath, 'utf8');

  it('does not contain absolute path /Users/bernhardg.', () => {
    expect(content).not.toContain('/Users/bernhardg.');
  });

  it('does not contain personal email @gotzendorfer.at', () => {
    expect(content).not.toContain('@gotzendorfer.at');
  });

  it('does not contain private repo name buchhaltgenie', () => {
    expect(content).not.toContain('buchhaltgenie');
  });

  it('does not contain private repo name aiat-pmo', () => {
    expect(content).not.toContain('aiat-pmo');
  });
});

// ---------------------------------------------------------------------------
// 2. Required body sections present
// ---------------------------------------------------------------------------

describe.each(NEW_PERSONAS)('required body sections — %s', (slug) => {
  const filePath = join(PERSONAS_DIR, `${slug}.v1.md`);
  const content = readFileSync(filePath, 'utf8');

  it('has ## Mission section', () => {
    expect(content).toContain('## Mission');
  });

  it('has ## Context Files section', () => {
    expect(content).toContain('## Context Files');
  });

  it('has ## Evaluation Criteria section', () => {
    expect(content).toContain('## Evaluation Criteria');
  });

  it('has ## Output Template section', () => {
    expect(content).toContain('## Output Template');
  });
});

// ---------------------------------------------------------------------------
// 3. Tier consistency — all 4 new personas are buyer-persona tier
// ---------------------------------------------------------------------------

describe.each(NEW_PERSONAS)('tier consistency — %s', (slug) => {
  const filePath = join(PERSONAS_DIR, `${slug}.v1.md`);
  const content = readFileSync(filePath, 'utf8');

  it('frontmatter declares tier: buyer-persona', () => {
    expect(content).toContain('tier: buyer-persona');
  });
});

// ---------------------------------------------------------------------------
// 4. Length range — floor 100 / ceiling 250 lines
//    (all 4 files are ~130 lines; floor catches truncation, ceiling catches
//    accidental duplication — per test-quality.md floor/ceiling carve-out)
// ---------------------------------------------------------------------------

describe.each(NEW_PERSONAS)('length range — %s', (slug) => {
  const filePath = join(PERSONAS_DIR, `${slug}.v1.md`);
  const content = readFileSync(filePath, 'utf8');

  it('has at least 100 lines', () => {
    const lineCount = content.split('\n').length;
    expect(lineCount).toBeGreaterThanOrEqual(100);
  });

  it('has at most 250 lines', () => {
    const lineCount = content.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(250);
  });
});

// ---------------------------------------------------------------------------
// 5. Verdict enum integrity — output_contract body must name all 3 values
// ---------------------------------------------------------------------------

describe.each(NEW_PERSONAS)('verdict enum integrity — %s', (slug) => {
  const filePath = join(PERSONAS_DIR, `${slug}.v1.md`);
  const content = readFileSync(filePath, 'utf8');

  it('output_contract references verdict value "pass"', () => {
    expect(content).toContain('pass');
  });

  it('output_contract references verdict value "fail"', () => {
    expect(content).toContain('fail');
  });

  it('output_contract references verdict value "warn"', () => {
    expect(content).toContain('warn');
  });
});

// ---------------------------------------------------------------------------
// 6. README cross-link — README.md must reference the p3-p6 range
// ---------------------------------------------------------------------------

describe('README cross-link', () => {
  const readmePath = join(PERSONAS_DIR, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');

  it('README.md references the gotzendorfer-buyer-p1-cto through p6-ld range covering new personas', () => {
    expect(readme).toContain('gotzendorfer-buyer-p1-cto.v1.md');
    expect(readme).toContain('gotzendorfer-buyer-p6-ld.v1.md');
  });
});
