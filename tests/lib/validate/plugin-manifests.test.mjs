/**
 * tests/lib/validate/plugin-manifests.test.mjs
 *
 * Tests for scripts/validate-plugin-manifests.mjs (#475).
 *
 * The script is a CLI (not an importable module), so every test drives it via
 * spawnSync(process.execPath, [SCRIPT, ...]) — mirroring the pattern in
 * plugin-schema.test.mjs and check-owner-leakage.test.mjs.
 *
 * pluginRoot resolution (from script source):
 *   argv.find(a => !a.startsWith('--')) ?? join(fileURLToPath(import.meta.url), '..', '..')
 *
 * So the root is passed as a POSITIONAL CLI argument, not as cwd.
 * The `runScript` helper appends `root` after any flags so the script picks
 * it up from argv.  For the real-PLUGIN_ROOT live tests no positional arg is
 * passed — the script defaults to its own parent directory (= PLUGIN_ROOT).
 *
 * Network-dependent tests (live schemastore fetch) guard against offline CI:
 * if the script exits 2 AND stderr matches a fetch-error pattern the test is
 * skipped with a logged reason rather than failing.
 *
 * Exit codes per script header:
 *   0 — all manifests valid
 *   1 — one or more validation failures
 *   2 — system error (network, file I/O, AJV compile)
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(PLUGIN_ROOT, 'scripts', 'validate-plugin-manifests.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run the validate-plugin-manifests CLI synchronously.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.flags]  - flag args like ['--json']
 * @param {string|null} [opts.root] - positional pluginRoot arg; null = use
 *   the script's own default (= real PLUGIN_ROOT)
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runScript({ flags = [], root = null } = {}) {
  const args = [SCRIPT, ...flags];
  if (root !== null) args.push(root);
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

/**
 * Return true if a result should cause a live-fetch test to skip because
 * the schemastore was unreachable (exit 2 + network error in stderr).
 */
function isNetworkFailure(result) {
  return (
    result.status === 2 &&
    /fetch failed|HTTP|ETIMEDOUT|network error|ENOTFOUND/i.test(result.stderr)
  );
}

/**
 * Create a tmpdir, call setupFn(root) to populate it, and return the root.
 * No git init required — the script validates by path, not VCS tracking.
 *
 * @param {(root: string) => void} setupFn
 * @returns {string}
 */
function makeTmpRoot(setupFn) {
  const root = mkdtempSync(join(os.tmpdir(), 'plugin-manifests-test-'));
  setupFn(root);
  return root;
}

// Minimal valid plugin.json — only `name` is required by the schema.
const VALID_PLUGIN_JSON = JSON.stringify({
  $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
  name: 'test-plugin',
  version: '1.0.0',
  description: 'Fixture plugin for testing',
});

// Minimal valid marketplace.json — name, owner, plugins are required.
const VALID_MARKETPLACE_JSON = JSON.stringify({
  $schema: 'https://json.schemastore.org/claude-code-marketplace.json',
  name: 'test-namespace',
  owner: { name: 'Test Author' },
  plugins: [],
});

// ---------------------------------------------------------------------------
// 1. Script exists (sanity)
// ---------------------------------------------------------------------------

