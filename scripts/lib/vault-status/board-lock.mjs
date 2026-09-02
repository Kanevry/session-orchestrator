/**
 * board-lock.mjs — cross-repo mutex for the vault live-status board (issue #1180).
 *
 * The board at `<vault-dir>/01-projects/_active-sessions.md` is ONE file shared
 * by every repo on the host: `sweepBoard()` runs at every session-start and
 * session-end of EVERY repo, and each run performs a read-modify-write
 * (`mirrorBoardInner` reads the existing board to seed `preservedRows` /
 * `priorStatusByRepo`, merges the freshly-derived rows over it, then writes).
 * `atomicWriteWithBackup`'s tmp+rename protects READERS from a half-written
 * file; it does NOT protect the merge, so two sessions that read the same base
 * concurrently both write a board missing the other's row — last writer wins.
 *
 * Why not `withStateMdLock`: that lock lives at `<repoRoot>/.orchestrator/state.lock`
 * and is PER-REPO. Two different repos racing on the one shared board never
 * contend on it — wrong domain.
 *
 * Why `staleCheck: 'mtime'` and not `'pid'`: the vault directory can be shared
 * across hosts (Obsidian sync / a network volume), so the recorded pid is not
 * probeable here. `mtime` ages the lock out after `staleMs` regardless of who
 * wrote it. (`tryAcquireFileLock` never auto-overrides a CROSS-HOST body — see
 * `file-lock.mjs` `isExistingStale` — so a foreign-host lock is waited out and
 * then handled by the fail-open path below, never stolen.)
 *
 * FAIL-OPEN by contract: a board update is best-effort telemetry and must never
 * abort a session phase (same posture as `writeBoard`'s `skipped-write-failed`
 * return). On acquire timeout or fs-error we emit exactly ONE stderr WARN and
 * run `fn` unlocked.
 *
 * Return shape follows {@link import('../locks/state-md-lock.mjs').withStateMdLock}:
 * the value of `fn` is returned verbatim, so call sites need no branching. The
 * lock outcome — which is diagnostic, not part of the board result — is exposed
 * through the optional `onLockOutcome` callback instead of widening the return
 * type for every caller. That is the simpler of the two shapes the issue offered:
 * `mirrorBoardInner` already returns a `{ result, rows }` envelope of its own and
 * would have had to unwrap a second one on every path.
 *
 * No external deps — Node stdlib + `file-lock.mjs`.
 */

import path from 'node:path';
import crypto from 'node:crypto';

import { withFileLock } from '../file-lock.mjs';
import { expandTilde } from '../common.mjs';

/** Default acquire budget: short — the critical section is a read + a rename. */
const DEFAULT_TIMEOUT_MS = 5000;
/** Default poll cadence while another writer holds the board. */
const DEFAULT_POLL_MS = 50;
/**
 * Default mtime staleness TTL — a board write that took a minute is dead.
 *
 * CEILING (BV-004): 60 s bounds the WHOLE critical section, and that section is
 * not just the rename — `mirrorBoardInner` runs `collectRows` over every repo
 * registered on this host. A sweep that ever exceeds 60 s makes a LIVE writer
 * look stale, and the second writer overrides its lock and re-opens the exact
 * lost-update race this mutex exists to close. It is a constant rather than a
 * measurement because the sweep is fast today and a self-tuning TTL would be a
 * second thing to be wrong.
 * REVISIT when a board sweep is measured above 30 s (half the TTL — the point
 * at which a slow host crosses it), or when an `onLockOutcome` carrying
 * `staleOverride` is observed in the events ledger on a host that had no crash.
 */
const DEFAULT_STALE_MS = 60_000;

/**
 * Resolve the board lock path for a vault directory.
 *
 * `<vaultDir>/.orchestrator/board.lock` — deliberately NOT beside the board in
 * `01-projects/`: the vault's own `.gitignore` already ignores
 * `.orchestrator/*.lock`, and `vault-sync` walks `.md` files only, so the lock
 * is invisible to both the vault's VCS and its validator.
 *
 * Home-expansion is `expandTilde` from `../common.mjs` — the consolidation the
 * comment above once deferred (issue #1182): 8 inline `expandHome` copies in
 * 3 non-equivalent shapes, one of them (`gitlab-portfolio/cli.mjs`) actively
 * wrong on `~user/x`. All 8 call sites now import the shared helper.
 *
 * @param {string} vaultDir — absolute or `~`-prefixed vault root.
 * @returns {string} absolute lock path.
 */
