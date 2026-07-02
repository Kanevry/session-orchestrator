#!/usr/bin/env node
/**
 * backfill-learnings.mjs — normalize producer DIALECTS in learnings.jsonl.
 *
 * Epic #723 B2. The live corpus historically carried the rule-conversion scope
 * under `files` (not the canonical `file_paths`), duplicated `source_session`
 * into `session_id`, used `last_seen` instead of `updated_at`, and left
 * `next_review: null` / non-canonical (no-millis) timestamps. This one-shot
 * backfill routes every line through the schema SSOT (`migrateLegacyLearning`,
 * which applies `normalizeDialects` + the insight/subject alias chain + a
 * `schema_version:1` stamp), gates the result with `validateLearning`, and
 * rewrites the file where a safe normalization exists.
 *
 * Data-loss safety (three guarantees):
 *   - A line that fails `JSON.parse` is preserved byte-identical and counted
 *     (`parse_errors`) — never dropped.
 *   - A record that still fails `validateLearning` AFTER migration is passed
 *     through byte-identical and counted (`invalid_after_migration`) — never
 *     mutated, never flagged.
 *   - `--apply` writes atomically (copy-to-`.bak-<ISO>` → tmp → rename), so the
 *     canonical file always exists holding either the old or the new content.
 *
 * This script duplicates NO normalization logic — all shape work lives in
 * `scripts/lib/learnings/schema.mjs`.
 *
 * Usage:
 *   node scripts/backfill-learnings.mjs [--file PATH] [--apply|--dry-run]
 *
 * Modes:
 *   (default / --dry-run)   compute + report intended rewrites per line; does
 *                           not touch the file
 *   --apply                 write the normalized file atomically via tmp+rename,
 *                           after copying the original to `${file}.bak-<ISO>`
 *
 * Exit codes:
 *   0 — completed (dry-run or apply)
 *   1 — I/O error (file not found, unreadable, write failed)
 *   2 — usage error (unknown argument)
 *
 * Output: JSON summary on stdout (single line)
 *   {"scanned":N,"normalized":N,"unchanged":N,"parse_errors":N,
 *    "invalid_after_migration":N,"applied":bool,"dry_run":bool,"backup":"<path>|null","file":"<path>"}
 */

import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import {
  migrateLegacyLearning,
  normalizeDialects,
  validateLearning,
  ValidationError,
} from './lib/learnings/schema.mjs';

const DEFAULT_FILE = '.orchestrator/metrics/learnings.jsonl';

function parseArgs(argv) {
  const args = { file: DEFAULT_FILE, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: node scripts/backfill-learnings.mjs [--file PATH] [--apply|--dry-run]\n' +
          '  --file      target learnings.jsonl (default: .orchestrator/metrics/learnings.jsonl)\n' +
          '  --dry-run   report normalizations; do not modify file (default)\n' +
          '  --apply     rewrite file atomically with a .bak-<ISO> backup\n'
      );
      process.exit(0);
    } else {
      process.stderr.write(`backfill-learnings: unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

/**
 * Classify + transform a single parsed record via the schema SSOT.
 *
 * Returns { outcome, line } where outcome is one of:
 *   - 'unchanged'   : migration is a semantic no-op (serialized form matches input)
 *   - 'normalized'  : migration changed the record AND it validates
 *   - 'invalid'     : migration result still fails validateLearning → keep original
 *
 * @param {object} parsed — the JSON.parse'd record
 * @param {string} originalLine — the verbatim source line (returned untouched on 'invalid')
 * @returns {{ outcome: 'unchanged'|'normalized'|'invalid', line: string }}
 */
function processRecord(parsed, originalLine) {
  // Two SSOT calls, no duplicated normalization logic:
  //   1. migrateLegacyLearning — aliases + schema_version:1 stamp + dialects
  //      (files→file_paths, session_id/last_seen/next_review), byte-exact timestamps.
  //   2. normalizeDialects (full) — canonicalize timestamp FORMAT to millis+Z.
  //      Idempotent for every other dialect (already handled in step 1).
  const migrated = normalizeDialects(migrateLegacyLearning(parsed));

  // Gate: a record that cannot pass the schema after migration is passed
  // through byte-identical (never mutated, never flagged).
  try {
    validateLearning(migrated);
  } catch (err) {
    if (err instanceof ValidationError) {
      return { outcome: 'invalid', line: originalLine };
    }
    throw err;
  }

  const migratedLine = JSON.stringify(migrated);
  // Semantic-equality against the re-serialized parsed input: a migration that
  // reorders nothing and changes no value is a no-op.
  if (migratedLine === JSON.stringify(parsed)) {
    return { outcome: 'unchanged', line: migratedLine };
  }
  return { outcome: 'normalized', line: migratedLine };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.file || !existsSync(args.file)) {
    process.stderr.write(`backfill-learnings: file not found: ${args.file}\n`);
    process.exit(1);
  }

  let lines;
  try {
    lines = readFileSync(args.file, 'utf8').split('\n').filter((l) => l.length > 0);
  } catch (err) {
    process.stderr.write(`backfill-learnings: read failed: ${err.message}\n`);
    process.exit(1);
  }

  const outputLines = [];
  const counts = {
    scanned: 0,
    normalized: 0,
    unchanged: 0,
    parse_errors: 0,
    invalid_after_migration: 0,
  };

  for (const line of lines) {
    counts.scanned++;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      counts.parse_errors++;
      outputLines.push(line); // byte-identical preservation — never drop
      continue;
    }

    const { outcome, line: outLine } = processRecord(parsed, line);
    if (outcome === 'invalid') counts.invalid_after_migration++;
    else counts[outcome]++;
    outputLines.push(outLine);
  }

  const summary = {
    scanned: counts.scanned,
    normalized: counts.normalized,
    unchanged: counts.unchanged,
    parse_errors: counts.parse_errors,
    invalid_after_migration: counts.invalid_after_migration,
    applied: false,
    dry_run: !args.apply,
    backup: null,
    file: args.file,
  };

  if (!args.apply) {
    process.stdout.write(JSON.stringify(summary) + '\n');
    return;
  }

  // Apply path — POSIX atomic replace, self-contained (no io.mjs dependency).
  //   1. copyFileSync: canonical → .bak-<ISO>   (backup; canonical still present)
  //   2. writeFileSync: normalized → tmp        (new content; canonical still present)
  //   3. renameSync: tmp → canonical            (atomic replace per POSIX)
  // The canonical file exists at every step, holding old or new content.
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${args.file}.bak-${iso}`;
  const tmpPath = join(dirname(args.file), `.${basename(args.file)}.tmp-${process.pid}`);
  try {
    copyFileSync(args.file, backupPath);
    writeFileSync(tmpPath, outputLines.join('\n') + '\n', 'utf8');
    renameSync(tmpPath, args.file);
    summary.applied = true;
    summary.backup = backupPath;
  } catch (err) {
    const recoveryHint = existsSync(backupPath)
      ? `Canonical file is intact; backup at ${backupPath}.`
      : 'Backup was not created.';
    process.stderr.write(`backfill-learnings: write failed: ${err.message}. ${recoveryHint}\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(summary) + '\n');
}

main();
