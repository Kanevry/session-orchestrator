/**
 * tests/scripts/vault-backfill.test.mjs
 *
 * Tests for scripts/vault-backfill.mjs (Issue #241).
 *
 * Strategy:
 *   - CLI integration tests run the script via spawnSync (top-level await prevents
 *     direct import). A fresh tmpdir is created per test and cleaned up in afterEach.
 *   - Helper unit tests import pure functions directly from the lib modules.
 *
 * Template fixture: a minimal .vault.yaml.template is written inline to a tmpdir
 * for every subprocess test. PROJECTS_BASELINE_DIR is set to point at it.
 *
 * The script is spawned with process.execPath so tests remain hermetic even when
 * PATH is restricted (scenario 7 — glab-absent path).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isRoot } from '../_helpers/perms.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'vault-backfill.mjs');
const NODE = process.execPath;

// Minimal .vault.yaml template used by subprocess tests.
// Must contain all substitution tokens that renderTemplate touches.
const MINIMAL_TEMPLATE = [
  'apiVersion: vault.gotzendorfer/v1',
  'kind: Repository',
  'metadata:',
  '  name: "{{PROJECT_NAME}}"',
  '  slug: "{{PROJECT_NAME}}"',
  '  tier: active',
  '  owner: bernhard',
  'spec:',
  '  summary: "{{PROJECT_NAME}} — summary"',
  '  links:',
  '    gitlab: "{{GITLAB_GROUP}}/{{PROJECT_NAME}}"',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write the minimal template fixture into baseDir so PROJECTS_BASELINE_DIR
 * resolves correctly.
 */
function setupTemplateDir(baseDir) {
  const tplDir = join(baseDir, 'templates', 'shared');
  mkdirSync(tplDir, { recursive: true });
  writeFileSync(join(tplDir, '.vault.yaml.template'), MINIMAL_TEMPLATE, 'utf8');
}

/**
 * Write a manifest JSON to a file and return its path.
 */
function writeManifest(dir, manifest) {
  const p = join(dir, 'manifest.json');
  writeFileSync(p, JSON.stringify(manifest), 'utf8');
  return p;
}

/**
 * Run the CLI script and return { status, stdout, stderr }.
 * env merges PROJECTS_BASELINE_DIR + HOME on top of a minimal PATH.
 */
