/**
 * tests/setup/navigator-dir-guard.test.mjs — #1462.
 *
 * Named bug (TV-001): a test run reads the operator's real navigator lease or
 * writes into the real `~/.config/navigator/checkin/`. The last case is the
 * wiring proof: the worker's env must already carry the redirect when this file
 * starts, which only `setupFiles` in `vitest.config.mjs` can provide.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lstatSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

// Captured before the import below re-applies the guard in this worker: the
// value here is what setupFiles delivered, not what this file set up.
const deliveredBySetupFiles = process.env.NAVIGATOR_CONFIG_DIR;

const { guardNavigatorDir, NAVIGATOR_DIR_ENV, NAVIGATOR_DIR_GUARD_PREFIX } = await import('./navigator-dir-guard.mjs');

describe('navigator-dir-guard (#1462)', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'nav-guard-test-'))); });
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

  it('points the variable at a prefixed directory under tmpRoot and creates it', () => {
    const env = {};
    const { dir, previous } = guardNavigatorDir(env, { tmpRoot, runId: 'r1' });
    expect(previous).toBeUndefined();
    expect(env[NAVIGATOR_DIR_ENV]).toBe(dir);
    expect(dir).toBe(path.join(tmpRoot, `${NAVIGATOR_DIR_GUARD_PREFIX}r1`));
    expect(lstatSync(dir).isDirectory()).toBe(true);
  });

  it('refuses a symlink planted at the predictable path and mints a mkdtemp name', () => {
    const planted = path.join(tmpRoot, `${NAVIGATOR_DIR_GUARD_PREFIX}r2`);
    symlinkSync(path.join(tmpRoot, 'elsewhere'), planted);
    const env = {};
    const { dir } = guardNavigatorDir(env, { tmpRoot, runId: 'r2' });
    expect(dir).not.toBe(planted);
    expect(path.basename(dir).startsWith(NAVIGATOR_DIR_GUARD_PREFIX)).toBe(true);
    expect(lstatSync(dir).isDirectory()).toBe(true);
  });

  it('setupFiles delivers the redirect to this worker, outside the home directory', () => {
    expect(deliveredBySetupFiles, 'setupFiles must register tests/setup/navigator-dir-guard.mjs').toBeTruthy();
    const home = realpathSync(homedir()) + path.sep;
    expect(realpathSync(deliveredBySetupFiles).startsWith(home)).toBe(false);
  });
});
