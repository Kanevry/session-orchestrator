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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  it.skipIf(process.platform === 'win32')(
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
  it('already-kebab slug is unchanged', () => {
    expect(pathToSlug('auth-service')).toBe('auth-service');
  });

  it('Auth_Service → auth-service (uppercase + underscore)', () => {
    expect(pathToSlug('Auth_Service')).toBe('auth-service');
  });

  it('auth.service.v2 → auth-service-v2 (dots → hyphens)', () => {
    expect(pathToSlug('auth.service.v2')).toBe('auth-service-v2');
  });

  it('extracts last path segment from group/repo', () => {
    expect(pathToSlug('my-group/my-repo')).toBe('my-repo');
  });

  it('collapses multiple hyphens into one', () => {
    expect(pathToSlug('my--repo')).toBe('my-repo');
  });

  it('strips leading and trailing hyphens', () => {
    expect(pathToSlug('-repo-')).toBe('repo');
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

  it('all three valid tier values pass', () => {
    for (const tier of ['top', 'active', 'archived']) {
      const result = validateManifest(
        {
          version: 1,
          repos: [{ id: 1, path: 'g/r', slug: 'repo', tier, visibility: 'public' }],
        },
        (c, m) => { throw new Error(m); },
      );
      expect(result[0].tier).toBe(tier);
    }
  });

  it('all three valid visibility values pass', () => {
    for (const visibility of ['public', 'internal', 'private']) {
      const result = validateManifest(
        {
          version: 1,
          repos: [{ id: 1, path: 'g/r', slug: 'repo', tier: 'active', visibility }],
        },
        (c, m) => { throw new Error(m); },
      );
      expect(result[0].visibility).toBe(visibility);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 15: yamlScalar — unit tests (Issue #247, CWE-1336)
// ---------------------------------------------------------------------------

import { yamlScalar } from '@lib/vault-backfill/template.mjs';

describe('yamlScalar (unit, #247)', () => {
  it('wraps a plain ASCII string in double quotes', () => {
    expect(yamlScalar('alice')).toBe('"alice"');
  });

  it('escapes embedded newline — newline cannot create a new YAML key', () => {
    const result = yamlScalar('alice\nmalicious-key: malicious-value');
    // JSON.stringify encodes \n as \\n inside the quoted string
    expect(result).toBe('"alice\\nmalicious-key: malicious-value"');
    // The literal text "malicious-key:" must not appear unescaped
    expect(result).not.toContain('\nmalicious-key:');
  });

  it('escapes embedded carriage return', () => {
    expect(yamlScalar('alice\r\nbob')).toBe('"alice\\r\\nbob"');
  });

  it('escapes colon (YAML key separator)', () => {
    // JSON.stringify does NOT escape ":" because JSON strings allow it — but the
    // value is wrapped in double quotes, making it a YAML scalar, not a key.
    const result = yamlScalar('ns:path');
    expect(result).toBe('"ns:path"');
    expect(result.startsWith('"')).toBe(true);
    expect(result.endsWith('"')).toBe(true);
  });

  it('escapes hash character (YAML comment marker)', () => {
    const result = yamlScalar('alice # injected comment');
    expect(result).toBe('"alice # injected comment"');
  });

  it('escapes backslash', () => {
    expect(yamlScalar('a\\b')).toBe('"a\\\\b"');
  });

  it('escapes embedded double quote', () => {
    expect(yamlScalar('say "hello"')).toBe('"say \\"hello\\""');
  });

  it('handles empty string', () => {
    expect(yamlScalar('')).toBe('""');
  });

  it('coerces non-string to string before quoting', () => {
    // undefined → "undefined" (safe scalar)
    expect(yamlScalar(undefined)).toBe('"undefined"');
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
