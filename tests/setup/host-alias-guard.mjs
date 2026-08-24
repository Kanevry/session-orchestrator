/**
 * tests/setup/host-alias-guard.mjs — vitest `setupFiles` entry.
 *
 * THE BUG THIS CATCHES (TV-001): a test writes into the OPERATOR'S REAL
 * self-alias ledger at `~/.config/session-orchestrator/host-aliases.json`,
 * because `recordHostAlias()` fires from inside `buildLock()` — so every suite
 * that calls `acquire()` / `forceAcquire()` writes there as a SIDE EFFECT of
 * taking a lock, with no vault-writer-style call site to notice.
 *
 * That ledger is not a scratch file: `hostnamesMatch()` reads it to decide
 * whether a lock belongs to THIS machine (#1072), and the damage outlives the
 * run in a file no `git checkout` restores.
 *
 * MEASURED 2026-08-24, so the claim is the right size. `buildLock()` calls
 * `recordHostAlias()` with NO argument (`scripts/lib/session-lock.mjs:243`), so
 * what a test writes today is the machine's REAL current name — not a fixture
 * one. The reachable harm is therefore not a forged identity but the file
 * itself: run with `HOME` pointed at a sandbox and this guard opted out,
 *
 *     HOME=<tmp> SO_HOST_ALIAS_GUARD_ALLOW_REAL=1 npx vitest run \
 *       tests/hooks/lock-bootstrap.test.mjs \
 *       tests/integration/session-lock-cross-process.test.mjs
 *
 * creates `<tmp>/.config/session-orchestrator/host-aliases.json`. Three suites
 * reach that path with no redirect of their own — the two above plus
 * `tests/integration/parallel-detection-e2e.test.mjs`; the other two
 * lock-touching suites already set the variable per-test.
 *
 * Two consequences make it worth a guard rather than a shrug. The ledger's
 * contract is one entry per GENUINE lock acquisition — "the one moment we know
 * for a fact that the current os.hostname() belongs to THIS machine" — and a
 * test run forges that moment hundreds of times without a session; and entries
 * are capped at 16 (`HOST_ALIASES_MAX`), so test-driven writes take part in
 * evicting real spellings. The fixture-name hazard is one `vi.spyOn(os,
 * 'hostname')` away (census 2026-08-24: no suite stubs it yet).
 *
 * The path resolution (`_hostAliasesFile()` in `scripts/lib/host-identity.mjs`)
 * is:
 *
 *     SO_HOST_ALIASES_FILE  >  ~/.config/session-orchestrator/host-aliases.json
 *
 * WHY AN INHERITED VALUE IS KEPT — the one deliberate difference from
 * `vault-guard.mjs`, which overwrites unconditionally. There, tier 1
 * (`SO_VAULT_DIR`) competes with lower tiers that point at the REAL vault, so an
 * inherited value can itself be the hazard. Here there is no lower tier to
 * outrank: the real ledger is what you get when the variable is UNSET, so any
 * value present is already a redirection away from it. Overwriting one would
 * only break the two suites that set it themselves per-test
 * (`tests/lib/host-identity.test.mjs`, `tests/lib/session-lock.test.mjs`).
 *
 * OPT-OUT: set `SO_HOST_ALIAS_GUARD_ALLOW_REAL=1`. The guard is ON by default —
 * fail-closed, because the damage lands outside the repo, in a file no `git
 * checkout` restores.
 */

import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Env var a test/operator sets to `'1'` to keep the host's real alias ledger. */
export const HOST_ALIAS_GUARD_OPT_OUT = 'SO_HOST_ALIAS_GUARD_ALLOW_REAL';

/** Prefix of every directory this guard mints — the wiring is greppable on disk. */
export const HOST_ALIAS_GUARD_PREFIX = 'so-host-alias-guard-';

/**
 * Resolve the run-shared guard directory, refusing to REUSE anything at that
 * path that is not a real directory. Twin of the same function in
 * `vault-guard.mjs`; kept local because these two files are vitest
 * `setupFiles` and each must stand alone in a fresh fork.
 *
 * The path is DERIVED (`<tmp>/<prefix><ppid>`) and therefore predictable, and
 * the OS temp root is world-writable — so another user can pre-plant a symlink
 * there and `recordHostAlias()` writes the machine's lock-identity ledger
 * through it. `lstatSync` (not `statSync`) is what sees the symlink itself
 * rather than its target: a symlink-to-directory reports `isDirectory() ===
 * false` here, which is exactly the discrimination this needs. Anything that is
 * not a plain directory → mint a fresh `mkdtemp` name instead, giving up the
 * one-dir-per-run property rather than the sandbox.
 *
 * Ceiling (BV-004): TOCTOU-narrowing, not TOCTOU-free — the path could still be
 * replaced between the `lstat` and the write. Revisit if a guard directory is
 * ever found symlinked.
 *
 * @param {string} tmpRoot  canonicalised OS temp root.
 * @param {string} prefix   directory-name prefix.
 * @param {string} runId    per-run discriminator.
 * @returns {{ dir: string, minted: boolean }}
 */
