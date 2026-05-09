/**
 * tests/lib/ecosystem-wizard/wizard-prompt.test.mjs
 *
 * Unit tests for scripts/lib/ecosystem-wizard/wizard-prompt.mjs.
 * Covers: runEcosystemWizard (programmatic answers path).
 *
 * Uses the `answers` injection path exclusively — no readline interaction.
 * All file I/O is directed to a per-test tmpdir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEcosystemWizard } from '../../../scripts/lib/ecosystem-wizard/wizard-prompt.mjs';
import { writePolicyFile } from '../../../scripts/lib/ecosystem-wizard/config-writer.mjs';

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'wizard-prompt-test-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeClaudeMd(content = '## Session Config\n\npersistence: true\n') {
  writeFileSync(join(sandbox, 'CLAUDE.md'), content, 'utf8');
}

// ---------------------------------------------------------------------------
// Happy path — all answers provided
// ---------------------------------------------------------------------------

describe('runEcosystemWizard — happy path with all answers', () => {
  it('writes policy file and returns written paths on fresh project', async () => {
    writeClaudeMd();

    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: {
        endpoints: 'API|https://api.example.com/health',
        pipelines: 'main:Production',
        criticalIssueLabels: 'priority:critical',
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.written.length).toBeGreaterThan(0);
    expect(result.written).toContain(join(sandbox, '.orchestrator', 'policy', 'ecosystem.json'));
  });

  it('writes correct endpoint data to the policy JSON file', async () => {
    writeClaudeMd();

    await runEcosystemWizard({
      repoRoot: sandbox,
      answers: {
        endpoints: 'Web|https://web.example.com/health,API|https://api.example.com/health',
        pipelines: '',
        criticalIssueLabels: '',
      },
    });

    const policyPath = join(sandbox, '.orchestrator', 'policy', 'ecosystem.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(policy.version).toBe(1);
    expect(policy.endpoints).toHaveLength(2);
    expect(policy.endpoints[0]).toEqual({ name: 'Web', url: 'https://web.example.com/health' });
    expect(policy.endpoints[1]).toEqual({ name: 'API', url: 'https://api.example.com/health' });
  });

  it('returns detection field with ciProvider, packageManager and scripts', async () => {
    writeClaudeMd();

    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: { endpoints: '', pipelines: '', criticalIssueLabels: '' },
    });

    expect(result.detection).toBeDefined();
    expect(typeof result.detection.ciProvider).toBe('string');
    expect(result.detection.packageManager === null || typeof result.detection.packageManager === 'string').toBe(true);
    expect(Array.isArray(result.detection.scripts)).toBe(true);
  });

  it('returns an error when repoRoot is missing', async () => {
    const result = await runEcosystemWizard({
      answers: { endpoints: '', pipelines: '', criticalIssueLabels: '' },
    });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].reason).toContain('repoRoot is required');
  });
});

// ---------------------------------------------------------------------------
// Blank-answer fallback — empty input keeps existing values
// ---------------------------------------------------------------------------

describe('runEcosystemWizard — blank-answer fallback', () => {
  it('preserves existing endpoints when endpoints answer is blank', async () => {
    const initialConfig = {
      endpoints: [{ name: 'OldAPI', url: 'https://oldapi.example.com/health' }],
      pipelines: [],
      criticalIssueLabels: [],
    };
    writePolicyFile(sandbox, initialConfig, false);
    writeClaudeMd();

    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: { endpoints: '', pipelines: '', criticalIssueLabels: '' },
    });

    expect(result.errors).toEqual([]);

    const policyPath = join(sandbox, '.orchestrator', 'policy', 'ecosystem.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    // Blank answer → existing config preserved
    expect(policy.endpoints).toEqual([{ name: 'OldAPI', url: 'https://oldapi.example.com/health' }]);
  });

  it('preserves existing pipelines when pipelines answer is blank', async () => {
    const initialConfig = {
      endpoints: [],
      pipelines: [{ id: 'main', label: 'Production' }],
      criticalIssueLabels: [],
    };
    writePolicyFile(sandbox, initialConfig, false);
    writeClaudeMd();

    await runEcosystemWizard({
      repoRoot: sandbox,
      answers: { endpoints: '', pipelines: '', criticalIssueLabels: '' },
    });

    const policyPath = join(sandbox, '.orchestrator', 'policy', 'ecosystem.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(policy.pipelines).toEqual([{ id: 'main', label: 'Production' }]);
  });

  it('uses new value when non-blank answer overrides existing', async () => {
    const initialConfig = {
      endpoints: [{ name: 'OldAPI', url: 'https://old.example.com/health' }],
      pipelines: [],
      criticalIssueLabels: [],
    };
    writePolicyFile(sandbox, initialConfig, false);
    writeClaudeMd();

    await runEcosystemWizard({
      repoRoot: sandbox,
      answers: {
        endpoints: 'NewAPI|https://new.example.com/health',
        pipelines: '',
        criticalIssueLabels: '',
      },
    });

    const policyPath = join(sandbox, '.orchestrator', 'policy', 'ecosystem.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(policy.endpoints[0].url).toBe('https://new.example.com/health');
    expect(policy.endpoints[0].name).toBe('NewAPI');
  });
});

// ---------------------------------------------------------------------------
// Existing config serialization — re-run preserves choices
// ---------------------------------------------------------------------------

describe('runEcosystemWizard — existing config preserved on re-run', () => {
  it('skips policy file write when identical answers provided on second run', async () => {
    writeClaudeMd();

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
    // Both files skipped — idempotent
    expect(secondRun.skipped.length).toBeGreaterThan(0);
  });

  it('exposes existingConfig in result when policy file is already present', async () => {
    const initialConfig = {
      endpoints: [{ name: 'Svc', url: 'https://svc.example.com/health' }],
      pipelines: [],
      criticalIssueLabels: [],
    };
    writePolicyFile(sandbox, initialConfig, false);
    writeClaudeMd();

    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: { endpoints: '', pipelines: '', criticalIssueLabels: '' },
    });

    expect(result.existingConfig).not.toBeNull();
    expect(result.existingConfig.endpoints[0].name).toBe('Svc');
  });

  it('returns existingConfig=null on a fresh project with no policy file', async () => {
    writeClaudeMd();

    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: { endpoints: 'API|https://api.example.com/health', pipelines: '', criticalIssueLabels: '' },
    });

    expect(result.existingConfig).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dryRun mode
// ---------------------------------------------------------------------------

describe('runEcosystemWizard — dryRun mode', () => {
  it('returns written paths but does not create policy file when dryRun=true', async () => {
    writeClaudeMd();

    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: { endpoints: 'API|https://api.example.com/health', pipelines: 'main', criticalIssueLabels: '' },
      dryRun: true,
    });

    expect(result.errors).toEqual([]);
    expect(result.written.length).toBeGreaterThan(0);

    const policyPath = join(sandbox, '.orchestrator', 'policy', 'ecosystem.json');
    let exists = true;
    try { readFileSync(policyPath); } catch { exists = false; }
    expect(exists).toBe(false);
  });
});
