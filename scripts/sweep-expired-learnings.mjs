#!/usr/bin/env node
/**
 * sweep-expired-learnings.mjs — CLI for the two mechanical archive-safe writers
 * over `learnings.jsonl`: the time-driven expiry sweep (Epic #723 B4, default)
 * and the decision-driven prune (`--prune`, issue #1017).
 *
 * Both move records OUT of the active store and INTO an append-only archive
 * sidecar. NEVER deletes data — archived entries remain readable in the archive
 * file, tagged with `_archived_at` and an `_archive_reason` from the closed
 * enum `expired | pruned | superseded | merged`.
 *
 * All read/partition/write logic lives in
 * `scripts/lib/learnings/expiry-sweep.mjs` (`sweepExpiredLearnings` /
 * `pruneLearnings`), which delegates the destructive store rewrite to
 * `rewriteLearnings()` from `scripts/lib/learnings/io.mjs` — automatic
 * `.bak-<ISO>` backup + keep-3 rotation (#721) protects every `--apply` run.
 *
 * Why `--prune` is a subcommand here and not an inline `node -e` block in
 * `skills/evolve/SKILL.md`: a mechanism that lives inside prose has no test, no
 * `--help`, and no exit-code contract. `/evolve` names this command; the
 * mechanism stays in code.
 *
 * Usage:
 *   node scripts/sweep-expired-learnings.mjs [--prune] [--dry-run|--apply] [--json]
 *     [--grace-days N] [--entries PATH] [--file PATH] [--archive PATH]
 *     [--appended N] [--boosted M] [--duration-ms D] [--skipped a,b] [--repo-root PATH]
 *
 * Flags:
 *   --prune           Decision-driven prune+consolidate+rewrite instead of the
 *                      time-driven expiry sweep (issue #1017)
 *   --dry-run         Preview counts; write nothing (DEFAULT, both modes)
 *   --apply           Perform the archive append + store rewrite
 *   --json            Emit a single machine-parseable JSON summary line
 *                      (default: human-readable one-liner)
 *   --grace-days N    Days past expiry before archiving (default: 14).
 *                      SWEEP ONLY — `--prune` has no grace window by design.
 *   --entries PATH    JSONL sidecar holding the caller's next store generation.
 *                      PRUNE ONLY. Must exist, parse cleanly, and hold at least
 *                      one record — absent/malformed/empty all exit 1 untouched.
 *                      Omitted ⇒ a pure prune+consolidate pass over the on-disk
 *                      store.
 *   --file PATH       Learnings store (default: .orchestrator/metrics/learnings.jsonl)
 *   --archive PATH    Archive sidecar (default: .orchestrator/metrics/learnings-archive.jsonl)
 *   --appended N      PRUNE ONLY (#1206). New learnings written this `/evolve`
 *                      run (Step 3.5(4)); folded into the mechanical
 *                      `orchestrator.evolve.completed` emit alongside this
 *                      call's own `pruned` count. Default 0.
 *   --boosted M       PRUNE ONLY (#1206). Existing learnings reinforced this
 *                      run (Step 3.5(2)). Default 0.
 *   --duration-ms D   PRUNE ONLY (#1206). Elapsed ms since the run's telemetry
 *                      start marker. Default 0.
 *   --skipped a,b     PRUNE ONLY (#1206). Comma-separated list of optional
 *                      steps that ran but were themselves skipped this run
 *                      (HR-105 — e.g. `skill-evolution-off`). Default none.
 *   --repo-root PATH  PRUNE ONLY (#1206). Repo root the
 *                      `orchestrator.evolve.completed` record is pinned to.
 *                      No default and NO process.cwd() fallback (#1119) — when
 *                      omitted, no event is emitted at all (stderr WARN, exit
 *                      code unaffected). Emission is best-effort and never
 *                      changes this command's exit code or stdout contract.
 *
 * Exit codes:
 *   0  Success (including no-op when nothing is archive-eligible)
 *   1  Usage/input error (bad flag/value, flag used in the wrong mode, or an
 *      absent/malformed/empty `--entries` sidecar)
 *   2  Sweep/prune error (I/O or validation failure inside the lib)
 */

import { existsSync } from 'node:fs';
import { sweepExpiredLearnings, pruneLearnings } from './lib/learnings/expiry-sweep.mjs';
import { readLearnings } from './lib/learnings/io.mjs';
import { emitEvolveCompleted } from './lib/learnings/evolve-telemetry.mjs';

const DEFAULT_FILE = '.orchestrator/metrics/learnings.jsonl';
const DEFAULT_ARCHIVE = '.orchestrator/metrics/learnings-archive.jsonl';
const DEFAULT_GRACE_DAYS = 14;

