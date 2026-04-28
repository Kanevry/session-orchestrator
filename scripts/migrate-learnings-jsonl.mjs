#!/usr/bin/env node
/**
 * migrate-learnings-jsonl.mjs — one-shot migration helper for learnings.jsonl.
 *
 * Fixes schema drift described in issue #303:
 *   - description | recommendation → insight
 *   - missing id → crypto.randomUUID()
 *   - missing schema_version → 1
 *
 * Usage:
 *   node scripts/migrate-learnings-jsonl.mjs [--source <path>] [--dry-run] [--apply]
 *
 * Flags:
 *   --source <path>   Path to learnings.jsonl (default: .orchestrator/metrics/learnings.jsonl)
 *   --dry-run         Preview changes without writing (DEFAULT)
 *   --apply           Write migrated records back to the file
 *
 * Exit codes:
 *   0  Success (including no-op if everything is already canonical)
 *   1  Input/validation error
 *   2  I/O error
 *
 * Idempotent: running --apply a second time produces no further changes.
 *
 * Output (stdout — one JSON object per line):
 *   {"action":"migrated"|"already-canonical","id":"...","changes":[...]}
 *
 * Summary line (stderr):
 *   migrate-learnings: N migrated, M already-canonical, K failed-validation [dry-run|applied]
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  migrateLegacyLearning,
  validateLearning,
  ValidationError,
} from './lib/learnings.mjs';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const helpFlag = args.includes('--help') || args.includes('-h');
if (helpFlag) {
  process.stdout.write(`Usage: migrate-learnings-jsonl.mjs [--source <path>] [--dry-run] [--apply]

Options:
  --source <path>   Path to learnings.jsonl (default: .orchestrator/metrics/learnings.jsonl)
  --dry-run         Preview changes without writing (DEFAULT)
  --apply           Write migrated records back to the file

Exit codes:  0 success  1 input error  2 I/O error
`);
  process.exit(0);
}

const applyFlag = args.includes('--apply');
const dryRun = !applyFlag; // default is --dry-run

const sourceIdx = args.indexOf('--source');
const sourcePath =
  sourceIdx !== -1 && args[sourceIdx + 1]
    ? args[sourceIdx + 1]
    : '.orchestrator/metrics/learnings.jsonl';

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

if (!existsSync(sourcePath)) {
  process.stderr.write(`migrate-learnings: source file not found: ${sourcePath}\n`);
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(sourcePath, 'utf8');
} catch (err) {
  process.stderr.write(`migrate-learnings: failed to read ${sourcePath}: ${err.message}\n`);
  process.exit(2);
}

const lines = raw.split('\n').filter((l) => l.trim().length > 0);

// ---------------------------------------------------------------------------
// Migrate
// ---------------------------------------------------------------------------

let countMigrated = 0;
let countCanonical = 0;
let countFailedValidation = 0;
let countMalformed = 0;

const outputLines = [];

for (const line of lines) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    countMalformed++;
    process.stderr.write(`migrate-learnings: WARN skipping malformed JSON line: ${line.slice(0, 80)}\n`);
    // Preserve the original malformed line as-is (do not discard data)
    outputLines.push(line);
    continue;
  }

  // Detect which fields need migration
  const changes = [];
  if (!parsed.id) changes.push('id:added');
  if (!parsed.insight) {
    if (typeof parsed.description === 'string') changes.push('description→insight');
    else if (typeof parsed.recommendation === 'string') changes.push('recommendation→insight');
  }
  if (parsed.schema_version === undefined || parsed.schema_version === null) {
    changes.push('schema_version:1');
  }

  const migrated = migrateLegacyLearning(parsed);

  // Validate after migration — records that still fail after migration are
  // preserved in-place (no data loss) but flagged in the summary.
  let validated;
  try {
    // Stamp schema_version before validation so appendLearning-style stamping
    // is mimicked (migrateLegacyLearning already does this, but be explicit).
    validated = validateLearning({
      ...migrated,
      schema_version: migrated.schema_version ?? 1,
    });
  } catch (err) {
    countFailedValidation++;
    const reason = err instanceof ValidationError ? err.message : String(err);
    process.stderr.write(
      `migrate-learnings: WARN record id=${parsed.id ?? '<no id>'} still fails validation after migration: ${reason}\n`
    );
    // Preserve original line — do not destroy unmigratable records
    outputLines.push(line);
    process.stdout.write(
      JSON.stringify({ action: 'failed-validation', id: parsed.id ?? null, reason, changes }) + '\n'
    );
    continue;
  }

  if (changes.length === 0) {
    countCanonical++;
    outputLines.push(JSON.stringify(validated));
    process.stdout.write(JSON.stringify({ action: 'already-canonical', id: validated.id }) + '\n');
  } else {
    countMigrated++;
    outputLines.push(JSON.stringify(validated));
    process.stdout.write(JSON.stringify({ action: 'migrated', id: validated.id, changes }) + '\n');
  }
}

// ---------------------------------------------------------------------------
// Write (--apply only)
// ---------------------------------------------------------------------------

const modeLabel = dryRun ? 'dry-run' : 'applied';

if (!dryRun) {
  const body = outputLines.join('\n') + '\n';
  const tmp = `${sourcePath}.migrate-tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, sourcePath);
  } catch (err) {
    process.stderr.write(`migrate-learnings: ERROR failed to write ${sourcePath}: ${err.message}\n`);
    // Attempt cleanup of tmp
    try { if (existsSync(tmp)) renameSync(tmp, tmp + '.failed'); } catch { /* ignore */ }
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stderr.write(
  `migrate-learnings: ${countMigrated} migrated, ${countCanonical} already-canonical, ` +
  `${countFailedValidation} failed-validation, ${countMalformed} malformed [${modeLabel}]\n`
);

process.exit(countFailedValidation > 0 ? 1 : 0);
