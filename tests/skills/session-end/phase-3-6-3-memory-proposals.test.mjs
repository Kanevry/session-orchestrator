/**
 * tests/skills/session-end/phase-3-6-3-memory-proposals.test.mjs
 *
 * Vitest suite: the session-end Phase 3.6.3 Memory Proposals Collection
 * (#501, F2.1) procedure is correctly wired.
 *
 * Since the #724 session-end diet, the six Phase 3.6.x tail procedures live in
 * the progressive-disclosure sub-file `phase-3-6-tail.md`, loaded on demand by
 * the SKILL.md skip-plan dispatcher. The procedure-body assertions therefore
 * target the sub-file; the SKILL.md assertions target the dispatcher wiring +
 * Sub-File Reference table.
 *
 * Test surface: file-content assertions only — no production code executed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SKILL_PATH = join(PROJECT_ROOT, 'skills', 'session-end', 'SKILL.md');
const TAIL_PATH = join(PROJECT_ROOT, 'skills', 'session-end', 'phase-3-6-tail.md');

let skill;
let tail;
beforeAll(() => {
  skill = readFileSync(SKILL_PATH, 'utf8');
  tail = readFileSync(TAIL_PATH, 'utf8');
});

// ---------------------------------------------------------------------------
// Case 1: The Phase 3.6.3 heading lives in the tail sub-file with its title
// ---------------------------------------------------------------------------
describe('phase-3-6-tail.md — Phase 3.6.3 heading', () => {
  it('contains the exact 3.6.3 heading with issue #501 and PRD F2.1', () => {
    expect(tail).toContain('### 3.6.3 Memory Proposals Collection (#501, F2.1)');
  });
});

// ---------------------------------------------------------------------------
// Case 2: Ordering — 3.6.3 appears BEFORE 3.6.5 and BEFORE 3.6.7 in the sub-file
// ---------------------------------------------------------------------------
describe('phase-3-6-tail.md — Phase 3.6.3 heading order', () => {
  it('3.6.3 appears before 3.6.5 (Auto-Dream) in the sub-file', () => {
    const idx363 = tail.indexOf('### 3.6.3 Memory Proposals Collection');
    const idx365 = tail.indexOf('### 3.6.5 Auto-Dream Dispatch');
    expect(idx363).toBeGreaterThan(0);
    expect(idx365).toBeGreaterThan(idx363);
  });

  it('3.6.3 appears before 3.6.7 (Auto-Dialectic) in the sub-file', () => {
    const idx363 = tail.indexOf('### 3.6.3 Memory Proposals Collection');
    const idx367 = tail.indexOf('### 3.6.7 Auto-Dialectic Dispatch');
    expect(idx363).toBeGreaterThan(0);
    expect(idx367).toBeGreaterThan(idx363);
  });
});

// ---------------------------------------------------------------------------
// Case 3: Section references the required module files
// ---------------------------------------------------------------------------
describe('phase-3-6-tail.md — Phase 3.6.3 module references', () => {
  it('references scripts/lib/memory-proposals/collector.mjs', () => {
    expect(tail).toContain('scripts/lib/memory-proposals/collector.mjs');
  });

  it('references scripts/lib/memory-proposals/sink.mjs', () => {
    expect(tail).toContain('scripts/lib/memory-proposals/sink.mjs');
  });

  it('references schema and store modules via brace-expansion shorthand', () => {
    expect(tail).toContain('scripts/lib/memory-proposals/{schema,store,collector,sink}.mjs');
  });
});

// ---------------------------------------------------------------------------
// Case 4: Section references issue #501
// ---------------------------------------------------------------------------
describe('phase-3-6-tail.md — Phase 3.6.3 issue reference', () => {
  it('references issue #501', () => {
    expect(tail).toContain('#501');
  });
});

// ---------------------------------------------------------------------------
// Case 5: SKILL.md Sub-File Reference table points at the tail sub-file
// ---------------------------------------------------------------------------
describe('session-end SKILL.md — Sub-File Reference table row', () => {
  it('Sub-File Reference table references phase-3-6-tail.md', () => {
    expect(skill).toContain('`phase-3-6-tail.md`');
  });

  it('the table row still names Memory-Proposals Collection', () => {
    expect(skill).toContain('Memory-Proposals Collection');
  });

  it('the old (inline) Phase 3.6.3 row is gone', () => {
    expect(skill).not.toContain('(inline) Phase 3.6.3');
  });
});

// ---------------------------------------------------------------------------
// Case 6: Key API calls are documented — collectProposals, writeApproved,
//          clearProposalsJsonl, archiveRejected (the four contract functions)
// ---------------------------------------------------------------------------
describe('phase-3-6-tail.md — Phase 3.6.3 API function references', () => {
  it('documents collectProposals call', () => {
    expect(tail).toContain('collectProposals');
  });

  it('documents writeApproved call', () => {
    expect(tail).toContain('writeApproved');
  });

  it('documents clearProposalsJsonl call', () => {
    expect(tail).toContain('clearProposalsJsonl');
  });

  it('documents archiveRejected call', () => {
    expect(tail).toContain('archiveRejected');
  });
});

// ---------------------------------------------------------------------------
// Case 7: PRD reference F2.1 is present in the section
// ---------------------------------------------------------------------------
describe('phase-3-6-tail.md — Phase 3.6.3 PRD reference', () => {
  it('contains PRD F2.1 reference', () => {
    expect(tail).toContain('F2.1');
  });

  it('references the memory-proposals spec source (issue #501)', () => {
    // The standalone PRD doc (docs/prd/2026-05-21-learning-memory-modernization.md)
    // was moved to the vault for privacy (#462) and is no longer in-repo; the
    // canonical in-repo spec reference is tracking issue #501. The procedure points there.
    expect(tail).toContain('#501');
  });
});