function printHelp() {
  process.stdout.write(
    `Usage: node scripts/sweep-expired-learnings.mjs [--prune] [--dry-run|--apply] [--json] [--grace-days N] [--entries PATH] [--file PATH] [--archive PATH]

Modes:
  (default)         Expiry sweep — archive entries expired past the grace window
  --prune           Prune + consolidate + rewrite (issue #1017): archives
                    expired / zero-confidence / superseded / caller-dropped
                    records instead of deleting them

Options:
  --dry-run         Preview counts; write nothing (default)
  --apply           Perform the archive append + store rewrite
  --json            Emit a single machine-parseable JSON summary line
  --grace-days N    Days past expiry before archiving (default: ${DEFAULT_GRACE_DAYS}); sweep only
  --entries PATH    JSONL sidecar with the next store generation; prune only.
                    Must exist, parse cleanly, and hold >= 1 record
  --file PATH       Learnings store (default: ${DEFAULT_FILE})
  --archive PATH    Archive sidecar (default: ${DEFAULT_ARCHIVE})

Exit codes:  0 success  1 usage/input error  2 sweep/prune error
`
  );
}

/** Exit 1 with a diagnostic on stderr (usage/input errors). */
function usageError(message) {
  process.stderr.write(`sweep-expired-learnings: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    prune: false,
    dryRun: true,
    json: false,
    graceDays: DEFAULT_GRACE_DAYS,
    graceDaysExplicit: false,
    entries: null,
    file: DEFAULT_FILE,
    archive: DEFAULT_ARCHIVE,
    appended: 0,
    boosted: 0,
    durationMs: 0,
    skipped: [],
    // #1119 — NO process.cwd() fallback. Most CLI callers (every test in this
    // file except the SKILL.md-extraction fixture, which sets its own tmp
    // `cwd`) invoke this script from the repo root without `--repo-root`; a
    // cwd fallback would silently append synthetic `orchestrator.evolve.
    // completed` records to the operator's REAL fleet ledger on every
    // `--prune --apply` run in `npm test`. `emitEvolveCompleted()` already
    // refuses to emit (stderr WARN, no throw) when repoRoot is absent — same
    // fail-closed contract as `emitReconcileCompleted` / `express-path.mjs`.
    repoRoot: null,
    telemetryExplicit: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prune') {
      args.prune = true;
    } else if (a === '--apply') {
      args.dryRun = false;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--grace-days') {
      const raw = argv[++i];
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) {
        usageError(`--grace-days requires a non-negative number, got: ${raw}`);
      }
      args.graceDays = v;
      args.graceDaysExplicit = true;
    } else if (a === '--entries') {
      args.entries = argv[++i];
    } else if (a === '--file') {
      args.file = argv[++i];
    } else if (a === '--archive') {
      args.archive = argv[++i];
    } else if (a === '--appended') {
      const raw = argv[++i];
      const v = Number(raw);
      if (!Number.isInteger(v) || v < 0) {
        usageError(`--appended requires a non-negative integer, got: ${raw}`);
      }
      args.appended = v;
      args.telemetryExplicit = true;
    } else if (a === '--boosted') {
      const raw = argv[++i];
      const v = Number(raw);
      if (!Number.isInteger(v) || v < 0) {
        usageError(`--boosted requires a non-negative integer, got: ${raw}`);
      }
      args.boosted = v;
      args.telemetryExplicit = true;
    } else if (a === '--duration-ms') {
      const raw = argv[++i];
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) {
        usageError(`--duration-ms requires a non-negative number, got: ${raw}`);
      }
      args.durationMs = v;
      args.telemetryExplicit = true;
    } else if (a === '--skipped') {
      const raw = argv[++i];
      args.skipped = typeof raw === 'string' ? raw.split(',').filter((s) => s.length > 0) : [];
      args.telemetryExplicit = true;
    } else if (a === '--repo-root') {
      args.repoRoot = argv[++i];
      args.telemetryExplicit = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      usageError(`unknown argument: ${a}`);
    }
  }

  // Mode/flag mismatches are usage errors, never silent no-ops: a `--grace-days`
  // that the prune path ignores would read as "the grace window applied" in a
  // transcript, and an `--entries` the sweep ignores would read as "my next
  // generation was written".
  if (args.prune && args.graceDaysExplicit) {
    usageError('--grace-days is not valid with --prune (the prune path has no grace window)');
  }
  if (!args.prune && args.entries !== null) {
    usageError('--entries is only valid with --prune');
  }
  if (!args.prune && args.telemetryExplicit) {
    usageError(
      '--appended/--boosted/--duration-ms/--skipped/--repo-root are only valid with --prune ' +
        '(the sweep path never emits orchestrator.evolve.completed)',
    );
  }
  return args;
}

/**
 * Time-driven expiry sweep (Epic #723 B4) — the default mode.
 *
 * @param {ReturnType<typeof parseArgs>} args
 */
async function runSweep(args) {
  let result;
  try {
    result = await sweepExpiredLearnings({
      filePath: args.file,
      archivePath: args.archive,
      dryRun: args.dryRun,
      graceDays: args.graceDays,
    });
  } catch (err) {
    process.stderr.write(`sweep-expired-learnings: sweep failed: ${err.message}\n`);
    process.exit(2);
  }

  const summary = {
    file: args.file,
    grace_days: args.graceDays,
    ...result,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    process.stdout.write(
      `sweep-expired-learnings: scanned=${summary.scanned} kept=${summary.kept} ` +
        `archived=${summary.archived} dry_run=${summary.dryRun} archive=${summary.archivePath}\n`
    );
  }
}

