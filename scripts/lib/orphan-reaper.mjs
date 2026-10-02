/**
 * orphan-reaper.mjs — Teil B of Epic #1425: the NET under the process-group kill.
 *
 * Teil A (`process-group.mjs`) prevents orphans at the source. This module finds
 * the ones that happen anyway — a session that crashed, a harness SIGKILL, a
 * leak from a foreign repo on the same host — and reaps them.
 *
 * The 2026-09-20 incident this exists for: four orphaned `tsgo --noEmit`
 * processes, two at PPID 1, 86-588% CPU and up to 8.0 GB RSS each; the Mac at
 * 13% free memory, load 67.4. The existing detector
 * (`countZombieProcesses`, `resource-probe/parsers.mjs`) would have counted ZERO:
 * its `ps` carries no `ppid` and no `rss`, its name filter knows only
 * `claude`/`node`, and it defines a zombie as IDLE (`cpu <= 1.0`) — the exact
 * opposite of a runaway.
 *
 * ## Shape: pure decision, impure execution
 *
 *   ps text → `parsePsSnapshot` → `decideReapCandidates` (PURE)
 *           → targeted ps + identity re-check BEFORE EVERY SIGNAL
 *           → `deps.killProcessGroup` → wait → re-measure (IMPURE)
 *
 * ## Layout (#1437)
 *
 * This file is the stable entry: the public re-exports below plus the CLI the
 * trigger hooks spawn. The implementation lives in `orphan-reaper/`:
 *
 *   defaults.mjs       `REAPER_DEFAULTS` + the repo-path join (node:path only)
 *   trigger.mjs        `maybeTriggerOrphanScan` — the ONE trigger both hooks
 *                      import; deliberately NOT re-exported here, so this CLI's
 *                      closure stays free of the config parser and platform.mjs
 *   scan-throttle.mjs  B4 throttle marker — loaded lazily by trigger.mjs
 *   no-follow-append.mjs  the O_NOFOLLOW|O_NONBLOCK append both ledgers share
 *   ps-snapshot.mjs    the binding `ps` format, its parser and runners
 *   reaper-decide.mjs  the PURE candidate decision and its identity checks
 *   reaper-audit.mjs   B5 audit record, writer, bounded reader, pruner, HR-101 rate
 *   scan.mjs           `runOrphanScan` + its `resolveDeps` adapter
 *
 * Explicit named re-exports, never `export *`: a star barrel hides which module
 * a name comes from, and the import census reads it as no reference at all.
 */

import { isMainModule } from './is-main-module.mjs';
import { REAPER_DEFAULTS } from './orphan-reaper/defaults.mjs';
import { runOrphanScan } from './orphan-reaper/scan.mjs';

export { REAPER_DEFAULTS } from './orphan-reaper/defaults.mjs';
export {
  SCAN_MARKER_RELPATH,
  scanMarkerPath,
  shouldScanNow,
  touchScanMarker,
} from './orphan-reaper/scan-throttle.mjs';
export {
  PS_ARGS,
  parsePsSnapshot,
  parsePsSnapshotDetailed,
  psPidArgs,
} from './orphan-reaper/ps-snapshot.mjs';
export {
  READ_ONLY_COMMAND_PATTERNS,
  decideReapCandidates,
  isReadOnlyCommand,
  verifyGroupMemberIdentity,
} from './orphan-reaper/reaper-decide.mjs';
export {
  FALSE_ALARM_SUSPECT_RATE,
  REAPER_AUDIT_RELPATH,
  auditPath,
  falseAlarmRate,
} from './orphan-reaper/reaper-audit.mjs';
export { REAPER_SCAN_EVENT, resolveDeps, runOrphanScan } from './orphan-reaper/scan.mjs';

// ---------------------------------------------------------------------------
// CLI (#1432 B4 follow-up)
// ---------------------------------------------------------------------------
//
// The two trigger hooks (`hooks/on-stop.mjs`,
// `hooks/post-tool-batch-wave-signal.mjs`) spawn the scan as a DETACHED child.
// Before this tail existed they had to hand `node` an `--input-type=module -e
// <program>` string that dynamically imported this module — a program the
// hooks carried as source text, in two byte-identical copies. This entry point
// replaces it with a plain argv call, so the hooks spawn `node
// scripts/lib/orphan-reaper.mjs --repo-root <p> --mode <m> …` and the child's
// contract lives HERE, in one place, next to the function it drives.

