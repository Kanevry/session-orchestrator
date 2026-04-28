#!/usr/bin/env node
/**
 * migrate-sessions-jsonl.mjs — migrate old sessions.jsonl entries to the
 * canonical schema_version=1 shape.
 *
 * Issue #304: 73% of sessions.jsonl records were mirror-invalid because two
 * incompatible writer formats coexisted:
 *
 *   OLD (pre-v3):  agents_dispatched / agents_complete / agents_partial /
 *                  agents_failed scalars + waves_completed scalar (no waves[])
 *   NEW (v3+):     agent_summary object + waves[] array + total_agents +
 *                  total_files_changed
 *
 * This script is the TARGETED migration path (single-shape → canonical).
 * For full-file backfill including deprecation tagging, use
 * `scripts/backfill-sessions.mjs` instead.
 *
 * Usage:
 *   node scripts/migrate-sessions-jsonl.mjs [--file PATH]
 *   node scripts/migrate-sessions-jsonl.mjs [--file PATH] --apply
 *
 * Modes:
 *   (default)  --dry-run: print a JSON report; do not write any file
 *   --apply             : write the migrated file atomically (tmp + rename)
 *                         with a .bak-<ISO> backup of the original
 *
 * Exit codes:
 *   0 — success (dry-run report or apply completed)
 *   1 — I/O error or file not found
 *   2 — usage error
 *
 * Idempotency: already-canonical (schema_version=1) records are left byte-
 * identical. Running --apply twice produces the same result.
 *
 * Output (stdout, one JSON line):
 *   {"mode":"dry-run|apply","file":"...","total":N,"migrated":N,
 *    "already_canonical":N,"unmappable":N,"parse_errors":N,"backup":"<path>|null"}
 */

import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { validateSession, normalizeSession, ValidationError } from './lib/session-schema.mjs';

const DEFAULT_FILE = '.orchestrator/metrics/sessions.jsonl';

// ---------------------------------------------------------------------------
// Migration logic: old → new shape
// ---------------------------------------------------------------------------

/**
 * Determine if an entry uses the old scalar-fields shape:
 * - Has flat agent scalar fields (agents_dispatched / agents_complete / etc.)
 *   but lacks agent_summary object
 * - Has waves_completed or waves_total scalar but lacks waves array
 */
export function isOldShape(entry) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const hasOldAgentScalars =
    !('agent_summary' in entry) &&
    (typeof entry.agents_dispatched === 'number' ||
      typeof entry.agents_complete === 'number' ||
      typeof entry.agents_partial === 'number' ||
      typeof entry.agents_failed === 'number');
  const hasOldWaveScalar =
    !Array.isArray(entry.waves) &&
    (typeof entry.waves_completed === 'number' || typeof entry.waves_total === 'number');
  return hasOldAgentScalars || hasOldWaveScalar;
}

/**
 * Map an old-shape entry to the canonical schema_version=1 shape.
 *
 * Mapping rules:
 *   total_agents       = agents_complete + agents_partial + agents_failed
 *                        (falls back to agents_dispatched, then 0)
 *   agent_summary      = { complete, partial, failed, spiral }
 *                        (agents_spiral → spiral; defaults to 0 if absent)
 *   waves              = [] (empty — scalar counts are not reconstructible
 *                        into individual wave objects without additional data)
 *   total_waves        = waves_completed ?? waves_total ?? total_waves ?? 0
 *   total_files_changed= files_changed ?? total_files_changed ?? 0
 *   duration_seconds   = duration_min * 60 if duration_min present and
 *                        duration_seconds absent
 *
 * All original fields are PRESERVED alongside the new canonical fields so
 * no information is lost (additive migration). schema_version is stamped to 1.
 *
 * @param {object} entry — raw old-shape entry
 * @returns {object} migrated entry (new object; input not mutated)
 */
