/**
 * tests/skills/write-executable-plan/ears-vitest-gen.test.mjs
 *
 * Structural / content tests verifying that the EARS→vitest mapping table and
 * EARS conditional seam added by issue #487 W2 landed correctly in:
 *   - skills/write-executable-plan/SKILL.md
 *   - skills/write-executable-plan/plan-template.md
 *
 * Also sanity-checks that the exemplar test file cited in the SKILL.md
 * (tests/lib/wave-executor/persona-gate-hook.test.mjs) actually exists.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { EARS_PATTERNS } from '../../_shared/ears-patterns.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SKILL_PATH = join(REPO_ROOT, 'skills', 'write-executable-plan', 'SKILL.md');
const TEMPLATE_PATH = join(REPO_ROOT, 'skills', 'write-executable-plan', 'plan-template.md');
const EXEMPLAR_PATH = join(REPO_ROOT, 'tests', 'lib', 'wave-executor', 'persona-gate-hook.test.mjs');

// ---------------------------------------------------------------------------
// M1 note (issue #492 deep-3 qa coverage-gap bundle):
//
// This is a DOC-CONTRACT test, not a true EARS→vitest end-to-end test. There
// is NO executable EARS→vitest code generator in the repository — the mapping
// is doc-driven, defined as a Markdown table in skills/write-executable-plan/
// SKILL.md (§ "EARS → vitest mapping (1:1)") and referenced by plan-template.md.
// A literal integration test against a generator is therefore impossible.
//
// Instead, the tests below assert COMPLETENESS + CONSISTENCY of the documented
// mapping so they FAIL if someone edits the SKILL to drop a pattern, change the
// row count, rename the cross-referenced heading, or desync the cited exemplar.
// ---------------------------------------------------------------------------

/**
 * Extract the body of the EARS mapping table from SKILL.md — the contiguous
 * block of Markdown table rows that sits between the table header line
 * ("| EARS pattern | vitest construct | example skeleton |") and the
 * "Reference test exemplifying this pattern" line that follows the table.
 *
 * Returns only the data-row region so completeness assertions are scoped to
 * the table itself, not to incidental prose elsewhere in the file. Throws if
 * the anchors are missing (which is itself a contract regression).
 */
function extractEarsTableBody(skillContent) {
  const headerMarker = '| EARS pattern | vitest construct | example skeleton |';
  const endMarker = 'Reference test exemplifying this pattern';
  const headerIdx = skillContent.indexOf(headerMarker);
  if (headerIdx === -1) {
    throw new Error('EARS mapping table header row not found in SKILL.md');
  }
  const endIdx = skillContent.indexOf(endMarker, headerIdx);
  if (endIdx === -1) {
    throw new Error('EARS mapping table end marker (Reference test) not found in SKILL.md');
  }
  return skillContent.slice(headerIdx, endIdx);
}

/**
 * Count the data rows in the EARS mapping table body — table lines that begin
 * with "| **" (each EARS pattern name is bold). Excludes the header row (no
 * "**") and the "|---|" separator row.
 */
function countEarsTableDataRows(tableBody) {
  return tableBody
    .split('\n')
    .filter((line) => line.trimStart().startsWith('| **')).length;
}

// ---------------------------------------------------------------------------
// SKILL.md — EARS conditional seam present
// ---------------------------------------------------------------------------

describe('write-executable-plan/SKILL.md — EARS conditional seam', () => {
  it('contains EARS keyword in the Phase 3 Step 1 body', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('EARS');
  });

  it('contains "Acceptance Criteria (EARS)" to describe the source PRD section trigger', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('Acceptance Criteria (EARS)');
  });

  it('EARS seam references the 3.A section designator', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('3.A');
  });
});

// ---------------------------------------------------------------------------
// SKILL.md — all 5 canonical EARS pattern names present in mapping table
// ---------------------------------------------------------------------------

describe('write-executable-plan/SKILL.md — EARS canonical pattern names in mapping table', () => {
  it.each(EARS_PATTERNS)('contains the %s pattern name', (pattern) => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain(pattern);
  });
});

// ---------------------------------------------------------------------------
// SKILL.md — vitest constructs referenced in mapping table
// ---------------------------------------------------------------------------

describe('write-executable-plan/SKILL.md — vitest constructs in EARS mapping table', () => {
  it('references it.skipIf as the Optional feature vitest construct', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('it.skipIf');
  });

  it('EARS mapping table contains the exemplar test path persona-gate-hook.test.mjs', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('persona-gate-hook.test.mjs');
  });
});

// ---------------------------------------------------------------------------
// plan-template.md — EARS seam note present in Task 1 Step 1
// ---------------------------------------------------------------------------

