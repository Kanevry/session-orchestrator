/**
 * tests/skills/plan/user-stories-edge-cases.test.mjs
 *
 * Edge-case, boundary, and seam-collision hardening for the optional
 * User-Story layer (issue #659 W2). Complements the structural happy-path
 * checks in tests/skills/plan/user-stories-section.test.mjs.
 *
 * These tests catch the high-risk regressions that the structural checks
 * would miss:
 *   - the write-executable-plan EARS seam must NOT collide with the new
 *     un-numbered ## User Stories heading (the #1 risk for this feature),
 *   - the SKILL.md Phase 6.1 toggle-off fallback must preserve the three
 *     mode-derivation bullets byte-for-byte (status quo),
 *   - the SKILL.md story-present branch keys on a *populated* ## User
 *     Stories section,
 *   - the prd-reviewer gate is correctly count-bumped to 7 criteria, gated,
 *     and explicitly does NOT introduce an INVEST gate,
 *   - both mode files carry the Q4 toggle and mode-feature.md bumped its
 *     question count.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEP_SKILL = join(REPO_ROOT, 'skills', 'write-executable-plan', 'SKILL.md');
const WEP_TEMPLATE = join(REPO_ROOT, 'skills', 'write-executable-plan', 'plan-template.md');
const PLAN_SKILL = join(REPO_ROOT, 'skills', 'plan', 'SKILL.md');
const REVIEWER_PROMPT = join(REPO_ROOT, 'skills', 'plan', 'prd-reviewer-prompt.md');
const MODE_FEATURE = join(REPO_ROOT, 'skills', 'plan', 'mode-feature.md');
const MODE_NEW = join(REPO_ROOT, 'skills', 'plan', 'mode-new.md');

// Scope to the `**EARS seam:**` paragraph: from the marker to the next blank
// line (paragraph break). This isolates the seam trigger prose so the
// non-collision assertion does not read the whole file.
function earsSeamParagraph(content) {
  const start = content.indexOf('**EARS seam:**');
  const rest = content.slice(start);
  const end = rest.indexOf('\n\n');
  return end > -1 ? rest.slice(0, end) : rest;
}

// ---------------------------------------------------------------------------
// 7. Seam non-collision — the EARS seam paragraph must NOT match ## User Stories
// ---------------------------------------------------------------------------

describe('write-executable-plan/SKILL.md — EARS seam does not collide with User Stories', () => {
  it('the **EARS seam:** paragraph references EARS but NOT User Stories', () => {
    const content = readFileSync(WEP_SKILL, 'utf8');
    const paragraph = earsSeamParagraph(content);
    expect(paragraph).toContain('**EARS seam:**');
    expect(paragraph).toContain('Acceptance Criteria (EARS)');
    expect(paragraph).not.toContain('User Stories');
  });
});

describe('write-executable-plan/plan-template.md — EARS seam does not collide with User Stories', () => {
  it('the **EARS seam:** paragraph references EARS but NOT User Stories', () => {
    const content = readFileSync(WEP_TEMPLATE, 'utf8');
    const paragraph = earsSeamParagraph(content);
    expect(paragraph).toContain('**EARS seam:**');
    expect(paragraph).toContain('Acceptance Criteria (EARS)');
    expect(paragraph).not.toContain('User Stories');
  });
});

// ---------------------------------------------------------------------------
// 8. Status-quo fallback — Phase 6.1 toggle-off path preserves the three
//    mode-derivation bullets verbatim
// ---------------------------------------------------------------------------

describe('plan/SKILL.md — Phase 6.1 toggle-off fallback preserves mode bullets', () => {
  it('the 6.1 Otherwise branch still derives from all three /plan modes', () => {
    const content = readFileSync(PLAN_SKILL, 'utf8');
    const start = content.indexOf('### 6.1 Derive Issue Structure');
    const end = content.indexOf('### 6.2 Auto-Prioritize');
    const body = content.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('Otherwise');
    expect(body).toContain('`/plan new`');
    expect(body).toContain('`/plan feature`');
    expect(body).toContain('`/plan retro`');
  });
});

// ---------------------------------------------------------------------------
// 9. Story-present branch — Phase 6.1 keys on a *populated* ## User Stories section
// ---------------------------------------------------------------------------

describe('plan/SKILL.md — Phase 6.1 story-present branch', () => {
  it('the 6.1 section gates the story branch on a populated ## User Stories section', () => {
    const content = readFileSync(PLAN_SKILL, 'utf8');
    const start = content.indexOf('### 6.1 Derive Issue Structure');
    const end = content.indexOf('### 6.2 Auto-Prioritize');
    const body = content.slice(start, end);
    expect(body).toContain('populated');
    expect(body).toContain('## User Stories');
  });
});

// ---------------------------------------------------------------------------
// 10. Reviewer gate — 7 criteria, gated criterion #7, table row, no INVEST gate
// ---------------------------------------------------------------------------

describe('plan/prd-reviewer-prompt.md — User Stories reviewer gate', () => {
  it('contains the ### 7. User Stories gated criterion header', () => {
    const content = readFileSync(REVIEWER_PROMPT, 'utf8');
    expect(content).toContain('### 7. User Stories');
  });

  it('criterion #7 carries an explicit SKIP keyed on the absent ## User Stories section', () => {
    const content = readFileSync(REVIEWER_PROMPT, 'utf8');
    const start = content.indexOf('### 7. User Stories');
    const end = content.indexOf('## Output Format');
    const body = content.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('SKIP if:');
    expect(body).toContain('no `## User Stories` section');
  });

  it('contains the | User Stories | output-table row', () => {
    const content = readFileSync(REVIEWER_PROMPT, 'utf8');
    expect(content).toContain('| User Stories |');
  });

  it('was count-bumped to "7 criteria" (twice) and introduces no new "6 criteria"', () => {
    const content = readFileSync(REVIEWER_PROMPT, 'utf8');
    const sevenCount = content.split('7 criteria').length - 1;
    expect(sevenCount).toBe(2);
    expect(content).not.toContain('6 criteria');
  });

  it('criterion #7 explicitly does NOT introduce an INVEST gate', () => {
    const content = readFileSync(REVIEWER_PROMPT, 'utf8');
    const start = content.indexOf('### 7. User Stories');
    const end = content.indexOf('## Output Format');
    const body = content.slice(start, end);
    expect(body).toContain('Do NOT apply INVEST');
  });
});

describe('plan/SKILL.md — reviewer criterion count bumped to 7', () => {
  it('Phase 5.1 says the reviewer checks 7 criteria (not 6)', () => {
    const content = readFileSync(PLAN_SKILL, 'utf8');
    expect(content).toContain('7 criteria');
    expect(content).not.toContain('6 criteria');
  });
});

// ---------------------------------------------------------------------------
// 11. Mode toggle — present in both mode files; mode-feature.md count bumped
// ---------------------------------------------------------------------------

describe('plan mode files — User-Story toggle question present', () => {
  it('mode-feature.md carries the User-Story-Schicht toggle question', () => {
    const content = readFileSync(MODE_FEATURE, 'utf8');
    expect(content).toContain('User-Story-Schicht für dieses Feature erzeugen?');
  });

  it('mode-new.md carries the User-Story-Schicht toggle question', () => {
    const content = readFileSync(MODE_NEW, 'utf8');
    expect(content).toContain('User-Story-Schicht für dieses Feature erzeugen?');
  });
});

describe('plan/mode-feature.md — Wave 1 question count bumped for the toggle', () => {
  it('Wave 1 header says (6 questions), not (5 questions)', () => {
    const content = readFileSync(MODE_FEATURE, 'utf8');
    expect(content).toContain('(6 questions)');
    expect(content).not.toContain('(5 questions)');
  });

  it('Wave 1 split is (3+3 split), not (3+2 split)', () => {
    const content = readFileSync(MODE_FEATURE, 'utf8');
    expect(content).toContain('(3+3 split)');
    expect(content).not.toContain('(3+2 split)');
  });
});

// Slice the Wave-1 question block: from the `### Wave 1` heading to the next
// `### Wave 2` heading. This isolates the six numbered questions from the
// Phase-2/3 numbered lists that appear later in the file.
function wave1Block(content) {
  const start = content.indexOf('### Wave 1');
  const end = content.indexOf('### Wave 2', start);
  return content.slice(start, end);
}

// ---------------------------------------------------------------------------
// 12. Q-number contiguity — the Wave-1 question block in BOTH mode files must
//     enumerate questions [1,2,3,4,5,6] with no gap and no duplicate. The
//     User-Story toggle was inserted as Q4 and the scope/dependency questions
//     renumbered to Q5/Q6; a renumber slip would show up here as a gap or a
//     repeated index.
// ---------------------------------------------------------------------------

describe('plan mode files — Wave 1 questions are contiguously numbered 1..6', () => {
  it('mode-feature.md Wave 1 block enumerates exactly [1,2,3,4,5,6]', () => {
    const content = readFileSync(MODE_FEATURE, 'utf8');
    const block = wave1Block(content);
    const nums = [...block.matchAll(/^(\d+)\.\s+\*\*/gm)].map((m) => Number(m[1]));
    expect(nums).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('mode-new.md Wave 1 block enumerates exactly [1,2,3,4,5,6]', () => {
    const content = readFileSync(MODE_NEW, 'utf8');
    const block = wave1Block(content);
    const nums = [...block.matchAll(/^(\d+)\.\s+\*\*/gm)].map((m) => Number(m[1]));
    expect(nums).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

// ---------------------------------------------------------------------------
// 13. Cross-file 7-criteria coherence — SKILL.md and the reviewer prompt must
//     agree that the reviewer checks 7 criteria, and the reviewer prompt must
//     actually enumerate exactly 7 criterion headers. Catches SKILL ↔ reviewer
//     drift (e.g., SKILL bumped to 7 but the reviewer left at 6, or vice
//     versa).
// ---------------------------------------------------------------------------

describe('SKILL.md ↔ prd-reviewer-prompt.md — 7-criteria coherence', () => {
  it('SKILL.md states the reviewer checks 7 criteria', () => {
    const content = readFileSync(PLAN_SKILL, 'utf8');
    expect(content).toContain('7 criteria');
  });

  it('prd-reviewer-prompt.md states 7 criteria', () => {
    const content = readFileSync(REVIEWER_PROMPT, 'utf8');
    expect(content).toContain('7 criteria');
  });

  it('prd-reviewer-prompt.md enumerates exactly 7 ### N. criterion headers', () => {
    const content = readFileSync(REVIEWER_PROMPT, 'utf8');
    const headers = [...content.matchAll(/^### (\d+)\.\s/gm)].map((m) => Number(m[1]));
    expect(headers).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

// ---------------------------------------------------------------------------
// 14. Reviewer output-table integrity — the Output Format table must carry
//     exactly 7 criterion data rows (excluding the `| Criterion |` header and
//     the `|---|` separator), and the `| User Stories |` row must offer SKIP
//     (i.e., the gated PASS/FAIL/SKIP verdict). Every data row carries a
//     PASS verdict token; the header row does not, and the separator does not
//     start with `| ` — so matching `| ... PASS` isolates the data rows.
// ---------------------------------------------------------------------------

describe('prd-reviewer-prompt.md — Output Format table has 7 criterion data rows', () => {
  it('exactly 7 table rows carry a PASS verdict (header + separator excluded)', () => {
    const content = readFileSync(REVIEWER_PROMPT, 'utf8');
    const dataRows = content
      .split('\n')
      .filter((l) => /^\| /.test(l) && l.includes('PASS'));
    expect(dataRows).toHaveLength(7);
  });

  it('the | User Stories | row offers SKIP (PASS/FAIL/SKIP gated verdict)', () => {
    const content = readFileSync(REVIEWER_PROMPT, 'utf8');
    const userStoryRow = content
      .split('\n')
      .find((l) => l.startsWith('| User Stories |'));
    expect(userStoryRow).toBeDefined();
    expect(userStoryRow).toContain('PASS/FAIL/SKIP');
  });
});
