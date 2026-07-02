/**
 * tests/scripts/run-quality-gate.test.mjs
 *
 * Vitest suite for scripts/run-quality-gate.mjs (issue #218).
 *
 * The script is a pass-through orchestrator that shells out to gate-*.sh
 * sub-scripts. Tests verify: CLI surface (help, argument validation, exit codes)
 * and JSON output shape. Sub-scripts are invoked with skip commands to keep
 * tests hermetic (no network, no build tool dependency).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { parseSessionConfig } from '@lib/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '../../scripts/run-quality-gate.mjs');
const REPO_ROOT = resolve(__dirname, '../../');

/**
 * Run scripts/run-quality-gate.mjs with the given argument list.
 * All spawns run with cwd = REPO_ROOT so that the policy-file loader and
 * gate-*.sh scripts can find their relative paths.
 *
 * @param {string[]} args
 * @param {Record<string, string>} [extraEnv]
 * @param {{cwd?: string}} [options]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function run(args, extraEnv = {}, options = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...extraEnv },
  });
}

function writeSkipPolicy(root) {
  const policyDir = join(root, '.orchestrator', 'policy');
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(
    join(policyDir, 'quality-gates.json'),
    JSON.stringify({
      version: 1,
      commands: {
        typecheck: { command: 'skip' },
        test: { command: 'skip' },
        lint: { command: 'skip' },
      },
    }),
    'utf8',
  );
}

function writeMarkerNpmProject(root) {
  writeFileSync(
    join(root, 'mark.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(`${process.argv[2]}.marker`, 'ok');",
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      scripts: {
        typecheck: 'node mark.mjs typecheck',
        test: 'node mark.mjs test',
        lint: 'node mark.mjs lint',
      },
    }),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// --help / -h
// ---------------------------------------------------------------------------

describe('run-quality-gate.mjs — help flag', () => {
  it('--help prints usage text and exits 0', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: run-quality-gate.mjs');
    expect(r.stdout).toContain('--variant');
    expect(r.stdout).toContain('baseline');
    expect(r.stdout).toContain('full-gate');
  });

  it('-h is an alias for --help and exits 0', () => {
    const r = run(['-h']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: run-quality-gate.mjs');
  });

  it('help output documents all four valid variants', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('baseline');
    expect(r.stdout).toContain('incremental');
    expect(r.stdout).toContain('full-gate');
    expect(r.stdout).toContain('per-file');
  });

  it('help output documents exit codes', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Exit codes');
  });
});

// ---------------------------------------------------------------------------
// Argument validation — missing / unknown / invalid variant
// ---------------------------------------------------------------------------

describe('run-quality-gate.mjs — argument validation', () => {
  it('exits 1 with informative ERROR when --variant is omitted', () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ERROR');
    expect(r.stderr).toContain('--variant');
  });

  it('exits 1 with informative ERROR for an unknown variant name', () => {
    const r = run(['--variant', 'nonexistent']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ERROR');
    expect(r.stderr).toContain('nonexistent');
  });

  it('includes allowed variant list in error message for invalid variant', () => {
    const r = run(['--variant', 'bogus']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('baseline');
    expect(r.stderr).toContain('full-gate');
  });

  it('exits 1 with ERROR for an unknown CLI flag', () => {
    const r = run(['--unknown-flag']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ERROR');
    expect(r.stderr).toContain('--unknown-flag');
  });

  it('exits 1 with ERROR when --variant is provided without a value', () => {
    const r = run(['--variant']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ERROR');
  });
});

// ---------------------------------------------------------------------------
// baseline variant — JSON output shape
// ---------------------------------------------------------------------------

describe('run-quality-gate.mjs — baseline variant', () => {
  it('exits 0 when both typecheck and test are skipped', () => {
    const config = JSON.stringify({ 'typecheck-command': 'skip', 'test-command': 'skip' });
    const r = run(['--variant', 'baseline', '--config', config]);
    expect(r.status).toBe(0);
  });

  it('produces valid JSON output for baseline with skip commands', () => {
    const config = JSON.stringify({ 'typecheck-command': 'skip', 'test-command': 'skip' });
    const r = run(['--variant', 'baseline', '--config', config]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toBeTypeOf('object');
    expect(parsed).not.toBeNull();
  });

  it('baseline JSON output contains the variant field set to "baseline"', () => {
    const config = JSON.stringify({ 'typecheck-command': 'skip', 'test-command': 'skip' });
    const r = run(['--variant', 'baseline', '--config', config]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.variant).toBe('baseline');
  });

  it('baseline JSON output contains typecheck and test keys', () => {
    const config = JSON.stringify({ 'typecheck-command': 'skip', 'test-command': 'skip' });
    const r = run(['--variant', 'baseline', '--config', config]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Object.keys(parsed)).toContain('typecheck');
    expect(Object.keys(parsed)).toContain('test');
  });

  it('baseline skips both checks when commands are "skip" — statuses are "skip"', () => {
    const config = JSON.stringify({ 'typecheck-command': 'skip', 'test-command': 'skip' });
    const r = run(['--variant', 'baseline', '--config', config]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.typecheck).toBe('skip');
    expect(parsed.test).toBe('skip');
  });
});

describe('run-quality-gate.mjs — parser default command integration', () => {
  it('uses npm defaults from parseSessionConfig output instead of stale pnpm/tsgo defaults', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qg-parser-defaults-'));
    writeMarkerNpmProject(tmp);

    const config = parseSessionConfig('## Session Config\n\npersistence: true\n');
    const r = run(
      ['--variant', 'full-gate', '--config', JSON.stringify(config)],
      { CLAUDE_PROJECT_DIR: tmp },
      { cwd: tmp },
    );

    try {
      expect(r.status).toBe(0);
      expect(existsSync(join(tmp, 'typecheck.marker'))).toBe(true);
      expect(existsSync(join(tmp, 'test.marker'))).toBe(true);
      expect(existsSync(join(tmp, 'lint.marker'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// full-gate variant — JSON output shape
// ---------------------------------------------------------------------------

describe('run-quality-gate.mjs — full-gate variant', () => {
  it('exits 0 when all three checks are skipped', () => {
    const config = JSON.stringify({
      'typecheck-command': 'skip',
      'test-command': 'skip',
      'lint-command': 'skip',
    });
    const r = run(['--variant', 'full-gate', '--config', config]);
    expect(r.status).toBe(0);
  });

  it('produces a JSON object as output for full-gate', () => {
    const config = JSON.stringify({
      'typecheck-command': 'skip',
      'test-command': 'skip',
      'lint-command': 'skip',
    });
    const r = run(['--variant', 'full-gate', '--config', config]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toBeTypeOf('object');
    expect(parsed).not.toBeNull();
  });

  it('full-gate JSON contains the variant field set to "full-gate"', () => {
    const config = JSON.stringify({
      'typecheck-command': 'skip',
      'test-command': 'skip',
      'lint-command': 'skip',
    });
    const r = run(['--variant', 'full-gate', '--config', config]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.variant).toBe('full-gate');
  });

  it('full-gate JSON contains nested typecheck, test, and lint objects', () => {
    const config = JSON.stringify({
      'typecheck-command': 'skip',
      'test-command': 'skip',
      'lint-command': 'skip',
    });
    const r = run(['--variant', 'full-gate', '--config', config]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.typecheck).toBeTypeOf('object');
    expect(parsed.test).toBeTypeOf('object');
    expect(parsed.lint).toBeTypeOf('object');
  });

  it('full-gate JSON typecheck object has status and error_count keys', () => {
    const config = JSON.stringify({
      'typecheck-command': 'skip',
      'test-command': 'skip',
      'lint-command': 'skip',
    });
    const r = run(['--variant', 'full-gate', '--config', config]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Object.keys(parsed.typecheck)).toContain('status');
    expect(Object.keys(parsed.typecheck)).toContain('error_count');
  });

  it('full-gate JSON test object has status, total, and passed keys', () => {
    const config = JSON.stringify({
      'typecheck-command': 'skip',
      'test-command': 'skip',
      'lint-command': 'skip',
    });
    const r = run(['--variant', 'full-gate', '--config', config]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Object.keys(parsed.test)).toContain('status');
    expect(Object.keys(parsed.test)).toContain('total');
    expect(Object.keys(parsed.test)).toContain('passed');
  });

  it('full-gate JSON contains duration_seconds as a number', () => {
    const config = JSON.stringify({
      'typecheck-command': 'skip',
      'test-command': 'skip',
      'lint-command': 'skip',
    });
    const r = run(['--variant', 'full-gate', '--config', config]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.duration_seconds).toBeTypeOf('number');
  });

  it('full-gate JSON contains debug_artifacts array', () => {
    const config = JSON.stringify({
      'typecheck-command': 'skip',
      'test-command': 'skip',
      'lint-command': 'skip',
    });
    const r = run(['--variant', 'full-gate', '--config', config]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed.debug_artifacts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config JSON parsing
// ---------------------------------------------------------------------------

describe('run-quality-gate.mjs — config handling', () => {
  it('accepts a JSON string via --config and applies overrides', () => {
    const config = JSON.stringify({ 'typecheck-command': 'skip', 'test-command': 'skip' });
    const r = run(['--variant', 'baseline', '--config', config]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.typecheck).toBe('skip');
  });

  it('warns but does not crash when --config is not valid JSON', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qg-invalid-config-'));
    writeSkipPolicy(tmp);

    const r = run(
      ['--variant', 'baseline', '--config', 'not-json-or-file'],
      { CLAUDE_PROJECT_DIR: tmp },
      { cwd: tmp },
    );

    rmSync(tmp, { recursive: true, force: true });

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Config is neither a valid file path nor valid JSON');
    const parsed = JSON.parse(r.stdout);
    expect(parsed.typecheck).toBe('skip');
    expect(parsed.test).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
// quality_gate telemetry emission (#610) — emits one canonical event per run
// ---------------------------------------------------------------------------

describe('run-quality-gate.mjs — quality_gate telemetry emission (#610)', () => {
  let tmp;

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'qg-emit-')); });
  afterEach(() => { if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true }); });

  /** Read parsed events.jsonl records from the isolated tmp project dir. */
  function readEvents() {
    const p = join(tmp, '.orchestrator', 'metrics', 'events.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('emits orchestrator.quality_gate.passed when a full-gate run passes', () => {
    const config = JSON.stringify({ 'typecheck-command': 'skip', 'test-command': 'skip', 'lint-command': 'skip' });
    const r = run(['--variant', 'full-gate', '--config', config], { CLAUDE_PROJECT_DIR: tmp });
    expect(r.status).toBe(0);
    const ev = readEvents().find((e) => e.event === 'orchestrator.quality_gate.passed');
    expect(ev).toBeDefined();
    expect(ev.variant).toBe('full-gate');
    expect(ev.exit_code).toBe(0);
  });

  it('emits orchestrator.quality_gate.failed when a full-gate check fails', () => {
    // Cross-platform fail stand-in: POSIX `false` is not a cmd.exe builtin (Windows CI).
    const config = JSON.stringify({ 'typecheck-command': 'skip', 'test-command': 'node -e "process.exit(1)"', 'lint-command': 'skip' });
    const r = run(['--variant', 'full-gate', '--config', config], { CLAUDE_PROJECT_DIR: tmp });
    expect(r.status).not.toBe(0);
    const ev = readEvents().find((e) => e.event === 'orchestrator.quality_gate.failed');
    expect(ev).toBeDefined();
    expect(ev.variant).toBe('full-gate');
    expect(ev.exit_code).toBe(r.status);
  });

  it('emits orchestrator.quality_gate.passed with variant "incremental" for a passing incremental run (#613)', () => {
    // Emission was previously asserted only for the full-gate variant. This pins
    // that the emitted `variant` field carries the raw --variant CLI value, so an
    // incremental run is telemetered distinctly from full-gate. Falsification: if
    // the emit hard-coded "full-gate" (or dropped variant), this assertion fails.
    const config = JSON.stringify({ 'typecheck-command': 'skip', 'test-command': 'skip' });
    const r = run(['--variant', 'incremental', '--config', config], { CLAUDE_PROJECT_DIR: tmp });
    expect(r.status).toBe(0);
    const ev = readEvents().find((e) => e.event === 'orchestrator.quality_gate.passed');
    expect(ev).toBeDefined();
    expect(ev.variant).toBe('incremental');
    expect(ev.exit_code).toBe(0);
  });
});
