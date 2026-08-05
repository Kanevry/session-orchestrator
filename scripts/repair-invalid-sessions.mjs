#!/usr/bin/env node
/**
 * repair-invalid-sessions.mjs — one-time repair CLI for schema-invalid session
 * ledger records (GitLab #1004).
 *
 * Thin driver: argument parsing, output rendering, exit codes. All repair logic
 * lives in `scripts/lib/session-record-repair.mjs` so tests import functions
 * instead of spawning a process.
 *
 *   node scripts/repair-invalid-sessions.mjs [--dry-run|--apply] [--json]
 *                                            [--file PATH] [--repo-root PATH]
 *                                            [--no-backup]
 *
 * SAFETY: `--dry-run` is the DEFAULT — nothing is written unless `--apply` is
 * passed. Under `--apply` the original is copied to `<file>.bak-<stamp>` BEFORE
 * the swap, the new content is written to `<file>.tmp-<pid>` and renamed over
 * the target (atomic), and the result is then re-verified against BOTH
 * `validateSession` and `checkSessionsIntegrity`. A failed verification restores
 * the backup byte-identically and exits 3 — the ledger is never left in a state
 * worse than the one this CLI found.
 *
 * Exit codes (`.claude/rules/cli-design.md`):
 *   0 — completed (dry-run or apply); the ledger is clean or unchanged
 *   1 — user/input error (bad flag, unknown argument)
 *   2 — system error (unreadable/unwritable ledger, I/O failure)
 *   3 — post-verification failed; the backup was restored and nothing was kept
 */

import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { repairLedger, CANONICAL_LEDGER_REL } from './lib/session-record-repair.mjs';
import { SO_PROJECT_DIR } from './lib/platform.mjs';

const USAGE =
  'Usage: node scripts/repair-invalid-sessions.mjs [--dry-run|--apply] [--json]\n' +
  '                                                [--file PATH] [--repo-root PATH]\n' +
  '                                                [--no-backup]\n' +
  '  --dry-run     preview only (DEFAULT — nothing is written)\n' +
  '  --apply       rewrite the ledger in place (backup + atomic rename)\n' +
  '  --json        emit the summary as JSON to stdout\n' +
  '  --file        ledger path (default: <repo-root>/' +
  CANONICAL_LEDGER_REL +
  ')\n' +
  '  --repo-root   project root (default: resolved SO_PROJECT_DIR)\n' +
  '  --no-backup   skip the .bak-<stamp> copy under --apply (not recommended)\n' +
  'Exit codes: 0 completed, 1 arg error, 2 system error, 3 post-verification failed\n';

/**
 * Human-readable summary — mirrors `scripts/backfill-abandoned-sessions.mjs`
 * `renderHuman()` so the two migration CLIs read the same way.
 *
 * @param {object} s summary from `repairLedger`
 * @returns {string}
 */
export function renderHuman(s) {
  const lines = [];
  lines.push(`Repair invalid session records — ${s.mode}`);
  lines.push(`  file:            ${s.file}`);
  lines.push(`  lines:           ${s.total}`);
  lines.push(`  invalid before:  ${s.invalid_before}`);
  lines.push(`  ${s.mode === 'apply' ? 'repaired:       ' : 'would repair:   '} ${s.repaired}`);
  lines.push(`  invalid after:   ${s.invalid_after}${s.mode === 'apply' ? '' : ' (projected)'}`);
  if (s.unparseable > 0) {
    lines.push(`  unparseable:     ${s.unparseable} (passed through untouched)`);
  }
  if (s.duplicate_ids_observed.length > 0) {
    const ids = s.duplicate_ids_observed.map((d) => `${d.session_id} x${d.count}`).join(', ');
    lines.push(`  duplicate ids:   ${s.duplicate_ids_observed.length} (${ids}) — preserved, never deduped`);
  }
  const classes = Object.entries(s.defects_by_class);
  if (classes.length > 0) {
    lines.push('  defects by class:');
    for (const [cls, n] of classes.sort((a, b) => b[1] - a[1])) lines.push(`    ${cls}: ${n}`);
  }
  if (s.backup_path) lines.push(`  backup:          ${s.backup_path}`);
  if (s.errors.length > 0) {
    lines.push(`  errors:          ${s.errors.length} (original line kept)`);
    for (const e of s.errors) lines.push(`    line ${e.line} ${e.session_id ?? '<no session_id>'}: ${e.error}`);
  }
  if (s.post_verify && s.post_verify.integrity !== 'clean' && s.post_verify.integrity !== 'skipped-not-canonical-path') {
    lines.push(`  integrity:       ${s.post_verify.integrity.message ?? 'FAILED'}`);
  }
  if (s.ok === false) {
    lines.push('  POST-VERIFICATION FAILED — backup restored, ledger unchanged.');
  }
  return lines.join('\n') + '\n';
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        apply: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        file: { type: 'string' },
        'repo-root': { type: 'string' },
        'no-backup': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    process.stderr.write(`repair-invalid-sessions: ${err.message}\n${USAGE}`);
    process.exit(1);
  }

  const { values } = parsed;

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  // --apply is an explicit opt-in; absent it (or with --dry-run) we never write.
  const apply = values.apply === true && values['dry-run'] !== true;
  const repoRoot = values['repo-root'] || SO_PROJECT_DIR;
  const file = values.file || path.join(repoRoot, CANONICAL_LEDGER_REL);

  let summary;
  try {
    summary = repairLedger({ file, repoRoot, apply, backup: values['no-backup'] !== true });
  } catch (err) {
    process.stderr.write(`repair-invalid-sessions: ${err?.message ?? String(err)}\n`);
    process.exit(2);
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    process.stdout.write(renderHuman(summary));
  }
  process.exit(summary.ok === false ? 3 : 0);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`repair-invalid-sessions: unexpected error: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}
