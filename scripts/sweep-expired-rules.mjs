#!/usr/bin/env node
/**
 * sweep-expired-rules.mjs — CLI for the generated-rule expiry sweep (#1377).
 *
 * The sibling of `scripts/sweep-expired-learnings.mjs`, one corpus over:
 * that one moves expired LEARNINGS out of `learnings.jsonl`, this one removes
 * expired ENTRIES from the consolidated `.claude/rules/*.md` files that were
 * generated from them. `scripts/lib/rule-loader.mjs` already refuses to inject
 * an expired generated rule; nothing until now removed one from disk.
 *
 * All planning and writing logic lives in
 * `scripts/lib/reconcile/rule-expiry-sweep.mjs`
 * (`planRuleExpirySweep` / `applyRuleExpirySweep`). This file is argv parsing,
 * output formatting, the event emit, and exit codes — nothing else.
 *
 * SAFETY: `--dry-run` is the DEFAULT and writes nothing. `--apply` is the only
 * write path, and it rewrites or deletes TRACKED files under `.claude/rules/`.
 *
 * Usage:
 *   node scripts/sweep-expired-rules.mjs [--dry-run|--apply] [--json]
 *     [--grace-days N] [--now ISO] [--repo-root PATH] [--learnings PATH]
 *
 * Exit codes (the same contract as the learnings sweep CLI, deliberately —
 * two sibling commands with inverted codes is a trap for the operator who
 * learns one of them):
 *   0  Success, including the no-op when nothing is expired
 *   1  Usage/invocation error (bad flag or value)
 *   2  Sweep error (an I/O or validation failure inside the lib, or any
 *      per-file error on the `--apply` path)
 */

import { emitEvent } from './lib/events.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import {
  RULE_EXPIRY_SWEEP_EVENT,
  applyRuleExpirySweep,
  planRuleExpirySweep,
} from './lib/reconcile/rule-expiry-sweep.mjs';

const DEFAULT_GRACE_DAYS = 0;

function printHelp() {
  process.stdout.write(
    `Usage: node scripts/sweep-expired-rules.mjs [--dry-run|--apply] [--json] [--grace-days N] [--now ISO] [--repo-root PATH] [--learnings PATH]

Removes EXPIRED entries from the consolidated machine-generated rule files in
.claude/rules/. An expired entry's prose block is deleted; its "## Provenance"
pair is KEPT as a "markers only" bullet, because /reconcile dedupes on those
markers and dropping one re-proposes the learning. A file is deleted only when
every substantive entry expired, and every provenance key is stamped terminal
before the unlink.

Options:
  --dry-run         Preview the plan; write nothing (DEFAULT)
  --apply           Perform the rewrites/deletes and emit the ledger event
  --json            Emit a single machine-parseable JSON summary line
  --grace-days N    Days past expiry before an entry is swept (default: ${DEFAULT_GRACE_DAYS})
  --now ISO         Injected clock (testing / what-if planning)
  --repo-root PATH  Repo root (default: process.cwd())
  --learnings PATH  Learnings store, repo-relative (default: the metrics store)

Exit codes:  0 success  1 usage/invocation error  2 sweep error
`,
  );
}

/** Exit 1 with a diagnostic on stderr (usage/invocation errors). */
function usageError(message) {
  process.stderr.write(`sweep-expired-rules: ${message}\n`);
  process.exit(1);
}

export function parseArgs(argv) {
  const args = {
    dryRun: true,
    json: false,
    graceDays: DEFAULT_GRACE_DAYS,
    now: null,
    repoRoot: process.cwd(),
    learnings: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.dryRun = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--grace-days') {
      const raw = argv[++i];
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) {
        usageError(`--grace-days requires a non-negative number, got: ${raw}`);
      }
      args.graceDays = v;
    } else if (a === '--now') {
      const raw = argv[++i];
      if (typeof raw !== 'string' || !Number.isFinite(Date.parse(raw))) {
        usageError(`--now requires an ISO timestamp, got: ${raw}`);
      }
      args.now = raw;
    } else if (a === '--repo-root') {
      const raw = argv[++i];
      if (typeof raw !== 'string' || raw.length === 0) usageError('--repo-root requires a path');
      args.repoRoot = raw;
    } else if (a === '--learnings') {
      const raw = argv[++i];
      if (typeof raw !== 'string' || raw.length === 0) usageError('--learnings requires a path');
      args.learnings = raw;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      usageError(`unknown argument: ${a}`);
    }
  }
  return args;
}

