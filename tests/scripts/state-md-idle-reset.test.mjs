/**
 * tests/scripts/state-md-idle-reset.test.mjs — CLI smoke test (#1560).
 *
 * Bug caught: Phase 1.5 now tells the coordinator to run this CLI instead of
 * rewriting STATE.md by hand, so a CLI that exits 0 without writing (wrong
 * state-dir resolution, a dropped await, an unwired --repo-root) would silently
 * leave a `completed` STATE.md in place. Runs the REAL subprocess against a tmp
 * repo in its own subfolder, never the live .claude/STATE.md.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/state-md-idle-reset.mjs', import.meta.url));

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'so-idle-reset-cli-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('scripts/state-md-idle-reset.mjs', () => {
  it('--json resets a completed STATE.md under --repo-root and reports it', () => {
    const statePath = join(sandbox, '.claude', 'STATE.md');
    mkdirSync(join(sandbox, '.claude'));
    writeFileSync(
      statePath,
      '---\nsession: s-1\nstatus: completed\ncurrent-wave: 3\nrecommended-mode: deep\n---\n\n## Wave History\n\n- W1 done\n',
      'utf8',
    );

    const run = spawnSync(process.execPath, [SCRIPT, '--repo-root', sandbox, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SO_PLATFORM: 'claude', SO_STATE_DIR: '' },
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ changed: true, reason: null, path: statePath });
    const written = readFileSync(statePath, 'utf8');
    expect(written).toMatch(/^status: idle$/m);
    expect(written).toMatch(/^recommended-mode: deep$/m);
    expect(written).toContain('### Wave History (s-1)\n- W1 done');
  });

  // A mistyped root used to get an .orchestrator/ lock dir created and exit 0 "missing".
  it('exits 2 and creates nothing for a --repo-root that does not exist', () => {
    const missing = join(sandbox, 'does-not-exist');
    const run = spawnSync(process.execPath, [SCRIPT, '--repo-root', missing, '--json'], { encoding: 'utf8' });

    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(existsSync(missing)).toBe(false);
  });

  // An existing directory without STATE.md (a typo hitting a real dir) must not get a lock dir either.
  it('reports missing and creates no .orchestrator/ in a directory without STATE.md', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--repo-root', sandbox, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SO_PLATFORM: 'claude', SO_STATE_DIR: '' },
    });

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ changed: false, reason: 'missing' });
    expect(existsSync(join(sandbox, '.orchestrator'))).toBe(false);
  });
});
