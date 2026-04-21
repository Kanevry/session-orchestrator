/**
 * tests/skills/docs-orchestrator-lifecycle.test.mjs
 *
 * Regression-guard tests for the docs-orchestrator lifecycle contract.
 * These are documentation-contract tests: they assert that key prose
 * invariants hold in the skill files so future refactors don't silently
 * break the Phase 2.5 → session-plan → session-end handoff chain.
 *
 * Strategy: read live skill files and assert on exact strings / regexes.
 * No mocks, no subprocesses, no mutation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

function readSkill(relativePath) {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// describe('Phase 2.5 — session-start', ...)
// ---------------------------------------------------------------------------

describe('Phase 2.5 — session-start', () => {
  const sessionStart = readSkill('skills/session-start/SKILL.md');

  it('has the Phase 2.5: Docs Planning heading', () => {
    expect(sessionStart).toMatch(/## Phase 2\.5: Docs Planning/);
  });

  it('preserves the opt-in gate line', () => {
    expect(sessionStart).toContain(
      '> Skip this phase if `docs-orchestrator.enabled` config is not `true` (default: `false`).',
    );
  });

  it('emits the "### Docs Planning Result (Phase 2.5)" parse-contract heading', () => {
    // session-plan Step 1.8 depends on this exact heading string.
    expect(sessionStart).toContain('### Docs Planning Result (Phase 2.5)');
  });

  it('references audience-mapping.md authoritative source', () => {
    expect(sessionStart).toContain('skills/docs-orchestrator/audience-mapping.md');
  });
});

// ---------------------------------------------------------------------------
// describe('Phase 3.2 — session-end', ...)
// ---------------------------------------------------------------------------

describe('Phase 3.2 — session-end', () => {
  const sessionEnd = readSkill('skills/session-end/SKILL.md');

  // Extract the Phase 3.2 section for targeted assertions.
  // The section starts at "### 3.2 Docs Verification" and ends before "### 3.2a".
  const phase32Start = sessionEnd.indexOf('### 3.2 Docs Verification');
  const phase32End = sessionEnd.indexOf('### 3.2a');
  const phase32 = sessionEnd.slice(phase32Start, phase32End);

  it('has the Docs Verification heading', () => {
    expect(sessionEnd).toMatch(/### 3\.2 Docs Verification/);
  });

  it('documents the ok|partial|gap outcome taxonomy', () => {
    expect(phase32).toContain('ok');
    expect(phase32).toContain('partial');
    expect(phase32).toContain('gap');
  });

  it('documents all three mode branches', () => {
    expect(phase32).toContain('warn');
    expect(phase32).toContain('strict');
    expect(phase32).toContain('off');
  });

  it('reads docs-tasks from STATE.md frontmatter', () => {
    // The section must identify STATE.md as the single source of truth for docs-tasks.
    expect(phase32).toContain('STATE.md');
    expect(phase32).toContain('docs-tasks');
  });
});

// ---------------------------------------------------------------------------
// describe('docs-orchestrator/SKILL.md', ...)
// ---------------------------------------------------------------------------

describe('docs-orchestrator/SKILL.md', () => {
  const docsOrchestrator = readSkill('skills/docs-orchestrator/SKILL.md');

  it('has the all-sources-absent hard guard', () => {
    // From the W2 inline fix — docs-writer must abort when all source blocks are absent.
    expect(docsOrchestrator).toContain(
      'refusing to produce source-less documentation',
    );
  });

  it('lists the canonical four source types', () => {
    expect(docsOrchestrator).toContain('diff');
    expect(docsOrchestrator).toContain('git-log');
    expect(docsOrchestrator).toContain('session-memory');
    expect(docsOrchestrator).toContain('affected-files');
  });
});

// ---------------------------------------------------------------------------
// describe('audience-mapping.md', ...)
// ---------------------------------------------------------------------------

describe('audience-mapping.md', () => {
  const audienceMapping = readSkill('skills/docs-orchestrator/audience-mapping.md');

  it('documents all three canonical audiences', () => {
    expect(audienceMapping).toContain('user');
    expect(audienceMapping).toContain('dev');
    expect(audienceMapping).toContain('vault');
  });

  it('has non-overlap entries for all 4 sibling skills', () => {
    // The Non-Overlap with Sibling Skills table must reference all four siblings.
    expect(audienceMapping).toContain('vault-mirror');
    expect(audienceMapping).toContain('daily');
    expect(audienceMapping).toContain('claude-md-drift-check');
    expect(audienceMapping).toContain('vault-sync');
  });
});

// ---------------------------------------------------------------------------
// describe('session-plan/SKILL.md', ...)
// ---------------------------------------------------------------------------

describe('session-plan/SKILL.md', () => {
  const sessionPlan = readSkill('skills/session-plan/SKILL.md');

  it('specifies the Docs Tasks (machine-readable) emission block', () => {
    expect(sessionPlan).toMatch(/### Docs Tasks \(machine-readable\)/);
  });

  it('documents the terminal status enum as ok|partial|gap', () => {
    // The terminal values must all appear as per the W3 inline fix.
    // The authoritative sentence is in the Docs-tasks persistence section.
    expect(sessionPlan).toContain('`ok`');
    expect(sessionPlan).toContain('`partial`');
    expect(sessionPlan).toContain('`gap`');
  });
});
