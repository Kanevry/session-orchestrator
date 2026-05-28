/**
 * tests/skills/plan/ears-section.test.mjs
 *
 * Structural / content tests verifying that the EARS Add-Section feature
 * (issue #487 W2 Tasks 1-4) landed correctly in both PRD templates and
 * mode-feature.md.
 *
 * These tests do NOT execute any skill logic — they verify that the
 * Markdown source files contain the expected section headers, pattern
 * names, and reviewer instructions added by W2.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { EARS_PATTERNS } from '../../_shared/ears-patterns.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FEATURE_TEMPLATE = join(REPO_ROOT, 'skills', 'plan', 'prd-feature-template.md');
const FULL_TEMPLATE = join(REPO_ROOT, 'skills', 'plan', 'prd-full-template.md');
const MODE_FEATURE = join(REPO_ROOT, 'skills', 'plan', 'mode-feature.md');
const REVIEWER_PROMPT = join(REPO_ROOT, 'skills', 'plan', 'prd-reviewer-prompt.md');

// ---------------------------------------------------------------------------
// prd-feature-template.md — EARS section header and pattern names
// ---------------------------------------------------------------------------

describe('prd-feature-template.md — EARS section header', () => {
  it('contains ## 3.A Acceptance Criteria (EARS) as a top-level section header', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('## 3.A Acceptance Criteria (EARS)');
  });
});

describe('prd-feature-template.md — EARS canonical pattern names', () => {
  it.each(EARS_PATTERNS)('contains the %s pattern name', (pattern) => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain(pattern);
  });
});

describe('prd-feature-template.md — Section 3 Gherkin not modified', () => {
  it('still contains the Given keyword in Section 3', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('Given');
  });

  it('still contains the When keyword in Section 3', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('When');
  });

  it('still contains the Then keyword in Section 3', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('Then');
  });

  it('still contains a gherkin code fence in Section 3', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('```gherkin');
  });
});

// ---------------------------------------------------------------------------
// prd-full-template.md — EARS section header and pattern names
// ---------------------------------------------------------------------------

describe('prd-full-template.md — EARS section header', () => {
  it('contains ## 5.A Acceptance Criteria (EARS) as a top-level section header', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    expect(content).toContain('## 5.A Acceptance Criteria (EARS)');
  });

  it('5.A section is placed after the ## 5. Success Criteria section (semantic placement)', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    const section5Idx = content.indexOf('## 5. Success Criteria');
    const section5AIdx = content.indexOf('## 5.A Acceptance Criteria (EARS)');
    // Both sections must exist
    expect(section5Idx).toBeGreaterThan(-1);
    expect(section5AIdx).toBeGreaterThan(-1);
    // 5.A must appear after Section 5
    expect(section5AIdx).toBeGreaterThan(section5Idx);
  });
});

describe('prd-full-template.md — EARS canonical pattern names', () => {
  it.each(EARS_PATTERNS)('contains the %s pattern name', (pattern) => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    expect(content).toContain(pattern);
  });
});

// ---------------------------------------------------------------------------
// mode-feature.md — Phase 2 fill-table has a row for Section 3.A
// ---------------------------------------------------------------------------

describe('mode-feature.md — Phase 2 fill-table row for Section 3.A', () => {
  it('contains 3.A in the Phase 2 fill-table', () => {
    const content = readFileSync(MODE_FEATURE, 'utf8');
    expect(content).toContain('3.A');
  });

  it('Phase 2 fill-table 3.A row references EARS', () => {
    const content = readFileSync(MODE_FEATURE, 'utf8');
    // The row should mention both "3.A" and "EARS" within the same fill-table context
    expect(content).toContain('EARS');
  });

  it('3.A row and EARS keyword appear in the same Phase 2 section', () => {
    const content = readFileSync(MODE_FEATURE, 'utf8');
    const phase2Idx = content.indexOf('## Phase 2');
    expect(phase2Idx).toBeGreaterThan(-1);
    // Extract Phase 2 section content (everything from Phase 2 until next ##)
    const afterPhase2 = content.slice(phase2Idx);
    const nextSectionIdx = afterPhase2.indexOf('\n## ', 1);
    const phase2Body = nextSectionIdx > -1 ? afterPhase2.slice(0, nextSectionIdx) : afterPhase2;
    expect(phase2Body).toContain('3.A');
    expect(phase2Body).toContain('EARS');
  });
});

// ---------------------------------------------------------------------------
// prd-reviewer-prompt.md — Clarity section has EARS-awareness bullet
// ---------------------------------------------------------------------------

describe('prd-reviewer-prompt.md — Clarity section EARS-awareness bullet', () => {
  it('mentions EARS in the Clarity review criterion', () => {
    const content = readFileSync(REVIEWER_PROMPT, 'utf8');
    expect(content).toContain('EARS');
  });

  it('EARS-awareness bullet references all 5 canonical pattern names', () => {
    const content = readFileSync(REVIEWER_PROMPT, 'utf8');
    const present = EARS_PATTERNS.filter((pattern) => content.includes(pattern));
    expect(present).toEqual([...EARS_PATTERNS]);
  });

  it('EARS mention appears inside the Clarity section (not before it)', () => {
    const content = readFileSync(REVIEWER_PROMPT, 'utf8');
    const clarityIdx = content.indexOf('### 3. Clarity');
    const earsIdx = content.indexOf('EARS');
    expect(clarityIdx).toBeGreaterThan(-1);
    expect(earsIdx).toBeGreaterThan(-1);
    expect(earsIdx).toBeGreaterThan(clarityIdx);
  });

  it('references the shall keyword requirement for EARS statements', () => {
    const content = readFileSync(REVIEWER_PROMPT, 'utf8');
    expect(content).toContain('shall');
  });
});
