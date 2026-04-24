#!/usr/bin/env node
/**
 * backfill-sessions.mjs — normalize legacy shapes in sessions.jsonl.
 *
 * Issue #249 follow-up. Reads a sessions.jsonl file and rewrites each line
 * into the canonical schema_version=1 shape where a safe deterministic
 * mapping exists. Entries that cannot be safely mapped are tagged
 * `_deprecated: true` (preserved but flagged — never dropped).
 *
 * Usage:
 *   node scripts/backfill-sessions.mjs [--file PATH] [--apply] [--mark-deprecated-only]
 *
 * Modes:
 *   (default / --dry-run)   reports intended rewrites + deprecations per line;
 *                           does not touch the file
 *   --apply                 writes the rewritten file atomically via temp+rename;
 *                           creates a `.bak-<ISO>` backup of the original
 *   --mark-deprecated-only  same as --apply but only tags unmappable entries
 *                           with `_deprecated: true`; leaves mappable entries
 *                           untouched (conservative path)
 *
 * Exit codes:
 *   0 — completed (dry-run or apply)
 *   1 — I/O error (unreadable file, write failed)
 *   2 — usage error
 *
 * Output: JSON summary on stdout
 *   {"mode":"dry-run|apply|mark-deprecated-only","total":N,"rewritten":N,"deprecated":N,"unchanged":N,"backup":"<path>|null"}
 */

import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { validateSession, normalizeSession, ValidationError } from './lib/session-schema.mjs';

const DEFAULT_FILE = '.orchestrator/metrics/sessions.jsonl';

/**
 * Line numbers (1-indexed) known to be unmappable per D1 inventory. These
 * entries have fundamentally divergent shape (e.g., `waves: null` scalar
 * counts, alternative telemetry models) that cannot be deterministically
 * converted without data loss. Marked `_deprecated: true` on apply.
 *
 * The logic below also independently detects unmappable entries by shape,
 * so this list is informational — identification is structural, not
 * positional. If the file is truncated or reordered, the shape-check still
 * fires.
 */
const KNOWN_UNMAPPABLE_SHAPES = Object.freeze({
  // `waves` is null (scalar counts via waves_completed/waves_total — array
  // cannot be reconstructed):
  wavesIsNull: (e) => e.waves === null,
  // `waves` is a number (integer count, not an array):
  wavesIsNumber: (e) => typeof e.waves === 'number',
  // `waves_executed` scalar instead of `waves` array — array not reconstructible:
  wavesExecutedScalar: (e) => typeof e.waves_executed === 'number' && !('waves' in e),
  // head_ref + metrics-object variant (windows-native experiment) — no
  // canonical mapping for the `metrics` bag:
  metricsObjectShape: (e) => 'metrics' in e && !('agent_summary' in e),
});

/**
 * Value-transforming aliases not safe for session-schema.mjs (which only
 * does same-shape renames). Applied here because backfill has full context.
 */
function applyValueAliases(e) {
  const next = { ...e };
  // duration_min / duration_minutes → duration_seconds (multiply by 60)
  if ('duration_min' in next && !('duration_seconds' in next)) {
    if (typeof next.duration_min === 'number' && next.duration_min >= 0) {
      next.duration_seconds = next.duration_min * 60;
    }
  }
  if ('duration_minutes' in next && !('duration_seconds' in next)) {
    if (typeof next.duration_minutes === 'number' && next.duration_minutes >= 0) {
      next.duration_seconds = next.duration_minutes * 60;
    }
  }
  // agent_summary reconstruction from agents_complete/partial/failed/dispatched
  // ONLY when waves scalar does NOT indicate a fundamentally different shape.
  // Ambiguous without `spiral` — synthesize as 0 if reconstruction is attempted.
  if (
    !('agent_summary' in next) &&
    typeof next.agents_complete === 'number' &&
    typeof next.agents_partial === 'number' &&
    typeof next.agents_failed === 'number'
  ) {
    next.agent_summary = {
      complete: next.agents_complete,
      partial: next.agents_partial,
      failed: next.agents_failed,
      spiral: typeof next.agents_spiral === 'number' ? next.agents_spiral : 0,
    };
  }
  // total_agents: derive from agents_dispatched if missing
  if (!('total_agents' in next) && typeof next.agents_dispatched === 'number') {
    next.total_agents = next.agents_dispatched;
  }
  // total_files_changed: derive from files_changed scalar (if a number)
  if (!('total_files_changed' in next) && typeof next.files_changed === 'number') {
    next.total_files_changed = next.files_changed;
  }
  // total_waves: derive from waves_total or waves_completed scalar
  if (!('total_waves' in next)) {
    if (typeof next.waves_total === 'number') next.total_waves = next.waves_total;
    else if (typeof next.waves_completed === 'number') next.total_waves = next.waves_completed;
  }
  return next;
}

function detectUnmappableReason(entry) {
  for (const [name, check] of Object.entries(KNOWN_UNMAPPABLE_SHAPES)) {
    if (check(entry)) return name;
  }
  return null;
}

