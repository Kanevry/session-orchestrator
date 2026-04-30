/**
 * tests/scripts/orchestrators-e2e.test.mjs
 *
 * End-to-end smoke tests confirming the .mjs gate siblings are wired correctly
 * through the two orchestrators (run-quality-gate.mjs, validate-plugin.mjs)
 * after the .sh → .mjs port (issue #218).
 *
 * All commands are skipped via --config JSON to keep tests hermetic. The
 * incremental and per-file variants are not otherwise covered as full
 * invocations in run-quality-gate.test.mjs (they only appear in help-output
 * assertions there), so this file adds that gap coverage.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SKIP_CONFIG = JSON.stringify({ 'typecheck-command': 'skip', 'test-command': 'skip' });
const SKIP_CONFIG_WITH_LINT = JSON.stringify({
  'typecheck-command': 'skip',
  'test-command': 'skip',
  'lint-command': 'skip',
});

function runGate(args) {
  return spawnSync('node', [path.join(ROOT, 'scripts/run-quality-gate.mjs'), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Orchestrator 1: run-quality-gate.mjs — all four variants via .mjs gate subs
// ---------------------------------------------------------------------------

describe('orchestrators e2e (post .sh→.mjs port)', () => {
  it('run-quality-gate.mjs baseline emits JSON with variant:baseline, exit 0', () => {
    const r = runGate(['--variant', 'baseline', '--config', SKIP_CONFIG]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.variant).toBe('baseline');
    expect(out.typecheck).toBe('skip');
    expect(out.test).toBe('skip');
  });

  it('run-quality-gate.mjs incremental emits JSON with variant:incremental and errors:[], exit 0', () => {
    const r = runGate(['--variant', 'incremental', '--config', SKIP_CONFIG]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.variant).toBe('incremental');
    expect(Array.isArray(out.errors)).toBe(true);
    expect(out.errors).toHaveLength(0);
  });

  it('run-quality-gate.mjs full-gate emits JSON with variant:full-gate, exit 0 when all skipped', () => {
    const r = runGate(['--variant', 'full-gate', '--config', SKIP_CONFIG_WITH_LINT]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.variant).toBe('full-gate');
    expect(out.typecheck.status).toBe('skip');
    expect(out.test.status).toBe('skip');
    expect(out.lint.status).toBe('skip');
  });

  it('run-quality-gate.mjs per-file emits JSON with variant:per-file, exit 0 when files empty', () => {
    const r = runGate(['--variant', 'per-file', '--files', '', '--config', SKIP_CONFIG]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.variant).toBe('per-file');
    expect(Array.isArray(out.files)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Orchestrator 2: validate-plugin.mjs — checks .mjs validate siblings
  // ---------------------------------------------------------------------------

  it('validate-plugin.mjs reports at least 15 passed and 0 failed against this repo, exit 0', () => {
    const r = spawnSync('node', [path.join(ROOT, 'scripts/validate-plugin.mjs')], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Results:');
    const match = r.stdout.match(/Results:\s+(\d+)\s+passed,\s+(\d+)\s+failed/);
    expect(match).not.toBeNull();
    expect(parseInt(match[1], 10)).toBeGreaterThanOrEqual(15);
    expect(parseInt(match[2], 10)).toBe(0);
  });
});
