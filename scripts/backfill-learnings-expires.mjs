#!/usr/bin/env node
/**
 * backfill-learnings-expires.mjs — one-shot backfill helper for `expires_at`.
 *
 * Closes issue #323. Surfaced by 2026-05-07 W1 D2 surface-map: 1/129 records
 * in .orchestrator/metrics/learnings.jsonl was missing `expires_at` (id:
 * `archive-en-masse-residual-policy-2026-05-01`).
 *
 * For each record without `expires_at`, derives one from `created_at` + `type`
 * via `deriveExpiresAt()` from `scripts/lib/learnings.mjs`. Records that
 * already have `expires_at` pass through untouched.
 *
 * Forensics: every patched record gets a `_backfilled_expires_at: true` tag
 * so downstream readers can identify backfilled vs originally-stamped values.
 *
 * Usage:
 *   node scripts/backfill-learnings-expires.mjs [--source <path>] [--dry-run] [--apply]
 *
 * Flags:
 *   --source <path>   Path to learnings.jsonl (default: .orchestrator/metrics/learnings.jsonl)
 *   --dry-run         Preview changes without writing (DEFAULT)
 *   --apply           Write patched records back; backup original to <path>.bak.<isoDate>
 *
 * Exit codes:
 *   0  Success (including no-op when nothing needs backfilling)
 *   1  Input/validation error
 *   2  I/O error
 *
 * Idempotent: a second --apply run produces 0 to_backfill (every record now
 * has expires_at; the `_backfilled_expires_at` tag is preserved).
 *
 * Output (stdout — single JSON summary line):
 *   {"total":N,"already_has_expires":A,"to_backfill":B,"parse_errors":P,"applied":bool}
 *
 * Per-record narration goes to stderr so stdout stays machine-parseable.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deriveExpiresAt } from './lib/learnings.mjs';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    `Usage: backfill-learnings-expires.mjs [--source <path>] [--dry-run] [--apply]

Options:
  --source <path>   Path to learnings.jsonl (default: .orchestrator/metrics/learnings.jsonl)
  --dry-run         Preview changes without writing (DEFAULT)
  --apply           Write patched records; backup original to <path>.bak.<isoDate>

Exit codes:  0 success  1 input error  2 I/O error
`
  );
  process.exit(0);
}

const applyFlag = args.includes('--apply');
const dryRun = !applyFlag;

const sourceIdx = args.indexOf('--source');
const sourcePath =
  sourceIdx !== -1 && args[sourceIdx + 1]
    ? args[sourceIdx + 1]
    : '.orchestrator/metrics/learnings.jsonl';

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

if (!existsSync(sourcePath)) {
  process.stderr.write(`backfill-learnings-expires: source file not found: ${sourcePath}\n`);
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(sourcePath, 'utf8');
} catch (err) {
  process.stderr.write(
    `backfill-learnings-expires: failed to read ${sourcePath}: ${err.message}\n`
  );
  process.exit(2);
}

const lines = raw.split('\n').filter((l) => l.trim().length > 0);

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

let countAlready = 0;
let countToBackfill = 0;
let countParseErrors = 0;
const outputLines = [];

for (const line of lines) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    countParseErrors++;
    process.stderr.write(
      `backfill-learnings-expires: WARN skipping malformed JSON line: ${line.slice(0, 80)}\n`
    );
    // Preserve original line — never destroy data
    outputLines.push(line);
    continue;
  }

  const hasExpires =
    typeof parsed.expires_at === 'string' && parsed.expires_at.length > 0;
  if (hasExpires) {
    countAlready++;
    outputLines.push(JSON.stringify(parsed));
    continue;
  }

  // Derive expires_at from created_at + type. deriveExpiresAt() falls back
  // to Date.now() when created_at is missing/unparseable, so we always
  // produce a valid ISO timestamp.
  const newExpires = deriveExpiresAt(parsed.created_at, parsed.type);
  const patched = {
    ...parsed,
    expires_at: newExpires,
    _backfilled_expires_at: true,
  };
  countToBackfill++;
  outputLines.push(JSON.stringify(patched));
  process.stderr.write(
    `backfill-learnings-expires: patched id=${parsed.id ?? '<no id>'} type=${parsed.type ?? '<no type>'} expires_at=${newExpires}\n`
  );
}

// ---------------------------------------------------------------------------
// Write (--apply only)
// ---------------------------------------------------------------------------

let applied = false;
if (!dryRun && countToBackfill > 0) {
  // Backup first
  const isoDate = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${sourcePath}.bak.${isoDate}`;
  try {
    copyFileSync(sourcePath, backupPath);
  } catch (err) {
    process.stderr.write(
      `backfill-learnings-expires: ERROR failed to create backup ${backupPath}: ${err.message}\n`
    );
    process.exit(2);
  }

  // Atomic write via tmp + rename
  const body = outputLines.join('\n') + '\n';
  const tmp = `${sourcePath}.backfill-tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, sourcePath);
    applied = true;
    process.stderr.write(
      `backfill-learnings-expires: backup written to ${backupPath}\n`
    );
  } catch (err) {
    process.stderr.write(
      `backfill-learnings-expires: ERROR failed to write ${sourcePath}: ${err.message}\n`
    );
    try {
      if (existsSync(tmp)) renameSync(tmp, tmp + '.failed');
    } catch {
      /* ignore */
    }
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Summary (single JSON line on stdout)
// ---------------------------------------------------------------------------

const summary = {
  total: lines.length,
  already_has_expires: countAlready,
  to_backfill: countToBackfill,
  parse_errors: countParseErrors,
  applied,
  dry_run: dryRun,
  source: sourcePath,
};
process.stdout.write(JSON.stringify(summary) + '\n');

process.exit(0);