export function boardLockPathFor(vaultDir) {
  return path.join(expandTilde(vaultDir), '.orchestrator', 'board.lock');
}

/**
 * Run `fn` while holding the board mutex for `vaultDir`.
 *
 * Acquire polls until `timeoutMs`; the containing `.orchestrator/` directory is
 * created on demand (`tryAcquireFileLock` → `createExclusive` does a
 * `mkdirSync(dir, { recursive: true })` before linking). The lock is always
 * released in a `finally`, including when `fn` throws — a throw propagates
 * unchanged and is NEVER converted into the fail-open path (an unlocked retry
 * of a throwing merge would run it twice).
 *
 * @param {string} vaultDir
 * @param {() => (T | Promise<T>)} fn
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 * @param {number} [opts.pollMs=50]
 * @param {number} [opts.staleMs=60000] — mtime age after which a lock is overridden.
 * @param {string} [opts.holder] — holder label recorded in the lock body.
 * @param {(outcome: { locked: boolean, lockPath: string, reason?: string, staleOverride?: string }) => void} [opts.onLockOutcome]
 *   — diagnostic sink, called exactly once before `fn` runs. `staleOverride`
 *   is present only when this acquire OVERRODE an aged lock, and carries
 *   `file-lock.mjs`'s own reason token — the observable behind the
 *   DEFAULT_STALE_MS revisit trigger.
 * @param {(lockPath: string, fn: Function, opts: object) => Promise<object>} [opts.lockImpl]
 *   — test seam; defaults to {@link withFileLock}. Must honour the same
 *   `{ ok: true, value } | { ok: false, reason }` contract.
 * @param {(msg: string) => void} [opts.warn] — WARN sink (default: stderr).
 * @returns {Promise<T>} whatever `fn` returned.
 * @template T
 */
export async function withBoardLock(vaultDir, fn, opts = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError('withBoardLock: fn must be a function');
  }

  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
    staleMs = DEFAULT_STALE_MS,
    holder: holderOpt,
    onLockOutcome,
    lockImpl = withFileLock,
    warn = (msg) => process.stderr.write(msg),
  } = opts;

  const lockPath = boardLockPathFor(vaultDir);
  const holder = typeof holderOpt === 'string' && holderOpt.length > 0
    ? holderOpt
    : `board-writer-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

  let outcomeReported = false;
  // A stale-override is the one event that can silently break the mutex's
  // guarantee (see DEFAULT_STALE_MS § CEILING), and `withFileLock` announces it
  // ONLY through its `warn` sink — where it is prose nobody can aggregate. Lift
  // it onto the diagnostic outcome so the revisit trigger is observable rather
  // than anecdotal. It rides the SAME single `onLockOutcome` call (the override
  // happens during acquire, i.e. strictly before `fn`), which keeps the
  // documented "called exactly once" contract intact.
  let staleOverride = null;
  const warnAndWatch = (msg) => {
    const hit = /overriding stale lock \(([^)]*)\)/.exec(msg);
    if (hit) staleOverride = hit[1];
    warn(`${msg}\n`);
  };

  const result = await lockImpl(
    lockPath,
    async () => {
      outcomeReported = true;
      onLockOutcome?.({
        locked: true,
        lockPath,
        ...(staleOverride ? { staleOverride } : {}),
      });
      return await fn();
    },
    {
      timeoutMs,
      pollMs,
      staleCheck: 'mtime',
      staleMs,
      holder,
      indent: 2,
      tmpPrefix: '.board.lock',
      warn: warnAndWatch,
    },
  );

  if (result?.ok) return result.value;

  // Fail-open: never let a contended or broken lock abort a session phase.
  // `outcomeReported` guards the (impossible-by-contract, but cheap to pin)
  // case of an impl that both ran `fn` and reported failure.
  if (!outcomeReported) {
    const reason = result?.reason ?? 'unknown';
    warn(`⚠ withBoardLock: ${reason} acquiring ${lockPath} — writing board WITHOUT the lock (best-effort)\n`);
    onLockOutcome?.({ locked: false, lockPath, reason });
    return await fn();
  }
  return result?.value;
}
