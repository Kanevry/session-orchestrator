import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectCiProvider,
  detectPackageManagerFromRoot,
  readPackageScripts,
  validateEcosystemPolicy,
  parseEndpoints,
  parsePipelines,
  parseCommaSeparated,
  resolveConfigFile,
  readExistingEcosystemConfig,
  writeSessionConfigBlock,
  writePolicyFile,
  runEcosystemWizard,
} from '../../scripts/lib/ecosystem-wizard.mjs';

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'eco-wizard-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

describe('detectCiProvider', () => {
  it('returns "none" for empty directory', () => {
    expect(detectCiProvider(sandbox)).toBe('none');
  });

  it('detects gitlab from .gitlab-ci.yml', () => {
    writeFileSync(join(sandbox, '.gitlab-ci.yml'), 'stages: [test]');
    expect(detectCiProvider(sandbox)).toBe('gitlab');
  });

  it('detects github from .github/workflows directory', () => {
    mkdirSync(join(sandbox, '.github', 'workflows'), { recursive: true });
    expect(detectCiProvider(sandbox)).toBe('github');
  });

  it('prefers gitlab when both .gitlab-ci.yml and .github/workflows exist', () => {
    writeFileSync(join(sandbox, '.gitlab-ci.yml'), '');
    mkdirSync(join(sandbox, '.github', 'workflows'), { recursive: true });
    expect(detectCiProvider(sandbox)).toBe('gitlab');
  });
});

describe('detectPackageManagerFromRoot', () => {
  it('returns null when no lockfile is present', () => {
    expect(detectPackageManagerFromRoot(sandbox)).toBeNull();
  });

  it('detects pnpm from pnpm-lock.yaml', () => {
    writeFileSync(join(sandbox, 'pnpm-lock.yaml'), '');
    expect(detectPackageManagerFromRoot(sandbox)).toBe('pnpm');
  });

  it('detects npm from package-lock.json', () => {
    writeFileSync(join(sandbox, 'package-lock.json'), '{}');
    expect(detectPackageManagerFromRoot(sandbox)).toBe('npm');
  });
});

