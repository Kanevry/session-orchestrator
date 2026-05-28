/**
 * tests/skills/brainstorm/ears-ac.test.mjs
 *
 * Structural / content tests verifying that the EARS AC section added by
 * issue #487 W2 landed correctly in skills/brainstorm/SKILL.md.
 *
 * Tests verify:
 *   1. The new section header is present
 *   2. All 5 canonical EARS pattern names are present
 *   3. The section is correctly positioned between Trade-offs Accepted and Open Questions
 *   4. The section heading carries the [optional] label
 *   5. No existing sections were inadvertently removed (+1 ## header vs pre-W2)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { EARS_PATTERNS } from '../../_shared/ears-patterns.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SKILL_PATH = join(REPO_ROOT, 'skills', 'brainstorm', 'SKILL.md');

// ---------------------------------------------------------------------------
// Section header presence
// ---------------------------------------------------------------------------

describe('brainstorm/SKILL.md — EARS AC section header', () => {
  it('contains ## Acceptance Criteria (EARS) [optional] section header', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('## Acceptance Criteria (EARS) [optional]');
  });

  it('section heading carries the [optional] label (case-sensitive)', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    // Must contain the exact string with lower-case brackets as specified
    expect(content).toContain('[optional]');
  });
});

// ---------------------------------------------------------------------------
// Canonical EARS pattern names
// ---------------------------------------------------------------------------

describe('brainstorm/SKILL.md — EARS canonical pattern names', () => {
  it.each(EARS_PATTERNS)('contains the %s pattern name', (pattern) => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain(pattern);
  });
});

// ---------------------------------------------------------------------------
// Section ordering: EARS AC is between Trade-offs Accepted and Open Questions
// ---------------------------------------------------------------------------

describe('brainstorm/SKILL.md — EARS section ordering', () => {
  it('EARS section appears after ## Trade-offs Accepted', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    const tradeOffsIdx = content.indexOf('## Trade-offs Accepted');
    const earsIdx = content.indexOf('## Acceptance Criteria (EARS) [optional]');
    expect(tradeOffsIdx).toBeGreaterThan(-1);
    expect(earsIdx).toBeGreaterThan(-1);
    expect(earsIdx).toBeGreaterThan(tradeOffsIdx);
  });

  it('EARS section appears before ## Open Questions', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    const earsIdx = content.indexOf('## Acceptance Criteria (EARS) [optional]');
    const openQIdx = content.indexOf('## Open Questions');
    expect(earsIdx).toBeGreaterThan(-1);
    expect(openQIdx).toBeGreaterThan(-1);
    expect(earsIdx).toBeLessThan(openQIdx);
  });
});

// ---------------------------------------------------------------------------
// No existing sections removed: ## header count must be pre-W2 count + 1
//
// Pre-W2 headers in SKILL.md Phase 4 spec template:
//   Problem, Chosen Approach, Trade-offs Accepted, Open Questions,
//   Out of Scope, Hand-off  = 6 ## headers in the template block
//   + the Phase headers (## Phase 0..6), ## Anti-Patterns, ## See Also,
//     ## Soul Reference, ## When to use, ## When NOT to use,
//     ## Phase 4 header itself already counted above
// We use floor/ceiling per test-quality.md Dynamic Artifact Counts rule:
//   current count is verified to be ≥ pre-W2 floor (the new section is +1)
// ---------------------------------------------------------------------------

describe('brainstorm/SKILL.md — section count (no accidental removals)', () => {
  it('has at least 20 ## level headers (floor guards against accidental removal)', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    const headers = content.match(/^## /gm) ?? [];
    // Pre-W2 the file had many ## headers; with the new EARS section it is +1.
    // Floor of 20 catches any accidental large-scale removal while tolerating growth.
    expect(headers.length).toBeGreaterThanOrEqual(20);
  });

  it('has at most 80 ## level headers (ceiling guards against runaway duplication)', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    const headers = content.match(/^## /gm) ?? [];
    expect(headers.length).toBeLessThanOrEqual(80);
  });
});
