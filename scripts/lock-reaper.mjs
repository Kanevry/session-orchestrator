/**
 * lock-reaper.mjs — CLI: reconcile orphaned session.lock leases across the fleet.
 *
 * Host-wide reconciliation for `session.lock` leases left behind by crashed or
 * abandoned sessions (Epic #724 C7). Wraps scripts/lib/lock-reaper.mjs
 * reapStaleLocks(); default mode is --dry-run (classify only). Pass --apply to
 * archive-move dead-lease locks.
 *
 * SAFETY: reaping only ever touches OWN-HOST leases whose heartbeat is past TTL
 * and whose recorded PID is dead. Live leases and cross-host leases are never
 * reaped — see the lib's HARD SAFETY INVARIANTS. Every reap is an archive-move
 * (a copy is written to <repo>/.orchestrator/tmp/reaped-locks/ before the
 * original is removed), never an unlink-only.
 *
 * DO NOT run --apply against the real ~/Projects while parallel sessions are
 * active unless you understand the invariants — the live-lock guard protects
 * them, but --dry-run first is the safe habit.
 *
 * Exit codes: 0 success · 1 user/input error (bad flags) · 2 system error.
 *
 * Exports (for unit tests): main.
 */

import { reapStaleLocks } from './lib/lock-reaper.mjs';

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

/**
 * @param {number|null} ageHours
 * @returns {string}
 */
function formatAge(ageHours) {
  if (ageHours === null || ageHours === undefined) return 'unknown age';
  if (ageHours >= 24) return `${(ageHours / 24).toFixed(1)}d stale`;
  return `${ageHours.toFixed(1)}h stale`;
}

/**
 * Print a human-readable summary to stdout.
 *
 * @param {{ scanned:number, candidates:object[], reaped:object[], skipped:object[], dryRun:boolean }} result
 */
function printHuman(result) {
  const { scanned, candidates, reaped, skipped, dryRun } = result;

  process.stdout.write(`Scanned ${scanned} repo(s).\n`);

  if (candidates.length > 0) {
    const label = dryRun ? 'REAP CANDIDATES' : 'REAPED';
    process.stdout.write(`  ${label} (${candidates.length}):\n`);
    for (const c of candidates) {
      const archived = c.archivePath ? ` → ${c.archivePath}` : '';
      process.stdout.write(`    ${c.repoName ?? c.repo} — session ${c.sessionId}, ${formatAge(c.ageHours)}${archived}\n`);
    }
  }

  if (skipped.length > 0) {
    process.stdout.write(`  SKIPPED (${skipped.length}):\n`);
    for (const s of skipped) {
      process.stdout.write(`    ${s.repo} — ${s.reason}\n`);
    }
  }

  if (dryRun) {
    process.stdout.write(
      `\nDry-run mode. Use --apply to archive-move the ${candidates.length} candidate(s).\n`,
    );
  } else {
    process.stdout.write(`\nApplied. Archived ${reaped.length} orphaned lease(s).\n`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Parse argv, run the reconciliation, print the result.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv]     — override process.argv.slice(2) (tests).
 * @param {string} [opts.startDir]   — override scan root (tests + --start-dir).
 * @param {object} [opts.deps]       — forwarded to reapStaleLocks (tests).
 * @returns {Promise<0|1|2>} exit code.
 */
export async function main(opts = {}) {
  const argv = opts.argv ?? process.argv.slice(2);

  let flagDryRun = false;
  let flagApply = false;
  let flagJson = false;
  let flagHelp = false;
  let startDir = opts.startDir;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        flagDryRun = true;
        break;
      case '--apply':
        flagApply = true;
        break;
      case '--json':
        flagJson = true;
        break;
      case '--start-dir':
        startDir = argv[++i];
        if (typeof startDir !== 'string' || startDir.length === 0) {
          process.stderr.write('lock-reaper: --start-dir requires a path argument.\n');
          return 1;
        }
        break;
      case '--help':
      case '-h':
        flagHelp = true;
        break;
      default:
        process.stderr.write(`lock-reaper: unknown argument: ${arg}\n`);
        process.stderr.write('Run with --help for usage.\n');
        return 1;
    }
  }

  if (flagHelp) {
    process.stdout.write(`lock-reaper.mjs — reconcile orphaned session.lock leases across the fleet

USAGE
  node scripts/lock-reaper.mjs [--dry-run] [--apply] [--json] [--start-dir <path>] [--help]

FLAGS
  --dry-run          (default) Classify orphaned leases; no filesystem mutations.
  --apply            Archive-move own-host dead-lease locks. Requires explicit opt-in.
  --json             Emit machine-readable JSON to stdout.
  --start-dir <path> Override the scan root (defaults to the confinement root).
  -h, --help         Show this help text and exit.

SAFETY
  Only own-host leases whose heartbeat is past TTL AND whose recorded PID is
  dead are reaped. Live leases and cross-host leases are never reaped — they are
  listed for an operator. Every reap is an archive-move to
  <repo>/.orchestrator/tmp/reaped-locks/, never an unlink-only.

EXIT CODES
  0 — success
  1 — user/input error (bad flags)
  2 — system error (unexpected exception)
`);
    return 0;
  }

  if (flagApply && flagDryRun) {
    process.stderr.write('lock-reaper: --apply and --dry-run are mutually exclusive.\n');
    process.stderr.write('Run with --help for usage.\n');
    return 1;
  }

  // Default: dry-run unless --apply was given.
  const dryRun = !flagApply;

  const result = await reapStaleLocks({ startDir, dryRun, deps: opts.deps });

  if (flagJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    printHuman(result);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// CLI guard — prevents execution during test-time imports.
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`lock-reaper: unexpected error: ${err?.stack ?? err}\n`);
      process.exit(2);
    });
}
