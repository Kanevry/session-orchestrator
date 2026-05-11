/**
 * Tests for validateWorkspacePath (ADR-364 thin-slice §5).
 *
 * Covers the mandatory DoD cases:
 *   - happy path (strict descendant)
 *   - traversal via ../etc/passwd (CWE-23)
 *   - absolute path outside root
 *   - empty-string inputs (TypeError)
 *   - root-itself (must be strict descendant, not equal)
 *   - symlink-escape (documented limitation — pure helper says "yes")
 *   - non-string inputs (TypeError)
 *   - zero production call-sites assertion
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { validateWorkspacePath } from '../../../scripts/lib/worktree/lifecycle.mjs';

// ---------------------------------------------------------------------------
// Table-driven cases (ADR-364 §5 DoD — ≥6 mandatory cases)
// ---------------------------------------------------------------------------

describe('validateWorkspacePath — table-driven cases (ADR-364 §5 DoD)', () => {
  const ROOT = '/var/tmp/so-worktrees';

  const cases = [
    // [name, computed, root, expected, why]
    ['happy: child of root',                `${ROOT}/abc`,              ROOT, true,    'normal worktree'],
    ['traversal: ../etc/passwd',            `${ROOT}/../etc/passwd`,    ROOT, false,   'classic CWE-23'],
    ['traversal: deeper escape',            `${ROOT}/sub/../../escape`, ROOT, false,   '..-up beyond root'],
    ['absolute outside root',               '/var/tmp/other/x',         ROOT, false,   'sibling tree'],
    ['empty-string computed → throws',      '',                         ROOT, 'throw', 'TypeError'],
    ['empty-string root → throws',          `${ROOT}/abc`,              '',   'throw', 'TypeError'],
    ['root === computed → false',           ROOT,                       ROOT, false,   'must be strict descendant'],
    ['nested deeper child',                 `${ROOT}/a/b/c/d`,          ROOT, true,    'multi-level descendant'],
    ['root with trailing slash',            `${ROOT}/abc`,              `${ROOT}/`, true, 'trailing-slash root tolerated'],
    ['relative computed resolves to CWD',   'abc',                      ROOT, false,   'CWD-relative not under abs root'],
  ];

  for (const [name, computed, root, expected, why] of cases) {
    it(`${name} — ${why}`, () => {
      if (expected === 'throw') {
        expect(() => validateWorkspacePath(computed, root)).toThrow(TypeError);
      } else {
        expect(validateWorkspacePath(computed, root)).toBe(expected);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Non-string and invalid inputs
// ---------------------------------------------------------------------------

describe('validateWorkspacePath — non-string inputs throw TypeError', () => {
  it.each([null, undefined, 42, {}, [], true])('rejects %p as computed', (bad) => {
    expect(() => validateWorkspacePath(bad, '/var/tmp/so-worktrees')).toThrow(TypeError);
  });

  it.each([null, undefined, 42, {}, [], true])('rejects %p as root', (bad) => {
    expect(() => validateWorkspacePath('/var/tmp/so-worktrees/x', bad)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Purity contract + documented limitation
// ---------------------------------------------------------------------------

describe('validateWorkspacePath — purity contract (ADR-364 §5)', () => {
  it('does NOT detect symlink-escape (documented limitation)', () => {
    // The function operates on string inputs only — it cannot dereference symlinks.
    // The string `/var/tmp/so-worktrees/symlink-to-etc` looks like a child path; the
    // helper says "yes" without inspecting whether it is a symlink. Callers wanting
    // symlink-safety must call fs.realpathSync(computed) first and pass the resolved
    // path to this helper.
    expect(
      validateWorkspacePath(
        '/var/tmp/so-worktrees/symlink-to-etc',
        '/var/tmp/so-worktrees',
      ),
    ).toBe(true);
  });

  it('is synchronous and returns a boolean — no I/O', () => {
    // If this ever became async or threw during sync execution on a path that
    // doesn't exist on disk, the purity contract would be broken.
    const result = validateWorkspacePath('/var/tmp/so-worktrees/nonexistent', '/var/tmp/so-worktrees');
    expect(typeof result).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Production call-site allowlist (#370 wired the first sanctioned call-site).
// Was "zero call-sites" pre-#370 (deep-3 ADR-364 §5 DoD); flipped to allowlist
// when #370 landed gc-stale-worktrees defence-in-depth wiring.
// ---------------------------------------------------------------------------

describe('production call-site allowlist (#370)', () => {
  it('helper is invoked only from sanctioned files', async () => {
    const { execSync } = await import('node:child_process');
    const out = execSync(
      "rg -l 'validateWorkspacePath\\(' scripts/ tests/ | sort",
      { encoding: 'utf8', cwd: fileURLToPath(new URL('../../../', import.meta.url)) },
    );
    const files = out.trim().split('\n').filter(Boolean);
    const allowed = [
      'scripts/gc-stale-worktrees.mjs',
      'scripts/lib/autopilot/worktree-pipeline.mjs',
      'scripts/lib/worktree/lifecycle.mjs',
      'tests/lib/worktree/validate-workspace-path.test.mjs',
    ];
    const unexpected = files.filter((f) => !allowed.includes(f));
    expect(unexpected).toEqual([]);
  });
});
