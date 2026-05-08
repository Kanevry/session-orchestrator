#!/usr/bin/env node
/**
 * migrate-subagents-jsonl.mjs — one-shot migration helper for subagents.jsonl.
 *
 * Mirrors migrate-learnings-jsonl.mjs structure. Applies the migrate /
 * normalize / validate pipeline from subagents-schema.mjs to every record.
 *
 * For schema_version 1 (current), migrateLegacySubagent() is a no-op that
 * only stamps a missing schema_version. The script is structurally complete
 * and produces a 1:1 pass-through — ready for future schema bumps without
 * code changes.
 *
 * Usage:
 *   node scripts/migrate-subagents-jsonl.mjs [--source <path>] [--dry-run] [--apply]
 *
 * Flags:
 *   --source <path>   Path to subagents.jsonl
 *                     (default: .orchestrator/metrics/subagents.jsonl)
 *   --dry-run         Preview changes without writing (DEFAULT)
 *   --apply           Write migrated records back to the file
 *
 * Exit codes:
 *   0  Success (including no-op if everything is already canonical)
 *   1  Input/validation error (or --apply had failed-validation records)
 *   2  I/O error
 *
 * Idempotent: running --apply a second time produces no further changes.
 *
 * Output (stdout — one JSON object per line):
 *   {"action":"migrated"|"already-canonical"|"failed-validation","id":"...","changes":[...]}
 *
 * Summary line (stderr):
 *   migrate-subagents: N migrated, M already-canonical, K failed-validation [dry-run|applied]
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  migrateLegacySubagent,
  normalizeSubagent,
  validateSubagent,
  ValidationError,
} from './lib/subagents-schema.mjs';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const helpFlag = args.includes('--help') || args.includes('-h');
if (helpFlag) {
  process.stdout.write(`Usage: migrate-subagents-jsonl.mjs [--source <path>] [--dry-run] [--apply]

Options:
  --source <path>   Path to subagents.jsonl
                    (default: .orchestrator/metrics/subagents.jsonl)
  --dry-run         Preview changes without writing (DEFAULT)
  --apply           Write migrated records back to the file

Output (stdout — one JSON object per line):
  {"action":"migrated"|"already-canonical"|"failed-validation","id":"...","changes":[...]}

Exit codes:  0 success  1 input/validation error  2 I/O error
`);
  process.exit(0);
}

const applyFlag = args.includes('--apply');
const dryRun = !applyFlag; // default is --dry-run

const sourceIdx = args.indexOf('--source');
const sourcePath =
  sourceIdx !== -1 && args[sourceIdx + 1]
    ? args[sourceIdx + 1]
    : '.orchestrator/metrics/subagents.jsonl';

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

if (!existsSync(sourcePath)) {
  process.stderr.write(`migrate-subagents: source file not found: ${sourcePath}\n`);
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(sourcePath, 'utf8');
} catch (err) {
  process.stderr.write(`migrate-subagents: failed to read ${sourcePath}: ${err.message}\n`);
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
    process.stderr.write(
      `migrate-subagents: WARN skipping malformed JSON line: ${line.slice(0, 80)}\n`
    );
    // Preserve the original malformed line as-is (do not discard data).
    outputLines.push(line);
    continue;
  }

  // Detect which fields would be stamped by migrateLegacySubagent.
  const changes = [];
  if (parsed.schema_version === undefined || parsed.schema_version === null) {
    changes.push('schema_version:1');
  }

  const migrated = migrateLegacySubagent(parsed);
  const normalized = normalizeSubagent(migrated);

  let validated;
  try {
    validated = validateSubagent(normalized);
  } catch (err) {
    countFailedValidation++;
    const reason = err instanceof ValidationError ? err.message : String(err);
    const id = parsed.agent_id ?? null;
    process.stderr.write(
      `migrate-subagents: WARN record agent_id=${id ?? '<no agent_id>'} still fails validation` +
      ` after migration: ${reason}\n`
    );
    // Preserve original line — do not destroy unmigratable records.
    outputLines.push(line);
    process.stdout.write(
      JSON.stringify({ action: 'failed-validation', id, reason, changes }) + '\n'
    );
    continue;
  }

  if (changes.length === 0) {
    countCanonical++;
    outputLines.push(JSON.stringify(validated));
    process.stdout.write(
      JSON.stringify({ action: 'already-canonical', id: validated.agent_id }) + '\n'
    );
  } else {
    countMigrated++;
    outputLines.push(JSON.stringify(validated));
    process.stdout.write(
      JSON.stringify({ action: 'migrated', id: validated.agent_id, changes }) + '\n'
    );
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
    process.stderr.write(
      `migrate-subagents: ERROR failed to write ${sourcePath}: ${err.message}\n`
    );
    // Attempt cleanup of tmp.
    try { if (existsSync(tmp)) renameSync(tmp, tmp + '.failed'); } catch { /* ignore */ }
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stderr.write(
  `migrate-subagents: ${countMigrated} migrated, ${countCanonical} already-canonical, ` +
  `${countFailedValidation} failed-validation, ${countMalformed} malformed [${modeLabel}]\n`
);

process.exit(countFailedValidation > 0 ? 1 : 0);
