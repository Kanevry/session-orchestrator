/**
 * tests/skills/plan/prd-commit-gate.test.mjs
 *
 * Structural / content tests verifying that the PRD Commit HARD-GATE
 * (issue #784) landed correctly in SKILL.md, mode-feature.md, and
 * mode-retro.md.
 *
 * These tests do NOT execute any skill logic — they verify that the
 * Markdown source files contain the expected section headers, HARD-GATE
 * markers, and cross-references, in the correct relative order.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SKILL = join(REPO_ROOT, 'skills', 'plan', 'SKILL.md');
const MODE_FEATURE = join(REPO_ROOT, 'skills', 'plan', 'mode-feature.md');
const MODE_RETRO = join(REPO_ROOT, 'skills', 'plan', 'mode-retro.md');

// ---------------------------------------------------------------------------
// SKILL.md — Phase 5.5 PRD Commit Gate exists, is a HARD-GATE, and sits
// between Phase 5 (PRD Review) and Phase 6 (Issue Creation)
// ---------------------------------------------------------------------------

describe('plan/SKILL.md — Phase 5.5 PRD Commit Gate', () => {
  const content = readFileSync(SKILL, 'utf8');

  it('contains the Phase 5.5 PRD Commit Gate header', () => {
    expect(content).toContain('## Phase 5.5: PRD Commit Gate (all modes)');
  });

  it('contains a <HARD-GATE> block', () => {
    expect(content).toContain('<HARD-GATE>');
    expect(content).toContain('</HARD-GATE>');
  });

  it('Phase 5.5 sits after Phase 5 (User Review Gate) and before Phase 6 (Issue Creation)', () => {
    const idxPhase5Review = content.indexOf('### 5.3 User Review Gate');
    const idxPhase55 = content.indexOf('## Phase 5.5: PRD Commit Gate');
    const idxPhase6 = content.indexOf('## Phase 6: Issue Creation (all modes)');
    expect(idxPhase5Review).toBeGreaterThan(-1);
    expect(idxPhase55).toBeGreaterThan(-1);
    expect(idxPhase6).toBeGreaterThan(-1);
    expect(idxPhase55).toBeGreaterThan(idxPhase5Review);
    expect(idxPhase6).toBeGreaterThan(idxPhase55);
  });

  it('the HARD-GATE block appears inside the Phase 5.5 section, before Phase 6', () => {
    const idxPhase55 = content.indexOf('## Phase 5.5: PRD Commit Gate');
    const idxHardGate = content.indexOf('<HARD-GATE>', idxPhase55);
    const idxPhase6 = content.indexOf('## Phase 6: Issue Creation (all modes)');
    expect(idxHardGate).toBeGreaterThan(idxPhase55);
    expect(idxHardGate).toBeLessThan(idxPhase6);
  });

  it('the HARD-GATE text mandates blocking Phase 6 until commit', () => {
    const idxPhase55 = content.indexOf('## Phase 5.5: PRD Commit Gate');
    const idxHardGate = content.indexOf('<HARD-GATE>', idxPhase55);
    const idxHardGateEnd = content.indexOf('</HARD-GATE>', idxPhase55);
    const gateBody = content.slice(idxHardGate, idxHardGateEnd);
    expect(gateBody).toContain('Do NOT proceed to Phase 6');
    expect(gateBody).toContain('There is no bypass.');
  });

  it('Phase 5.5 body includes the verification commands (git status --porcelain and git ls-files)', () => {
    const idxPhase55 = content.indexOf('## Phase 5.5: PRD Commit Gate');
    const idxPhase6 = content.indexOf('## Phase 6: Issue Creation (all modes)');
    const phase55Body = content.slice(idxPhase55, idxPhase6);
    expect(phase55Body).toContain('git status --porcelain');
    expect(phase55Body).toContain('git ls-files');
  });

  it('Phase 5.5 references the retro mode explicitly (gate applies to all modes reaching Phase 6)', () => {
    const idxPhase55 = content.indexOf('## Phase 5.5: PRD Commit Gate');
    const idxPhase6 = content.indexOf('## Phase 6: Issue Creation (all modes)');
    const phase55Body = content.slice(idxPhase55, idxPhase6);
    expect(phase55Body).toContain('/plan retro');
  });
});

// ---------------------------------------------------------------------------
// SKILL.md — Phase 6.6 Epic Backlink Commit exists after 6.5 Final Report,
// and existing 6.1-6.5 subsections are untouched (regression guard)
// ---------------------------------------------------------------------------

describe('plan/SKILL.md — Phase 6.6 Epic Backlink Commit', () => {
  const content = readFileSync(SKILL, 'utf8');

  it('contains the 6.6 Epic Backlink Commit header', () => {
    expect(content).toContain('### 6.6 Epic Backlink Commit (PRD Update)');
  });

  it('6.6 sits after 6.5 Final Report', () => {
    const idx65 = content.indexOf('### 6.5 Final Report');
    const idx66 = content.indexOf('### 6.6 Epic Backlink Commit (PRD Update)');
    expect(idx65).toBeGreaterThan(-1);
    expect(idx66).toBeGreaterThan(idx65);
  });

  it('existing Phase 6 subsections 6.1-6.4 are still present (no renumbering regression)', () => {
    expect(content).toContain('### 6.1 Derive Issue Structure');
    expect(content).toContain('### 6.2 Auto-Prioritize');
    expect(content).toContain('### 6.3 User Review');
    expect(content).toContain('### 6.4 Create Issues');
  });

  it('6.6 instructs a separate follow-up commit, not an amend', () => {
    const idx66 = content.indexOf('### 6.6 Epic Backlink Commit (PRD Update)');
    const body = content.slice(idx66, idx66 + 1200);
    expect(body).toContain('never amend');
  });
});

// ---------------------------------------------------------------------------
// SKILL.md — Critical Rules bullet
// ---------------------------------------------------------------------------

describe('plan/SKILL.md — Critical Rules PRD-commit bullet', () => {
  it('contains a bullet mandating commit before issue creation', () => {
    const content = readFileSync(SKILL, 'utf8');
    const idxCriticalRules = content.indexOf('## Critical Rules');
    expect(idxCriticalRules).toBeGreaterThan(-1);
    const body = content.slice(idxCriticalRules);
    expect(body).toContain('ALWAYS commit the PRD before creating issues');
    expect(body).toContain('Phase 5.5');
  });
});

// ---------------------------------------------------------------------------
// mode-feature.md — reference to the PRD Commit Gate between Phase 2 and
// Phase 3
// ---------------------------------------------------------------------------

describe('mode-feature.md — PRD Commit Gate reference', () => {
  const content = readFileSync(MODE_FEATURE, 'utf8');

  it('references the PRD Commit Gate and SKILL.md Phase 5.5', () => {
    expect(content).toContain('PRD Commit Gate');
    expect(content).toContain('Phase 5.5');
  });

  it('the reference sits between Phase 2 and Phase 3', () => {
    const idxPhase2 = content.indexOf('## Phase 2: Feature PRD Generation');
    const idxReference = content.indexOf('PRD Commit Gate');
    const idxPhase3 = content.indexOf('## Phase 3: Issue Creation');
    expect(idxPhase2).toBeGreaterThan(-1);
    expect(idxReference).toBeGreaterThan(idxPhase2);
    expect(idxPhase3).toBeGreaterThan(idxReference);
  });

  it('references the Epic Backlink Commit (SKILL.md § 6.6) inside Create Issues', () => {
    const idxCreateIssues = content.indexOf('### Create Issues');
    expect(idxCreateIssues).toBeGreaterThan(-1);
    const body = content.slice(idxCreateIssues);
    expect(body).toContain('Epic Backlink Commit');
    expect(body).toContain('6.6');
  });
});

// ---------------------------------------------------------------------------
// mode-retro.md — reference to the PRD Commit Gate between the retro
// document save (3.1) and improvement issue creation (3.2)
// ---------------------------------------------------------------------------

describe('mode-retro.md — PRD Commit Gate reference', () => {
  const content = readFileSync(MODE_RETRO, 'utf8');

  it('references the PRD Commit Gate and SKILL.md Phase 5.5', () => {
    expect(content).toContain('PRD Commit Gate');
    expect(content).toContain('Phase 5.5');
  });

  it('the reference sits between 3.1 (Retro Document) and 3.2 (Improvement Issues)', () => {
    const idx31 = content.indexOf('### 3.1 Retro Document');
    const idxReference = content.indexOf('PRD Commit Gate');
    const idx32 = content.indexOf('### 3.2 Improvement Issues');
    expect(idx31).toBeGreaterThan(-1);
    expect(idxReference).toBeGreaterThan(idx31);
    expect(idx32).toBeGreaterThan(idxReference);
  });
});
