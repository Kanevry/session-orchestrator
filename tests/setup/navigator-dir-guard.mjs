/**
 * tests/setup/navigator-dir-guard.mjs — vitest `setupFiles` entry (#1462).
 *
 * THE BUG THIS CATCHES (TV-001): a test run reads or writes the OPERATOR'S REAL
 * navigator state under `~/.config/navigator/`. `tests/hooks/on-session-start.test.mjs`
 * spawns the hook with `...process.env`, so on a host that holds a real lease
 * the hook reads the live `~/.config/navigator/leases/navigator.json` and the
 * assertions measure the operator's fleet instead of the fixture; and a
 * check-in test writes into the real `~/.config/navigator/checkin/`, where the
 * running navigator picks the fabricated check-in up as a live peer.
 *
 * WHY ONE ENV VAR: `NAVIGATOR_CONFIG_DIR` overrides the whole navigator root,
 * and setting it here reaches the worker's own `process.env` and every child
 * that inherits it — no per-call-site redirect to forget.
 *
 * The constant is carried here rather than imported from
 * `scripts/lib/fleet-protocol.mjs`, so this setup file loads even when that
 * library does not.
 *
 * WHAT IT DOES NOT COVER (BV-004 ceiling): a child spawned with an env that does
 * not spread `process.env`, and a writer that hard-codes `~/.config/navigator`
 * instead of honouring the variable. Revisit trigger: the next test-made file
 * found under the real `~/.config/navigator/`.
 *
 * Same shape as `events-ledger-guard.mjs`: unconditional (no opt-out), one
 * directory per run derived from `process.ppid`, canonical temp root,
 * symlink-planted path refused.
 */

import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Env var that overrides the navigator config root (`~/.config/navigator`). */
export const NAVIGATOR_DIR_ENV = 'NAVIGATOR_CONFIG_DIR';

/** Prefix of every directory this guard mints — the wiring is greppable on disk. */
export const NAVIGATOR_DIR_GUARD_PREFIX = 'so-navigator-dir-guard-';

/**
 * Point `env[NAVIGATOR_DIR_ENV]` at `<realpath tmpRoot>/<prefix><runId>`.
 *
 * The directory is reused only when it is a plain directory; anything else at
 * that predictable path (a symlink planted in a shared temp root) gets a fresh
 * `mkdtemp` name instead — the same TOCTOU-narrowing check as events-ledger-guard.
 *
 * @param {Record<string, string|undefined>} env  environment object to mutate.
 * @param {{ tmpRoot?: string, runId?: string }} [opts]
 * @returns {{ dir: string, previous: string|undefined }}
 */
export function guardNavigatorDir(env, { tmpRoot = tmpdir(), runId = String(process.ppid) } = {}) {
  const root = realpathSync(tmpRoot);
  let dir = path.join(root, `${NAVIGATOR_DIR_GUARD_PREFIX}${runId}`);
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (st === undefined) mkdirSync(dir, { recursive: true });
  else if (!st.isDirectory()) dir = mkdtempSync(path.join(root, NAVIGATOR_DIR_GUARD_PREFIX));

  const previous = env[NAVIGATOR_DIR_ENV];
  env[NAVIGATOR_DIR_ENV] = dir;
  return { dir, previous };
}

export const appliedNavigatorDirGuard = guardNavigatorDir(process.env);

// No exit-time cleanup: a forks-pool worker never reaches a normal exit (see
// vault-guard). The OS reaps the temp root.
