/**
 * tests/setup/vault-guard.mjs — vitest `setupFiles` entry.
 *
 * THE BUG THIS CATCHES (TV-001): a test writes into the OPERATOR'S REAL VAULT
 * instead of its own fixture, because `vault-dir` resolves HOST-LOCALLY. A
 * synthetic `repoRoot` with a fixture `CLAUDE.md` fakes the SOURCE of the
 * mirrored content — it never fakes the DESTINATION.
 *
 * The resolution chain (scripts/lib/config/host-paths.mjs `resolveHostPath`) is:
 *
 *     SO_VAULT_DIR  >  owner.yaml paths.vault-dir  >  committed CLAUDE.md value
 *
 * The committed value in this repo is `~/Projects/vault`, and the operator's
 * owner.yaml sets tier 2 to the same real vault. So a test that calls any vault
 * writer — `mirrorNarrative()`, the board writer, `vault-mirror.mjs` — without
 * passing a hermetic `hostPaths` ctx resolves tiers 2/3 on the HOST and lands in
 * a directory that is tracked and PUSHED in the operator's vault repo.
 *
 * WHY A PER-CALL-SITE CONVENTION IS NOT ENOUGH — the same shape as
 * scrub-git-env.mjs, one domain over. The defence before this file existed was
 * discipline at every call site, and it is visibly load-bearing in the suite:
 * `tests/lib/vault-status/narrative-mirror.test.mjs` threads a
 * `HERMETIC_HOST_PATHS` ctx through ~20 call sites with a comment explaining why
 * each one needs it, and `tests/lib/vault-status/board-writer-sweep.test.mjs`
 * hand-rolls a save/delete/restore dance around `process.env.SO_VAULT_DIR`.
 * Every one of those is correct; the hole is the call site nobody remembered.
 * Measured 2026-08-24 at f0766e1, before this file:
 *
 *     rg -n "SO_VAULT_DIR" tests/setup/ vitest.config.mjs   → 0 hits
 *
 * WHY SETTING THE TOP TIER IS WHAT CLOSES IT. `SO_VAULT_DIR` is the HIGHEST
 * tier, so one assignment shadows owner.yaml AND the committed default for every
 * consumer at once — the sync resolver, production code that reads it directly,
 * and any child process the suite spawns (which inherits `process.env`). A
 * lower-tier fix would have to be re-applied per consumer.
 *
 * OPT-OUT: set `SO_VAULT_GUARD_ALLOW_REAL=1`. The guard is ON by default —
 * fail-closed, because the failure mode it prevents is not recoverable by a
 * local revert (the vault is a foreign repo with its own history).
 */

import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Env var a test/operator sets to `'1'` to keep the host's real `vault-dir`. */
export const VAULT_GUARD_OPT_OUT = 'SO_VAULT_GUARD_ALLOW_REAL';

/** Prefix of every directory this guard mints — the wiring is greppable on disk. */
export const VAULT_GUARD_PREFIX = 'so-vault-guard-';

