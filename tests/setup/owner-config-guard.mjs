/**
 * tests/setup/owner-config-guard.mjs — vitest `setupFiles` entry (#1567 items 2/8).
 *
 * THE BUG THIS CATCHES (TV-001): a test reads the OPERATOR'S REAL host-private
 * config. `resolvePrivateConfigDir()` falls back to `~/.config/session-orchestrator`,
 * so `loadOwnerConfig()` reads the host's real `owner.yaml`, and
 * `getConfinementRoot()` without arguments follows `SO_PROJECTS_ROOT` and that
 * file's `paths.projects-root` (e.g. `tests/lib/getConfinementRoot-lockstep.test.mjs`).
 * Harmless only while no host sets `projects-root`; red the day one does. The
 * same directory holds the session registry, which tests without their own
 * `SO_SESSION_REGISTRY_DIR` otherwise share with the live sessions.
 *
 * WHY THESE TWO VARS: `SO_CONFIG_HOME` is the HIGHEST tier of the private-dir
 * chain (`SO_CONFIG_HOME` > `XDG_CONFIG_HOME` > homedir), so pinning it here
 * reaches the worker's `process.env` and every child that spreads it.
 * `SO_PROJECTS_ROOT` outranks owner.yaml in `getConfinementRoot()` and is
 * removed, not redirected: its absence IS the default. `XDG_CONFIG_HOME` is
 * left alone — git and other tools read it too.
 *
 * Tests that exercise the chain set or clear these vars themselves
 * (`vi.stubEnv`, explicit child env) and keep working: a stub outranks a
 * setup-file value.
 *
 * WHAT IT DOES NOT COVER (BV-004 ceiling): a child spawned with an env that
 * does not spread `process.env`, a test that clears `SO_CONFIG_HOME` and keeps
 * the real `HOME`, a reader that hard-codes `homedir()` instead of the
 * resolver (`scripts/lib/telemetry/paths.mjs`), a user-owned group/world-writable
 * `TMPDIR` ancestor (the policy check rejects that too), and the vitest MAIN
 * process: `globalSetup` (validate-plugin) still reads the real policy. Revisit trigger: a test result
 * that changes with the content of the real `~/.config/session-orchestrator/`.
 *
 * One directory per RUN (`<ppid>`, the vitest main process), like
 * vault-guard and navigator-dir-guard: with `pool: 'forks'` a per-process name
 * would mint one directory per test file. Ceiling: test files of one run share
 * this directory, so a test that writes the registry or owner.yaml here without
 * its own redirect is visible to the next file — still far narrower than the
 * operator's real directory it replaces. Same symlink refusal as
 * events-ledger-guard.
 */

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Env var naming the host-private config directory itself. */
export const OWNER_CONFIG_DIR_ENV = 'SO_CONFIG_HOME';

/** Env var that overrides owner.yaml `paths.projects-root`. */
export const PROJECTS_ROOT_ENV = 'SO_PROJECTS_ROOT';

/**
 * Env vars that name a host-local redaction input DIRECTLY, bypassing
 * `SO_CONFIG_HOME` (#1628): the owner-leakage policy file
 * (`check-owner-leakage.mjs` `policySource()`), the CP11 confidential-names
 * list and the vault-mirror pseudonym map (`config/host-paths.mjs`). Removed,
 * not redirected: absent, each falls back to its default under the pinned dir.
 */
export const HOST_REDACTION_ENVS = ['SO_OWNER_PATTERNS_FILE', 'SO_CONFIDENTIAL_NAMES_FILE', 'SO_NAMESPACE_MAP'];

/** Prefix of every directory this guard mints — the wiring is greppable on disk. */
export const OWNER_CONFIG_GUARD_PREFIX = 'so-owner-config-guard-';

/**
 * Point `env.SO_CONFIG_HOME` at `<realpath tmpRoot>/<prefix><runId>` (mode 0700)
 * and drop `env.SO_PROJECTS_ROOT` plus every {@link HOST_REDACTION_ENVS} entry.
 *
 * @param {Record<string, string|undefined>} env  environment object to mutate.
 * @param {{ tmpRoot?: string, runId?: string }} [opts]
 * @returns {{ dir: string, previous: string|undefined }}
 */
export function guardOwnerConfig(
  env,
  { tmpRoot = tmpdir(), runId = String(process.ppid) } = {},
) {
  const root = realpathSync(tmpRoot);
  let dir = path.join(root, `${OWNER_CONFIG_GUARD_PREFIX}${runId}`);
  // Mode 0700 explicitly, never the umask default (#1628): `checkedHostFile()`
  // rejects a group/world-writable policy parent as 'unsafe', and an unsafe
  // policy fails CLOSED — `isOwnerLeakySegment()` then flags every segment and
  // vault-mirror writes `redacted-repo`. A umask of 000 (WSL default) made the
  // shared dir 0777 and 46 tests red on one host only.
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (st === undefined) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } else if (!st.isDirectory() || (st.mode & 0o022) !== 0) {
    dir = mkdtempSync(path.join(root, OWNER_CONFIG_GUARD_PREFIX));
  }

  const previous = env[OWNER_CONFIG_DIR_ENV];
  env[OWNER_CONFIG_DIR_ENV] = dir;
  delete env[PROJECTS_ROOT_ENV];
  for (const key of HOST_REDACTION_ENVS) delete env[key];
  return { dir, previous };
}

export const appliedOwnerConfigGuard = guardOwnerConfig(process.env);

/**
 * The pinned config dir above starts EMPTY, so the security-pulse cache under it
 * is always absent and every real session-start probe run (in-process, or a
 * hook child spreading `process.env`) would detach the network refresher
 * (`scripts/lib/security-pulse/spawn.mjs`). Switched off for the worker and its
 * children; tests of the spawn path pass their own `env` (a stub outranks this).
 */
export const SECURITY_PULSE_REFRESH_ENV = 'SO_SECURITY_PULSE_REFRESH';
process.env[SECURITY_PULSE_REFRESH_ENV] = 'off';

// No exit-time cleanup: a forks-pool worker never reaches a normal exit (see
// vault-guard). The OS reaps the temp root.
