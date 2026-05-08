/**
 * tests/skills/vault-sync-exclude.test.mjs
 *
 * Regression tests for issue #329 (W3 B1):
 *   skills/vault-sync/validator.mjs unconditionally loads
 *   `vault-sync.exclude` from <VAULT_DIR>/CLAUDE.md (or AGENTS.md) BEFORE
 *   parsing argv, so bare invocations honour the project's configured
 *   exclusion list. CLI --exclude flags remain additive.
 *
 * Each test creates its own tempdir via mkdtempSync('vsync-exclude-…') and
 * cleans up afterwards. Spawns the validator as a subprocess via
 * execFileSync('node', [validator.mjs], { cwd, env: { VAULT_DIR } }).
 *
 * Source under test: skills/vault-sync/validator.mjs lines 113–141
 *   ("Unconditional config-loaded excludes (issue #329)")
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const VALIDATOR_MJS = join(REPO_ROOT, 'skills/vault-sync/validator.mjs');

// ── Helpers ─────────────────────────────────────────────────────────────────

const tmpDirs = [];

function makeTmpVault(prefix = 'vsync-exclude-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/**
 * Run the validator against `vaultDir`. Captures stdout (JSON) and stderr
 * separately. Tolerates non-zero exit codes (validation failures emit JSON
 * on stdout AND exit 1 — that's expected and we still need to parse the
 * payload).
 *
 * @param {string} vaultDir - VAULT_DIR env var value
 * @param {string[]} extraArgs - extra CLI args (e.g. ['--exclude', 'glob'])
 * @param {object} options - {cwd?: string, env?: object}
 */
function runValidator(vaultDir, extraArgs = [], options = {}) {
  const { cwd = vaultDir, env: extraEnv = {} } = options;
  let stdout;
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('node', [VALIDATOR_MJS, ...extraArgs], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, VAULT_DIR: vaultDir, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Non-zero exit (e.g. 1 for validation failure). The validator still
    // emits a well-formed JSON payload on stdout.
    stdout = err.stdout?.toString() ?? '';
    stderr = err.stderr?.toString() ?? '';
    exitCode = err.status ?? -1;
  }
  return { stdout, stderr, exitCode };
}

/** Minimal `## Session Config` + `vault-sync:` marker — required by isVaultDir. */
function vaultMarkerSessionConfig(extraVaultSync = '') {
  return [
    '# Project',
    '',
    '## Session Config',
    '',
    'vault-sync:',
    '  enabled: true',
    extraVaultSync,
    '',
  ].join('\n');
}

/** A note with intentionally INVALID frontmatter (unknown `type` enum value). */
const BAD_NOTE = [
  '---',
  'id: bad-note',
  'type: memo',           // invalid: not in enum
  'created: 2026-05-08',
  'updated: 2026-05-08',
  '---',
  '',
  'Body.',
  '',
].join('\n');

/** A note with valid frontmatter so the validator has something to count. */
const GOOD_NOTE = [
  '---',
  'id: good-note',
  'type: note',
  'created: 2026-05-08',
  'updated: 2026-05-08',
  '---',
  '',
  'Hello.',
  '',
].join('\n');

function writeFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

// ── 1. bare-invocation-reads-CLAUDE.md ─────────────────────────────────────

