/**
 * blast-radius-classifier.test.mjs — Unit tests for the #647 C2 R5
 * blast-radius classifier (`classifyTarget`).
 *
 * The classifier is PATH-TRAVERSAL-SAFE and FAIL-CLOSED: only the repo's own
 * ROOT CLAUDE.md / AGENTS.md yield `autonomous-gated`; everything that escapes
 * the repo or is ambiguous is `unknown` / `always-mr`.
 *
 * repoRoot is the live repo root so realpathSync resolves the canonical anchor.
 */

import { describe, it, expect } from 'vitest';
import { classifyTarget } from '@lib/skill-evolution/blast-radius-classifier.mjs';

// Portable repo root (vitest runs from the repo root). Avoids hardcoding a
// personal home path (#494 owner-privacy). classifyTarget's path rules resolve
// targetPath against this root and never require the target to exist, so cwd
// makes every worked case classify identically across machines.
const REPO_ROOT = process.cwd();

describe('classifyTarget — artifact-type classification table', () => {
  it.each([
    ['CLAUDE.md', { targetType: 'local-config', gate: 'config-validation', posture: 'autonomous-gated' }],
    ['AGENTS.md', { targetType: 'local-config', gate: 'config-validation', posture: 'autonomous-gated' }],
    ['skills/discovery/SKILL.md', { targetType: 'plugin-skill', gate: 'none', posture: 'always-mr' }],
    ['.claude/skills/foo/SKILL.md', { targetType: 'local-skill', gate: 'none', posture: 'always-mr' }],
    ['../../etc/passwd', { targetType: 'unknown', gate: 'none', posture: 'always-mr' }],
    ['skills/../../etc', { targetType: 'unknown', gate: 'none', posture: 'always-mr' }],
    ['/abs/outside/repo', { targetType: 'unknown', gate: 'none', posture: 'always-mr' }],
    ['subdir/CLAUDE.md', { targetType: 'unknown', gate: 'none', posture: 'always-mr' }],
    ['skills/../CLAUDE.md', { targetType: 'local-config', gate: 'config-validation', posture: 'autonomous-gated' }],
  ])('classifies %s correctly', (targetPath, expected) => {
    expect(classifyTarget(targetPath, { repoRoot: REPO_ROOT })).toEqual(expected);
  });
});

describe('classifyTarget — input guards (fail-closed, never throws)', () => {
  it('fail-closes when targetPath is not a string', () => {
    expect(classifyTarget(undefined, { repoRoot: REPO_ROOT })).toEqual({
      targetType: 'unknown',
      gate: 'none',
      posture: 'always-mr',
    });
  });

  it('fail-closes when repoRoot is missing', () => {
    expect(classifyTarget('CLAUDE.md', {})).toEqual({
      targetType: 'unknown',
      gate: 'none',
      posture: 'always-mr',
    });
  });

  it('does not throw for a path that escapes the repo', () => {
    expect(() => classifyTarget('../../../../etc/shadow', { repoRoot: REPO_ROOT })).not.toThrow();
  });
});
