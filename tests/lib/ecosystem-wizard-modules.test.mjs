/**
 * tests/lib/ecosystem-wizard-modules.test.mjs
 * Direct sub-module isolation tests for #325 ecosystem-wizard split.
 * Verifies each sub-module is independently importable and behaves correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectCiProvider } from '../../scripts/lib/ecosystem-wizard/ci-detector.mjs';
import {
  detectPackageManagerFromRoot,
  readPackageScripts,
} from '../../scripts/lib/ecosystem-wizard/package-manager-detector.mjs';
import {
  parseCommaSeparated,
  parseEndpoints,
  parsePipelines,
} from '../../scripts/lib/ecosystem-wizard/config-parser.mjs';
import { validateEcosystemPolicy } from '../../scripts/lib/ecosystem-wizard/config-writer.mjs';
import * as barrel from '../../scripts/lib/ecosystem-wizard.mjs';

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'eco-modules-test-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ci-detector module
// ---------------------------------------------------------------------------

describe('ci-detector module', () => {
  it('exports detectCiProvider as a function', () => {
    expect(typeof detectCiProvider).toBe('function');
  });

  it('returns "gitlab" when .gitlab-ci.yml is present', () => {
    writeFileSync(join(sandbox, '.gitlab-ci.yml'), 'stages: [test]\n', 'utf8');
    expect(detectCiProvider(sandbox)).toBe('gitlab');
  });

  it('returns "github" when .github/workflows directory is present', () => {
    mkdirSync(join(sandbox, '.github', 'workflows'), { recursive: true });
    expect(detectCiProvider(sandbox)).toBe('github');
  });

  it('returns "none" when neither CI config is present', () => {
    expect(detectCiProvider(sandbox)).toBe('none');
  });

  it('gitlab takes priority over github when both are present', () => {
    writeFileSync(join(sandbox, '.gitlab-ci.yml'), 'stages: [test]\n', 'utf8');
    mkdirSync(join(sandbox, '.github', 'workflows'), { recursive: true });
    expect(detectCiProvider(sandbox)).toBe('gitlab');
  });
});

// ---------------------------------------------------------------------------
// package-manager-detector module
// ---------------------------------------------------------------------------

describe('package-manager-detector module', () => {
  it('detectPackageManagerFromRoot returns "pnpm" when pnpm-lock.yaml is present', () => {
    writeFileSync(join(sandbox, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n', 'utf8');
    expect(detectPackageManagerFromRoot(sandbox)).toBe('pnpm');
  });

  it('detectPackageManagerFromRoot returns "npm" when only package-lock.json is present', () => {
    writeFileSync(join(sandbox, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');
    expect(detectPackageManagerFromRoot(sandbox)).toBe('npm');
  });

  it('detectPackageManagerFromRoot returns "yarn" when yarn.lock is present', () => {
    writeFileSync(join(sandbox, 'yarn.lock'), '# yarn lockfile v1\n', 'utf8');
    expect(detectPackageManagerFromRoot(sandbox)).toBe('yarn');
  });

  it('detectPackageManagerFromRoot returns null when no lockfile is present', () => {
    expect(detectPackageManagerFromRoot(sandbox)).toBeNull();
  });

  it('pnpm takes priority over npm when both lockfiles are present', () => {
    writeFileSync(join(sandbox, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n', 'utf8');
    writeFileSync(join(sandbox, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');
    expect(detectPackageManagerFromRoot(sandbox)).toBe('pnpm');
  });

  it('readPackageScripts returns array of script names from package.json', () => {
    writeFileSync(
      join(sandbox, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', build: 'tsc' } }),
      'utf8'
    );
    const scripts = readPackageScripts(sandbox);
    expect(scripts).toContain('test');
    expect(scripts).toContain('lint');
    expect(scripts).toContain('build');
  });

  it('readPackageScripts returns empty array when package.json is absent', () => {
    expect(readPackageScripts(sandbox)).toEqual([]);
  });

  it('readPackageScripts returns empty array when package.json has no scripts field', () => {
    writeFileSync(join(sandbox, 'package.json'), JSON.stringify({ name: 'test-pkg' }), 'utf8');
    expect(readPackageScripts(sandbox)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// config-parser module
// ---------------------------------------------------------------------------

describe('config-parser module', () => {
  describe('parseCommaSeparated', () => {
    it('splits a comma-separated string into trimmed items', () => {
      expect(parseCommaSeparated('a,b,c')).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array for empty string input', () => {
      expect(parseCommaSeparated('')).toEqual([]);
    });

    it('trims whitespace around items', () => {
      expect(parseCommaSeparated(' foo , bar , baz ')).toEqual(['foo', 'bar', 'baz']);
    });

    it('filters out items that are only whitespace', () => {
      expect(parseCommaSeparated('a, ,b')).toEqual(['a', 'b']);
    });
  });

  describe('parseEndpoints', () => {
    it('parses "Name|URL" format into objects with name and url fields', () => {
      const result = parseEndpoints('API|https://api.example.com/health');
      expect(result).toEqual([{ name: 'API', url: 'https://api.example.com/health' }]);
    });

    it('parses multiple comma-separated endpoints', () => {
      const result = parseEndpoints('API|https://api.example.com/health,Web|https://web.example.com/');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: 'API', url: 'https://api.example.com/health' });
      expect(result[1]).toEqual({ name: 'Web', url: 'https://web.example.com/' });
    });

    it('returns empty array for input with no pipe separator', () => {
      expect(parseEndpoints('no-pipe-here')).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      expect(parseEndpoints('')).toEqual([]);
    });
  });

  describe('parsePipelines', () => {
    it('parses plain id entries into objects with id field', () => {
      const result = parsePipelines('main');
      expect(result).toEqual([{ id: 'main' }]);
    });

    it('parses "id:label" format into objects with id and label fields', () => {
      const result = parsePipelines('main:Production,dev:Development');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: 'main', label: 'Production' });
      expect(result[1]).toEqual({ id: 'dev', label: 'Development' });
    });

    it('returns empty array for empty string', () => {
      expect(parsePipelines('')).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// config-writer module — validateEcosystemPolicy
// ---------------------------------------------------------------------------

describe('config-writer module — validateEcosystemPolicy', () => {
  it('returns empty array for a valid policy with all fields', () => {
    const errors = validateEcosystemPolicy({
      version: 1,
      endpoints: [{ name: 'API', url: 'https://api.example.com/health' }],
      pipelines: [{ id: 'main' }],
      criticalIssueLabels: ['priority:critical'],
    });
    expect(errors).toEqual([]);
  });

  it('returns empty array for a minimal valid policy with only version', () => {
    expect(validateEcosystemPolicy({ version: 1 })).toEqual([]);
  });

  it('returns error when policy is not an object', () => {
    const errors = validateEcosystemPolicy('not-an-object');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('plain object');
  });

  it('returns error when version is not 1', () => {
    const errors = validateEcosystemPolicy({ version: 2 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('version'))).toBe(true);
  });

  it('returns error when endpoints entry is missing a url field', () => {
    const errors = validateEcosystemPolicy({
      version: 1,
      endpoints: [{ name: 'API' }],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('url'))).toBe(true);
  });

  it('returns error when pipelines entry is missing an id field', () => {
    const errors = validateEcosystemPolicy({
      version: 1,
      pipelines: [{ label: 'No ID' }],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('id'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// barrel re-exports
// ---------------------------------------------------------------------------

describe('barrel re-exports from ecosystem-wizard.mjs', () => {
  it('exports at least 10 and no more than 50 public symbols (floor/ceiling for growth)', () => {
    const count = Object.keys(barrel).length;
    expect(count).toBeGreaterThanOrEqual(10);
    expect(count).toBeLessThanOrEqual(50);
  });

  it('exports detectCiProvider', () => {
    expect(typeof barrel.detectCiProvider).toBe('function');
  });

  it('exports detectPackageManagerFromRoot', () => {
    expect(typeof barrel.detectPackageManagerFromRoot).toBe('function');
  });

  it('exports readPackageScripts', () => {
    expect(typeof barrel.readPackageScripts).toBe('function');
  });

  it('exports parseCommaSeparated', () => {
    expect(typeof barrel.parseCommaSeparated).toBe('function');
  });

  it('exports parseEndpoints', () => {
    expect(typeof barrel.parseEndpoints).toBe('function');
  });

  it('exports parsePipelines', () => {
    expect(typeof barrel.parsePipelines).toBe('function');
  });

  it('exports validateEcosystemPolicy', () => {
    expect(typeof barrel.validateEcosystemPolicy).toBe('function');
  });

  it('exports resolveConfigFile', () => {
    expect(typeof barrel.resolveConfigFile).toBe('function');
  });

  it('exports readExistingEcosystemConfig', () => {
    expect(typeof barrel.readExistingEcosystemConfig).toBe('function');
  });

  it('exports writeSessionConfigBlock', () => {
    expect(typeof barrel.writeSessionConfigBlock).toBe('function');
  });

  it('exports writePolicyFile', () => {
    expect(typeof barrel.writePolicyFile).toBe('function');
  });

  it('exports runEcosystemWizard', () => {
    expect(typeof barrel.runEcosystemWizard).toBe('function');
  });
});