describe('vault-sync exclude — config-loaded excludes (issue #329)', () => {
  it('bare invocation reads vault-sync.exclude from <VAULT_DIR>/CLAUDE.md', () => {
    const vault = makeTmpVault();
    writeFile(
      join(vault, 'CLAUDE.md'),
      vaultMarkerSessionConfig(['  exclude:', '    - "**/_MOC.md"'].join('\n')),
    );
    writeFile(join(vault, 'topic', '_MOC.md'), BAD_NOTE);
    writeFile(join(vault, 'topic', 'good.md'), GOOD_NOTE);

    const { stdout } = runValidator(vault);
    const parsed = JSON.parse(stdout);
    expect(parsed.excluded_count).toBeGreaterThanOrEqual(1);
    // No error should reference the excluded _MOC.md file
    const mocErrors = (parsed.errors || []).filter((e) => e.file && e.file.includes('_MOC.md'));
    expect(mocErrors.length).toBe(0);
  });

  // ── 2. CLI-flag-is-additive ────────────────────────────────────────────────

  it('CLI --exclude flag is additive on top of config excludes', () => {
    const vault = makeTmpVault();
    writeFile(
      join(vault, 'CLAUDE.md'),
      vaultMarkerSessionConfig(['  exclude:', '    - "**/_MOC.md"'].join('\n')),
    );
    writeFile(join(vault, 'topic', '_MOC.md'), BAD_NOTE);
    writeFile(join(vault, 'topic', 'README.md'), BAD_NOTE);

    const { stdout } = runValidator(vault, ['--exclude', '**/README.md']);
    const parsed = JSON.parse(stdout);
    // Both files should be excluded → excluded_count >= 2
    expect(parsed.excluded_count).toBeGreaterThanOrEqual(2);
    // Neither excluded file should appear in the errors list
    const leakage = (parsed.errors || []).filter(
      (e) => e.file && (e.file.includes('_MOC.md') || e.file.includes('README.md')),
    );
    expect(leakage.length).toBe(0);
  });

  // ── 3. missing-CLAUDE.md-falls-back-silently ──────────────────────────────

  it('missing CLAUDE.md/AGENTS.md falls back silently (no throw, well-formed JSON)', () => {
    const vault = makeTmpVault();
    // No CLAUDE.md / AGENTS.md, but provide _meta/ as a vault marker so
    // isVaultDir() succeeds and we can exercise the config-load fallback.
    mkdirSync(join(vault, '_meta'), { recursive: true });
    writeFile(join(vault, 'good.md'), GOOD_NOTE);

    const { stdout, stderr } = runValidator(vault);
    // stdout MUST be well-formed JSON
    const parsed = JSON.parse(stdout);
    expect(typeof parsed).toBe('object');
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('excluded_count');
    expect(parsed.excluded_count).toBe(0);
    // No error in stderr referencing a config-load failure
    expect(stderr).not.toMatch(/config|parse|exclude/i);
  });

  // ── 4. unparseable-CLAUDE.md-falls-back-silently ──────────────────────────

  it('unparseable CLAUDE.md (malformed YAML in vault-sync block) falls back silently', () => {
    const vault = makeTmpVault();
    // Malformed: `exclude:` followed by an unbalanced bracket scalar
    writeFile(
      join(vault, 'CLAUDE.md'),
      vaultMarkerSessionConfig(['  exclude: "[**/_MOC.md'].join('\n')),
    );
    writeFile(join(vault, 'good.md'), GOOD_NOTE);

    const { stdout } = runValidator(vault);
    // Must not throw — stdout is well-formed JSON
    const parsed = JSON.parse(stdout);
    expect(typeof parsed).toBe('object');
    expect(parsed).toHaveProperty('excluded_count');
    // Config-side excludes are 0 (parser returned non-array or []).
    expect(parsed.excluded_count).toBe(0);
  });

  // ── 5. AGENTS.md-alias-honoured ───────────────────────────────────────────

  it('AGENTS.md alias is honoured when CLAUDE.md is absent', () => {
    const vault = makeTmpVault();
    writeFile(
      join(vault, 'AGENTS.md'),
      vaultMarkerSessionConfig(['  exclude:', '    - "**/_MOC.md"'].join('\n')),
    );
    writeFile(join(vault, 'topic', '_MOC.md'), BAD_NOTE);
    writeFile(join(vault, 'topic', 'good.md'), GOOD_NOTE);

    const { stdout } = runValidator(vault);
    const parsed = JSON.parse(stdout);
    expect(parsed.excluded_count).toBeGreaterThanOrEqual(1);
    const mocErrors = (parsed.errors || []).filter((e) => e.file && e.file.includes('_MOC.md'));
    expect(mocErrors.length).toBe(0);
  });

  // ── 6. VAULT_DIR-env-wins-over-cwd ─────────────────────────────────────────

  it('VAULT_DIR env var wins over cwd for config resolution', () => {
    const vaultA = makeTmpVault('vsync-exclude-A-');
    const vaultB = makeTmpVault('vsync-exclude-B-');

    // Vault A — has CLAUDE.md with exclude pattern AND a target file matching it
    writeFile(
      join(vaultA, 'CLAUDE.md'),
      vaultMarkerSessionConfig(['  exclude:', '    - "**/_MOC.md"'].join('\n')),
    );
    writeFile(join(vaultA, 'topic', '_MOC.md'), BAD_NOTE);
    writeFile(join(vaultA, 'topic', 'good.md'), GOOD_NOTE);

    // Vault B — vault marker only (no CLAUDE.md), no exclude config
    mkdirSync(join(vaultB, '_meta'), { recursive: true });
    writeFile(join(vaultB, 'b.md'), GOOD_NOTE);

    // Run from cwd=B but VAULT_DIR=A → A's CLAUDE.md must drive the excludes
    const { stdout } = runValidator(vaultA, [], { cwd: vaultB });
    const parsed = JSON.parse(stdout);
    expect(parsed.excluded_count).toBeGreaterThanOrEqual(1);
    // The validator should report A as its vault_dir, not B
    expect(parsed.vault_dir).toContain(vaultA.split(sep).pop());
  });

  // ── 7. non-array-exclude-does-not-crash ───────────────────────────────────

  it('non-array exclude (string scalar) does not crash; excluded_count = 0', () => {
    const vault = makeTmpVault();
    // `exclude:` parses to a string, NOT an array → Array.isArray() guard
    // must short-circuit cleanly without throwing.
    writeFile(
      join(vault, 'CLAUDE.md'),
      vaultMarkerSessionConfig(['  exclude: "string-not-list"'].join('\n')),
    );
    writeFile(join(vault, 'good.md'), GOOD_NOTE);

    const { stdout } = runValidator(vault);
    const parsed = JSON.parse(stdout);
    expect(typeof parsed).toBe('object');
    expect(parsed).toHaveProperty('excluded_count');
    expect(parsed.excluded_count).toBe(0);
  });
});
