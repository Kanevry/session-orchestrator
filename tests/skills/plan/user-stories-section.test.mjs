/**
 * tests/skills/plan/user-stories-section.test.mjs
 *
 * Structural / content tests verifying that the optional User-Story layer
 * (issue #659 W2) landed correctly in both PRD templates: section existence,
 * placement ordering relative to the surrounding numbered sections, the
 * German Als/möchte/damit story form with its ↳ AC pointer, the optional
 * `>` blockquote marker, and the no-renumber guard that proves the EARS /
 * numbered sections were NOT shifted when the un-numbered ## User Stories
 * heading was inserted.
 *
 * These tests do NOT execute any skill logic — they verify that the
 * Markdown source files contain the expected section header, ordering, and
 * story-form scaffolding added by W2.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FEATURE_TEMPLATE = join(REPO_ROOT, 'skills', 'plan', 'prd-feature-template.md');
const FULL_TEMPLATE = join(REPO_ROOT, 'skills', 'plan', 'prd-full-template.md');
const MODE_FEATURE = join(REPO_ROOT, 'skills', 'plan', 'mode-feature.md');

// ---------------------------------------------------------------------------
// 1. ## User Stories section exists in both templates
// ---------------------------------------------------------------------------

describe('User Stories section — existence in both PRD templates', () => {
  it('prd-feature-template.md contains a ## User Stories section header', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('## User Stories');
  });

  it('prd-full-template.md contains a ## User Stories section header', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    expect(content).toContain('## User Stories');
  });
});

// ---------------------------------------------------------------------------
// 2. Ordering — feature template: ## 2. Solution & Scope < ## User Stories < ## 3. Acceptance Criteria
// ---------------------------------------------------------------------------

describe('prd-feature-template.md — User Stories placement ordering', () => {
  it('## User Stories appears after ## 2. Solution & Scope and before ## 3. Acceptance Criteria', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    const solutionIdx = content.indexOf('## 2. Solution & Scope');
    const storiesIdx = content.indexOf('## User Stories');
    const acIdx = content.indexOf('## 3. Acceptance Criteria');
    expect(solutionIdx).toBeGreaterThan(-1);
    expect(storiesIdx).toBeGreaterThan(-1);
    expect(acIdx).toBeGreaterThan(-1);
    expect(storiesIdx).toBeGreaterThan(solutionIdx);
    expect(storiesIdx).toBeLessThan(acIdx);
  });
});

// ---------------------------------------------------------------------------
// 3. Ordering — full template: ## 3. Target Audience & Personas < ## User Stories < ## 4. Solution & Scope
// ---------------------------------------------------------------------------

describe('prd-full-template.md — User Stories placement ordering', () => {
  it('## User Stories appears after ## 3. Target Audience & Personas and before ## 4. Solution & Scope', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    const audienceIdx = content.indexOf('## 3. Target Audience & Personas');
    const storiesIdx = content.indexOf('## User Stories');
    const solutionIdx = content.indexOf('## 4. Solution & Scope');
    expect(audienceIdx).toBeGreaterThan(-1);
    expect(storiesIdx).toBeGreaterThan(-1);
    expect(solutionIdx).toBeGreaterThan(-1);
    expect(storiesIdx).toBeGreaterThan(audienceIdx);
    expect(storiesIdx).toBeLessThan(solutionIdx);
  });
});

// ---------------------------------------------------------------------------
// 4. No-renumber guard — the surrounding numbered sections were NOT shifted
// ---------------------------------------------------------------------------

describe('prd-feature-template.md — no-renumber guard', () => {
  it('still contains ## 3. Acceptance Criteria (un-renumbered)', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('## 3. Acceptance Criteria');
  });

  it('still contains ## 3.A Acceptance Criteria (EARS) (un-renumbered)', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('## 3.A Acceptance Criteria (EARS)');
  });

  it('still contains ## 4. Technical Notes (un-renumbered)', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('## 4. Technical Notes');
  });

  it('still contains ## 5. Risks & Dependencies (un-renumbered)', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toContain('## 5. Risks & Dependencies');
  });
});

describe('prd-full-template.md — no-renumber guard', () => {
  it('still contains ## 4. Solution & Scope (un-renumbered)', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    expect(content).toContain('## 4. Solution & Scope');
  });

  it('still contains ## 5. Success Criteria (un-renumbered)', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    expect(content).toContain('## 5. Success Criteria');
  });

  it('still contains ## 5.A Acceptance Criteria (EARS) (un-renumbered)', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    expect(content).toContain('## 5.A Acceptance Criteria (EARS)');
  });

  it('still contains ## 6. Technical Architecture (un-renumbered)', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    expect(content).toContain('## 6. Technical Architecture');
  });
});

// ---------------------------------------------------------------------------
// 5. Story form present in the User-Stories section body
// ---------------------------------------------------------------------------

describe('prd-feature-template.md — User Stories section body story form', () => {
  it('section body contains the German Als/möchte ich/damit story form and a ↳ AC pointer', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    const start = content.indexOf('## User Stories');
    const end = content.indexOf('## 3. Acceptance Criteria');
    const body = content.slice(start, end);
    expect(body).toContain('**Als**');
    expect(body).toContain('**möchte ich**');
    expect(body).toContain('**damit**');
    expect(body).toContain('↳ AC:');
  });
});

describe('prd-full-template.md — User Stories section body story form', () => {
  it('section body contains the German Als/möchte ich/damit story form and a ↳ AC pointer', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    const start = content.indexOf('## User Stories');
    const end = content.indexOf('## 4. Solution & Scope');
    const body = content.slice(start, end);
    expect(body).toContain('**Als**');
    expect(body).toContain('**möchte ich**');
    expect(body).toContain('**damit**');
    expect(body).toContain('↳ AC:');
  });
});

// ---------------------------------------------------------------------------
// 6. Optional marker — the User-Stories section body carries a `>` blockquote
// ---------------------------------------------------------------------------

describe('prd-feature-template.md — User Stories optional-marker blockquote', () => {
  it('section body contains a `>` blockquote marking the layer as optional', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    const start = content.indexOf('## User Stories');
    const end = content.indexOf('## 3. Acceptance Criteria');
    const body = content.slice(start, end);
    expect(body).toContain('\n>');
  });
});

describe('prd-full-template.md — User Stories optional-marker blockquote', () => {
  it('section body contains a `>` blockquote marking the layer as optional', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    const start = content.indexOf('## User Stories');
    const end = content.indexOf('## 4. Solution & Scope');
    const body = content.slice(start, end);
    expect(body).toContain('\n>');
  });
});

// ---------------------------------------------------------------------------
// 7. Appetite → Wave-1 Q5 lock — guards the just-fixed renumber-ripple bug.
//    Before the User-Story toggle was inserted as Q4, the Phase-3 Appetite
//    label mapped from "Wave 1 Q4 scope answer". After the renumber, the
//    scope question moved to Q5 and the mapping must follow. This test
//    fails if the mapping reverts to Q4 (the bug) or any other index.
// ---------------------------------------------------------------------------

describe('mode-feature.md — Appetite label maps from Wave 1 Q5 (renumber-ripple lock)', () => {
  it('the **Appetite:** mapping line references Q5 and not Q4', () => {
    const content = readFileSync(MODE_FEATURE, 'utf8');
    const lines = content.split('\n');
    const appetiteLine = lines.find(
      (l) => l.includes('**Appetite:**') && l.includes('Map from'),
    );
    expect(appetiteLine).toBeDefined();
    expect(appetiteLine).toContain('Wave 1 Q5');
    expect(appetiteLine).not.toContain('Q4');
  });
});

// ---------------------------------------------------------------------------
// 8. AC-pointer per template — cross-contamination guard. The feature
//    template's stories must point at §3/§3.A; the full template's at
//    §5/§5.A. A copy-paste between templates would leak the wrong section
//    reference — this pins each to its own numbering and forbids the other.
// ---------------------------------------------------------------------------

describe('prd-feature-template.md — User Stories AC-pointers reference §3, never §5', () => {
  it('the section body contains §3 / §3.A and not §5', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    const start = content.indexOf('## User Stories');
    const end = content.indexOf('## 3. Acceptance');
    const body = content.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('§3 / §3.A');
    expect(body).not.toContain('§5');
  });
});

describe('prd-full-template.md — User Stories AC-pointers reference §5, never §3', () => {
  it('the section body contains §5 / §5.A and not §3', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    const start = content.indexOf('## User Stories');
    const end = content.indexOf('## 4. Solution');
    const body = content.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('§5 / §5.A');
    expect(body).not.toContain('§3');
  });
});

// ---------------------------------------------------------------------------
// 9. Un-numbered heading discipline — the inserted ## User Stories heading
//    must carry NO numeric prefix (so it does not renumber the surrounding
//    EARS/numbered sections), and must sit strictly between its two numbered
//    neighbours. Feature: §2 < US < §3. Full: §3 < US < §4.
// ---------------------------------------------------------------------------

describe('prd-feature-template.md — un-numbered ## User Stories between §2 and §3', () => {
  it('matches the bare un-numbered heading /^## User Stories$/m', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    expect(content).toMatch(/^## User Stories$/m);
  });

  it('## User Stories sits strictly between ## 2. Solution & Scope and ## 3. Acceptance Criteria', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    const s2 = content.indexOf('## 2. Solution & Scope');
    const us = content.indexOf('## User Stories');
    const s3 = content.indexOf('## 3. Acceptance Criteria');
    expect(s2).toBeGreaterThan(-1);
    expect(us).toBeGreaterThan(s2);
    expect(s3).toBeGreaterThan(us);
  });
});

describe('prd-full-template.md — un-numbered ## User Stories between §3 and §4', () => {
  it('matches the bare un-numbered heading /^## User Stories$/m', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    expect(content).toMatch(/^## User Stories$/m);
  });

  it('## User Stories sits strictly between ## 3. Target Audience & Personas and ## 4. Solution & Scope', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    const s3 = content.indexOf('## 3. Target Audience & Personas');
    const us = content.indexOf('## User Stories');
    const s4 = content.indexOf('## 4. Solution & Scope');
    expect(s3).toBeGreaterThan(-1);
    expect(us).toBeGreaterThan(s3);
    expect(s4).toBeGreaterThan(us);
  });
});

// ---------------------------------------------------------------------------
// 10. Single-line tri-clause story form — every line that opens with **Als**
//     must carry **möchte ich** AND **damit** on the SAME line. This catches
//     a dropped `damit` (benefit) clause that the toContain checks in §5
//     above would miss because they scan the whole section, not each line.
//     Both templates ship US-1 and US-2, so ≥2 such lines are required.
// ---------------------------------------------------------------------------

describe('prd-feature-template.md — every Als-story line is a complete Als/möchte/damit triple', () => {
  it('has ≥2 story lines, each with **möchte ich** and **damit**', () => {
    const content = readFileSync(FEATURE_TEMPLATE, 'utf8');
    const storyLines = content
      .split('\n')
      .filter((l) => l.startsWith('**Als**'));
    expect(storyLines.length).toBeGreaterThanOrEqual(2);
    const incomplete = storyLines.filter(
      (l) => !l.includes('**möchte ich**') || !l.includes('**damit**'),
    );
    expect(incomplete).toEqual([]);
  });
});

describe('prd-full-template.md — every Als-story line is a complete Als/möchte/damit triple', () => {
  it('has ≥2 story lines, each with **möchte ich** and **damit**', () => {
    const content = readFileSync(FULL_TEMPLATE, 'utf8');
    const storyLines = content
      .split('\n')
      .filter((l) => l.startsWith('**Als**'));
    expect(storyLines.length).toBeGreaterThanOrEqual(2);
    const incomplete = storyLines.filter(
      (l) => !l.includes('**möchte ich**') || !l.includes('**damit**'),
    );
    expect(incomplete).toEqual([]);
  });
});
