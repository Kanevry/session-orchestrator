/**
 * tests/skills/vault-sync-baseline-modes.test.mjs
 *
 * Integration tests for skills/vault-sync/validator.mjs --mode=baseline|diff|full
 * and legacy hard/bare-invocation backward compatibility (issue #327).
 *
 * Each test creates a minimal vault via mkdtempSync(), spawns the validator as
 * a subprocess, and asserts on exit code + stdout JSON shape.
 *
 * Vault structure used:
 *   <vault>/
 *     _meta/                       ← isVaultDir marker
 *     bad.md                       ← invalid frontmatter (type: memo is not in enum)
 *     good.md                      ← valid frontmatter
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const VALIDATOR_MJS = join(REPO_ROOT, 'skills/vault-sync/validator.mjs');

// ── Shared note fixtures ─────────────────────────────────────────────────────

/** Valid note — passes all schema constraints. */
const GOOD_NOTE = [
  '---',
  'id: good-note',
  'type: note',
  'created: 2026-05-08',
  'updated: 2026-05-08',
  '---',
  '',
  'Body.',
  '',
].join('\n');

/** Invalid note — `type: memo` is not a valid vaultNoteTypeSchema enum value. */
const BAD_NOTE = [
  '---',
  'id: bad-note',
  'type: memo',
  'created: 2026-05-08',
  'updated: 2026-05-08',
  '---',
  '',
  'Body.',
  '',
].join('\n');

/** Second invalid note with a distinct id — used to introduce a new error after baseline. */
const ANOTHER_BAD_NOTE = [
  '---',
  'id: another-bad',
  'type: badtype',
  'created: 2026-05-08',
  'updated: 2026-05-08',
  '---',
  '',
  'Body.',
  '',
].join('\n');

// ── Temp-dir management ──────────────────────────────────────────────────────

const tmpDirs = [];