export function migrateEntry(entry) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new TypeError('migrateEntry: entry must be a plain object');
  }

  const next = { ...entry };

  // Normalize safe key aliases (head_ref → branch, type → session_type, etc.)
  const normalized = normalizeSession(next);
  // normalizeSession may stamp schema_version:0 for legacy records — remove so
  // validateSession can stamp the canonical 1.
  const merged = { ...normalized };
  if (merged.schema_version === 0 && !('schema_version' in entry)) {
    delete merged.schema_version;
  }

  // duration_min / duration_minutes → duration_seconds
  if (!('duration_seconds' in merged)) {
    if (typeof merged.duration_min === 'number' && merged.duration_min >= 0) {
      merged.duration_seconds = merged.duration_min * 60;
    } else if (typeof merged.duration_minutes === 'number' && merged.duration_minutes >= 0) {
      merged.duration_seconds = merged.duration_minutes * 60;
    }
  }

  // agent_summary — reconstruct from scalar fields when absent
  if (!('agent_summary' in merged)) {
    const complete = typeof merged.agents_complete === 'number' ? merged.agents_complete : 0;
    const partial = typeof merged.agents_partial === 'number' ? merged.agents_partial : 0;
    const failed = typeof merged.agents_failed === 'number' ? merged.agents_failed : 0;
    const spiral = typeof merged.agents_spiral === 'number' ? merged.agents_spiral : 0;
    merged.agent_summary = { complete, partial, failed, spiral };
  }

  // total_agents — derive from sum of agent_summary counters or agents_dispatched
  if (!('total_agents' in merged)) {
    if (typeof merged.agents_dispatched === 'number') {
      merged.total_agents = merged.agents_dispatched;
    } else {
      const s = merged.agent_summary;
      merged.total_agents = (s.complete ?? 0) + (s.partial ?? 0) + (s.failed ?? 0) + (s.spiral ?? 0);
    }
  }

  // total_files_changed — derive from files_changed scalar
  if (!('total_files_changed' in merged)) {
    if (typeof merged.files_changed === 'number') {
      merged.total_files_changed = merged.files_changed;
    } else {
      merged.total_files_changed = 0;
    }
  }

  // total_waves — derive from scalar wave count fields
  if (!('total_waves' in merged)) {
    if (typeof merged.waves_completed === 'number') {
      merged.total_waves = merged.waves_completed;
    } else if (typeof merged.waves_total === 'number') {
      merged.total_waves = merged.waves_total;
    } else {
      merged.total_waves = 0;
    }
  }

  // waves — must be an array; scalars cannot be reconstructed into wave objects
  if (!Array.isArray(merged.waves)) {
    merged.waves = [];
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Outcome classification per line
// ---------------------------------------------------------------------------

/**
 * @typedef {'already_canonical'|'migrated'|'unmappable'|'parse_error'} LineOutcome
 */

/**
 * Process one parsed line. Returns the outcome and the (possibly transformed)
 * entry ready to serialize back to disk.
 *
 * @param {object} raw — parsed JSON object
 * @returns {{ outcome: LineOutcome, entry: object, reason?: string }}
 */
function processEntry(raw) {
  // Already canonical: validateSession passes on the raw entry as-is.
  try {
    const validated = validateSession(raw);
    // Double check: only truly already-canonical if serialized form matches
    if (JSON.stringify(validated) === JSON.stringify(raw)) {
      return { outcome: 'already_canonical', entry: raw };
    }
    // schema_version stamp added — still valid, mark as migrated.
    return { outcome: 'migrated', entry: validated };
  } catch {
    // Falls through to migration attempt.
  }

  // Attempt migration
  let migrated;
  try {
    migrated = migrateEntry(raw);
  } catch (err) {
    return { outcome: 'unmappable', entry: raw, reason: `migrateEntry threw: ${err.message}` };
  }

  // Validate the migrated result
  try {
    const validated = validateSession(migrated);
    return { outcome: 'migrated', entry: validated };
  } catch (err) {
    if (err instanceof ValidationError) {
      return {
        outcome: 'unmappable',
        entry: { ...raw, _migration_failed: true, _migration_reason: err.message },
        reason: err.message,
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { file: DEFAULT_FILE, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') {
      args.file = argv[++i];
    } else if (a === '--apply') {
      args.apply = true;
    } else if (a === '--dry-run') {
      args.apply = false;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: node scripts/migrate-sessions-jsonl.mjs [--file PATH] [--apply]\n' +
          '\n' +
          'Migrate old sessions.jsonl entries (agents_dispatched/waves_completed shape)\n' +
          'to the canonical schema_version=1 shape (agent_summary/waves[]/total_agents).\n' +
          '\n' +
          'Options:\n' +
          '  --file PATH   target JSONL file (default: .orchestrator/metrics/sessions.jsonl)\n' +
          '  --apply       write migrated file atomically (creates .bak-<ISO> backup)\n' +
          '  --dry-run     report only, do not write (default)\n' +
          '\n' +
          'Exit codes:\n' +
          '  0 — success\n' +
          '  1 — I/O error\n' +
          '  2 — usage error\n'
      );
      process.exit(0);
    } else {
      process.stderr.write(`migrate-sessions-jsonl: unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.file)) {
    process.stderr.write(`migrate-sessions-jsonl: file not found: ${args.file}\n`);
    process.exit(1);
  }

  let rawLines;
  try {
    rawLines = readFileSync(args.file, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
  } catch (err) {
    process.stderr.write(`migrate-sessions-jsonl: read failed: ${err.message}\n`);
    process.exit(1);
  }

  const counts = { already_canonical: 0, migrated: 0, unmappable: 0, parse_errors: 0 };
  const outputLines = [];
  const detail = [];

  for (let i = 0; i < rawLines.length; i++) {
    const lineNum = i + 1;
    let raw;
    try {
      raw = JSON.parse(rawLines[i]);
    } catch (err) {
      counts.parse_errors++;
      detail.push({ line: lineNum, outcome: 'parse_error', reason: err.message });
      outputLines.push(rawLines[i]); // preserve unparseable lines verbatim
      continue;
    }

    const { outcome, entry, reason } = processEntry(raw);
    counts[outcome]++;
    detail.push({ line: lineNum, outcome, session_id: raw.session_id ?? null, reason });
    outputLines.push(JSON.stringify(entry));
  }

  const summary = {
    mode: args.apply ? 'apply' : 'dry-run',
    file: args.file,
    total: rawLines.length,
    already_canonical: counts.already_canonical,
    migrated: counts.migrated,
    unmappable: counts.unmappable,
    parse_errors: counts.parse_errors,
    backup: null,
  };

  if (!args.apply) {
    process.stdout.write(JSON.stringify(summary) + '\n');
    process.stdout.write(JSON.stringify({ detail }) + '\n');
    return;
  }

  // Atomic write: backup → tmp → rename
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${args.file}.bak-${iso}`;
  const tmpPath = join(dirname(args.file), `.${basename(args.file)}.migrate-tmp-${process.pid}`);
  try {
    copyFileSync(args.file, backupPath);
    writeFileSync(tmpPath, outputLines.join('\n') + '\n', 'utf8');
    renameSync(tmpPath, args.file);
    summary.backup = backupPath;
  } catch (err) {
    const hint = existsSync(backupPath)
      ? `Canonical file intact; backup at ${backupPath}.`
      : 'Backup not created.';
    process.stderr.write(`migrate-sessions-jsonl: write failed: ${err.message}. ${hint}\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(summary) + '\n');
}

main().catch((err) => {
  process.stderr.write(`migrate-sessions-jsonl: unexpected error: ${err?.stack ?? err}\n`);
  process.exit(2);
});