function resolveGuardDir(tmpRoot, prefix, runId) {
  const dir = path.join(tmpRoot, `${prefix}${runId}`);
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (st === undefined) {
    mkdirSync(dir, { recursive: true });
    return { dir, minted: true };
  }
  if (st.isDirectory()) return { dir, minted: false };
  return { dir: mkdtempSync(path.join(tmpRoot, prefix)), minted: true };
}

/** Basename inside the guard directory; mirrors the real ledger's own name. */
export const HOST_ALIAS_GUARD_BASENAME = 'host-aliases.json';

/**
 * Point `env.SO_HOST_ALIASES_FILE` at a file under the OS temp root, shared by
 * every worker of ONE vitest run.
 *
 * The directory is derived from `process.ppid` — the vitest main process,
 * identical across every worker of one run and different across concurrent runs
 * — rather than minted with `mkdtemp`, for the reason measured in
 * `vault-guard.mjs`: `pool: 'forks'` re-evaluates this module once per TEST
 * FILE, so a minted path leaves ~one directory per test file per run. Deriving
 * it makes `mkdirSync(…, { recursive: true })` idempotent and a run leaves ONE.
 *
 * The temp root is CANONICALIZED (`realpathSync`) because on macOS
 * `os.tmpdir()` is a `/var/folders/…` symlink; a fixture should differ from
 * production in the destination only, never in the path's shape.
 *
 * Exported over an explicit `env` so the behaviour is testable without a second
 * worker: the module-level call below is the only one touching `process.env`.
 *
 * WHAT IT DOES NOT DO (BV-004 ceiling): it sets the variable once per test
 * file, before that file's tests run — never per call. A test that assigns or
 * deletes `SO_HOST_ALIASES_FILE` itself still owns that decision, and any code
 * path that reaches `~/.config/session-orchestrator/` WITHOUT going through
 * `_hostAliasesFile()` (`host-private.json`, `owner.yaml`) is untouched by it.
 * Revisit trigger: the first incident where a test writes into the real ledger
 * despite this file.
 *
 * @param {Record<string, string|undefined>} env  environment object to mutate.
 * @param {{ tmpRoot?: string, runId?: string }} [opts]  `tmpRoot` overrides the OS
 *   temp root; `runId` overrides the per-run discriminator (tests pass both so they
 *   never touch the live guard file their own worker is using).
 * @returns {{ applied: boolean, reason: 'opt-out'|'inherited'|'unset',
 *             previous: string|undefined, aliasFile: string|undefined, minted: boolean }}
 */
export function guardHostAliasesFile(env, { tmpRoot = tmpdir(), runId = String(process.ppid) } = {}) {
  const previous = env.SO_HOST_ALIASES_FILE;

  if (env[HOST_ALIAS_GUARD_OPT_OUT] === '1') {
    return { applied: false, reason: 'opt-out', previous, aliasFile: previous, minted: false };
  }
  if (typeof previous === 'string' && previous.trim() !== '') {
    // Already redirected — see "WHY AN INHERITED VALUE IS KEPT" above.
    return { applied: false, reason: 'inherited', previous, aliasFile: previous, minted: false };
  }

  const { dir, minted } = resolveGuardDir(
    realpathSync(tmpRoot),
    HOST_ALIAS_GUARD_PREFIX,
    runId,
  );
  const aliasFile = path.join(dir, HOST_ALIAS_GUARD_BASENAME);
  env.SO_HOST_ALIASES_FILE = aliasFile;

  return { applied: true, reason: 'unset', previous, aliasFile, minted };
}

const guard = guardHostAliasesFile(process.env);

// NO exit-time cleanup — measured in vault-guard.mjs: a `process.on('exit', …)`
// rmdir never runs, because a forks-pool worker does not reach a normal exit.
//
// The ceiling (BV-004): ONE directory per run in the OS temp root, which the OS
// reaps. Its contents are not litter but evidence — the alias names the suite
// would otherwise have taught the operator's live lock-identity logic.

export { guard as appliedHostAliasGuard };
