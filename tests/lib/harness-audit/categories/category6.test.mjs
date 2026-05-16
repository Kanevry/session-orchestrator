/**
 * tests/lib/harness-audit/categories/category6.test.mjs
 *
 * Vitest suite for scripts/lib/harness-audit/categories/category6.mjs
 *
 * Category 6: Config Hygiene — checks claude-md-line-count,
 * no-dead-branch-refs, plugin-narrative-section.
 *
 * Relies on resolveInstructionFile from common.mjs:
 *   - CLAUDE.md present → kind 'claude'
 *   - AGENTS.md present → kind 'agents' (only if CLAUDE.md absent)
 *   - neither present → null (checks should fail)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCategory6 } from '@lib/harness-audit/categories/category6.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'cat6-'));
}

/** Minimal valid CLAUDE.md content for a consumer repo (no plugin-specific heading). */
function minimalClaudeMd(extraLines = []) {
  const base = [
    '# Project Instructions',
    '',
    '## Session Config',
    'persistence: true',
    '',
  ];
  return [...base, ...extraLines].join('\n');
}

/** Build a string of exactly N lines. */
function nLines(n) {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runCategory6', () => {
  let root;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Happy path — CLAUDE.md present, ≤250 lines, no dead refs, consumer repo
  // -------------------------------------------------------------------------
  it('returns 3 passing checks for a well-formed consumer repo CLAUDE.md', () => {
    writeFileSync(join(root, 'CLAUDE.md'), minimalClaudeMd());

    const checks = runCategory6(root);

    expect(checks).toHaveLength(3);
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
    expect(checks.map((c) => c.check_id)).toEqual([
      'claude-md-line-count',
      'no-dead-branch-refs',
      'plugin-narrative-section',
    ]);
  });

  // -------------------------------------------------------------------------
  // Edge case — AGENTS.md alias: resolveInstructionFile picks AGENTS.md
  // -------------------------------------------------------------------------
  it('uses AGENTS.md when CLAUDE.md is absent', () => {
    writeFileSync(join(root, 'AGENTS.md'), minimalClaudeMd());

    const checks = runCategory6(root);
    const lineCountCheck = checks.find((c) => c.check_id === 'claude-md-line-count');

    expect(lineCountCheck.status).toBe('pass');
    // Path reported in scorecard should be the AGENTS.md alias
    expect(lineCountCheck.path).toBe('AGENTS.md');
  });

  // -------------------------------------------------------------------------
  // Edge case — CLAUDE.md takes precedence over AGENTS.md when both present
  // -------------------------------------------------------------------------
  it('prefers CLAUDE.md over AGENTS.md when both are present', () => {
    writeFileSync(join(root, 'CLAUDE.md'), minimalClaudeMd());
    writeFileSync(join(root, 'AGENTS.md'), minimalClaudeMd());

    const checks = runCategory6(root);
    const lineCountCheck = checks.find((c) => c.check_id === 'claude-md-line-count');

    expect(lineCountCheck.path).toBe('CLAUDE.md');
  });

  // -------------------------------------------------------------------------
  // Edge case — neither CLAUDE.md nor AGENTS.md present → checks fail
  // -------------------------------------------------------------------------
  it('fails all instruction-file checks when neither CLAUDE.md nor AGENTS.md exists', () => {
    // Do not write any instruction file

    const checks = runCategory6(root);
    const lineCountCheck = checks.find((c) => c.check_id === 'claude-md-line-count');
    const deadRefsCheck = checks.find((c) => c.check_id === 'no-dead-branch-refs');

    expect(lineCountCheck.status).toBe('fail');
    expect(deadRefsCheck.status).toBe('fail');
    expect(lineCountCheck.message).toContain('missing');
  });

  // -------------------------------------------------------------------------
  // Failure case — CLAUDE.md exceeds 250 lines
  // -------------------------------------------------------------------------
  it('fails claude-md-line-count when CLAUDE.md exceeds 250 lines', () => {
    writeFileSync(join(root, 'CLAUDE.md'), nLines(260));

    const checks = runCategory6(root);
    const lineCountCheck = checks.find((c) => c.check_id === 'claude-md-line-count');

    expect(lineCountCheck.status).toBe('fail');
    expect(lineCountCheck.evidence.lineCount).toBe(260);
    expect(lineCountCheck.message).toContain('> 250 limit');
  });

  // -------------------------------------------------------------------------
  // Failure case — dead branch ref detected in CLAUDE.md
  // -------------------------------------------------------------------------
  it('fails no-dead-branch-refs when CLAUDE.md contains a dead branch reference', () => {
    writeFileSync(
      join(root, 'CLAUDE.md'),
      minimalClaudeMd(['See branch feat/v3-refactor for prior work.']),
    );

    const checks = runCategory6(root);
    const deadRefsCheck = checks.find((c) => c.check_id === 'no-dead-branch-refs');

    expect(deadRefsCheck.status).toBe('fail');
    expect(deadRefsCheck.evidence.deadRefsFound).toContain('feat/v3-');
  });
});
