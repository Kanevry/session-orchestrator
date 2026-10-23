/**
 * tests/setup/owner-config-guard.test.mjs — #1567 items 2/8.
 *
 * Named bug (TV-001): a test run reads the operator's real
 * `~/.config/session-orchestrator/owner.yaml` and `SO_PROJECTS_ROOT`, so
 * `getConfinementRoot()` without arguments answers with the host's projects
 * root instead of the default. This is the wiring proof: the worker's env must
 * already carry the redirect when this file starts, which only `setupFiles` in
 * `vitest.config.mjs` can provide. Without the guard registered, the owner.yaml
 * path below resolves into the real home directory and the test fails.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { resolveOwnerYamlPath } from '../../scripts/lib/owner-yaml.mjs';
import { inspectOwnerPatterns } from '../../scripts/lib/validate/check-owner-leakage.mjs';
import { guardOwnerConfig } from './owner-config-guard.mjs';

describe('owner-config-guard (#1567)', () => {
  it('setupFiles moves owner.yaml out of the home directory and drops SO_PROJECTS_ROOT', () => {
    expect(process.env.SO_CONFIG_HOME, 'setupFiles must register tests/setup/owner-config-guard.mjs').toBeTruthy();
    expect(process.env.SO_PROJECTS_ROOT).toBeUndefined();

    // "Never the real ~/.config", not "never under the home": on Windows the
    // temp root lies under the home (%TEMP% = C:\Users\<name>\AppData\Local\Temp,
    // #1613). Where it does not (macOS, Linux) the stricter check still applies.
    const home = realpathSync(homedir()) + path.sep;
    const tmpRoot = realpathSync(tmpdir()) + path.sep;
    const ownerYaml = resolveOwnerYamlPath();
    const ownerDir = realpathSync(path.dirname(ownerYaml));
    expect(path.basename(path.dirname(ownerYaml)).startsWith('so-owner-config-guard-')).toBe(true);
    expect(ownerDir.startsWith(tmpRoot)).toBe(true);
    expect(ownerDir.startsWith(path.join(home, '.config') + path.sep)).toBe(false);
    if (!tmpRoot.startsWith(home)) expect(ownerDir.startsWith(home)).toBe(false);
  });

  // #1628 — under umask 000 (WSL) the guard dir came out 0777, the policy check
  // judged it 'unsafe', and vault-mirror redacted every repo to `redacted-repo`.
  it('keeps the policy source "missing", not "unsafe", under umask 000', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'so-owner-guard-umask-'));
    const prevUmask = process.umask(0);
    try {
      const env = { SO_OWNER_PATTERNS_FILE: '/elsewhere/owner-patterns.json' };
      const { dir } = guardOwnerConfig(env, { tmpRoot: root, runId: 'umask' });
      expect(env.SO_OWNER_PATTERNS_FILE).toBeUndefined();
      expect(inspectOwnerPatterns({ env, refresh: true }).status).toBe('missing');
      expect(dir.startsWith(realpathSync(root))).toBe(true);
    } finally {
      process.umask(prevUmask);
      inspectOwnerPatterns({ refresh: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