/**
 * Roll the plan up into the summary both output modes render.
 *
 * `header_raises` is additive (#1388 P7): a header-raise is an
 * `action: 'rewrite'` plan carrying `reason: 'header-raise'`, so it was counted
 * inside `rewrites` and invisible on the human stdout line although `--json`
 * always carried `plans[].reason`. It is a SUBSET of `rewrites`, never a
 * sibling category — the two are deliberately not disjoint.
 */
export function summarize(plan, args, applied) {
  const counts = { rewrite: 0, delete: 0, keep: 0 };
  for (const p of plan.plans) counts[p.action] = (counts[p.action] ?? 0) + 1;
  const headerRaises = plan.plans.filter((p) => p.reason === 'header-raise').length;
  return {
    dry_run: args.dryRun,
    grace_days: args.graceDays,
    files_scanned: plan.plans.length,
    rewrites: counts.rewrite,
    header_raises: headerRaises,
    deletes: counts.delete,
    keeps: counts.keep,
    expired_entries: plan.plans.reduce((n, p) => n + p.expiredPairIds.length, 0),
    unresolved_pairs: plan.plans.reduce((n, p) => n + p.unresolvedPairIds.length, 0),
    malformed_lines: plan.malformedLines,
    rules_dir_readable: plan.ok,
    skipped: plan.skipped,
    plans: plan.plans.map(({ nextContent: _nextContent, ...rest }) => rest),
    ...(applied ? { applied } : {}),
  };
}

async function main(argv) {
  const args = parseArgs(argv);

  let plan;
  try {
    plan = await planRuleExpirySweep({
      repoRoot: args.repoRoot,
      now: args.now ?? undefined,
      graceDays: args.graceDays,
      learningsPath: args.learnings ?? undefined,
    });
  } catch (err) {
    process.stderr.write(`sweep-expired-rules: planning failed: ${err?.message ?? err}\n`);
    process.exit(2);
  }

  let applied = null;
  if (!args.dryRun) {
    applied = applyRuleExpirySweep(plan, { repoRoot: args.repoRoot, now: args.now ?? undefined });
  }

  const summary = summarize(plan, args, applied);

  if (args.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else {
    process.stdout.write(
      `sweep-expired-rules: ${args.dryRun ? 'dry-run' : 'applied'} — ` +
        `${summary.files_scanned} generated rule file(s), ${summary.rewrites} rewrite(s) ` +
        `(${summary.header_raises} header-raise(s)), ` +
        `${summary.deletes} delete(s), ${summary.expired_entries} expired entr(ies), ` +
        `${summary.unresolved_pairs} unresolved pair(s), ${summary.skipped.length} skipped, ` +
        `${summary.malformed_lines} malformed learnings line(s)\n`,
    );
    for (const s of plan.skipped) process.stdout.write(`  skipped ${s.file}: ${s.reason}\n`);
    for (const p of plan.plans) {
      if (p.advisory) process.stdout.write(`  advisory ${p.file}: ${p.advisory}\n`);
    }
  }

  if (applied) {
    for (const e of applied.errors) {
      process.stderr.write(`sweep-expired-rules: ${e.file}: ${e.error}\n`);
    }
    // Emitted on apply ONLY, and AFTER the writes: a record's presence is proof
    // that `.claude/rules/` was actually changed, never that a preview ran.
    // Wrapped because `emitEvent` THROWS `EventValidationError` — a telemetry
    // failure must not turn a completed sweep into a non-zero exit.
    try {
      await emitEvent(
        RULE_EXPIRY_SWEEP_EVENT,
        {
          rewritten: applied.rewritten.length,
          deleted: applied.deleted.length,
          stamped: applied.stamped,
          write_errors: applied.errors.length,
          expired_entries: summary.expired_entries,
          files_scanned: summary.files_scanned,
          source: 'sweep-expired-rules-cli',
        },
        { repoRoot: args.repoRoot },
      );
    } catch (err) {
      process.stderr.write(`sweep-expired-rules: event emit failed: ${err?.message ?? err}\n`);
    }
    if (applied.errors.length > 0) process.exit(2);
  }

  if (!plan.ok) {
    process.stderr.write(
      'sweep-expired-rules: .claude/rules/ exists but could not be enumerated — ' +
        'the plan above is INCOMPLETE, not clean.\n',
    );
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) {
  await main(process.argv.slice(2));
}
