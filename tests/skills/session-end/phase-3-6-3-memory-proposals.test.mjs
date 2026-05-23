/**
 * tests/skills/session-end/phase-3-6-3-memory-proposals.test.mjs
 *
 * Vitest suite: session-end SKILL.md correctly wires Phase 3.6.3 Memory
 * Proposals Collection (#501, F2.1).
 *
 * Test surface: file-content assertions on skills/session-end/SKILL.md.
 * No production code is executed — only the Markdown spec is inspected.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SKILL_PATH = join(PROJECT_ROOT, 'skills', 'session-end', 'SKILL.md');

let content;
beforeAll(() => {
  content = readFileSync(SKILL_PATH, 'utf8');
});

// ---------------------------------------------------------------------------
// Case 1: The Phase 3.6.3 heading exists with the correct title
// ---------------------------------------------------------------------------
describe('session-end SKILL.md — Phase 3.6.3 heading', () => {
  it('contains the exact 3.6.3 heading with issue #501 and PRD F2.1', () => {
    expect(content).toContain(
      '### 3.6.3 Memory Proposals Collection (#501, F2.1)'
    );
  });
});

// ---------------------------------------------------------------------------
// Case 2: Ordering — 3.6.3 appears BEFORE 3.6.5 and BEFORE 3.6.7
// ---------------------------------------------------------------------------
describe('session-end SKILL.md — Phase 3.6.3 heading order', () => {
  it('3.6.3 appears before 3.6.5 (Auto-Dream) in the file', () => {
    const idx363 = content.indexOf('### 3.6.3 Memory Proposals Collection');
    const idx365 = content.indexOf('### 3.6.5 Auto-Dream Dispatch');
    expect(idx363).toBeGreaterThan(0);
    expect(idx365).toBeGreaterThan(idx363);
  });

  it('3.6.3 appears before 3.6.7 (Auto-Dialectic) in the file', () => {
    const idx363 = content.indexOf('### 3.6.3 Memory Proposals Collection');
    const idx367 = content.indexOf('### 3.6.7 Auto-Dialectic Dispatch');
    expect(idx363).toBeGreaterThan(0);
    expect(idx367).toBeGreaterThan(idx363);
  });
});

// ---------------------------------------------------------------------------
// Case 3: Section references the required module files
// ---------------------------------------------------------------------------
describe('session-end SKILL.md — Phase 3.6.3 module references', () => {
  it('references scripts/lib/memory-proposals/collector.mjs', () => {
    expect(content).toContain('scripts/lib/memory-proposals/collector.mjs');
  });

  it('references scripts/lib/memory-proposals/sink.mjs', () => {
    expect(content).toContain('scripts/lib/memory-proposals/sink.mjs');
  });

  it('references schema and store modules via brace-expansion shorthand', () => {
    expect(content).toContain('scripts/lib/memory-proposals/{schema,store,collector,sink}.mjs');
  });
});

// ---------------------------------------------------------------------------
// Case 4: Section references issue #501
// ---------------------------------------------------------------------------
describe('session-end SKILL.md — Phase 3.6.3 issue reference', () => {
  it('references issue #501', () => {
    expect(content).toContain('#501');
  });
});

// ---------------------------------------------------------------------------
// Case 5: Sub-File Reference table contains Phase 3.6.3 inline row
// ---------------------------------------------------------------------------
describe('session-end SKILL.md — Sub-File Reference table row', () => {
  it('Sub-File Reference table contains (inline) Phase 3.6.3 row', () => {
    expect(content).toContain('(inline) Phase 3.6.3');
  });

  it('Sub-File Reference table row for 3.6.3 mentions Memory-Proposals Collection', () => {
    expect(content).toContain('Memory-Proposals Collection');
  });
});

// ---------------------------------------------------------------------------
// Case 6: Key API calls are documented — collectProposals, writeApproved,
//          clearProposalsJsonl are mentioned (the four contract functions)
// ---------------------------------------------------------------------------
describe('session-end SKILL.md — Phase 3.6.3 API function references', () => {
  it('documents collectProposals call', () => {
    expect(content).toContain('collectProposals');
  });

  it('documents writeApproved call', () => {
    expect(content).toContain('writeApproved');
  });

  it('documents clearProposalsJsonl call', () => {
    expect(content).toContain('clearProposalsJsonl');
  });

  it('documents archiveRejected call', () => {
    expect(content).toContain('archiveRejected');
  });
});

// ---------------------------------------------------------------------------
// Case 7: PRD reference F2.1 is present in the section
// ---------------------------------------------------------------------------
describe('session-end SKILL.md — Phase 3.6.3 PRD reference', () => {
  it('contains PRD F2.1 reference', () => {
    expect(content).toContain('F2.1');
  });

  it('references the PRD document path', () => {
    expect(content).toContain('docs/prd/2026-05-21-learning-memory-modernization.md');
  });
});
