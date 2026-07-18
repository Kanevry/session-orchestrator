/**
 * tests/husky/pre-commit-wave-scope-guard.test.mjs
 *
 * Regression-guard test for the .husky/pre-commit wave-scope-commit-guard
 * wiring (#821). Mirrors tests/husky/pre-commit-owner-leakage.test.mjs's
 * "regression guard — hook content" style: a plain containment assertion
 * against the live hook file, so deleting the invocation line (which no
 * OTHER test exercises — the guard's own behavior is unit-tested separately
 * in tests/hooks/wave-scope-commit-guard.test.mjs) is caught here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const HOOK_PATH = join(REPO_ROOT, '.husky', 'pre-commit');

describe('.husky/pre-commit — wave-scope-commit-guard wiring (#821)', () => {
  it('contains the literal wave-scope-commit-guard invocation', () => {
    const hookContent = readFileSync(HOOK_PATH, 'utf8');
    expect(hookContent).toContain('node hooks/wave-scope-commit-guard.mjs');
  });

  it('the invocation is gated so a non-zero exit blocks the commit', () => {
    const hookContent = readFileSync(HOOK_PATH, 'utf8');
    expect(hookContent).toMatch(/node hooks\/wave-scope-commit-guard\.mjs \|\| exit 1/);
  });

  it('is exec-bit set (husky requirement)', () => {
    const stat = execFileSync('ls', ['-l', HOOK_PATH], { encoding: 'utf8' });
    expect(stat).toMatch(/^-r[w-]x/);
  });
});
