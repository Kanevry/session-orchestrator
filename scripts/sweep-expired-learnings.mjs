#!/usr/bin/env node
/**
 * sweep-expired-learnings.mjs — CLI for the mechanical expiry/archive sweep
 * (Epic #723 B4).
 *
 * Moves `learnings.jsonl` entries that have been expired for longer than the
 * grace period into an append-only archive sidecar. NEVER deletes data —
 * archived entries remain readable in the archive file, tagged with
 * `_archived_at` / `_archive_reason: "expired"`.
 *
 * All read/partition/write logic lives in
 * `scripts/lib/learnings/expiry-sweep.mjs` (`sweepExpiredLearnings`), which
 * delegates the destructive store rewrite to `rewriteLearnings()` from
 * `scripts/lib/learnings/io.mjs` — automatic `.bak-<ISO>` backup + keep-3
 * rotation (#721) protects every `--apply` run.
 *
 * Usage:
 *   node scripts/sweep-expired-learnings.mjs [--dry-run|--apply] [--json]
 *     [--grace-days N] [--file PATH] [--archive PATH]
 *
 * Flags:
 *   --dry-run         Preview counts; write nothing (DEFAULT)
 *   --apply           Archive stale-expired entries + rewrite the store
 *   --json            Emit a single machine-parseable JSON summary line
 *                      (default: human-readable one-liner)
 *   --grace-days N    Days past expiry before archiving (default: 14)
 *   --file PATH       Learnings store (default: .orchestrator/metrics/learnings.jsonl)
 *   --archive PATH    Archive sidecar (default: .orchestrator/metrics/learnings-archive.jsonl)
 *
 * Exit codes:
 *   0  Success (including no-op when nothing is archive-eligible)
 *   1  Usage error (bad flag/value)
 *   2  Sweep error (I/O or validation failure inside sweepExpiredLearnings)
 */

import { sweepExpiredLearnings } from './lib/learnings/expiry-sweep.mjs';

const DEFAULT_FILE = '.orchestrator/metrics/learnings.jsonl';
const DEFAULT_ARCHIVE = '.orchestrator/metrics/learnings-archive.jsonl';
const DEFAULT_GRACE_DAYS = 14;

function printHelp() {
  process.stdout.write(
    `Usage: node scripts/sweep-expired-learnings.mjs [--dry-run|--apply] [--json] [--grace-days N] [--file PATH] [--archive PATH]

Options:
  --dry-run         Preview counts; write nothing (default)
  --apply           Archive stale-expired entries + rewrite the store
  --json            Emit a single machine-parseable JSON summary line
  --grace-days N    Days past expiry before archiving (default: ${DEFAULT_GRACE_DAYS})
  --file PATH       Learnings store (default: ${DEFAULT_FILE})
  --archive PATH    Archive sidecar (default: ${DEFAULT_ARCHIVE})

Exit codes:  0 success  1 usage error  2 sweep error
`
  );
}

function parseArgs(argv) {
  const args = {
    dryRun: true,
    json: false,
    graceDays: DEFAULT_GRACE_DAYS,
    file: DEFAULT_FILE,
    archive: DEFAULT_ARCHIVE,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') {
      args.dryRun = false;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--grace-days') {
      const raw = argv[++i];
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) {
        process.stderr.write(
          `sweep-expired-learnings: --grace-days requires a non-negative number, got: ${raw}\n`
        );
        process.exit(1);
      }
      args.graceDays = v;
    } else if (a === '--file') {
      args.file = argv[++i];
    } else if (a === '--archive') {
      args.archive = argv[++i];
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      process.stderr.write(`sweep-expired-learnings: unknown argument: ${a}\n`);
      process.exit(1);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

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

main().catch((err) => {
  process.stderr.write(`sweep-expired-learnings: unexpected error: ${err?.stack ?? err}\n`);
  process.exit(2);
});