/**
 * Resolve the `--entries` sidecar into the caller's next store generation.
 *
 * Fails closed on THREE input conditions, all of which yield the same lethal
 * value — an empty next generation, which makes `pruneLearnings()` treat the
 * ENTIRE store as caller-dropped:
 *
 *   1. **absent file** — `readLearnings()` returns `{entries: [], malformed: []}`
 *      for a missing path, so one mistyped path would archive every active
 *      learning. A path the operator named and the filesystem does not have is
 *      an input error, not an empty set.
 *   2. **malformed line** — a half-written sidecar reads as a SHORTER next
 *      generation, pruning every record the truncated tail omitted.
 *   3. **parses to zero records** — a 0-byte or blank-line-only file. Guard (1)
 *      closes ABSENCE, which is a different condition: an empty file EXISTS, so
 *      it sails past `existsSync` and parses to a legitimate-looking empty
 *      generation. Measured on a 3-record fixture before this guard: a 0-byte
 *      `--entries` archived all 3 and exited 0.
 *
 * Condition 3 is REJECTED rather than obeyed because at a file boundary an
 * empty parse is indistinguishable from a truncated write, a failed producer,
 * or a typo that landed on an unrelated empty file — and no caller expresses
 * "archive the whole corpus" through this flag: `/evolve`'s next generation
 * always carries the survivors. The cost of rejecting a genuinely-intended
 * empty generation is one re-run; the cost of obeying a corrupt one is the
 * active store. Note this guard is deliberately NOT in `pruneLearnings()`: an
 * explicit `entries: []` written in CODE is a statement, and the lib keeps it
 * expressible. Only the FILE is ambiguous, so only the file is guarded.
 *
 * @param {string} entriesPath
 * @returns {Promise<object[]>} the validated, non-empty next generation
 */
async function loadEntriesSidecar(entriesPath) {
  if (!existsSync(entriesPath)) {
    usageError(
      `--entries sidecar not found: ${entriesPath} (refusing to prune — an absent ` +
        `next generation would archive the whole store)`
    );
  }
  let read;
  try {
    read = await readLearnings(entriesPath);
  } catch (err) {
    usageError(`--entries sidecar unreadable: ${entriesPath}: ${err.message}`);
  }
  if (read.malformed.length > 0) {
    usageError(
      `refusing to prune — ${read.malformed.length} malformed line(s) in ${entriesPath}`
    );
  }
  if (read.entries.length === 0) {
    usageError(
      `--entries sidecar holds no records: ${entriesPath} (refusing to prune — an empty ` +
        `next generation would archive every record in the store; omit --entries for a ` +
        `pure prune+consolidate pass)`
    );
  }
  return read.entries;
}

/**
 * Decision-driven prune + consolidate + rewrite (issue #1017).
 *
 * @param {ReturnType<typeof parseArgs>} args
 */
async function runPrune(args) {
  const entries = args.entries === null ? undefined : await loadEntriesSidecar(args.entries);

  let result;
  try {
    result = await pruneLearnings({
      filePath: args.file,
      archivePath: args.archive,
      entries,
      dryRun: args.dryRun,
    });
  } catch (err) {
    process.stderr.write(`sweep-expired-learnings: prune failed: ${err.message}\n`);
    process.exit(2);
  }

  const summary = {
    file: args.file,
    entries_from: args.entries,
    ...result,
  };

  // #1206 — the ONE mechanical call site for `orchestrator.evolve.completed`:
  // this `--prune --apply` invocation IS `/evolve analyze`'s Step 3.5(5) store
  // write, so folding the emit in here (instead of a separate
  // `emit-event.mjs` call in skill prose) means the event can no longer be
  // forgotten independently of the write it reports on. Gated on `!dryRun` —
  // a `--prune --dry-run` preview (the docs' own recommended pre-check for a
  // hand-assembled `--entries` sidecar) never wrote anything, so it must not
  // report a completed run either. Best-effort — never changes this
  // command's exit code or stdout contract.
  if (!args.dryRun) {
    await emitEvolveCompleted({
      repoRoot: args.repoRoot,
      appended: args.appended,
      boosted: args.boosted,
      pruned: result.archived,
      durationMs: args.durationMs,
      skipped: args.skipped,
    });
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    const byReason =
      Object.entries(summary.byReason)
        .map(([reason, n]) => `${reason}:${n}`)
        .join(',') || '-';
    process.stdout.write(
      `sweep-expired-learnings: prune scanned=${summary.scanned} kept=${summary.kept} ` +
        `archived=${summary.archived} by_reason=${byReason} dry_run=${summary.dryRun} ` +
        `archive=${summary.archivePath}\n`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.prune) {
    await runPrune(args);
    return;
  }
  await runSweep(args);
}

main().catch((err) => {
  process.stderr.write(`sweep-expired-learnings: unexpected error: ${err?.stack ?? err}\n`);
  process.exit(2);
});
