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
 *
 * SAFETY: `--dry-run` is the DEFAULT — nothing is written unless `--apply` is
 * passed. Under `--apply` the original is ALWAYS copied to `<file>.bak-<stamp>`
 * BEFORE the swap (the backup is mandatory — there is no opt-out, because this
 * is a write path to a protected ledger and the `.bak` is its only forensic
 * trail; MED-3), the new content is written to `<file>.tmp-<pid>` and renamed
 * over the target (atomic), and the result is then re-verified against BOTH
 * `validateSession` and `checkSessionsIntegrity`. A failed verification restores
 * the backup byte-identically and exits 3 — the ledger is never left in a state
 * worse than the one this CLI found. Records with no defensible repair (a
 * timestamp that is not ISO-8601 at all, a waves entry that is not an object)
 * are kept byte-identical and do NOT trigger that rollback (#1442): the repair
 * of every other line is kept, and the run exits 4 so a caller can tell "clean"
 * from "clean except N lines nobody can repair".
 *
 * TARGET CONSTRAINT (MED-3): `--file` MUST resolve inside
 * `<repo-root>/.orchestrator/metrics/`. Any target outside it — including a
 * `..` traversal or a symlinked parent that escapes the dir — is refused with
 * exit 1 BEFORE any read or write. This CLI is a write path to a protected
 * ledger that the pre-bash-sessions-ledger-guard does not see (it resolves to
 * verb `node`), so the target it may touch is bounded here.
 *
 * Exit codes (`.claude/rules/cli-design.md`):
 *   0 — completed (dry-run or apply); the ledger is clean or unchanged
 *   1 — user/input error (bad flag, unknown argument)
 *   2 — system error (unreadable/unwritable ledger, I/O failure)
 *   3 — post-verification failed; the backup was restored and nothing was kept
 *   4 — completed, but N unrepairable lines remain (apply: every repairable
 *       line was fixed and verified, the N were kept byte-identical; dry-run:
 *       the N lines that WOULD remain are listed). Checked after 3: a
 *       rolled-back run is always 3, never 4.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';

import { repairLedger, CANONICAL_LEDGER_REL } from './lib/session-record-repair.mjs';
import { getProjectDir, resolveEventsLedgerRoot } from './lib/platform.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const USAGE =
  'Usage: node scripts/repair-invalid-sessions.mjs [--dry-run|--apply] [--json]\n' +
  '                                                [--file PATH] [--repo-root PATH]\n' +
  '  --dry-run     preview only (DEFAULT — nothing is written)\n' +
  '  --apply       rewrite the ledger in place (mandatory backup + atomic rename)\n' +
  '  --json        emit the summary as JSON to stdout\n' +
  '  --file        ledger path (default: <repo-root>/' +
  CANONICAL_LEDGER_REL +
  ');\n' +
  '                must resolve inside <repo-root>/.orchestrator/metrics/\n' +
  '  --repo-root   project root (default: the resolved project dir\'s ledger root —\n' +
  '                its main checkout when run from a linked worktree)\n' +
  'Exit codes: 0 completed, 1 arg error, 2 system error, 3 post-verification failed\n' +
  '            (backup restored), 4 unrepairable remain (N lines kept byte-identical;\n' +
  '            every repairable line fixed — dry-run: would remain)\n';

/**
 * Resolve `--file` and REFUSE any target outside
 * `<repoRoot>/.orchestrator/metrics/` (MED-3). Symlinks are resolved on the
 * metrics dir and on the target's PARENT (the file itself may not exist yet),
 * so a symlinked parent cannot escape the dir; `path.resolve` collapses any
 * `..` traversal before the prefix check.
 *
 * @param {string} file - the requested target (default or `--file` value).
 * @param {string} repoRoot
 * @returns {{ok: true, file: string}|{ok: false, metricsDir: string, resolved: string}}
 */
function resolveLedgerTarget(file, repoRoot) {
  // ledger-root: explicit --repo-root by design; pre-bash-sessions-ledger-guard judges the same root
  const metricsDir = path.resolve(repoRoot, '.orchestrator', 'metrics');
  // `absFile` (normalized, `..` collapsed) is what the repair uses — NOT the
  // symlink-resolved form, so the canonical-path equality in `verifyWritten`
  // (which compares against a non-realpath'd repoRoot) still recognises it.
  const absFile = path.resolve(file);

  // The CONTAINMENT decision resolves symlinks on both the metrics dir and the
  // target's PARENT (the file itself may not exist yet), so a symlinked parent
  // cannot smuggle a path that textually sits under metrics but physically
  // escapes it (`metrics/link -> /etc`, then `--file metrics/link/passwd`).
  let realMetricsDir = metricsDir;
  try {
    realMetricsDir = fs.realpathSync(metricsDir);
  } catch {
    /* not created yet — fall back to the normalized path */
  }
  let realParent = path.dirname(absFile);
  try {
    realParent = fs.realpathSync(path.dirname(absFile));
  } catch {
    /* parent may not exist yet — fall back to the normalized parent */
  }
  const realFile = path.join(realParent, path.basename(absFile));

  const prefix = realMetricsDir.endsWith(path.sep) ? realMetricsDir : realMetricsDir + path.sep;
  if (!realFile.startsWith(prefix)) {
    return { ok: false, metricsDir: realMetricsDir, resolved: realFile };
  }
  return { ok: true, file: absFile };
}

/**
 * Refuse an explicit `--repo-root` whose ledger path follows a symlink (#1665).
 * The ledger guard admits the absolute `--apply` form only after
 * `isSymlinkFreeAbsolute` (hooks/pre-bash-sessions-ledger-guard.mjs) accepted
 * the root and the ledger, but it checks BEFORE this process runs, and
 * {@link resolveLedgerTarget} follows symlinks via `realpathSync` — a link
 * swapped in between the two would redirect the repair (TOCTOU).
 *
 * Same rule as the hook: NO component of the path may be a symlink — the root,
 * every ancestor (so a root under macOS `/tmp` → `/private/tmp` is refused,
 * exactly as the hook refuses it), `.orchestrator/`, `metrics/` and the ledger
 * file — and the root must equal its own `realpath`. `lstat` judges the link
 * itself, never its target. One deliberate difference: a MISSING component is
 * not a symlink here; the repair reports it as the I/O error it is.
 *
 * @param {string} repoRoot - the explicit `--repo-root` value
 * @param {string} ledgerFile - the requested ledger path under that root
 * @returns {string|null} the reason to refuse, or null
 */
function symlinkRefusal(repoRoot, ledgerFile) {
  for (let current = path.resolve(ledgerFile); ; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return `${current} is a symlink`;
    } catch {
      /* absent — nothing to follow */
    }
    if (path.dirname(current) === current) break;
  }
  const root = path.resolve(repoRoot);
  try {
    const real = fs.realpathSync.native(root);
    if (real !== root) return `${root} resolves to ${real}`;
  } catch {
    /* absent — the repair reports the missing ledger */
  }
  return null;
}

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
  if (s.healed_valid > 0) {
    lines.push(`  healed (valid):  ${s.healed_valid}`);
  }
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
    // #1442: name every line that stays invalid — in dry-run BEFORE anything is
    // written, so the operator knows the remainder --apply will leave behind.
    const verb = s.mode === 'apply' ? 'remain' : 'would remain';
    lines.push(`  unrepairable:    ${s.errors.length} (${verb} invalid; original line kept byte-identical)`);
    for (const e of s.errors) lines.push(`    line ${e.line} ${e.session_id ?? '<no session_id>'}: ${e.error}`);
  }
  if (s.post_verify && s.post_verify.integrity !== 'clean' && s.post_verify.integrity !== 'skipped-not-canonical-path') {
    lines.push(`  integrity:       ${s.post_verify.integrity.message ?? 'FAILED'}`);
  }
  if (s.ok === false) {
    lines.push('  POST-VERIFICATION FAILED — backup restored, ledger unchanged.');
    // #1670: lines appended after the rename are kept, not rolled back with the repair.
    if (s.restore_appended_bytes > 0) {
      lines.push(`  kept:            ${s.restore_appended_bytes} byte(s) appended concurrently after the rename`);
    }
  } else if (s.errors.length > 0) {
    lines.push(
      s.mode === 'apply'
        ? `  Repairable lines fixed and verified; ${s.errors.length} unrepairable line(s) left as they were (exit 4).`
        : `  --apply would fix every repairable line and leave ${s.errors.length} unrepairable line(s) as they are (exit 4).`
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Map a `repairLedger` summary to the exit-code contract in the header.
 * Rollback (3) wins over an unrepairable remainder (4): a restored ledger kept
 * nothing, so "N remain" would describe a write that did not happen.
 *
 * @param {object} summary
 * @returns {0|3|4}
 */
export function exitCodeFor(summary) {
  if (summary.ok === false) return 3;
  if (summary.unrepairable > 0) return 4;
  return 0;
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
  // #1592: only the DEFAULT follows the ledger to the main checkout, where
  // every writer appends. An explicit --repo-root stays the literal target: the
  // ledger guard sanctions the absolute --apply form only for a --repo-root
  // equal to the measured Git top-level and outside the resolved vault — mapping
  // it would let a linked worktree of the vault write the vault's main ledger.
  const repoRoot = values['repo-root'] || resolveEventsLedgerRoot(getProjectDir());
  const requestedFile = values.file || path.join(repoRoot, CANONICAL_LEDGER_REL);

  // #1665: an explicit root is the whole target identity — never follow a
  // symlink anywhere on the ledger path, checked BEFORE any I/O (dry-run too).
  if (values['repo-root']) {
    const refusal = symlinkRefusal(repoRoot, requestedFile);
    if (refusal) {
      process.stderr.write(
        `repair-invalid-sessions: refusing --repo-root ${repoRoot}: ${refusal} ` +
          `(the ledger path under an explicit --repo-root must not follow symlinks — #1665)\n`
      );
      process.exit(1);
    }
  }

  // MED-3: bound the target to <repoRoot>/.orchestrator/metrics/ BEFORE any I/O.
  const target = resolveLedgerTarget(requestedFile, repoRoot);
  if (!target.ok) {
    process.stderr.write(
      `repair-invalid-sessions: --file must resolve inside ${target.metricsDir}${path.sep} ` +
        `(got ${target.resolved})\n${USAGE}`
    );
    process.exit(1);
  }
  const file = target.file;

  let summary;
  try {
    // The backup is mandatory (MED-3): this is a write path to a protected
    // ledger and the `.bak` is its only forensic trail — there is no opt-out.
    summary = repairLedger({ file, repoRoot, apply, backup: true });
  } catch (err) {
    process.stderr.write(`repair-invalid-sessions: ${err?.message ?? String(err)}\n`);
    process.exit(2);
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    process.stdout.write(renderHuman(summary));
  }
  process.exit(exitCodeFor(summary));
}

const isDirectRun =isMainModule(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`repair-invalid-sessions: unexpected error: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}