describe('script existence', () => {
  it('validate-plugin-manifests.mjs exists at expected path', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Happy path — real PLUGIN_ROOT (live schemastore fetch)
// ---------------------------------------------------------------------------

describe('happy path — real PLUGIN_ROOT manifests', () => {
  it('exits 0 when run against the real plugin root', { timeout: 30_000 }, (ctx) => {
    const result = runScript();

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    expect(result.status).toBe(0);
  });

  it('stdout contains PASS line for plugin.json', { timeout: 30_000 }, (ctx) => {
    const result = runScript();

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    expect(result.stdout).toContain(
      '  PASS: .claude-plugin/plugin.json validates against schemastore (plugin-manifest)',
    );
  });

  it('stdout contains PASS line for marketplace.json', { timeout: 30_000 }, (ctx) => {
    const result = runScript();

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    expect(result.stdout).toContain(
      '  PASS: .claude-plugin/marketplace.json validates against schemastore (marketplace)',
    );
  });

  it('stdout does not contain any FAIL line when real manifests are valid', { timeout: 30_000 }, (ctx) => {
    const result = runScript();

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    expect(result.stdout).not.toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// 3. Invalid manifest — missing required field (tmpdir, live fetch)
// ---------------------------------------------------------------------------

describe('invalid manifest — missing required field in plugin.json', () => {
  it('exits 1 when plugin.json omits required "name" field', { timeout: 30_000 }, (ctx) => {
    const root = makeTmpRoot((r) => {
      mkdirSync(join(r, '.claude-plugin'), { recursive: true });
      // `name` is the only required field in the plugin schema; omit it
      writeFileSync(
        join(r, '.claude-plugin', 'plugin.json'),
        JSON.stringify({
          $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
          version: '3.6.0',
        }),
      );
      writeFileSync(join(r, '.claude-plugin', 'marketplace.json'), VALID_MARKETPLACE_JSON);
    });

    const result = runScript({ root });

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    expect(result.status).toBe(1);
  });

  it('stdout contains FAIL for plugin.json when name is missing', { timeout: 30_000 }, (ctx) => {
    const root = makeTmpRoot((r) => {
      mkdirSync(join(r, '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(r, '.claude-plugin', 'plugin.json'),
        JSON.stringify({
          $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
          version: '3.6.0',
        }),
      );
      writeFileSync(join(r, '.claude-plugin', 'marketplace.json'), VALID_MARKETPLACE_JSON);
    });

    const result = runScript({ root });

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    expect(result.stdout).toContain('  FAIL: .claude-plugin/plugin.json');
  });

  it('stdout contains AJV error text identifying the missing required property', { timeout: 30_000 }, (ctx) => {
    const root = makeTmpRoot((r) => {
      mkdirSync(join(r, '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(r, '.claude-plugin', 'plugin.json'),
        JSON.stringify({
          $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
          version: '3.6.0',
        }),
      );
      writeFileSync(join(r, '.claude-plugin', 'marketplace.json'), VALID_MARKETPLACE_JSON);
    });

    const result = runScript({ root });

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    // AJV draft-07 emits either "missingProperty" or "must have required property"
    const hasMissingPropText =
      result.stdout.includes('missingProperty') ||
      result.stdout.includes('must have required property');
    expect(hasMissingPropText).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Invalid manifest — wrong type in marketplace.json (tmpdir, live fetch)
// ---------------------------------------------------------------------------

describe('invalid manifest — wrong type in marketplace.json', () => {
  it('exits 1 when marketplace.json has name: 42 (number where string required)', { timeout: 30_000 }, (ctx) => {
    const root = makeTmpRoot((r) => {
      mkdirSync(join(r, '.claude-plugin'), { recursive: true });
      writeFileSync(join(r, '.claude-plugin', 'plugin.json'), VALID_PLUGIN_JSON);
      writeFileSync(
        join(r, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          $schema: 'https://json.schemastore.org/claude-code-marketplace.json',
          name: 42,
          owner: { name: 'Test' },
          plugins: [],
        }),
      );
    });

    const result = runScript({ root });

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    expect(result.status).toBe(1);
  });

  it('stdout contains FAIL for marketplace.json on type error', { timeout: 30_000 }, (ctx) => {
    const root = makeTmpRoot((r) => {
      mkdirSync(join(r, '.claude-plugin'), { recursive: true });
      writeFileSync(join(r, '.claude-plugin', 'plugin.json'), VALID_PLUGIN_JSON);
      writeFileSync(
        join(r, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          $schema: 'https://json.schemastore.org/claude-code-marketplace.json',
          name: 42,
          owner: { name: 'Test' },
          plugins: [],
        }),
      );
    });

    const result = runScript({ root });

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    expect(result.stdout).toContain('  FAIL: .claude-plugin/marketplace.json');
  });
});

// ---------------------------------------------------------------------------
// 5. Missing manifest files (tmpdir — no network needed; existsSync check
//    happens before any schema fetch)
// ---------------------------------------------------------------------------

describe('missing manifest files', () => {
  it('exits 1 when neither plugin.json nor marketplace.json exist', () => {
    const root = makeTmpRoot((_r) => {
      // Intentionally create no .claude-plugin/ directory
    });

    const result = runScript({ root });

    expect(result.status).toBe(1);
  });

  it('stdout contains FAIL when plugin.json is absent', () => {
    const root = makeTmpRoot((_r) => {
      // No .claude-plugin/ directory
    });

    const result = runScript({ root });

    expect(result.stdout).toContain('  FAIL:');
  });

  it('stdout contains "File not found" when manifests are absent', () => {
    const root = makeTmpRoot((_r) => {
      // No .claude-plugin/ directory
    });

    const result = runScript({ root });

    expect(result.stdout).toContain('File not found');
  });
});

// ---------------------------------------------------------------------------
// 6. Malformed JSON in manifest (tmpdir — parse error is caught before the
//    network schema fetch, so these tests are network-independent)
// ---------------------------------------------------------------------------

describe('malformed JSON in manifest', () => {
  it('exits 1 when plugin.json contains broken JSON', () => {
    const root = makeTmpRoot((r) => {
      mkdirSync(join(r, '.claude-plugin'), { recursive: true });
      writeFileSync(join(r, '.claude-plugin', 'plugin.json'), '{broken json');
      writeFileSync(join(r, '.claude-plugin', 'marketplace.json'), VALID_MARKETPLACE_JSON);
    });

    const result = runScript({ root });

    expect(result.status).toBe(1);
  });

  it('stdout contains FAIL for plugin.json on JSON parse error', () => {
    const root = makeTmpRoot((r) => {
      mkdirSync(join(r, '.claude-plugin'), { recursive: true });
      writeFileSync(join(r, '.claude-plugin', 'plugin.json'), '{broken json');
      writeFileSync(join(r, '.claude-plugin', 'marketplace.json'), VALID_MARKETPLACE_JSON);
    });

    const result = runScript({ root });

    expect(result.stdout).toContain('  FAIL:');
  });

  it('stdout contains "parse error" (case-insensitive) for broken plugin.json', () => {
    const root = makeTmpRoot((r) => {
      mkdirSync(join(r, '.claude-plugin'), { recursive: true });
      writeFileSync(join(r, '.claude-plugin', 'plugin.json'), '{broken json');
      writeFileSync(join(r, '.claude-plugin', 'marketplace.json'), VALID_MARKETPLACE_JSON);
    });

    const result = runScript({ root });

    expect(result.stdout.toLowerCase()).toContain('parse error');
  });

  it('exits 1 when marketplace.json contains broken JSON', () => {
    const root = makeTmpRoot((r) => {
      mkdirSync(join(r, '.claude-plugin'), { recursive: true });
      writeFileSync(join(r, '.claude-plugin', 'plugin.json'), VALID_PLUGIN_JSON);
      writeFileSync(join(r, '.claude-plugin', 'marketplace.json'), '{not valid json at all');
    });

    // marketplace.json parse error is caught after plugin.json succeeds schema
    // validation; the script still exits 1 and reports FAIL for marketplace.
    const result = runScript({ root });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL: .claude-plugin/marketplace.json');
  });
});

// ---------------------------------------------------------------------------
// 7. --json flag (real PLUGIN_ROOT, live fetch)
// ---------------------------------------------------------------------------

describe('--json flag output', () => {
  it('exits 0 with --json flag against real PLUGIN_ROOT', { timeout: 30_000 }, (ctx) => {
    const result = runScript({ flags: ['--json'] });

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping live --json test — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    expect(result.status).toBe(0);
  });

  it('--json stdout is valid JSON', { timeout: 30_000 }, (ctx) => {
    const result = runScript({ flags: ['--json'] });

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping live --json test — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it('--json output has results array with length 2', { timeout: 30_000 }, (ctx) => {
    const result = runScript({ flags: ['--json'] });

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping live --json test — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    const parsed = JSON.parse(result.stdout);
    expect(parsed.results).toHaveLength(2);
  });

  it('--json output has ok: true for both result entries', { timeout: 30_000 }, (ctx) => {
    const result = runScript({ flags: ['--json'] });

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping live --json test — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    const parsed = JSON.parse(result.stdout);
    expect(parsed.results[0].ok).toBe(true);
    expect(parsed.results[1].ok).toBe(true);
  });

  it('--json output entries have manifest paths plugin.json and marketplace.json', { timeout: 30_000 }, (ctx) => {
    const result = runScript({ flags: ['--json'] });

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping live --json test — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    const parsed = JSON.parse(result.stdout);
    expect(parsed.results[0].manifest).toBe('.claude-plugin/plugin.json');
    expect(parsed.results[1].manifest).toBe('.claude-plugin/marketplace.json');
  });

  it('--json output entries have labels plugin-manifest and marketplace', { timeout: 30_000 }, (ctx) => {
    const result = runScript({ flags: ['--json'] });

    if (isNetworkFailure(result)) {
      console.warn('[plugin-manifests.test] Skipping live --json test — schemastore unreachable:', result.stderr.slice(0, 120));
      ctx.task.skip('schemastore unreachable');
      return;
    }

    const parsed = JSON.parse(result.stdout);
    expect(parsed.results[0].label).toBe('plugin-manifest');
    expect(parsed.results[1].label).toBe('marketplace');
  });
});
