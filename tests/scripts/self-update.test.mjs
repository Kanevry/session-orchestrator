/**
 * tests/scripts/self-update.test.mjs
 *
 * Pins the one decision self-update makes that the harness does not: noticing
 * a plugin cache whose runtime dependencies were never installed (Claude Code
 * 2.1.287 `dependencies-refused`, measured 2026-10-02).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findClaudeEntry, missingRuntimeDeps } from '../../scripts/self-update.mjs';

describe('missingRuntimeDeps', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'so-self-update-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { yaml: '^2', '@babel/parser': '^7' },
      devDependencies: { vitest: '^4' },
    }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports every runtime dep when the harness skipped the install', () => {
    expect(missingRuntimeDeps(dir).sort()).toEqual(['@babel/parser', 'yaml']);
  });

  it('ignores devDependencies and resolves scoped names', () => {
    mkdirSync(join(dir, 'node_modules', '@babel', 'parser'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'yaml'), { recursive: true });
    expect(missingRuntimeDeps(dir)).toEqual([]);
  });
});

describe('findClaudeEntry', () => {
  const ours = { id: 'session-orchestrator@kanevry', scope: 'user', version: '5.4.0' };
  const other = { id: 'other@kanevry', scope: 'user', version: '1.0.0' };

  it('reads both the bare-array and the {plugins} shape', () => {
    expect(findClaudeEntry([other, ours])).toBe(ours);
    expect(findClaudeEntry({ plugins: [other, ours] })).toBe(ours);
  });

  it('prefers the user-scope entry over a project-scope one', () => {
    const project = { ...ours, scope: 'project', version: '5.0.0' };
    expect(findClaudeEntry([project, ours])).toBe(ours);
  });

  it('returns null when the plugin is absent or the shape is unknown', () => {
    expect(findClaudeEntry([other])).toBeNull();
    expect(findClaudeEntry({ unexpected: true })).toBeNull();
  });
});
