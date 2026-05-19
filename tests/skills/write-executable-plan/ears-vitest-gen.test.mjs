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

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SKILL_PATH = join(REPO_ROOT, 'skills', 'write-executable-plan', 'SKILL.md');
const TEMPLATE_PATH = join(REPO_ROOT, 'skills', 'write-executable-plan', 'plan-template.md');
const EXEMPLAR_PATH = join(REPO_ROOT, 'tests', 'lib', 'wave-executor', 'persona-gate-hook.test.mjs');

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
  it('contains the Ubiquitous pattern name', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('Ubiquitous');
  });

  it('contains the State-driven pattern name', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('State-driven');
  });

  it('contains the Event-driven pattern name', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('Event-driven');
  });

  it('contains the Optional feature pattern name', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('Optional feature');
  });

  it('contains the Unwanted behaviour pattern name', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('Unwanted behaviour');
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