describe('readPackageScripts', () => {
  it('returns empty array when package.json is absent', () => {
    expect(readPackageScripts(sandbox)).toEqual([]);
  });

  it('returns script names from package.json', () => {
    writeFileSync(
      join(sandbox, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } })
    );
    const scripts = readPackageScripts(sandbox);
    expect(scripts).toContain('test');
    expect(scripts).toContain('lint');
  });

  it('does not throw on malformed package.json', () => {
    writeFileSync(join(sandbox, 'package.json'), '{ bad json }');
    expect(() => readPackageScripts(sandbox)).not.toThrow();
    expect(readPackageScripts(sandbox)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

describe('validateEcosystemPolicy', () => {
  it('accepts a minimal valid policy (version only)', () => {
    expect(validateEcosystemPolicy({ version: 1 })).toEqual([]);
  });

  it('accepts a full valid policy', () => {
    const policy = {
      version: 1,
      endpoints: [{ name: 'API', url: 'https://example.com/health' }],
      pipelines: [{ id: 'main' }],
      criticalIssueLabels: ['priority:critical'],
    };
    expect(validateEcosystemPolicy(policy)).toEqual([]);
  });

  it('rejects non-object input', () => {
    expect(validateEcosystemPolicy(null)).not.toEqual([]);
    expect(validateEcosystemPolicy('string')).not.toEqual([]);
    expect(validateEcosystemPolicy([])).not.toEqual([]);
  });

  it('rejects wrong version', () => {
    const errors = validateEcosystemPolicy({ version: 2 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/version/);
  });

  it('rejects endpoint missing url', () => {
    const errors = validateEcosystemPolicy({
      version: 1,
      endpoints: [{ name: 'API' }],
    });
    expect(errors.some((e) => e.includes('url'))).toBe(true);
  });

  it('rejects endpoint with empty name', () => {
    const errors = validateEcosystemPolicy({
      version: 1,
      endpoints: [{ name: '', url: 'https://example.com' }],
    });
    expect(errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('rejects pipeline missing id', () => {
    const errors = validateEcosystemPolicy({
      version: 1,
      pipelines: [{ label: 'Deploy' }],
    });
    expect(errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('rejects empty criticalIssueLabels entry', () => {
    const errors = validateEcosystemPolicy({
      version: 1,
      criticalIssueLabels: [''],
    });
    expect(errors.some((e) => e.includes('criticalIssueLabels'))).toBe(true);
  });

  it('rejects non-array endpoints', () => {
    const errors = validateEcosystemPolicy({ version: 1, endpoints: 'not-an-array' });
    expect(errors.some((e) => e.includes('endpoints'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

describe('parseEndpoints', () => {
  it('parses single endpoint', () => {
    expect(parseEndpoints('API|https://example.com/health')).toEqual([
      { name: 'API', url: 'https://example.com/health' },
    ]);
  });

  it('parses multiple endpoints (comma-separated)', () => {
    const result = parseEndpoints('API|https://a.com, Worker|http://b:8080');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('API');
    expect(result[1].name).toBe('Worker');
  });

  it('skips entries without pipe separator', () => {
    expect(parseEndpoints('bad-entry, API|https://example.com')).toHaveLength(1);
  });

  it('returns empty array for blank input', () => {
    expect(parseEndpoints('')).toEqual([]);
  });
});

describe('parsePipelines', () => {
  it('parses simple id', () => {
    expect(parsePipelines('main')).toEqual([{ id: 'main' }]);
  });

  it('parses id with label', () => {
    expect(parsePipelines('deploy:Deploy to Prod')).toEqual([
      { id: 'deploy', label: 'Deploy to Prod' },
    ]);
  });

  it('parses multiple pipelines', () => {
    const result = parsePipelines('main, deploy:Deploy');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('main');
    expect(result[1].label).toBe('Deploy');
  });

  it('returns empty array for blank input', () => {
    expect(parsePipelines('')).toEqual([]);
  });
});

describe('parseCommaSeparated', () => {
  it('splits and trims entries', () => {
    expect(parseCommaSeparated('a, b,  c')).toEqual(['a', 'b', 'c']);
  });

  it('filters empty entries', () => {
    expect(parseCommaSeparated(',,')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseCommaSeparated('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Session Config writer
// ---------------------------------------------------------------------------

describe('writeSessionConfigBlock', () => {
  function writeClaude(content) {
    writeFileSync(join(sandbox, 'CLAUDE.md'), content, 'utf8');
    return join(sandbox, 'CLAUDE.md');
  }

  it('appends ecosystem-health block to existing Session Config', () => {
    const path = writeClaude('# Project\n\n## Session Config\n\npersistence: true\n');
    const result = writeSessionConfigBlock(
      path,
      { endpoints: [{ name: 'API', url: 'https://example.com' }], pipelines: [], criticalIssueLabels: [] },
      false
    );
    expect(result).toBe('written');
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('ecosystem-health:');
    expect(content).toContain('name: API');
  });

  it('is idempotent when ecosystem-health key already present', () => {
    const path = writeClaude(
      '## Session Config\n\npersistence: true\necosystem-health:\n  health-endpoints: []\n'
    );
    const result = writeSessionConfigBlock(
      path,
      { endpoints: [], pipelines: [], criticalIssueLabels: [] },
      false
    );
    expect(result).toBe('skipped');
    // Content should not have a duplicate ecosystem-health key
    const content = readFileSync(path, 'utf8');
    const count = (content.match(/ecosystem-health:/g) || []).length;
    expect(count).toBe(1);
  });

  it('dry-run does not modify the file', () => {
    const original = '## Session Config\n\npersistence: true\n';
    const path = writeClaude(original);
    const result = writeSessionConfigBlock(
      path,
      { endpoints: [{ name: 'API', url: 'https://x.com' }], pipelines: [], criticalIssueLabels: [] },
      true
    );
    expect(result).toBe('written');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Policy file writer
// ---------------------------------------------------------------------------

describe('writePolicyFile', () => {
  it('writes .orchestrator/policy/ecosystem.json', () => {
    const config = {
      endpoints: [{ name: 'API', url: 'https://x.com' }],
      pipelines: [{ id: 'main' }],
      criticalIssueLabels: ['priority:critical'],
    };
    const result = writePolicyFile(sandbox, config, false);
    expect(result).toBe('written');
    const policyPath = join(sandbox, '.orchestrator', 'policy', 'ecosystem.json');
    expect(existsSync(policyPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.endpoints[0].name).toBe('API');
    expect(parsed.pipelines[0].id).toBe('main');
    expect(parsed.criticalIssueLabels).toContain('priority:critical');
  });

  it('is idempotent when contents are identical', () => {
    const config = { endpoints: [], pipelines: [], criticalIssueLabels: [] };
    writePolicyFile(sandbox, config, false);
    const result = writePolicyFile(sandbox, config, false);
    expect(result).toBe('skipped');
  });

  it('dry-run does not create file', () => {
    const config = { endpoints: [], pipelines: [], criticalIssueLabels: [] };
    writePolicyFile(sandbox, config, true);
    const policyPath = join(sandbox, '.orchestrator', 'policy', 'ecosystem.json');
    expect(existsSync(policyPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runEcosystemWizard — integration-style
// ---------------------------------------------------------------------------

describe('runEcosystemWizard', () => {
  it('returns error when repoRoot is missing', async () => {
    const result = await runEcosystemWizard({});
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].reason).toMatch(/repoRoot/);
  });

  it('first-run writes both policy file and Session Config', async () => {
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      '# Project\n\n## Session Config\n\npersistence: true\n',
      'utf8'
    );
    writeFileSync(join(sandbox, '.gitlab-ci.yml'), 'stages: [test]');

    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: {
        endpoints: 'API|https://api.example.com/health',
        pipelines: 'main',
        criticalIssueLabels: 'priority:critical',
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.written).toContain(join(sandbox, '.orchestrator', 'policy', 'ecosystem.json'));
    expect(result.written).toContain(join(sandbox, 'CLAUDE.md'));

    const policy = JSON.parse(
      readFileSync(join(sandbox, '.orchestrator', 'policy', 'ecosystem.json'), 'utf8')
    );
    expect(policy.version).toBe(1);
    expect(policy.endpoints[0].url).toBe('https://api.example.com/health');
    expect(policy.criticalIssueLabels).toContain('priority:critical');

    const claudeMd = readFileSync(join(sandbox, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('ecosystem-health:');
  });

  it('idempotent re-run skips both files when already present', async () => {
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      '## Session Config\n\npersistence: true\necosystem-health:\n  health-endpoints: []\n',
      'utf8'
    );

    const config = { endpoints: [], pipelines: [], criticalIssueLabels: [] };
    // Write the policy file first
    writePolicyFile(sandbox, config, false);

    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: { endpoints: '', pipelines: '', criticalIssueLabels: '' },
    });

    expect(result.errors).toEqual([]);
    expect(result.written).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('exposes detection results in returned object', async () => {
    writeFileSync(join(sandbox, '.gitlab-ci.yml'), '');
    writeFileSync(join(sandbox, 'pnpm-lock.yaml'), '');
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      '## Session Config\n\npersistence: true\n',
      'utf8'
    );

    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: { endpoints: '', pipelines: '', criticalIssueLabels: '' },
    });

    expect(result.detection.ciProvider).toBe('gitlab');
    expect(result.detection.packageManager).toBe('pnpm');
  });

  it('dry-run writes no files', async () => {
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      '## Session Config\n\npersistence: true\n',
      'utf8'
    );

    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      dryRun: true,
      answers: {
        endpoints: 'API|https://example.com',
        pipelines: '',
        criticalIssueLabels: '',
      },
    });

    expect(result.errors).toEqual([]);
    expect(existsSync(join(sandbox, '.orchestrator', 'policy', 'ecosystem.json'))).toBe(false);
    // CLAUDE.md should not have been modified
    const content = readFileSync(join(sandbox, 'CLAUDE.md'), 'utf8');
    expect(content).not.toContain('ecosystem-health:');
  });

  it('validator rejects policy with malformed endpoint (missing url)', async () => {
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      '## Session Config\n\npersistence: true\n',
      'utf8'
    );

    // Force an invalid policy by bypassing parseEndpoints — inject a bad endpoints array
    // We test this indirectly by checking validateEcosystemPolicy directly
    const errors = validateEcosystemPolicy({
      version: 1,
      endpoints: [{ name: 'Bad' }], // missing url
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('gracefully handles missing CLAUDE.md (policy still written)', async () => {
    // No CLAUDE.md in sandbox
    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: {
        endpoints: 'API|https://example.com',
        pipelines: '',
        criticalIssueLabels: '',
      },
    });

    // Policy file should be written; no Session Config file to update
    expect(result.written).toContain(join(sandbox, '.orchestrator', 'policy', 'ecosystem.json'));
    // No error for missing config file (it simply isn't updated)
    const configErrors = result.errors.filter((e) => e.path.endsWith('CLAUDE.md'));
    expect(configErrors).toEqual([]);
  });

  it('writes pipeline with label into policy file', async () => {
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      '## Session Config\n\npersistence: true\n',
      'utf8'
    );

    await runEcosystemWizard({
      repoRoot: sandbox,
      answers: {
        endpoints: '',
        pipelines: 'deploy:Deploy to Production',
        criticalIssueLabels: '',
      },
    });

    const policy = JSON.parse(
      readFileSync(join(sandbox, '.orchestrator', 'policy', 'ecosystem.json'), 'utf8')
    );
    expect(policy.pipelines[0].id).toBe('deploy');
    expect(policy.pipelines[0].label).toBe('Deploy to Production');
  });

  it('AGENTS.md is resolved when CLAUDE.md is absent', async () => {
    writeFileSync(
      join(sandbox, 'AGENTS.md'),
      '## Session Config\n\npersistence: true\n',
      'utf8'
    );

    const result = await runEcosystemWizard({
      repoRoot: sandbox,
      answers: {
        endpoints: 'API|https://example.com',
        pipelines: '',
        criticalIssueLabels: '',
      },
    });

    expect(result.written).toContain(join(sandbox, 'AGENTS.md'));
    const content = readFileSync(join(sandbox, 'AGENTS.md'), 'utf8');
    expect(content).toContain('ecosystem-health:');
  });
});
