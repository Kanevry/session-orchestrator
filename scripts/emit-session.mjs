#!/usr/bin/env node
/**
 * emit-session.mjs — validating writer for session JSONL entries.
 *
 * Issue #249 follow-up. The gate that session-end Phase 3.7 invokes to append
 * a single session record to `.orchestrator/metrics/sessions.jsonl` (or any
 * target path). Replaces the raw shell `>>` append with a validated path:
 *
 *   node scripts/emit-session.mjs [--file PATH] [--entry JSON]
 *
 * Input modes:
 *   --entry '<json>'   pass the entry JSON literally (for shell pipelines)
 *   (stdin)            read the entry JSON from stdin (default when no --entry)
 *
 * Defaults:
 *   --file .orchestrator/metrics/sessions.jsonl
 *
 * Exit codes:
 *   0 — validated and appended
 *   1 — validation failed (see stderr for reason); file not touched
 *   2 — I/O / parse error (non-JSON input, unwritable path)
 *
 * On success the script echoes a single JSON line to stdout:
 *   {"action":"appended","path":"<file>","session_id":"<id>","schema_version":1}
 */

import { readFileSync } from 'node:fs';
import { appendJsonl } from './lib/common.mjs';
import {
  validateSession,
  ValidationError,
  CURRENT_SESSION_SCHEMA_VERSION,
  clampTimestampsMonotonic,
  aliasLegacyEndedAt,
} from './lib/session-schema.mjs';

function parseArgs(argv) {
  const args = { file: '.orchestrator/metrics/sessions.jsonl', entry: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--entry') args.entry = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: node scripts/emit-session.mjs [--file PATH] [--entry JSON]\n' +
          '  --file   target JSONL file (default: .orchestrator/metrics/sessions.jsonl)\n' +
          '  --entry  entry JSON (if omitted, read from stdin)\n' +
          'Exit codes: 0 append ok, 1 validation error, 2 I/O error\n'
      );
      process.exit(0);
    } else {
      process.stderr.write(`emit-session: unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    process.stderr.write(`emit-session: failed to read stdin: ${err.message}\n`);
    process.exit(2);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = args.entry ?? readStdin();
  if (!raw || raw.trim().length === 0) {
    process.stderr.write('emit-session: no entry provided (stdin empty and --entry not set)\n');
    process.exit(2);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`emit-session: input is not valid JSON: ${err.message}\n`);
    process.exit(2);
  }

  // Pre-validation repairs (issue #321):
  //   1. Alias legacy `ended_at` -> `completed_at` for pre-canonical writers.
  //   2. Clamp completed_at < started_at inversions (clock-skew or manual
  //      STATE.md frontmatter edits) before validate would reject them.
  let repaired = aliasLegacyEndedAt(parsed);
  if (repaired !== parsed && repaired._completed_at_conflict === true) {
    process.stderr.write(
      `emit-session: WARN session_id=${repaired.session_id ?? '<unknown>'}: ` +
        `both completed_at and ended_at present and differ; preferring completed_at\n`
    );
  }
  const beforeClamp = repaired;
  repaired = clampTimestampsMonotonic(repaired);
  if (repaired !== beforeClamp && repaired._clamped === true) {
    const startedMs = Date.parse(repaired.started_at);
    const origMs = Date.parse(repaired._original_completed_at);
    const deltaSec = Number.isFinite(startedMs - origMs)
      ? Math.round((startedMs - origMs) / 1000)
      : null;
    process.stderr.write(
      `emit-session: WARN session_id=${repaired.session_id ?? '<unknown>'}: ` +
        `completed_at < started_at (delta=${deltaSec}s); clamped completed_at to started_at ` +
        `(original preserved as _original_completed_at=${repaired._original_completed_at})\n`
    );
  }

  let validated;
  try {
    validated = validateSession(repaired);
  } catch (err) {
    if (err instanceof ValidationError) {
      process.stderr.write(`emit-session: validation failed: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  try {
    await appendJsonl(args.file, validated);
  } catch (err) {
    process.stderr.write(`emit-session: write failed (${args.file}): ${err.message}\n`);
    process.exit(2);
  }

  const summary = {
    action: 'appended',
    path: args.file,
    session_id: validated.session_id,
    schema_version: validated.schema_version ?? CURRENT_SESSION_SCHEMA_VERSION,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
}

main().catch((err) => {
  process.stderr.write(`emit-session: unexpected error: ${err?.stack ?? err}\n`);
  process.exit(2);
});