function parseArgs(argv) {
  const args = { file: DEFAULT_FILE, mode: 'dry-run' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--apply') args.mode = 'apply';
    else if (a === '--dry-run') args.mode = 'dry-run';
    else if (a === '--mark-deprecated-only') args.mode = 'mark-deprecated-only';
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: node scripts/backfill-sessions.mjs [--file PATH] [--apply|--dry-run|--mark-deprecated-only]\n' +
          '  --file                   target sessions.jsonl (default: .orchestrator/metrics/sessions.jsonl)\n' +
          '  --dry-run                report rewrites; do not modify file (default)\n' +
          '  --apply                  rewrite file atomically with .bak-<ISO> backup\n' +
          '  --mark-deprecated-only   tag only unmappable entries with _deprecated:true\n'
      );
      process.exit(0);
    } else {
      process.stderr.write(`backfill-sessions: unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

/**
 * Process a single entry. Returns { outcome, entry } where outcome is one
 * of: 'unchanged' | 'rewritten' | 'deprecated'.
 *
 *   - 'unchanged': transforms are a no-op (entry already canonical byte-equivalent)
 *   - 'rewritten': entry was transformed (safe aliases + value-transforming aliases)
 *                  and the result validates as v1
 *   - 'deprecated': structurally unmappable OR validation still fails after
 *                   transforms; tagged with _deprecated:true
 */
function processEntry(raw) {
  const structuralReason = detectUnmappableReason(raw);
  if (structuralReason) {
    return {
      outcome: 'deprecated',
      entry: { ...raw, _deprecated: true, _deprecation_reason: `structural: ${structuralReason}` },
    };
  }

  // Always run the transform pipeline so value-alias reconstruction happens
  // even on entries that would pass validation without it.
  let transformed = normalizeSession(raw);
  transformed = applyValueAliases(transformed);
  // Drop normalizeSession's read-path schema_version:0 stamp so validateSession
  // stamps the canonical 1 on successful rewrites.
  if (transformed.schema_version === 0 && !('schema_version' in raw)) {
    delete transformed.schema_version;
  }

  let validated;
  try {
    validated = validateSession(transformed);
  } catch (err) {
    if (err instanceof ValidationError) {
      return {
        outcome: 'deprecated',
        entry: { ...raw, _deprecated: true, _deprecation_reason: err.message },
      };
    }
    throw err;
  }

  // "Unchanged" means: the serialized form matches the serialized original.
  // This preserves byte-identical behavior for already-canonical entries
  // while still classifying entries that needed any transform as rewritten.
  if (JSON.stringify(validated) === JSON.stringify(raw)) {
    return { outcome: 'unchanged', entry: raw };
  }
  return { outcome: 'rewritten', entry: validated };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.file)) {
    process.stderr.write(`backfill-sessions: file not found: ${args.file}\n`);
    process.exit(1);
  }

  let lines;
  try {
    lines = readFileSync(args.file, 'utf8').split('\n').filter((l) => l.length > 0);
  } catch (err) {
    process.stderr.write(`backfill-sessions: read failed: ${err.message}\n`);
    process.exit(1);
  }

  const perLine = [];
  const rewritten = [];
  const counts = { unchanged: 0, rewritten: 0, deprecated: 0, parseError: 0 };

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    let raw;
    try {
      raw = JSON.parse(lines[i]);
    } catch (err) {
      counts.parseError++;
      perLine.push({ line: lineNum, outcome: 'parse-error', reason: err.message });
      rewritten.push(lines[i]); // preserve original line verbatim
      continue;
    }
    const { outcome, entry } = processEntry(raw);
    counts[outcome]++;
    perLine.push({ line: lineNum, outcome, session_id: raw.session_id ?? null });
    if (args.mode === 'mark-deprecated-only' && outcome === 'rewritten') {
      // Conservative: leave mappable entries as-is.
      rewritten.push(lines[i]);
    } else {
      rewritten.push(JSON.stringify(entry));
    }
  }

  const summary = {
    mode: args.mode,
    file: args.file,
    total: lines.length,
    unchanged: counts.unchanged,
    rewritten: counts.rewritten,
    deprecated: counts.deprecated,
    parse_errors: counts.parseError,
    backup: null,
  };

  if (args.mode === 'dry-run') {
    process.stdout.write(JSON.stringify(summary) + '\n');
    process.stdout.write(JSON.stringify({ detail: perLine }) + '\n');
    return;
  }

  // Apply path — POSIX atomic replace (tmp → rename-over-canonical) preceded
  // by a pre-write copy-to-backup. This eliminates the crash window where the
  // canonical path could be briefly missing if the rename dance were split:
  //   1. copyFileSync: canonical → .bak-<ISO>  (backup; canonical still present)
  //   2. writeFileSync: rewritten → tmp        (new content; canonical still present)
  //   3. renameSync: tmp → canonical           (atomic replace per POSIX)
  // At every point between steps, the canonical file exists and holds either
  // the old content or the new content. Recovery artifact: .bak-<ISO>.
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${args.file}.bak-${iso}`;
  const tmpPath = join(dirname(args.file), `.${basename(args.file)}.tmp-${process.pid}`);
  try {
    copyFileSync(args.file, backupPath);
    writeFileSync(tmpPath, rewritten.join('\n') + '\n', 'utf8');
    renameSync(tmpPath, args.file);
    summary.backup = backupPath;
  } catch (err) {
    const recoveryHint = existsSync(backupPath)
      ? `Canonical file is intact; backup at ${backupPath}.`
      : 'Backup was not created.';
    process.stderr.write(`backfill-sessions: write failed: ${err.message}. ${recoveryHint}\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(summary) + '\n');
}

main().catch((err) => {
  process.stderr.write(`backfill-sessions: unexpected error: ${err?.stack ?? err}\n`);
  process.exit(1);
});