/**
 * Resolve the run-shared guard directory, refusing to REUSE anything at that
 * path that is not a real directory.
 *
 * The path is DERIVED (`<tmp>/<prefix><ppid>`) and therefore predictable, and
 * the OS temp root is world-writable — so another user can pre-plant a symlink
 * there and every subsequent `SO_VAULT_DIR`-rooted write follows it out of the
 * sandbox. `lstatSync` (not `statSync`) is what sees the symlink itself rather
 * than its target: a symlink-to-directory reports `isDirectory() === false`
 * here, which is exactly the discrimination this needs. Anything that is not a
 * plain directory → mint a fresh `mkdtemp` name instead, giving up the
 * one-dir-per-run property rather than the sandbox.
 *
 * Ceiling (BV-004): this is TOCTOU-narrowing, not TOCTOU-free — the path could
 * still be replaced between the `lstat` and the write. Closing that needs an
 * O_NOFOLLOW-style open of every file written underneath, which is far beyond a
 * test-setup guard. Revisit if a guard directory is ever found symlinked.
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

/**
 * Point `env.SO_VAULT_DIR` at an empty directory under the OS temp root, shared
 * by every worker of ONE vitest run.
 *
 * Unconditional by design (unless opted out): it does not try to decide whether
 * an INHERITED `SO_VAULT_DIR` is "safe enough" to keep. Deciding that would mean
 * re-deriving where the real vault is — owner.yaml, the committed default, a
 * symlink to either — and every such heuristic fails open on the case it did not
 * anticipate. Overwriting always is one branch and cannot fail open. It also
 * subsumes the specific hazard of an exported `SO_VAULT_DIR=~/Projects/vault`
 * in the invoking shell, which is otherwise the highest-precedence pointer at
 * the real vault there is.
 *
 * The temp root is CANONICALIZED (`realpathSync`) on purpose. On macOS
 * `os.tmpdir()` is `/var/folders/…`, a symlink to `/private/var/folders/…`,
 * while a real vault directory is a canonical path. Handing every test a
 * symlinked vault root would inject a failure class production never sees — the
 * #1033(b) class, where `validatePathInsideProject` without `canonicalizeRoot`
 * rejects the SECOND write to an existing file. The fixture should differ from
 * production in the destination only, never in the path's shape.
 *
 * Exported as a function over an explicit `env` so the behaviour is testable
 * without a second worker: the module-level call below is the only one that
 * touches `process.env`.
 *
 * WHAT IT DOES NOT DO (BV-004 ceiling): it sets the variable once per test file,
 * before that file's tests run — never per call. A test that assigns or deletes
 * `SO_VAULT_DIR` itself still owns that
 * decision (board-writer-sweep.test.mjs deletes it deliberately), and a code
 * path that reads a vault location from somewhere OTHER than this tier — a
 * hardcoded literal, or an owner.yaml read that bypasses `resolveHostPath` —
 * is untouched by it. Revisit trigger: the first incident where a test writes
 * into the real vault despite this file.
 *
 * WHY THE PATH IS DERIVED AND NOT MINTED (`mkdtemp`). Vitest with `pool: 'forks'`
 * forks a FRESH process per test file, each re-evaluating this module with the
 * parent's environment — so nothing a worker writes to `process.env` reaches the
 * next one. Measured 2026-08-24: a `mkdtempSync` version left exactly one new
 * directory per test file (delta 3 over a 3-file run), which is ~400 per full-suite
 * run. Deriving the name from `process.ppid` — the vitest main process, identical
 * across every worker of one run and different across concurrent runs — makes the
 * directory shared and `mkdirSync(…, {recursive:true})` idempotent, so a run leaves
 * ONE. Sharing one fallback destination between workers is not a new hazard: it is
 * where accidental writes land, and before this file they all landed in one shared
 * place already — the operator's real vault.
 *
 * @param {Record<string, string|undefined>} env  environment object to mutate.
 * @param {{ tmpRoot?: string, runId?: string }} [opts]  `tmpRoot` overrides the OS
 *   temp root; `runId` overrides the per-run discriminator (tests pass both so they
 *   never touch the live guard dir their own worker is using).
 * @returns {{ applied: boolean, reason: 'opt-out'|'unset'|'redirected',
 *             previous: string|undefined, vaultDir: string|undefined, minted: boolean }}
 */
export function guardVaultDir(env, { tmpRoot = tmpdir(), runId = String(process.ppid) } = {}) {
  const previous = env.SO_VAULT_DIR;

  if (env[VAULT_GUARD_OPT_OUT] === '1') {
    return { applied: false, reason: 'opt-out', previous, vaultDir: previous, minted: false };
  }

  const { dir: vaultDir, minted } = resolveGuardDir(
    realpathSync(tmpRoot),
    VAULT_GUARD_PREFIX,
    runId,
  );
  env.SO_VAULT_DIR = vaultDir;

  return {
    applied: true,
    reason: previous === undefined ? 'unset' : 'redirected',
    previous,
    vaultDir,
    minted,
  };
}

const guard = guardVaultDir(process.env);

// Loud only when a value was actually DISPLACED, and only from a worker that
// found the run's directory absent. The unset case is every normal run and would
// be pure noise. `minted` bounds the rest to the forks that START CONCURRENTLY —
// measured, not assumed: a 3-file run still printed 3 lines because all three
// forks raced the same `existsSync`, while every later fork sees the directory
// and stays quiet. So the bound is one line per parallel fork slot (≈ CPU count),
// not one per test file (≈ 400 over the full suite), and not exactly one.
if (guard.reason === 'redirected' && guard.minted) {
  process.stderr.write(
    `[vault-guard] redirected SO_VAULT_DIR from ${guard.previous} to ${guard.vaultDir} — ` +
      `vault-dir resolves host-locally, so an inherited value can point the suite at the ` +
      `operator's real vault. Set ${VAULT_GUARD_OPT_OUT}=1 to keep it.\n`,
  );
}

// NO exit-time cleanup, and that is a measurement rather than an omission: a
// `process.on('exit', …)` rmdir was written first and never ran — after six
// vitest invocations 132 stale directories were still on disk, because a
// forks-pool worker does not reach a normal exit. A hook that provably does
// nothing is worse than the litter it claims to clean.
//
// The ceiling (BV-004): ONE directory per run in the OS temp root, which the OS
// reaps. Empty means nothing escaped its fixture; NON-empty is not litter but
// the evidence that a test wrote through the vault resolver, and what it wrote.
// Revisit trigger: a run that leaves more than one, which would mean `runId`
// stopped being shared across the run's workers.

export { guard as appliedVaultGuard };