/**
 * Parse the CLI argv — PURE, and exported so the flag contract is testable
 * without starting a process (the argv form is what the two hooks build, so a
 * typo in it fails silently as a dead detached child).
 *
 * Never throws: an unknown flag, a missing value and a non-numeric value all
 * land in `errors`, which the tail maps to exit 2. Returning the errors rather
 * than throwing keeps this usable from a test and from the tail alike.
 *
 * @param {string[]} [argv]  `process.argv.slice(2)`
 * @returns {{help: boolean, json: boolean, repoRoot: string|null, mode: 'report'|'kill',
 *   dryRun: boolean, minAgeSeconds: number, killGraceMs: number, verifyWaitMs: number,
 *   falseAlarmWindow: number, errors: string[]}}
 */
export function parseReaperCliArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  /** @type {string[]} */
  const errors = [];
  const out = {
    help: false,
    json: false,
    repoRoot: null,
    mode: /** @type {'report'|'kill'} */ ('report'),
    dryRun: true,
    minAgeSeconds: REAPER_DEFAULTS.minAgeSeconds,
    killGraceMs: REAPER_DEFAULTS.killGraceMs,
    verifyWaitMs: REAPER_DEFAULTS.verifyWaitMs,
    falseAlarmWindow: REAPER_DEFAULTS.falseAlarmWindow,
    errors,
  };

  /**
   * Consume the value of `--flag <value>`; records an error when it is absent.
   * @param {string} flag @param {number} i @returns {string|null}
   */
  const valueAt = (flag, i) => {
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      errors.push(`missing value for ${flag}`);
      return null;
    }
    return value;
  };

  /**
   * A count of seconds/milliseconds: finite and non-negative. A `NaN` here
   * would reach `runOrphanScan` as a threshold that compares false against
   * everything — a silently disarmed gate, which is why it is an error and
   * never a fallback to the default.
   * @param {string} flag @param {string} raw @returns {number|null}
   */
  const numberFrom = (flag, raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      errors.push(`${flag} expects a non-negative number, got ${JSON.stringify(raw)}`);
      return null;
    }
    return n;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '--repo-root': {
        const value = valueAt(arg, i);
        if (value !== null) { out.repoRoot = value; i += 1; }
        break;
      }
      case '--mode': {
        const value = valueAt(arg, i);
        if (value === null) break;
        i += 1;
        if (value !== 'report' && value !== 'kill') {
          errors.push(`--mode expects report|kill, got ${JSON.stringify(value)}`);
          break;
        }
        out.mode = value;
        break;
      }
      case '--min-age-seconds':
      case '--kill-grace-ms':
      case '--verify-wait-ms': {
        const value = valueAt(arg, i);
        if (value === null) break;
        i += 1;
        const n = numberFrom(arg, value);
        if (n === null) break;
        if (arg === '--min-age-seconds') out.minAgeSeconds = n;
        else if (arg === '--kill-grace-ms') out.killGraceMs = n;
        else out.verifyWaitMs = n;
        break;
      }
      case '--false-alarm-window': {
        const value = valueAt(arg, i);
        if (value === null) break;
        i += 1;
        const n = numberFrom(arg, value);
        if (n === null) break;
        // A window of 0 is not "no window" — `falseAlarmRate` reads it as "every
        // firing ever recorded", which is the opposite of the rolling window the
        // key names. The config parser clamps at 1; the CLI refuses instead, so
        // a hand-run diagnosis never measures a different population than the
        // hook does.
        if (n < 1) {
          errors.push(`${arg} expects a number >= 1, got ${JSON.stringify(value)}`);
          break;
        }
        out.falseAlarmWindow = n;
        break;
      }
      default:
        errors.push(`unknown argument: ${arg}`);
    }
  }

  // `kill` is the ONLY value that disarms the dry run — same direction as
  // `runOrphanScan`'s own `dryRun = true` default: a caller that mistypes the
  // mode scans and reports, it does not signal. (A rejected `--mode` value
  // already left `mode` at `report`, so this stays `true` there too.)
  out.dryRun = out.mode !== 'kill';
  return out;
}

