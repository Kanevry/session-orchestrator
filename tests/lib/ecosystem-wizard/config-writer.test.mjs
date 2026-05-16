/**
 * tests/lib/ecosystem-wizard/config-writer.test.mjs
 *
 * Unit tests for scripts/lib/ecosystem-wizard/config-writer.mjs.
 * Covers: validateEcosystemPolicy, writePolicyFile, writeSessionConfigBlock,
 * resolveConfigFile, and readExistingEcosystemConfig.
 *
 * All file I/O is directed to a per-test tmpdir. No real project files are touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateEcosystemPolicy,
  writePolicyFile,
  writeSessionConfigBlock,
  resolveConfigFile,
  readExistingEcosystemConfig,
  buildPolicyObject,
} from '@lib/ecosystem-wizard/config-writer.mjs';

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'config-writer-test-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// validateEcosystemPolicy
// ---------------------------------------------------------------------------

describe('validateEcosystemPolicy', () => {
  it('returns empty array for a minimal valid policy (version:1 only)', () => {
    expect(validateEcosystemPolicy({ version: 1 })).toEqual([]);
  });

  it('returns empty array for a fully-populated valid policy', () => {
    const errors = validateEcosystemPolicy({
      version: 1,
      endpoints: [{ name: 'API', url: 'https://api.example.com/health' }],
      pipelines: [{ id: 'main', label: 'Production' }],
      criticalIssueLabels: ['priority:critical'],
    });
    expect(errors).toEqual([]);
  });

  it('returns error when policy is not a plain object', () => {
    const errors = validateEcosystemPolicy('not-an-object');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('plain object');
  });

  it('returns error when policy is null', () => {
    const errors = validateEcosystemPolicy(null);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns error when version is not 1', () => {
    const errors = validateEcosystemPolicy({ version: 2 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('version'))).toBe(true);
  });

  it('returns error when version is missing (undefined)', () => {
    const errors = validateEcosystemPolicy({ endpoints: [] });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('version'))).toBe(true);
  });

  it('returns error when endpoints entry is missing url field', () => {
    const errors = validateEcosystemPolicy({
      version: 1,
      endpoints: [{ name: 'API' }],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('url'))).toBe(true);
  });

  it('returns error when endpoints entry is missing name field', () => {
    const errors = validateEcosystemPolicy({
      version: 1,
      endpoints: [{ url: 'https://api.example.com/health' }],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('returns error when endpoints is not an array', () => {
    const errors = validateEcosystemPolicy({
      version: 1,
      endpoints: 'not-array',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('endpoints'))).toBe(true);
  });

  it('returns error when pipelines entry is missing id field', () => {
    const errors = validateEcosystemPolicy({
      version: 1,
      pipelines: [{ label: 'No ID here' }],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('returns error when criticalIssueLabels contains an empty string', () => {
    const errors = validateEcosystemPolicy({
      version: 1,
      criticalIssueLabels: ['priority:critical', ''],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('criticalIssueLabels'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writePolicyFile
// ---------------------------------------------------------------------------

describe('writePolicyFile', () => {
  it('writes JSON with version=1 and specified keys to .orchestrator/policy/ecosystem.json', () => {
    const config = {
      endpoints: [{ name: 'API', url: 'https://api.example.com/health' }],
      pipelines: [{ id: 'main' }],
      criticalIssueLabels: ['priority:critical'],
    };

    const result = writePolicyFile(sandbox, config, false);

    expect(result).toBe('written');
    const policyPath = join(sandbox, '.orchestrator', 'policy', 'ecosystem.json');
    const written = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(written.version).toBe(1);
    expect(written.endpoints).toEqual([{ name: 'API', url: 'https://api.example.com/health' }]);
    expect(written.pipelines).toEqual([{ id: 'main' }]);
    expect(written.criticalIssueLabels).toEqual(['priority:critical']);
  });

  it('writes the rationale field in the JSON output', () => {
    const config = { endpoints: [], pipelines: [], criticalIssueLabels: [] };
    writePolicyFile(sandbox, config, false);
    const policyPath = join(sandbox, '.orchestrator', 'policy', 'ecosystem.json');
    const written = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(typeof written.rationale).toBe('string');
    expect(written.rationale.length).toBeGreaterThan(0);
  });

  it('returns skipped when content is identical on second write', () => {
    const config = {
      endpoints: [{ name: 'API', url: 'https://api.example.com/health' }],
      pipelines: [],
      criticalIssueLabels: [],
    };
    writePolicyFile(sandbox, config, false);
    const result = writePolicyFile(sandbox, config, false);
    expect(result).toBe('skipped');
  });

  it('returns written and does not touch filesystem when dryRun=true', () => {
    const config = { endpoints: [], pipelines: [], criticalIssueLabels: [] };
    const result = writePolicyFile(sandbox, config, true);
    expect(result).toBe('written');
    const policyPath = join(sandbox, '.orchestrator', 'policy', 'ecosystem.json');
    // File should NOT exist since dryRun=true
    let exists = true;
    try { readFileSync(policyPath); } catch { exists = false; }
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeSessionConfigBlock
// ---------------------------------------------------------------------------

describe('writeSessionConfigBlock', () => {
  it('inserts ecosystem-health block into an existing Session Config section', () => {
    const claudeMd = join(sandbox, 'CLAUDE.md');
    writeFileSync(claudeMd, '## Session Config\n\npersistence: true\n', 'utf8');

    const config = {
      endpoints: [{ name: 'API', url: 'https://api.example.com/health' }],
      pipelines: [],
      criticalIssueLabels: [],
    };
    const result = writeSessionConfigBlock(claudeMd, config, false);

    expect(result).toBe('written');
    const content = readFileSync(claudeMd, 'utf8');
    expect(content).toContain('ecosystem-health:');
    expect(content).toContain('https://api.example.com/health');
    // Existing content preserved
    expect(content).toContain('persistence: true');
  });

  it('appends a new Session Config section when none exists', () => {
    const claudeMd = join(sandbox, 'CLAUDE.md');
    writeFileSync(claudeMd, '# My Project\n\nSome content here.\n', 'utf8');

    const config = { endpoints: [], pipelines: [{ id: 'main' }], criticalIssueLabels: [] };
    const result = writeSessionConfigBlock(claudeMd, config, false);

    expect(result).toBe('written');
    const content = readFileSync(claudeMd, 'utf8');
    expect(content).toContain('## Session Config');
    expect(content).toContain('ecosystem-health:');
    // Original content not destroyed
    expect(content).toContain('# My Project');
  });

  it('returns skipped when ecosystem-health already present and overwrite=false', () => {
    const claudeMd = join(sandbox, 'CLAUDE.md');
    writeFileSync(
      claudeMd,
      '## Session Config\n\npersistence: true\necosystem-health:\n  health-endpoints:\n    - name: Old\n      url: https://old.example.com/health\n',
      'utf8'
    );

    const config = {
      endpoints: [{ name: 'New', url: 'https://new.example.com/health' }],
      pipelines: [],
      criticalIssueLabels: [],
    };
    const result = writeSessionConfigBlock(claudeMd, config, false, false);

    expect(result).toBe('skipped');
    // Original content unchanged
    const content = readFileSync(claudeMd, 'utf8');
    expect(content).toContain('https://old.example.com/health');
  });

  it('replaces existing ecosystem-health block when overwrite=true and content differs', () => {
    const claudeMd = join(sandbox, 'CLAUDE.md');
    writeFileSync(
      claudeMd,
      '## Session Config\n\npersistence: true\necosystem-health:\n  health-endpoints:\n    - name: Old\n      url: https://old.example.com/health\n',
      'utf8'
    );

    const config = {
      endpoints: [{ name: 'New', url: 'https://new.example.com/health' }],
      pipelines: [],
      criticalIssueLabels: [],
    };
    const result = writeSessionConfigBlock(claudeMd, config, false, true);

    expect(result).toBe('written');
    const content = readFileSync(claudeMd, 'utf8');
    expect(content).toContain('https://new.example.com/health');
    expect(content).not.toContain('https://old.example.com/health');
  });

  it('returns error when config file does not exist', () => {
    const missingPath = join(sandbox, 'CLAUDE.md');
    const config = { endpoints: [], pipelines: [], criticalIssueLabels: [] };
    const result = writeSessionConfigBlock(missingPath, config, false);
    expect(result).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// resolveConfigFile
// ---------------------------------------------------------------------------

describe('resolveConfigFile', () => {
  it('returns path to CLAUDE.md when it exists', () => {
    const claudeMd = join(sandbox, 'CLAUDE.md');
    writeFileSync(claudeMd, '# CLAUDE.md\n', 'utf8');
    expect(resolveConfigFile(sandbox)).toBe(claudeMd);
  });

  it('returns path to AGENTS.md when CLAUDE.md is absent', () => {
    const agentsMd = join(sandbox, 'AGENTS.md');
    writeFileSync(agentsMd, '# AGENTS.md\n', 'utf8');
    expect(resolveConfigFile(sandbox)).toBe(agentsMd);
  });

  it('prefers CLAUDE.md over AGENTS.md when both exist', () => {
    const claudeMd = join(sandbox, 'CLAUDE.md');
    const agentsMd = join(sandbox, 'AGENTS.md');
    writeFileSync(claudeMd, '# CLAUDE.md\n', 'utf8');
    writeFileSync(agentsMd, '# AGENTS.md\n', 'utf8');
    expect(resolveConfigFile(sandbox)).toBe(claudeMd);
  });

  it('returns null when neither file exists', () => {
    expect(resolveConfigFile(sandbox)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readExistingEcosystemConfig
// ---------------------------------------------------------------------------

describe('readExistingEcosystemConfig', () => {
  it('returns config object with typed arrays when valid policy file exists', () => {
    const policyDir = join(sandbox, '.orchestrator', 'policy');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(
      join(policyDir, 'ecosystem.json'),
      JSON.stringify({
        version: 1,
        rationale: 'test',
        endpoints: [{ name: 'API', url: 'https://api.example.com/health' }],
        pipelines: [{ id: 'main' }],
        criticalIssueLabels: ['priority:critical'],
      }),
      'utf8'
    );

    const config = readExistingEcosystemConfig(sandbox);

    expect(config).not.toBeNull();
    expect(config.endpoints).toEqual([{ name: 'API', url: 'https://api.example.com/health' }]);
    expect(config.pipelines).toEqual([{ id: 'main' }]);
    expect(config.criticalIssueLabels).toEqual(['priority:critical']);
  });

  it('returns null when policy file is absent', () => {
    expect(readExistingEcosystemConfig(sandbox)).toBeNull();
  });

  it('returns null when policy file contains invalid JSON', () => {
    const policyDir = join(sandbox, '.orchestrator', 'policy');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, 'ecosystem.json'), '{ invalid json }', 'utf8');
    expect(readExistingEcosystemConfig(sandbox)).toBeNull();
  });

  it('returns null when policy file fails schema validation (wrong version)', () => {
    const policyDir = join(sandbox, '.orchestrator', 'policy');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(
      join(policyDir, 'ecosystem.json'),
      JSON.stringify({ version: 99, endpoints: [] }),
      'utf8'
    );
    expect(readExistingEcosystemConfig(sandbox)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildPolicyObject
// ---------------------------------------------------------------------------

describe('buildPolicyObject', () => {
  it('always sets version to 1', () => {
    const policy = buildPolicyObject({ endpoints: [], pipelines: [], criticalIssueLabels: [] });
    expect(policy.version).toBe(1);
  });

  it('includes the rationale field', () => {
    const policy = buildPolicyObject({ endpoints: [], pipelines: [], criticalIssueLabels: [] });
    expect(typeof policy.rationale).toBe('string');
    expect(policy.rationale.length).toBeGreaterThan(0);
  });

  it('passthrough config arrays into the returned object', () => {
    const endpoints = [{ name: 'API', url: 'https://api.example.com' }];
    const pipelines = [{ id: 'main', label: 'Production' }];
    const criticalIssueLabels = ['severity:critical'];
    const policy = buildPolicyObject({ endpoints, pipelines, criticalIssueLabels });
    expect(policy.endpoints).toEqual(endpoints);
    expect(policy.pipelines).toEqual(pipelines);
    expect(policy.criticalIssueLabels).toEqual(criticalIssueLabels);
  });
});