function run(args, { env = {}, cwd } = {}) {
  const result = spawnSync(NODE, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    cwd: cwd ?? REPO_ROOT,
    env: {
      HOME: homedir(),
      PATH: '/usr/bin:/bin:/usr/local/bin',
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Run the interactive CLI and answer prompts one at a time over stdin. */
function runInteractive(args, { env = {}, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [SCRIPT_PATH, ...args], {
      cwd: cwd ?? REPO_ROOT,
      env: {
        HOME: homedir(),
        PATH: '/usr/bin:/bin:/usr/local/bin',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const prompts = [
      'Slug [',
      'Tier (top/active/archived) [active]: ',
      'Skip this repo? [y/N]: ',
      'Apply? [y/N]: ',
    ];
    const answers = ['\n', '\n', 'n\n', 'y\n'];
    let promptIndex = 0;
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (!stderr.includes(prompts[promptIndex])) return;

      const answer = answers[promptIndex++];
      if (promptIndex === answers.length) child.stdin.end(answer);
      else child.stdin.write(answer);
    });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * Parse all JSON action lines from stdout.
 */
function parseActions(stdout) {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Per-test tmpdir lifecycle
// ---------------------------------------------------------------------------

let tmpBase;
let outDir;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'so-vbf-test-'));
  outDir = mkdtempSync(join(tmpdir(), 'so-vbf-out-'));
});

afterEach(() => {
  try {
    // Ensure dirs are writable before recursive delete (handles read-only tests).
    chmodSync(outDir, 0o755);
  } catch {
    // ignore
  }
  rmSync(tmpBase, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Manifest validation — CLI exits 1 for bad manifests
// ---------------------------------------------------------------------------

describe('manifest validation via CLI exit codes', () => {
  beforeEach(() => {
    setupTemplateDir(tmpBase);
  });

  it('rejects manifest with version !== 1 → exit 1', () => {
    const manifestPath = writeManifest(tmpBase, {
      version: 2,
      repos: [{ id: 1, path: 'g/r', slug: 'my-repo', tier: 'active', visibility: 'internal' }],
    });
    const { status, stderr } = run(
      ['--yes', manifestPath],
      { env: { PROJECTS_BASELINE_DIR: tmpBase } },
    );
    expect(status).toBe(1);
    expect(stderr).toContain('version');
  });

  it('rejects manifest with uppercase slug → exit 1', () => {
    const manifestPath = writeManifest(tmpBase, {
      version: 1,
      repos: [{ id: 1, path: 'g/r', slug: 'BadSlug', tier: 'active', visibility: 'internal' }],
    });
    const { status, stderr } = run(
      ['--yes', manifestPath],
      { env: { PROJECTS_BASELINE_DIR: tmpBase } },
    );
    expect(status).toBe(1);
    expect(stderr).toContain('slug');
  });

  it('rejects manifest with invalid tier "premium" → exit 1', () => {
    const manifestPath = writeManifest(tmpBase, {
      version: 1,
      repos: [{ id: 1, path: 'g/r', slug: 'my-repo', tier: 'premium', visibility: 'internal' }],
    });
    const { status, stderr } = run(
      ['--yes', manifestPath],
      { env: { PROJECTS_BASELINE_DIR: tmpBase } },
    );
    expect(status).toBe(1);
    expect(stderr).toContain('tier');
  });

  it('rejects manifest with invalid visibility "secret" → exit 1', () => {
    const manifestPath = writeManifest(tmpBase, {
      version: 1,
      repos: [{ id: 1, path: 'g/r', slug: 'my-repo', tier: 'active', visibility: 'secret' }],
    });
    const { status, stderr } = run(
      ['--yes', manifestPath],
      { env: { PROJECTS_BASELINE_DIR: tmpBase } },
    );
    expect(status).toBe(1);
    expect(stderr).toContain('visibility');
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: --dry-run and --apply mutual exclusion
// ---------------------------------------------------------------------------

describe('flag validation', () => {
  it('--dry-run and --apply together → exit 1', () => {
    const { status, stderr } = run(['--dry-run', '--apply']);
    expect(status).toBe(1);
    expect(stderr).toContain('mutually exclusive');
  });

  it('no --groups and no --yes → exit 1', () => {
    const { status, stderr } = run(
      [],
      { cwd: tmpBase }, // no CLAUDE.md in this cwd → no groups from config
    );
    expect(status).toBe(1);
    expect(stderr).toContain('groups');
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: --yes headless apply — writes file with correct content
// ---------------------------------------------------------------------------

describe('headless --yes apply mode', () => {
  it('writes .vault.yaml at <out-dir>/<group>/<repo>/.vault.yaml → exit 0', () => {
    setupTemplateDir(tmpBase);
    const manifestPath = writeManifest(tmpBase, {
      version: 1,
      repos: [
        {
          id: 42,
          path: 'mygroup/my-test',
          slug: 'my-test',
          tier: 'active',
          visibility: 'internal',
        },
      ],
    });

    const { status, stdout } = run(
      ['--yes', manifestPath, '--apply', '--out-dir', outDir],
      { env: { PROJECTS_BASELINE_DIR: tmpBase, HOME: homedir(), PATH: '/usr/bin:/bin' } },
    );

    expect(status).toBe(0);

    const expectedFile = join(outDir, 'mygroup', 'my-test', '.vault.yaml');
    expect(existsSync(expectedFile)).toBe(true);

    const content = readFileSync(expectedFile, 'utf8');
    expect(content).toContain('slug: "my-test"');
    expect(content).toContain('tier: active');
    expect(content).toContain('# Generated by scripts/vault-backfill.mjs');

    const actions = parseActions(stdout);
    const wrote = actions.find((a) => a.action === 'wrote');
    expect(wrote).toBeDefined();
    expect(wrote.slug).toBe('my-test');
  });

  it('stdout contains JSON line with action:"wrote" and correct slug', () => {
    setupTemplateDir(tmpBase);
    const manifestPath = writeManifest(tmpBase, {
      version: 1,
      repos: [
        { id: 7, path: 'org/alpha-service', slug: 'alpha-service', tier: 'top', visibility: 'private' },
      ],
    });

    const { status, stdout } = run(
      ['--yes', manifestPath, '--apply', '--out-dir', outDir],
      { env: { PROJECTS_BASELINE_DIR: tmpBase, HOME: homedir(), PATH: '/usr/bin:/bin' } },
    );

    expect(status).toBe(0);
    const actions = parseActions(stdout);
    const wrote = actions.find((a) => a.action === 'wrote');
    expect(wrote).toBeDefined();
    expect(wrote.slug).toBe('alpha-service');
  });

  it('derives the complete nested namespace owner in headless apply without glab', () => {
    setupTemplateDir(tmpBase);
    const manifestPath = writeManifest(tmpBase, {
      version: 1,
      repos: [
        {
          id: 11,
          path: 'engineering/platform/edge-proxy',
          slug: 'edge-proxy',
          tier: 'active',
          visibility: 'internal',
        },
      ],
    });

    const { status } = run(
      ['--yes', manifestPath, '--apply', '--out-dir', outDir],
      { env: { PROJECTS_BASELINE_DIR: tmpBase, HOME: homedir(), PATH: '' } },
    );

    expect(status).toBe(0);
    const content = readFileSync(
      join(outDir, 'engineering', 'platform', 'edge-proxy', '.vault.yaml'),
      'utf8',
    );
    expect(content).toContain('owner: "engineering/platform"');
  });
});

// ---------------------------------------------------------------------------
// Interactive group scan + apply
// ---------------------------------------------------------------------------

describe('interactive group apply mode', () => {
  it('emits the scanned project id in wrote actions while deriving owner from path', async () => {
    setupTemplateDir(tmpBase);
    const binDir = join(tmpBase, 'bin');
    mkdirSync(binDir, { recursive: true });
    const glabPath = join(binDir, 'glab');
    writeFileSync(glabPath, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'glab version 1.0.0\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "groups/engineering%2Fplatform/projects?simple=true&per_page=100" ]; then
  printf '%s\\n' '[[{"id":314,"path_with_namespace":"engineering/platform/edge-proxy","visibility":"internal","created_at":"2026-07-01T12:00:00Z","namespace":{"full_path":"engineering/platform"},"web_url":"https://gitlab.example.test/engineering/platform/edge-proxy","private_token":"must-not-escape-the-normalized-representation"}]]'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "projects/engineering%2Fplatform%2Fedge-proxy/repository/files/.vault.yaml/raw" ]; then
  printf '404 File Not Found\\n' >&2
  exit 1
fi
printf 'unexpected glab arguments: %s %s\\n' "$1" "$2" >&2
exit 2
`, 'utf8');
    chmodSync(glabPath, 0o755);

    const { status, stdout } = await runInteractive(
      ['--groups', 'engineering/platform', '--apply', '--out-dir', outDir],
      {
        env: {
          PROJECTS_BASELINE_DIR: tmpBase,
          HOME: homedir(),
          PATH: `${binDir}:/usr/bin:/bin`,
        },
      },
    );

    expect(status).toBe(0);
    const actions = parseActions(stdout);
    expect(actions).toEqual([{
      action: 'wrote',
      path: join(outDir, 'engineering', 'platform', 'edge-proxy', '.vault.yaml'),
      slug: 'edge-proxy',
      id: 314,
      tier: 'active',
      visibility: 'internal',
      group: 'engineering/platform',
    }]);
    expect(readFileSync(join(outDir, 'engineering', 'platform', 'edge-proxy', '.vault.yaml'), 'utf8'))
      .toContain('owner: "engineering/platform"');
  });

  it('rejects traversal from exit-zero GitLab output before apply and confines writes to staging', async () => {
    setupTemplateDir(tmpBase);
    const binDir = join(tmpBase, 'bin');
    const stagingDir = join(tmpBase, 'staging', 'nested');
    const escapedFile = join(tmpBase, 'outside-response-sentinel', '.vault.yaml');
    mkdirSync(binDir, { recursive: true });
    const glabPath = join(binDir, 'glab');
    writeFileSync(glabPath, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'glab version 1.0.0\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "groups/engineering%2Fplatform/projects?simple=true&per_page=100" ]; then
  printf '%s\\n' '[[{"id":1065,"path_with_namespace":"../../outside-response-sentinel","visibility":"private","created_at":"2026-08-21T00:00:00Z"}]]'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "projects/..%2F..%2Foutside-response-sentinel/repository/files/.vault.yaml/raw" ]; then
  printf '404 File Not Found\\n' >&2
  exit 1
fi
printf 'unexpected glab arguments: %s %s\\n' "$1" "$2" >&2
exit 2
`, 'utf8');
    chmodSync(glabPath, 0o755);

    const { status, stdout, stderr } = await runInteractive(
      ['--groups', 'engineering/platform', '--apply', '--out-dir', stagingDir],
      {
        env: {
          PROJECTS_BASELINE_DIR: tmpBase,
          HOME: homedir(),
          PATH: `${binDir}:/usr/bin:/bin`,
          SO_VAULT_DIR: join(tmpBase, 'vault'),
        },
      },
    );

    expect(status).toBe(3);
    expect(parseActions(stdout)).toEqual([]);
    expect(stderr).toContain('unexpected project-list response shape');
    expect(`${stdout}${stderr}`).not.toContain('outside-response-sentinel');
    expect(existsSync(escapedFile)).toBe(false);
    expect(existsSync(stagingDir)).toBe(false);
  });

  it('returns API failure without crashing for an exit-zero project list with malformed created_at', () => {
    setupTemplateDir(tmpBase);
    const binDir = join(tmpBase, 'bin');
    mkdirSync(binDir, { recursive: true });
    const glabPath = join(binDir, 'glab');
    writeFileSync(glabPath, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'glab version 1.0.0\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "groups/engineering%2Fplatform/projects?simple=true&per_page=100" ]; then
  printf '%s\\n' '[[{"id":315,"path_with_namespace":"engineering/platform/bad-timestamp","visibility":"internal","created_at":42,"private_token":"must-not-escape-the-api-diagnostic"}]]'
  exit 0
fi
printf 'unexpected glab arguments: %s %s\\n' "$1" "$2" >&2
exit 2
`, 'utf8');
    chmodSync(glabPath, 0o755);

    const { status, stdout, stderr } = run(
      ['--groups', 'engineering/platform'],
      {
        env: {
          PROJECTS_BASELINE_DIR: tmpBase,
          HOME: homedir(),
          PATH: `${binDir}:/usr/bin:/bin`,
        },
      },
    );

    expect(status).toBe(3);
    expect(parseActions(stdout)).toEqual([]);
    expect(stderr).toContain('unexpected project-list response shape');
    expect(stderr).not.toContain('must-not-escape-the-api-diagnostic');
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: --yes headless dry-run (no --apply)
// ---------------------------------------------------------------------------

describe('headless --yes dry-run mode (no --apply)', () => {
  it('emits vault-yaml-rendered action and writes no file', () => {
    setupTemplateDir(tmpBase);
    const manifestPath = writeManifest(tmpBase, {
      version: 1,
      repos: [
        { id: 1, path: 'org/dry-repo', slug: 'dry-repo', tier: 'archived', visibility: 'public' },
      ],
    });

    const { status, stdout } = run(
      ['--yes', manifestPath, '--out-dir', outDir],
      { env: { PROJECTS_BASELINE_DIR: tmpBase, HOME: homedir(), PATH: '/usr/bin:/bin' } },
    );

    expect(status).toBe(0);

    const unexpectedFile = join(outDir, 'org', 'dry-repo', '.vault.yaml');
    expect(existsSync(unexpectedFile)).toBe(false);

    const actions = parseActions(stdout);
    const rendered = actions.find((a) => a.action === 'vault-yaml-rendered');
    expect(rendered).toBeDefined();
    expect(rendered.slug).toBe('dry-repo');
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: --yes with all skip:true → exit 4
// ---------------------------------------------------------------------------

describe('headless --yes all-skip mode', () => {
  it('all repos skip:true → exit 4 and no files written', () => {
    setupTemplateDir(tmpBase);
    const manifestPath = writeManifest(tmpBase, {
      version: 1,
      repos: [
        {
          id: 1,
          path: 'org/skipped-repo',
          slug: 'skipped-repo',
          tier: 'active',
          visibility: 'internal',
          skip: true,
        },
      ],
    });

    const { status } = run(
      ['--yes', manifestPath, '--apply', '--out-dir', outDir],
      { env: { PROJECTS_BASELINE_DIR: tmpBase, HOME: homedir(), PATH: '/usr/bin:/bin' } },
    );

    expect(status).toBe(4);
    expect(existsSync(join(outDir, 'org', 'skipped-repo', '.vault.yaml'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: --yes --apply with read-only out-dir → exit 2
// ---------------------------------------------------------------------------

describe('write failure handling', () => {
  // skipIf root/perms-not-enforced: chmod-readonly cannot force a write failure when the process bypasses permission bits (CI runs as root)
  it.skipIf(process.platform === 'win32' || isRoot)(
    '--apply to read-only out-dir → exit 2 with write-failed action',
    () => {
      setupTemplateDir(tmpBase);
      const manifestPath = writeManifest(tmpBase, {
        version: 1,
        repos: [
          { id: 1, path: 'org/locked-repo', slug: 'locked-repo', tier: 'active', visibility: 'private' },
        ],
      });

      // Make outDir read-only
      chmodSync(outDir, 0o444);

      const { status, stdout } = run(
        ['--yes', manifestPath, '--apply', '--out-dir', outDir],
        { env: { PROJECTS_BASELINE_DIR: tmpBase, HOME: homedir(), PATH: '/usr/bin:/bin' } },
      );

      // Restore before cleanup
      chmodSync(outDir, 0o755);

      expect(status).toBe(2);
      const actions = parseActions(stdout);
      const failed = actions.find((a) => a.action === 'write-failed');
      expect(failed).toBeDefined();
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 11: Template file missing → exit 2
// ---------------------------------------------------------------------------

describe('template loading', () => {
  it('missing PROJECTS_BASELINE_DIR template → exit 2 mentioning env var', () => {
    const manifestPath = writeManifest(tmpBase, {
      version: 1,
      repos: [
        { id: 1, path: 'g/r', slug: 'my-repo', tier: 'active', visibility: 'internal' },
      ],
    });

    const { status, stderr } = run(
      ['--yes', manifestPath],
      { env: { PROJECTS_BASELINE_DIR: '/tmp/__nonexistent_so_test__', HOME: homedir() } },
    );

    expect(status).toBe(2);
    expect(stderr).toContain('PROJECTS_BASELINE_DIR');
  });
});

// ---------------------------------------------------------------------------
// Scenario 12: renderTemplate unit tests
// ---------------------------------------------------------------------------

import { renderTemplate } from '@lib/vault-backfill/template.mjs';

describe('renderTemplate (unit)', () => {
  // Build a template that covers all substitution tokens.
  const TEST_TEMPLATE = [
    'apiVersion: vault.gotzendorfer/v1',
    'metadata:',
    '  name: "{{PROJECT_NAME}}"',
    '  slug: "{{PROJECT_NAME}}"',
    '  tier: active',
    '  owner: bernhard',
    'spec:',
    '  summary: "{{PROJECT_NAME}} — summary TODO"',
    '  links:',
    '    gitlab: "{{GITLAB_GROUP}}/{{PROJECT_NAME}}"',
    '',
  ].join('\n');

  it('substitutes {{PROJECT_NAME}} with humanName in name field', () => {
    const out = renderTemplate(
      { humanName: 'Auth Service', slug: 'auth-service', tier: 'active', gitlabPath: 'org/auth-service', owner: 'alice' },
      TEST_TEMPLATE,
    );
    expect(out).toContain('name: "Auth Service"');
  });

  it('sets metadata.slug line to the actual slug, not the human name', () => {
    const out = renderTemplate(
      { humanName: 'Auth Service', slug: 'auth-service', tier: 'active', gitlabPath: 'org/auth-service', owner: 'alice' },
      TEST_TEMPLATE,
    );
    expect(out).toContain('slug: "auth-service"');
    // The slug line must NOT contain "Auth Service"
    const slugLine = out.split('\n').find((l) => /^\s*slug:/.test(l));
    expect(slugLine).toBeDefined();
    expect(slugLine).not.toContain('Auth Service');
  });

  it('replaces tier: active with the manifest tier', () => {
    const out = renderTemplate(
      { humanName: 'Archive App', slug: 'archive-app', tier: 'archived', gitlabPath: 'org/archive-app', owner: 'bob' },
      TEST_TEMPLATE,
    );
    // The tier line should reflect the manifest value
    const tierLine = out.split('\n').find((l) => /^\s*tier:/.test(l));
    expect(tierLine).toBeDefined();
    expect(tierLine).toContain('archived');
  });

  it('replaces owner field with resolved owner', () => {
    const out = renderTemplate(
      { humanName: 'My App', slug: 'my-app', tier: 'active', gitlabPath: 'org/my-app', owner: 'charlie' },
      TEST_TEMPLATE,
    );
    const ownerLine = out.split('\n').find((l) => /^\s*owner:/.test(l));
    expect(ownerLine).toBeDefined();
    expect(ownerLine).toContain('charlie');
  });

  it('replaces {{GITLAB_GROUP}}/{{PROJECT_NAME}} with full gitlabPath', () => {
    const out = renderTemplate(
      { humanName: 'My App', slug: 'my-app', tier: 'active', gitlabPath: 'my-group/my-app', owner: 'alice' },
      TEST_TEMPLATE,
    );
    expect(out).toContain('my-group/my-app');
    // Original tokens must be gone
    expect(out).not.toContain('{{GITLAB_GROUP}}');
  });

  it('prepends the generator marker comment line', () => {
    const out = renderTemplate(
      { humanName: 'My App', slug: 'my-app', tier: 'active', gitlabPath: 'g/my-app', owner: 'alice' },
      TEST_TEMPLATE,
    );
    expect(out.startsWith('# Generated by scripts/vault-backfill.mjs')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 13: pathToSlug unit tests
// ---------------------------------------------------------------------------

import { pathToSlug } from '@lib/vault-backfill/template.mjs';

describe('pathToSlug (unit)', () => {
  it.each([
    ['auth-service', 'auth-service'],
    ['Auth_Service', 'auth-service'],
    ['auth.service.v2', 'auth-service-v2'],
    ['my-group/my-repo', 'my-repo'],
    ['my--repo', 'my-repo'],
    ['-repo-', 'repo'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(pathToSlug(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Scenario 14: validateManifest unit tests
// ---------------------------------------------------------------------------

import { validateManifest } from '@lib/vault-backfill/manifest.mjs';

describe('validateManifest (unit)', () => {
  /**
   * Collect the first die() call without actually calling process.exit.
   * Returns the error message string or null if no die was invoked.
   */
  function collectError(raw) {
    let caught = null;
    try {
      validateManifest(raw, (code, msg) => {
        caught = msg;
        throw new Error(`EXIT_${code}: ${msg}`);
      });
    } catch {
      // expected
    }
    return caught;
  }

  it('valid manifest returns normalised repos array', () => {
    const result = validateManifest(
      {
        version: 1,
        repos: [
          { id: 1, path: 'group/repo', slug: 'my-repo', tier: 'active', visibility: 'internal' },
        ],
      },
      (c, m) => { throw new Error(m); },
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 1,
      path: 'group/repo',
      slug: 'my-repo',
      tier: 'active',
      visibility: 'internal',
      skip: false,
    });
  });

  it('version field is required to be 1', () => {
    const err = collectError({ version: 3, repos: [] });
    expect(err).not.toBeNull();
    expect(err).toContain('version');
  });

  it('repos must be an array', () => {
    const err = collectError({ version: 1, repos: 'not-an-array' });
    expect(err).not.toBeNull();
    expect(err).toContain('repos');
  });

  it('empty repos array is accepted (no-op)', () => {
    const result = validateManifest(
      { version: 1, repos: [] },
      (c, m) => { throw new Error(m); },
    );
    expect(result).toHaveLength(0);
  });

  it('missing id field fails validation', () => {
    const err = collectError({
      version: 1,
      repos: [{ path: 'g/r', slug: 'my-repo', tier: 'active', visibility: 'internal' }],
    });
    expect(err).not.toBeNull();
    expect(err).toContain('id');
  });

  it('missing path field fails validation', () => {
    const err = collectError({
      version: 1,
      repos: [{ id: 1, slug: 'my-repo', tier: 'active', visibility: 'internal' }],
    });
    expect(err).not.toBeNull();
    expect(err).toContain('path');
  });

  it.each([
    ['a single project segment', 'project'],
    ['a leading separator', '/group/project'],
    ['a trailing separator', 'group/project/'],
    ['an empty nested segment', 'group//project'],
    ['a dot segment', 'group/./project'],
    ['a traversal segment', '../../manifest-response-sentinel'],
    ['a backslash', 'group\\project'],
    ['whitespace', 'group/repo name'],
    ['a URI fragment delimiter', 'group/repo#fragment'],
    ['a URI escape delimiter', 'group/repo%2Fother'],
    ['a colon delimiter', 'group/repo:tag'],
    ['a control character', 'group/repo\nother'],
  ])('rejects %s without echoing the untrusted manifest path', (_description, path) => {
    const err = collectError({
      version: 1,
      repos: [{ id: 1065, path, slug: 'repo', tier: 'active', visibility: 'private' }],
    });

    expect(err).toBe('manifest.repos[0].path must be a valid GitLab namespace/project path');
  });

  it('slug with uppercase letters fails validation', () => {
    const err = collectError({
      version: 1,
      repos: [{ id: 1, path: 'g/r', slug: 'My-Repo', tier: 'active', visibility: 'internal' }],
    });
    expect(err).not.toBeNull();
    expect(err).toContain('slug');
  });

  it('invalid tier fails validation', () => {
    const err = collectError({
      version: 1,
      repos: [{ id: 1, path: 'g/r', slug: 'my-repo', tier: 'premium', visibility: 'internal' }],
    });
    expect(err).not.toBeNull();
    expect(err).toContain('tier');
  });

  it('invalid visibility fails validation', () => {
    const err = collectError({
      version: 1,
      repos: [{ id: 1, path: 'g/r', slug: 'my-repo', tier: 'active', visibility: 'secret' }],
    });
    expect(err).not.toBeNull();
    expect(err).toContain('visibility');
  });

  it('skip:true is preserved in output', () => {
    const result = validateManifest(
      {
        version: 1,
        repos: [
          { id: 2, path: 'g/s', slug: 'skip-me', tier: 'archived', visibility: 'private', skip: true },
        ],
      },
      (c, m) => { throw new Error(m); },
    );
    expect(result[0].skip).toBe(true);
  });

  it('skip defaults to false when not provided', () => {
    const result = validateManifest(
      {
        version: 1,
        repos: [
          { id: 3, path: 'g/r', slug: 'no-skip', tier: 'top', visibility: 'public' },
        ],
      },
      (c, m) => { throw new Error(m); },
    );
    expect(result[0].skip).toBe(false);
  });

  it.each(['top', 'active', 'archived'])('accepts the valid tier %s', (tier) => {
    const result = validateManifest(
      {
        version: 1,
        repos: [{ id: 1, path: 'g/r', slug: 'repo', tier, visibility: 'public' }],
      },
      (_code, message) => { throw new Error(message); },
    );
    expect(result[0].tier).toBe(tier);
  });

  it.each(['public', 'internal', 'private'])('accepts the valid visibility %s', (visibility) => {
    const result = validateManifest(
      {
        version: 1,
        repos: [{ id: 1, path: 'g/r', slug: 'repo', tier: 'active', visibility }],
      },
      (_code, message) => { throw new Error(message); },
    );
    expect(result[0].visibility).toBe(visibility);
  });
});

// ---------------------------------------------------------------------------
// Scenario 15: yamlScalar — unit tests (Issue #247, CWE-1336)
// ---------------------------------------------------------------------------

import { yamlScalar } from '@lib/vault-backfill/template.mjs';

describe('yamlScalar (unit, #247)', () => {
  it.each([
    ['plain ASCII', 'alice', '"alice"'],
    ['an embedded newline', 'alice\nmalicious-key: malicious-value', '"alice\\nmalicious-key: malicious-value"'],
    ['an embedded carriage return', 'alice\r\nbob', '"alice\\r\\nbob"'],
    ['a colon', 'ns:path', '"ns:path"'],
    ['a hash', 'alice # injected comment', '"alice # injected comment"'],
    ['a backslash', 'a\\b', '"a\\\\b"'],
    ['an embedded double quote', 'say "hello"', '"say \\"hello\\""'],
    ['the empty string', '', '""'],
    ['a non-string value', undefined, '"undefined"'],
  ])('returns a quoted scalar for %s', (_label, input, expected) => {
    expect(yamlScalar(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Scenario 16: renderTemplate YAML injection regression (Issue #247, CWE-1336)
// ---------------------------------------------------------------------------

describe('renderTemplate — YAML injection regression (#247)', () => {
  const INJECTION_TEMPLATE = [
    'apiVersion: vault.gotzendorfer/v1',
    'metadata:',
    '  name: "{{PROJECT_NAME}}"',
    '  slug: "{{PROJECT_NAME}}"',
    '  tier: active',
    '  owner: bernhard',
    'spec:',
    '  summary: "{{PROJECT_NAME}} — summary TODO"',
    '  links:',
    '    gitlab: "{{GITLAB_GROUP}}/{{PROJECT_NAME}}"',
    '',
  ].join('\n');

  it('newline in owner does not inject a new YAML key', () => {
    const out = renderTemplate(
      {
        humanName: 'My App',
        slug: 'my-app',
        tier: 'active',
        gitlabPath: 'org/my-app',
        owner: 'alice\nmalicious-key: malicious-value',
      },
      INJECTION_TEMPLATE,
    );
    // The raw string "malicious-key:" must not appear on its own line
    expect(out).not.toMatch(/^malicious-key:/m);
    // The owner line must be a single quoted scalar
    const ownerLine = out.split('\n').find((l) => /^\s*owner:/.test(l));
    expect(ownerLine).toBeDefined();
    expect(ownerLine).toContain('"alice\\nmalicious-key: malicious-value"');
  });

  it('newline in gitlabPath does not inject a new YAML key', () => {
    const out = renderTemplate(
      {
        humanName: 'My App',
        slug: 'my-app',
        tier: 'active',
        gitlabPath: 'org/my-app\nevil-key: evil-value',
        owner: 'alice',
      },
      INJECTION_TEMPLATE,
    );
    expect(out).not.toMatch(/^evil-key:/m);
    // gitlabPath must appear as a quoted value in the output
    const gitlabLine = out.split('\n').find((l) => /gitlab:/.test(l));
    expect(gitlabLine).toBeDefined();
    expect(gitlabLine).toContain('"org/my-app\\nevil-key: evil-value"');
  });

  it('clean owner string round-trips without over-escaping (valid YAML scalar)', () => {
    const out = renderTemplate(
      {
        humanName: 'My App',
        slug: 'my-app',
        tier: 'active',
        gitlabPath: 'org/my-app',
        owner: 'bernhard',
      },
      INJECTION_TEMPLATE,
    );
    const ownerLine = out.split('\n').find((l) => /^\s*owner:/.test(l));
    expect(ownerLine).toBe('  owner: "bernhard"');
  });

  it('clean gitlabPath round-trips without over-escaping (valid YAML scalar)', () => {
    const out = renderTemplate(
      {
        humanName: 'My App',
        slug: 'my-app',
        tier: 'active',
        gitlabPath: 'my-group/my-app',
        owner: 'alice',
      },
      INJECTION_TEMPLATE,
    );
    const gitlabLine = out.split('\n').find((l) => /gitlab:/.test(l));
    expect(gitlabLine).toBe('    gitlab: "my-group/my-app"');
  });

  it('owner with special YAML chars (colon, hash) is safely quoted', () => {
    const out = renderTemplate(
      {
        humanName: 'My App',
        slug: 'my-app',
        tier: 'active',
        gitlabPath: 'org/my-app',
        owner: 'namespace:group # comment',
      },
      INJECTION_TEMPLATE,
    );
    expect(out).not.toMatch(/^# comment/m);
    const ownerLine = out.split('\n').find((l) => /^\s*owner:/.test(l));
    expect(ownerLine).toContain('"namespace:group # comment"');
  });
});
