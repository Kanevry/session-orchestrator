/**
 * tests/lib/ecosystem-wizard.test.mjs — #289
 * Tests for readExistingEcosystemConfig wiring + idempotent re-run behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readExistingEcosystemConfig,
  runEcosystemWizard,
  writePolicyFile,
} from '@lib/ecosystem-wizard.mjs';

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'eco-wizard-289-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC-1: readExistingEcosystemConfig is wired — existing-config path
// ---------------------------------------------------------------------------

describe('readExistingEcosystemConfig — existing policy', () => {
  it('returns config object when valid policy file exists', () => {
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

  it('runEcosystemWizard exposes existingConfig in result when policy file present', async () => {
    const config = { endpoints: [{ name: 'Old', url: 'https://old.example.com/health' }], pipelines: [], criticalIssueLabels: [] };
    writePolicyFile(sandbox, config, false);
    writeFileSync(join(sandbox, 'CLAUDE.md'), '## Session Config\n\npersistence: true\n', 'utf8');

    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: { endpoints: '', pipelines: '', criticalIssueLabels: '' },
    });

    expect(result.existingConfig).not.toBeNull();
    expect(result.existingConfig.endpoints[0].name).toBe('Old');
  });
});

// ---------------------------------------------------------------------------
// AC-1: missing-config path — fresh-run mode
// ---------------------------------------------------------------------------

describe('readExistingEcosystemConfig — missing-config path', () => {
  it('returns null when policy file does not exist', () => {
    const config = readExistingEcosystemConfig(sandbox);
    expect(config).toBeNull();
  });

  it('runEcosystemWizard exposes existingConfig=null on fresh project', async () => {
    writeFileSync(join(sandbox, 'CLAUDE.md'), '## Session Config\n\npersistence: true\n', 'utf8');

    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: { endpoints: 'API|https://api.example.com/health', pipelines: '', criticalIssueLabels: '' },
    });

    expect(result.existingConfig).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.written.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-1: malformed-config path — fresh-run mode + warning-compatible
// ---------------------------------------------------------------------------

describe('readExistingEcosystemConfig — malformed-config path', () => {
  it('returns null when policy file contains invalid JSON', () => {
    const policyDir = join(sandbox, '.orchestrator', 'policy');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, 'ecosystem.json'), '{ not valid json }', 'utf8');

    const config = readExistingEcosystemConfig(sandbox);
    expect(config).toBeNull();
  });

  it('returns null when policy file fails validation (wrong version)', () => {
    const policyDir = join(sandbox, '.orchestrator', 'policy');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(
      join(policyDir, 'ecosystem.json'),
      JSON.stringify({ version: 99, endpoints: [] }),
      'utf8'
    );

    const config = readExistingEcosystemConfig(sandbox);
    expect(config).toBeNull();
  });

  it('runEcosystemWizard falls back to fresh-run when policy is malformed', async () => {
    const policyDir = join(sandbox, '.orchestrator', 'policy');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, 'ecosystem.json'), '{ bad }', 'utf8');
    writeFileSync(join(sandbox, 'CLAUDE.md'), '## Session Config\n\npersistence: true\n', 'utf8');

    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: { endpoints: 'API|https://api.example.com/health', pipelines: 'main', criticalIssueLabels: '' },
    });

    // Fresh-run: wizard proceeds normally, overwrites malformed policy
    expect(result.errors).toEqual([]);
    expect(result.written).toContain(join(sandbox, '.orchestrator', 'policy', 'ecosystem.json'));
    const written = JSON.parse(
      readFileSync(join(sandbox, '.orchestrator', 'policy', 'ecosystem.json'), 'utf8')
    );
    expect(written.endpoints[0].name).toBe('API');
  });
});

// ---------------------------------------------------------------------------
// AC-3: merge-not-overwrite — changed fields updated, untouched preserved
// ---------------------------------------------------------------------------

describe('merge — changed fields updated, untouched fields preserved', () => {
  it('updates only the changed field in policy when one answer changes', async () => {
    // First run: establish initial config
    const initialConfig = {
      endpoints: [{ name: 'API', url: 'https://api.example.com/health' }],
      pipelines: [{ id: 'main' }],
      criticalIssueLabels: ['priority:critical'],
    };
    writePolicyFile(sandbox, initialConfig, false);
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      '## Session Config\n\npersistence: true\necosystem-health:\n  health-endpoints:\n    - name: API\n      url: https://api.example.com/health\n',
      'utf8'
    );

    // Second run: change only the endpoint URL, keep pipeline + labels blank (preserve)
    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: {
        endpoints: 'API|https://api.example.com/v2/health',
        pipelines: '',   // blank → preserve existing 'main'
        criticalIssueLabels: '', // blank → preserve existing 'priority:critical'
      },
    });

    expect(result.errors).toEqual([]);

    const policy = JSON.parse(
      readFileSync(join(sandbox, '.orchestrator', 'policy', 'ecosystem.json'), 'utf8')
    );
    // Changed field updated
    expect(policy.endpoints[0].url).toBe('https://api.example.com/v2/health');
    // Untouched fields preserved
    expect(policy.pipelines).toEqual([{ id: 'main' }]);
    expect(policy.criticalIssueLabels).toEqual(['priority:critical']);
  });

  it('Session Config block is updated when config changes', async () => {
    const initialConfig = {
      endpoints: [{ name: 'API', url: 'https://old.example.com/health' }],
      pipelines: [],
      criticalIssueLabels: [],
    };
    writePolicyFile(sandbox, initialConfig, false);
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      '## Session Config\n\npersistence: true\necosystem-health:\n  health-endpoints:\n    - name: API\n      url: https://old.example.com/health\n',
      'utf8'
    );

    await runEcosystemWizard({
      repoRoot: sandbox,
      answers: {
        endpoints: 'API|https://new.example.com/health',
        pipelines: '',
        criticalIssueLabels: '',
      },
    });

    const claudeMd = readFileSync(join(sandbox, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('https://new.example.com/health');
    expect(claudeMd).not.toContain('https://old.example.com/health');
  });
});

// ---------------------------------------------------------------------------
// AC-5: idempotent re-run — same answers produce zero diff
// ---------------------------------------------------------------------------

describe('idempotent re-run — same answers produce no writes', () => {
  it('re-run with identical answers skips both policy and Session Config', async () => {
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      '## Session Config\n\npersistence: true\n',
      'utf8'
    );

    // First run — writes both files
    const firstRun = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: {
        endpoints: 'API|https://api.example.com/health',
        pipelines: 'main',
        criticalIssueLabels: 'priority:critical',
      },
    });

    expect(firstRun.errors).toEqual([]);
    expect(firstRun.written.length).toBe(2);

    // Second run — same answers, should produce no writes
    const secondRun = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: {
        endpoints: 'API|https://api.example.com/health',
        pipelines: 'main',
        criticalIssueLabels: 'priority:critical',
      },
    });

    expect(secondRun.errors).toEqual([]);
    expect(secondRun.written).toEqual([]);
    expect(secondRun.skipped.length).toBeGreaterThan(0);
  });

  it('re-run with blank answers (keep-all) skips both files', async () => {
    // Pre-populate policy and CLAUDE.md with existing config
    const config = {
      endpoints: [{ name: 'API', url: 'https://api.example.com/health' }],
      pipelines: [{ id: 'main' }],
      criticalIssueLabels: ['priority:critical'],
    };
    writePolicyFile(sandbox, config, false);
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      '## Session Config\n\npersistence: true\necosystem-health:\n  health-endpoints:\n    - name: API\n      url: https://api.example.com/health\n  pipelines:\n    - id: main\n  critical-issue-labels: ["priority:critical"]\n',
      'utf8'
    );

    // Re-run with all blanks (user pressed Enter to keep existing)
    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: { endpoints: '', pipelines: '', criticalIssueLabels: '' },
    });

    expect(result.errors).toEqual([]);
    // Policy file identical → skipped
    expect(result.skipped).toContain(join(sandbox, '.orchestrator', 'policy', 'ecosystem.json'));
    // Nothing written
    expect(result.written).toEqual([]);
  });
});
