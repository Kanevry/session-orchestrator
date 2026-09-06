/**
 * tests/scripts/parse-config-flags.test.mjs
 *
 * NAMED BUG (2026-09-06 Wave 1): `parse-config.mjs` read `process.argv[2]` as
 * the positional config path unconditionally, so the flag in the command
 * `docs/session-config-template.md` documents at lines 13 and 965 —
 * `node scripts/parse-config.mjs --json` — was swallowed by the path slot and
 * rejected with `parse-config.mjs: File not found: --json`, exit 1. The
 * documented validation command could not be run as written.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'parse-config.mjs');

function run(args) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, SO_SKIP_CONFIG_VALIDATION: '1' },
  });
}

describe('parse-config.mjs argument shapes', () => {
  it('accepts --json and emits the config as JSON (the documented command)', () => {
    const r = run(['--json']);
    expect(r.stderr).not.toContain('File not found: --json');
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(typeof parsed).toBe('object');
    expect(parsed.waves).toBeGreaterThan(0);
  });

  it('accepts the positional path and produces the same JSON as --json', () => {
    const withFlag = run(['--json']);
    const withPath = run([join(REPO_ROOT, 'CLAUDE.md')]);
    expect(withPath.status).toBe(0);
    expect(JSON.parse(withPath.stdout)).toEqual(JSON.parse(withFlag.stdout));
  });

  it('accepts --json together with a positional path', () => {
    const r = run(['--json', join(REPO_ROOT, 'CLAUDE.md')]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).waves).toBeGreaterThan(0);
  });

  it('--help exits 0 and documents --json on stdout', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--json');
  });

  it('an unknown flag is rejected as an option, never as a missing file', () => {
    const r = run(['--no-such-flag']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown option: --no-such-flag');
    expect(r.stderr).not.toContain('File not found');
  });

  it('a genuinely missing positional path still exits 1 with File not found', () => {
    const r = run([join(REPO_ROOT, 'definitely-not-here-9f2a.md')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('File not found');
  });
});