function makeVault(prefix = 'vsb-int-') {
  const vault = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(vault);
  mkdirSync(join(vault, '_meta'), { recursive: true });
  writeFileSync(join(vault, 'bad.md'), BAD_NOTE, 'utf8');
  writeFileSync(join(vault, 'good.md'), GOOD_NOTE, 'utf8');
  return vault;
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

// ── Helper ───────────────────────────────────────────────────────────────────

/**
 * Spawn the validator with VAULT_DIR=vaultDir.
 * Returns { stdout, stderr, exitCode }.
 * Never throws — non-zero exits are captured.
 */
function runValidator(vaultDir, extraArgs = []) {
  let stdout;
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('node', [VALIDATOR_MJS, ...extraArgs], {
      encoding: 'utf8',
      env: { ...process.env, VAULT_DIR: vaultDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    stdout = err.stdout?.toString() ?? '';
    stderr = err.stderr?.toString() ?? '';
    exitCode = err.status ?? -1;
  }
  return { stdout: stdout ?? '', stderr, exitCode };
}

const BASELINE_JSON = (vault) =>
  join(vault, '.orchestrator', 'metrics', 'vault-sync-baseline.json');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('vault-sync validator — mode=baseline', () => {
  it('--mode=baseline writes baseline file and exits 0', () => {
    const vault = makeVault();
    const { exitCode } = runValidator(vault, ['--mode=baseline']);

    expect(exitCode).toBe(0);
    expect(existsSync(BASELINE_JSON(vault))).toBe(true);
  });

  it('--mode=baseline baseline file has correct required shape', () => {
    const vault = makeVault();
    runValidator(vault, ['--mode=baseline']);

    const data = JSON.parse(readFileSync(BASELINE_JSON(vault), 'utf8'));
    // All required header fields must be present
    expect(typeof data.schema_hash).toBe('string');
    expect(data.schema_hash).toHaveLength(8);
    expect(typeof data.generated_at).toBe('string');
    expect(data.generated_at).not.toBe('');
    expect(typeof data.vault_dir).toBe('string');
    expect(typeof data.error_count).toBe('number');
    expect(typeof data.warning_count).toBe('number');
    expect(Array.isArray(data.errors)).toBe(true);
    expect(Array.isArray(data.warnings)).toBe(true);
    // The bad.md note must be captured as 1 error
    expect(data.error_count).toBe(1);
  });
});

describe('vault-sync validator — mode=diff after baseline', () => {
  it('--mode=diff after baseline with same vault → exits 0 and new_errors is empty', () => {
    const vault = makeVault();
    runValidator(vault, ['--mode=baseline']);

    const { stdout, exitCode } = runValidator(vault, ['--mode=diff']);

    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.new_errors).toEqual([]);
  });

  it('--mode=diff after baseline + new invalid note → exits 1, new_errors has 1 entry', () => {
    const vault = makeVault();
    runValidator(vault, ['--mode=baseline']);

    // Introduce a brand-new error not present in the baseline
    writeFileSync(join(vault, 'another.md'), ANOTHER_BAD_NOTE, 'utf8');

    const { stdout, exitCode } = runValidator(vault, ['--mode=diff']);

    expect(exitCode).toBe(1);
    const data = JSON.parse(stdout);
    expect(data.new_errors).toHaveLength(1);
    expect(data.new_errors[0].file).toBe('another.md');
  });

  it('--mode=diff stdout JSON has required diff keys', () => {
    const vault = makeVault();
    runValidator(vault, ['--mode=baseline']);

    const { stdout } = runValidator(vault, ['--mode=diff']);
    const data = JSON.parse(stdout);

    expect(data).toHaveProperty('new_errors');
    expect(data).toHaveProperty('resolved_errors');
    expect(data).toHaveProperty('new_warnings');
    expect(data).toHaveProperty('resolved_warnings');
    expect(data).toHaveProperty('baseline_count');
    expect(data).toHaveProperty('current_count');
    expect(data).toHaveProperty('schema_hash');
  });
});

describe('vault-sync validator — mode=diff without baseline', () => {
  it('--mode=diff with no baseline file falls back to full enforcement, emits WARN on stderr', () => {
    const vault = makeVault();
    // Deliberately do NOT run --mode=baseline first

    const { stderr, exitCode } = runValidator(vault, ['--mode=diff']);

    // With errors in vault, fallback full enforcement exits 1
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/WARN/);
    expect(stderr).toMatch(/no baseline found/);
  });

  it('--mode=diff with no baseline file emits mode=diff-fallback-full in stdout JSON', () => {
    const vault = makeVault();

    const { stdout } = runValidator(vault, ['--mode=diff']);
    const data = JSON.parse(stdout);

    expect(data.mode).toBe('diff-fallback-full');
  });
});

describe('vault-sync validator — mode=full vs hard backward compatibility', () => {
  it('--mode=full exits 1 and status=invalid when vault has errors', () => {
    const vault = makeVault();
    const { stdout, exitCode } = runValidator(vault, ['--mode=full']);

    expect(exitCode).toBe(1);
    const data = JSON.parse(stdout);
    expect(data.status).toBe('invalid');
    expect(data.mode).toBe('full');
  });

  it('bare invocation (no --mode) defaults to hard — same exit code and status as full on errors', () => {
    const vault = makeVault();
    const { stdout: bareOut, exitCode: bareExit } = runValidator(vault);
    const { stdout: fullOut, exitCode: fullExit } = runValidator(vault, ['--mode=full']);

    const bareData = JSON.parse(bareOut);
    const fullData = JSON.parse(fullOut);

    expect(bareExit).toBe(1);
    expect(fullExit).toBe(1);
    // Both must report errors of the same count
    expect(bareData.errors.length).toBe(fullData.errors.length);
    // Bare invocation mode is 'hard' (the legacy name), full is 'full'
    expect(bareData.mode).toBe('hard');
    expect(fullData.mode).toBe('full');
    // Both status === 'invalid'
    expect(bareData.status).toBe('invalid');
    expect(fullData.status).toBe('invalid');
  });
});