/** `--help` text. Exit codes documented here are the ones the tail returns. */
const REAPER_HELP_TEXT = `orphan-reaper.mjs — scan for orphaned read-only gate processes (#1425 Teil B)

USAGE
  node scripts/lib/orphan-reaper.mjs [options]

DESCRIPTION
  Runs ONE orphan scan: ps -> decide -> (with --mode kill) re-verify identity
  against a fresh snapshot -> kill the process group -> audit. Candidates are a
  CONJUNCTION: recorded in this repo's gate-process ledger, PPID 1, older than
  --min-age-seconds, a read-only gate command, and an identity that still
  verifies. Spawned detached by hooks/on-stop.mjs and
  hooks/post-tool-batch-wave-signal.mjs; runnable by hand for diagnosis.

OPTIONS
  --repo-root <path>        Repo whose ledger, audit and marker are used
                            (default: cwd).
  --mode report|kill        report = dry run, signals nothing (default);
                            kill = send the SIGTERM/SIGKILL ladder.
  --min-age-seconds <n>     Minimum elapsed time before a process is reapable
                            (default: ${REAPER_DEFAULTS.minAgeSeconds}).
  --kill-grace-ms <n>       Grace between SIGTERM and SIGKILL
                            (default: ${REAPER_DEFAULTS.killGraceMs}).
  --verify-wait-ms <n>      Wait before re-measuring the effect
                            (default: ${REAPER_DEFAULTS.verifyWaitMs}).
  --false-alarm-window <n>  Rolling window of audit DECISIONS the HR-101
                            false-alarm rate is judged over; >= 1
                            (default: ${REAPER_DEFAULTS.falseAlarmWindow}).
  --json                    Emit the full scan result as one JSON object.
  --help, -h                Show this help and exit.

EXIT CODES
  0  the scan ran (0 candidates is a normal, successful scan)
  2  usage error, or a degraded scan that measured nothing (\`skipped\`)
`;

/**
 * CLI body: one scan, one line (or one JSON object) of output.
 *
 * A degraded scan — `skipped: 'ps-failed' | 'ledger-unreadable' | …` — exits 2,
 * not 0: it measured NOTHING, and an exit 0 there is exactly the "missing
 * measurement looks like a zero" shape this module refuses everywhere else.
 * The detached hook child ignores the code; a human or a CI caller does not.
 *
 * @param {string[]} argv  `process.argv.slice(2)`
 * @returns {Promise<number>} process exit code
 */
async function mainCli(argv) {
  const cli = parseReaperCliArgs(argv);

  if (cli.help) {
    process.stdout.write(REAPER_HELP_TEXT);
    return 0;
  }
  if (cli.errors.length > 0) {
    for (const message of cli.errors) process.stderr.write(`orphan-reaper: ${message}\n`);
    process.stderr.write('Run with --help for usage.\n');
    return 2;
  }

  const repoRoot = cli.repoRoot ?? process.cwd();
  let result;
  try {
    result = await runOrphanScan({
      repoRoot,
      dryRun: cli.dryRun,
      minAgeSeconds: cli.minAgeSeconds,
      killGraceMs: cli.killGraceMs,
      verifyWaitMs: cli.verifyWaitMs,
      falseAlarmWindow: cli.falseAlarmWindow,
    });
  } catch (err) {
    // runOrphanScan carries a NO-THROW contract; this catch exists so a broken
    // contract surfaces as a tool error instead of an unhandled rejection.
    process.stderr.write(`orphan-reaper: scan failed — ${err?.message ?? String(err)}\n`);
    return 2;
  }

  if (cli.json) {
    process.stdout.write(`${JSON.stringify({ repoRoot, mode: cli.mode, ...result })}\n`);
  } else {
    process.stdout.write(
      `orphan-reaper: scanned=${result.scanned} candidates=${result.candidates.length} `
      + `reported=${result.reported.length} unattributed=${result.unattributed} `
      + `peer_liveness=${result.peerLiveness ?? 'none'} killed=${result.killed.length} `
      + `malformed=${result.malformed} mode=${cli.mode}`
      + `${result.skipped ? ` skipped=${result.skipped}` : ''}\n`,
    );
  }
  return result.skipped ? 2 : 0;
}

// Entry guard: a bare `import()` of this module must do NOTHING — tests and
// any caller of the re-exports above import it. Written
// in the one symlink-safe form `scripts/lib/validate/check-entry-guard.mjs`
// and `check-hook-entry-guards.mjs` accept.
//
// `process.exitCode` rather than `process.exit()`: `--json` carries the whole
// result, whose `rejected` array materialises every PPID-1 row not in the
// ledger — measured 2026-09-22 on this host, 40.224 bytes for 834 processes,
// the same order as the 64 KiB pipe buffer above which `process.exit()`
// DISCARDS the pending write and turns a full result into a truncated one.
if (isMainModule(import.meta.url)) {
  process.exitCode = await mainCli(process.argv.slice(2));
}
