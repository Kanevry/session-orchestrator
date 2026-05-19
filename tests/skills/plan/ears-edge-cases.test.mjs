/**
 * tests/skills/plan/ears-edge-cases.test.mjs
 *
 * Edge-case, boundary, and error-path hardening for the EARS Add-Section
 * feature (issue #487 W2). Complements the W3 P1 happy-path tests in:
 *   - tests/skills/plan/ears-section.test.mjs
 *   - tests/skills/brainstorm/ears-ac.test.mjs
 *   - tests/skills/write-executable-plan/ears-vitest-gen.test.mjs
 *
 * These tests catch regressions that P1 structural checks would miss:
 * section ordering, exact keyword spellings (UK English), placeholder
 * discipline, Gherkin preservation, mapping table depth, and reviewer
 * completeness.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FEATURE_TEMPLATE = join(REPO_ROOT, 'skills', 'plan', 'prd-feature-template.md');
const FULL_TEMPLATE = join(REPO_ROOT, 'skills', 'plan', 'prd-full-template.md');
const BRAINSTORM_SKILL = join(REPO_ROOT, 'skills', 'brainstorm', 'SKILL.md');
const WEP_SKILL = join(REPO_ROOT, 'skills', 'write-executable-plan', 'SKILL.md');
const REVIEWER_PROMPT = join(REPO_ROOT, 'skills', 'plan', 'prd-reviewer-prompt.md');

// ---------------------------------------------------------------------------
// 1. Section ordering invariants
// ---------------------------------------------------------------------------

describe('prd-feature-template.md — section ordering invariants', () => {
  it('## 3. Acceptance Criteria appears before ## 3.A Acceptance Criteria (EARS)', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    const section3Idx = content.indexOf('## 3. Acceptance Criteria');
    const section3AIdx = content.indexOf('## 3.A Acceptance Criteria (EARS)');
    expect(section3Idx).toBeGreaterThan(-1);
    expect(section3AIdx).toBeGreaterThan(-1);
    expect(section3Idx).toBeLessThan(section3AIdx);
  });

  it('## 3.A Acceptance Criteria (EARS) appears before ## 4. Technical Notes', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    const section3AIdx = content.indexOf('## 3.A Acceptance Criteria (EARS)');
    const section4Idx = content.indexOf('## 4. Technical Notes');
    expect(section3AIdx).toBeGreaterThan(-1);
    expect(section4Idx).toBeGreaterThan(-1);
    expect(section3AIdx).toBeLessThan(section4Idx);
  });

  it('prd-full-template.md: ## 5.A Acceptance Criteria (EARS) appears before ## 6. Technical Architecture', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    const section5AIdx = content.indexOf('## 5.A Acceptance Criteria (EARS)');
    const section6Idx = content.indexOf('## 6. Technical Architecture');
    expect(section5AIdx).toBeGreaterThan(-1);
    expect(section6Idx).toBeGreaterThan(-1);
    expect(section5AIdx).toBeLessThan(section6Idx);
  });
});

// ---------------------------------------------------------------------------
// 2. EARS keyword spellings — UK English, hyphenation, exact phrases
// ---------------------------------------------------------------------------

describe('prd-feature-template.md — EARS keyword UK spellings and exact phrases', () => {
  it('uses UK spelling "Unwanted behaviour" (not "behavior")', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('Unwanted behaviour');
    expect(content).not.toContain('Unwanted behavior');
  });

  it('uses the exact phrase "Optional feature" (not just "Optional")', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('Optional feature');
  });

  it('uses hyphenated "State-driven" (not "State driven" without hyphen)', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('State-driven');
    expect(content).not.toContain('State driven');
  });

  it('uses hyphenated "Event-driven" (not "Event driven" without hyphen)', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('Event-driven');
    expect(content).not.toContain('Event driven');
  });

  it('contains "Ubiquitous" as a single unhyphenated word', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('Ubiquitous');
  });
});

// ---------------------------------------------------------------------------
// 3. Template placeholder discipline — {{...}} double-brace convention
// ---------------------------------------------------------------------------

describe('prd-feature-template.md — 3.A section uses {{...}} double-brace placeholders', () => {
  it('3.A section body contains at least one {{...}} double-brace placeholder', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    const section3AStart = content.indexOf('## 3.A Acceptance Criteria (EARS)');
    const section4Start = content.indexOf('## 4. Technical Notes');
    const section3ABody = content.slice(section3AStart, section4Start);
    expect(section3ABody).toContain('{{');
    expect(section3ABody).toContain('}}');
  });
});

describe('prd-full-template.md — 5.A section uses {{...}} double-brace placeholders', () => {
  it('5.A section body contains at least one {{...}} double-brace placeholder', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    const section5AStart = content.indexOf('## 5.A Acceptance Criteria (EARS)');
    const section6Start = content.indexOf('## 6. Technical Architecture');
    const section5ABody = content.slice(section5AStart, section6Start);
    expect(section5ABody).toContain('{{');
    expect(section5ABody).toContain('}}');
  });
});

describe('brainstorm/SKILL.md — EARS section uses {{...}} double-brace placeholders', () => {
  it('EARS AC section in SKILL.md contains at least one {{...}} double-brace placeholder', () => {
    const content = readFileSync(BRAINSTORM_SKILL, 'utf8');
    const earsSectionStart = content.indexOf('## Acceptance Criteria (EARS) [optional]');
    const openQStart = content.indexOf('## Open Questions');
    const earsSectionBody = content.slice(earsSectionStart, openQStart);
    expect(earsSectionBody).toContain('{{');
    expect(earsSectionBody).toContain('}}');
  });
});

// ---------------------------------------------------------------------------
// 4. No regression — Gherkin content intact in prd-feature-template.md
// ---------------------------------------------------------------------------

describe('prd-feature-template.md — Gherkin content in Section 3 not regressed', () => {
  it('Section 3 still contains the "Given" keyword before ## 3.A', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    const section3Start = content.indexOf('## 3. Acceptance Criteria');
    const section3AStart = content.indexOf('## 3.A Acceptance Criteria (EARS)');
    const section3Body = content.slice(section3Start, section3AStart);
    expect(section3Body).toContain('Given');
  });

  it('Section 3 still contains the "When" keyword before ## 3.A', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    const section3Start = content.indexOf('## 3. Acceptance Criteria');
    const section3AStart = content.indexOf('## 3.A Acceptance Criteria (EARS)');
    const section3Body = content.slice(section3Start, section3AStart);
    expect(section3Body).toContain('When');
  });

  it('Section 3 still contains the "Then" keyword before ## 3.A', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    const section3Start = content.indexOf('## 3. Acceptance Criteria');
    const section3AStart = content.indexOf('## 3.A Acceptance Criteria (EARS)');
    const section3Body = content.slice(section3Start, section3AStart);
    expect(section3Body).toContain('Then');
  });

  it('Section 3 still contains a ```gherkin code fence before ## 3.A', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    const section3Start = content.indexOf('## 3. Acceptance Criteria');
    const section3AStart = content.indexOf('## 3.A Acceptance Criteria (EARS)');
    const section3Body = content.slice(section3Start, section3AStart);
    expect(section3Body).toContain('```gherkin');
  });
});

// ---------------------------------------------------------------------------
// 5. EARS mapping table integrity in write-executable-plan/SKILL.md
// ---------------------------------------------------------------------------

describe('write-executable-plan/SKILL.md — EARS mapping table depth', () => {
  it('mapping table contains "invariant" (the Ubiquitous pattern vitest description)', () => {
    const content = readFileSync(WEP_SKILL, 'utf8');
    expect(content).toContain('invariant');
  });

  it('mapping table contains "arrange" (part of Event-driven arrange/trigger/expect idiom)', () => {
    const content = readFileSync(WEP_SKILL, 'utf8');
    expect(content).toContain('arrange');
  });

  it('mapping table contains "skipIf" (the Optional feature vitest conditional)', () => {
    const content = readFileSync(WEP_SKILL, 'utf8');
    expect(content).toContain('skipIf');
  });
});

// ---------------------------------------------------------------------------
// 6. prd-reviewer-prompt.md — EARS bullet lists all 5 pattern names in a
//    single line / sentence (completeness guard)
// ---------------------------------------------------------------------------

describe('prd-reviewer-prompt.md — EARS bullet completeness on a single line', () => {
  it('the EARS-awareness bullet contains all 5 canonical pattern names on the same line', () => {
    const content = readFileSync(REVIEWER_PROMPT, 'utf8');
    const lines = content.split('\n');
    const earsLine = lines.find(
      (line) =>
        line.includes('Ubiquitous') &&
        line.includes('State-driven') &&
        line.includes('Event-driven') &&
        line.includes('Optional feature') &&
        line.includes('Unwanted behaviour'),
    );
    expect(earsLine).not.toBeUndefined();
  });
});
