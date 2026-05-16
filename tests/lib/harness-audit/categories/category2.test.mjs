/**
 * tests/lib/harness-audit/categories/category2.test.mjs
 *
 * Unit tests for scripts/lib/harness-audit/categories/category2.mjs
 * Category 2: Quality Gate Coverage
 *
 * Checks exercised:
 *   c2.1 package-json-scripts
 *   c2.2 bootstrap-lock-schema
 *   c2.3 quality-gates-policy (optional file)
 *   c2.4 schema-drift-ci
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCategory2 } from '@lib/harness-audit/categories/category2.mjs';
import { _resetWarnFlags } from '@lib/harness-audit/categories/helpers.mjs';

/**
 * Write a file, creating intermediate directories as needed.
 */
function scaffold(root, relPath, content) {
  const abs = join(root, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

describe('category2 — Quality Gate Coverage', () => {
  let d;

  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), 'cat2-'));
    _resetWarnFlags();
  });

  afterEach(() => {
    rmSync(d, { recursive: true, force: true });
  });

  it('returns an array of checks (floor: at least 3)', () => {
    const checks = runCategory2(d);
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThanOrEqual(3);
    expect(checks.length).toBeLessThanOrEqual(20);
  });

  describe('happy path — all checks PASS', () => {
    it('all checks pass when a well-formed fixture repo is provided', () => {
      // c2.1 package.json with all three scripts
      scaffold(d, 'package.json', JSON.stringify({
        name: 'test-pkg',
        scripts: {
          test: 'vitest run',
          typecheck: 'tsc --noEmit',
          lint: 'eslint .',
        },
      }, null, 2));

      // c2.2 bootstrap.lock with valid fields
      scaffold(d, '.orchestrator/bootstrap.lock', [
        'version: 3.4.0',
        'tier: standard',
        'archetype: plugin',
      ].join('\n') + '\n');

      // c2.3 quality-gates.json absent → optional skip pass (no action needed)

      // c2.4 .gitlab-ci.yml with schema-drift-check reference
      scaffold(d, '.gitlab-ci.yml', [
        'stages: [validate]',
        'schema-drift-check:',
        '  stage: validate',
        '  script: node scripts/check-drift.mjs',
      ].join('\n'));

      const checks = runCategory2(d);
      const failed = checks.filter((c) => c.status === 'fail');
      expect(failed).toHaveLength(0);

      const passed = checks.filter((c) => c.status === 'pass');
      expect(passed.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('c2.1 package-json-scripts', () => {
    it('fails when package.json is missing', () => {
      const checks = runCategory2(d);
      const check = checks.find((c) => c.check_id === 'package-json-scripts');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.test).toBeNull();
    });

    it('fails when package.json lacks the lint script', () => {
      scaffold(d, 'package.json', JSON.stringify({
        scripts: {
          test: 'vitest run',
          typecheck: 'tsc --noEmit',
          // lint intentionally omitted
        },
      }));

      const checks = runCategory2(d);
      const check = checks.find((c) => c.check_id === 'package-json-scripts');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.lint).toBeNull();
      expect(check.evidence.test).toBe('vitest run');
    });

    it('passes when all three scripts are present', () => {
      scaffold(d, 'package.json', JSON.stringify({
        scripts: {
          test: 'vitest run',
          typecheck: 'npm run tsgo',
          lint: 'eslint .',
        },
      }));

      const checks = runCategory2(d);
      const check = checks.find((c) => c.check_id === 'package-json-scripts');
      expect(check).toBeDefined();
      expect(check.status).toBe('pass');
      expect(check.evidence.test).toBe('vitest run');
      expect(check.evidence.typecheck).toBe('npm run tsgo');
      expect(check.evidence.lint).toBe('eslint .');
    });
  });

  describe('c2.2 bootstrap-lock-schema', () => {
    it('fails when bootstrap.lock is missing', () => {
      const checks = runCategory2(d);
      const check = checks.find((c) => c.check_id === 'bootstrap-lock-schema');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.version).toBeNull();
    });

    it('fails when bootstrap.lock has an invalid tier value', () => {
      scaffold(d, '.orchestrator/bootstrap.lock', [
        'version: 3.4.0',
        'tier: turbo',        // invalid — only fast|standard|deep allowed
        'archetype: plugin',
      ].join('\n'));

      const checks = runCategory2(d);
      const check = checks.find((c) => c.check_id === 'bootstrap-lock-schema');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.tier).toBe('turbo');
    });

    it('passes for each valid tier value', () => {
      for (const tier of ['fast', 'standard', 'deep']) {
        scaffold(d, '.orchestrator/bootstrap.lock', [
          `version: 3.4.0`,
          `tier: ${tier}`,
          'archetype: plugin',
        ].join('\n'));

        const checks = runCategory2(d);
        const check = checks.find((c) => c.check_id === 'bootstrap-lock-schema');
        expect(check).toBeDefined();
        expect(check.status).toBe('pass');
        expect(check.evidence.tier).toBe(tier);
      }
    });
  });

  describe('c2.3 quality-gates-policy (optional)', () => {
    it('passes (skip) when quality-gates.json is absent', () => {
      const checks = runCategory2(d);
      const check = checks.find((c) => c.check_id === 'quality-gates-policy');
      expect(check).toBeDefined();
      expect(check.status).toBe('pass');
      expect(check.evidence.present).toBe(false);
    });

    it('fails when quality-gates.json is present but not valid JSON', () => {
      scaffold(d, '.orchestrator/policy/quality-gates.json', 'not-json{');

      const checks = runCategory2(d);
      const check = checks.find((c) => c.check_id === 'quality-gates-policy');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.present).toBe(true);
      expect(check.evidence.valid).toBe(false);
    });

    it('passes when quality-gates.json has all three command entries', () => {
      scaffold(d, '.orchestrator/policy/quality-gates.json', JSON.stringify({
        commands: {
          test: { command: 'npm test' },
          typecheck: { command: 'npm run typecheck' },
          lint: { command: 'npm run lint' },
        },
      }));

      const checks = runCategory2(d);
      const check = checks.find((c) => c.check_id === 'quality-gates-policy');
      expect(check).toBeDefined();
      expect(check.status).toBe('pass');
      expect(check.evidence.valid).toBe(true);
    });
  });

  describe('c2.4 schema-drift-ci', () => {
    it('fails when no CI config contains schema-drift reference', () => {
      scaffold(d, '.gitlab-ci.yml', 'stages: [validate]\njobs: []');

      const checks = runCategory2(d);
      const check = checks.find((c) => c.check_id === 'schema-drift-ci');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.matchedFile).toBeNull();
    });

    it('passes when .gitlab-ci.yml contains schema-drift-check', () => {
      scaffold(d, '.gitlab-ci.yml', [
        'schema-drift-check:',
        '  stage: validate',
        '  script: node scripts/check.mjs',
      ].join('\n'));

      const checks = runCategory2(d);
      const check = checks.find((c) => c.check_id === 'schema-drift-ci');
      expect(check).toBeDefined();
      expect(check.status).toBe('pass');
      expect(check.evidence.matchedFile).toBe('.gitlab-ci.yml');
    });

    it('passes when a GitHub workflow contains schema-drift reference', () => {
      scaffold(d, '.github/workflows/ci.yml', [
        'name: CI',
        'jobs:',
        '  schema-drift:',
        '    runs-on: ubuntu-latest',
        '    steps: []',
      ].join('\n'));

      const checks = runCategory2(d);
      const check = checks.find((c) => c.check_id === 'schema-drift-ci');
      expect(check).toBeDefined();
      expect(check.status).toBe('pass');
      expect(check.evidence.matchedFile).toBe('.github/workflows/ci.yml');
    });
  });
});
