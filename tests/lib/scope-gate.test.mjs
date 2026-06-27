/**
 * tests/lib/scope-gate.test.mjs
 *
 * Smoke-level direct unit tests for scripts/lib/scope-gate.mjs (A4 barrel split).
 * Verifies the new module path resolves and the scope/pattern primitives behave.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  findScopeFile,
  getEnforcementLevel,
  gateEnabled,
  pathMatchesPattern,
  suggestForScopeViolation,
} from '@lib/scope-gate.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-gate-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scope-gate.mjs (direct import)', () => {
  it('pathMatchesPattern matches a recursive glob', () => {
    expect(pathMatchesPattern('src/a/b/foo.ts', 'src/**/*.ts')).toBe(true);
  });

  it('pathMatchesPattern rejects a non-matching path', () => {
    expect(pathMatchesPattern('docs/readme.md', 'src/**/*.ts')).toBe(false);
  });

  it('findScopeFile resolves .claude/wave-scope.json', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    const scope = path.join(tmpDir, '.claude', 'wave-scope.json');
    fs.writeFileSync(scope, '{}');
    expect(findScopeFile(tmpDir)).toBe(scope);
  });

  it('findScopeFile returns null when no scope file exists', () => {
    expect(findScopeFile(tmpDir)).toBe(null);
  });

  it('getEnforcementLevel reads the enforcement field and fails closed on parse error', () => {
    const scope = path.join(tmpDir, 'scope.json');
    fs.writeFileSync(scope, JSON.stringify({ enforcement: 'warn' }));
    expect(getEnforcementLevel(scope)).toBe('warn');
    expect(getEnforcementLevel(path.join(tmpDir, 'missing.json'))).toBe('strict');
  });

  it('gateEnabled returns false only when explicitly disabled', () => {
    const scope = path.join(tmpDir, 'scope.json');
    fs.writeFileSync(scope, JSON.stringify({ gates: { commitGuard: false } }));
    expect(gateEnabled(scope, 'commitGuard')).toBe(false);
    expect(gateEnabled(scope, 'otherGate')).toBe(true);
  });

  it('suggestForScopeViolation includes the blocked path and allowed list', () => {
    expect(suggestForScopeViolation('x.ts', 'src/,tests/')).toContain('src/,tests/');
    expect(suggestForScopeViolation('x.ts', '')).toContain('No paths are currently allowed');
  });
});
