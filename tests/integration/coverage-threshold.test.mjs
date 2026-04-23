/**
 * tests/integration/coverage-threshold.test.mjs
 *
 * Regression-lock smoke test for vitest.config.mjs coverage thresholds (#263).
 *
 * Purpose: if someone removes the coverage thresholds or swaps out the v8
 * provider, this test fails loudly. We intentionally read the file as text
 * and regex/parse rather than importing the config — importing would re-run
 * defineConfig and couple this test to vitest internals.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VITEST_CONFIG = join(REPO_ROOT, 'vitest.config.mjs');
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');

describe('vitest.config.mjs coverage thresholds (#263 regression lock)', () => {
  const configText = readFileSync(VITEST_CONFIG, 'utf8');

  it('uses the v8 coverage provider', () => {
    // Match: provider: 'v8'  (allow single or double quotes, optional spaces)
    expect(configText).toMatch(/provider\s*:\s*['"]v8['"]/);
  });

  it('declares a coverage.thresholds block', () => {
    expect(configText).toMatch(/thresholds\s*:\s*\{/);
  });

  it('enforces lines >= 70', () => {
    const m = configText.match(/lines\s*:\s*(\d+)/);
    expect(m, 'lines threshold not found in vitest.config.mjs').not.toBeNull();
    const linesVal = Number(m[1]);
    expect(linesVal).toBeGreaterThanOrEqual(70);
  });

  it('enforces branches >= 60', () => {
    const m = configText.match(/branches\s*:\s*(\d+)/);
    expect(m, 'branches threshold not found in vitest.config.mjs').not.toBeNull();
    const branchesVal = Number(m[1]);
    expect(branchesVal).toBeGreaterThanOrEqual(60);
  });

  it('enforces functions >= 70', () => {
    const m = configText.match(/functions\s*:\s*(\d+)/);
    expect(m, 'functions threshold not found in vitest.config.mjs').not.toBeNull();
    const functionsVal = Number(m[1]);
    expect(functionsVal).toBeGreaterThanOrEqual(70);
  });

  it('enforces statements >= 70', () => {
    const m = configText.match(/statements\s*:\s*(\d+)/);
    expect(m, 'statements threshold not found in vitest.config.mjs').not.toBeNull();
    const statementsVal = Number(m[1]);
    expect(statementsVal).toBeGreaterThanOrEqual(70);
  });

  it('includes scripts/lib and hooks in coverage scope', () => {
    expect(configText).toMatch(/scripts\/lib/);
    expect(configText).toMatch(/hooks/);
  });
});

describe('coverage dev dependency (#263)', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));

  it('@vitest/coverage-v8 is declared in devDependencies', () => {
    expect(pkg.devDependencies).toBeDefined();
    expect(pkg.devDependencies['@vitest/coverage-v8']).toBeDefined();
    // Version should look like a semver range.
    expect(pkg.devDependencies['@vitest/coverage-v8']).toMatch(/\d+\.\d+\.\d+/);
  });

  it('test:coverage npm script is defined', () => {
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts['test:coverage']).toBeDefined();
    expect(pkg.scripts['test:coverage']).toMatch(/coverage/);
  });
});