describe('write-executable-plan/plan-template.md — EARS seam note', () => {
  it('references the EARS Acceptance Criteria section trigger in Step 1', () => {
    const content = readFileSync(TEMPLATE_PATH, 'utf8');
    expect(content).toContain('EARS');
  });

  it('EARS seam note references SKILL.md for the mapping table', () => {
    const content = readFileSync(TEMPLATE_PATH, 'utf8');
    expect(content).toContain('SKILL.md');
  });

  it('EARS seam note references the 3.A section designator', () => {
    const content = readFileSync(TEMPLATE_PATH, 'utf8');
    expect(content).toContain('3.A');
  });

  it('EARS seam note references the Acceptance Criteria (EARS) section name', () => {
    const content = readFileSync(TEMPLATE_PATH, 'utf8');
    expect(content).toContain('Acceptance Criteria (EARS)');
  });
});

// ---------------------------------------------------------------------------
// Sanity check: exemplar test file cited in SKILL.md actually exists on disk
// ---------------------------------------------------------------------------

describe('exemplar test file cited in SKILL.md — existence check', () => {
  it('tests/lib/wave-executor/persona-gate-hook.test.mjs exists on disk', () => {
    expect(existsSync(EXEMPLAR_PATH)).toBe(true);
  });
});

// ===========================================================================
// M1 (#492): doc-contract strengthening — COMPLETENESS of the mapping table.
//
// The existing tests above grep bare pattern names anywhere in the file, so a
// pattern row could be deleted from the table while the name survives in prose
// and the test would still pass. The tests below scope assertions to the table
// BODY (via extractEarsTableBody) so they fail when a row is actually dropped.
// ===========================================================================

describe('write-executable-plan/SKILL.md — EARS mapping table completeness (M1)', () => {
  it('declares the mapping as 1:1 in the table heading', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('EARS → vitest mapping (1:1)');
  });

  it('mapping table body contains exactly 5 EARS pattern data rows', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    const rows = countEarsTableDataRows(extractEarsTableBody(content));
    expect(rows).toBe(5);
  });

  it('all 5 canonical EARS pattern names appear inside the table body (not just in prose)', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    const tableBody = extractEarsTableBody(content);
    const present = EARS_PATTERNS.filter((name) => tableBody.includes(name));
    expect(present).toEqual([...EARS_PATTERNS]);
  });

  it('table body documents the it() vitest construct (Ubiquitous + Event-driven mapping)', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(extractEarsTableBody(content)).toContain('it(');
  });

  it('table body documents the describe() vitest construct (State-driven mapping)', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(extractEarsTableBody(content)).toContain('describe(');
  });

  it('table body documents the it.skipIf vitest construct (Optional feature mapping)', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(extractEarsTableBody(content)).toContain('it.skipIf');
  });

  it('table body documents the toThrow() vitest construct (Unwanted behaviour mapping)', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(extractEarsTableBody(content)).toContain('toThrow()');
  });
});

// ===========================================================================
// M1 (#492): cross-file CONSISTENCY contract.
//
// 1. The exemplar the SKILL cites must actually contain the vitest constructs
//    the SKILL prescribes — otherwise "Reference test exemplifying this
//    pattern" is a dangling/false claim. Asserted only for the constructs the
//    exemplar genuinely demonstrates (describe / it / toThrow); the exemplar
//    does NOT exercise it.skipIf, so that construct is deliberately not asserted
//    against it.
// 2. plan-template.md cross-references "SKILL.md § EARS → vitest mapping"; that
//    exact heading must exist in SKILL.md so the pointer never goes stale.
// ===========================================================================

describe('write-executable-plan — exemplar ↔ SKILL.md construct consistency (M1)', () => {
  it('cited exemplar contains the describe() construct documented in the mapping table', () => {
    const exemplar = readFileSync(EXEMPLAR_PATH, 'utf8');
    expect(exemplar).toContain('describe(');
  });

  it('cited exemplar contains the it() construct documented in the mapping table', () => {
    const exemplar = readFileSync(EXEMPLAR_PATH, 'utf8');
    expect(exemplar).toContain('it(');
  });

  it('cited exemplar contains the toThrow assertion documented for the Unwanted-behaviour row', () => {
    const exemplar = readFileSync(EXEMPLAR_PATH, 'utf8');
    expect(exemplar).toContain('toThrow');
  });
});

describe('write-executable-plan — plan-template ↔ SKILL heading cross-reference (M1)', () => {
  it('plan-template.md points at the "SKILL.md § EARS → vitest mapping" heading', () => {
    const template = readFileSync(TEMPLATE_PATH, 'utf8');
    expect(template).toContain('SKILL.md § EARS → vitest mapping');
  });

  it('the heading referenced by plan-template.md actually exists in SKILL.md', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('EARS → vitest mapping');
  });
});
