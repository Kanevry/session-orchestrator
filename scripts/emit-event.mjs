#!/usr/bin/env node
/**
 * emit-event.mjs — CLI wrapper around emitEvent() from scripts/lib/events.mjs.
 *
 * Lets non-Node callers (shell helpers, hooks) route through the single
 * canonical emission path instead of hand-writing JSONL with `jq >> file`.
 * Hand-rolled appenders drift from `emitEvent()` (the `stop` vs
 * `orchestrator.session.stopped` divergence #609 fixed); this CLI closes the
 * last such gap — compute-grounding-injection.sh (#611).
 *
 * Usage:
 *   node scripts/emit-event.mjs --type <name> --payload '<json>' [--file <path>]
 *
 * Flags:
 *   --type <name>      REQUIRED. Event type (e.g. orchestrator.grounding.injected).
 *   --payload <json>   Optional. JSON object string, shallow-merged into the record.
 *                      Defaults to {} when omitted. Must parse to a plain object.
 *   --file <path>      Optional. Destination JSONL path override. Defaults to the
 *                      project's .orchestrator/metrics/events.jsonl (via emitEvent).
 *   --json             Optional. Emit a structured JSON result line to stdout.
 *   --help, -h         Print usage and exit 0.
 *
 * Exit codes (per .claude/rules/cli-design.md):
 *   0 — success (event emitted)
 *   1 — user/input error (missing --type, malformed --payload JSON, non-object payload)
 *   2 — system error (write failure, unexpected internal error)
 *
 * Data → stdout (only with --json). Diagnostics → stderr (always). Related: #611.
 */

import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HELP = `Usage: emit-event.mjs --type <name> [--payload '<json>'] [--file <path>] [--json]

Routes a single event through emitEvent() (scripts/lib/events.mjs) — the canonical
emission path that also fires the optional Clank Event Bus webhook.

Flags:
  --type <name>      REQUIRED. Event type (e.g. orchestrator.grounding.injected).
  --payload <json>   Optional. JSON object string, shallow-merged. Defaults to {}.
  --file <path>      Optional. Destination JSONL path override. Defaults to the
                     project's .orchestrator/metrics/events.jsonl.
  --json             Optional. Print a JSON result object to stdout.
  --help, -h         Print this help and exit 0.

Exit codes:
  0 — success
  1 — user/input error (missing --type, malformed --payload, non-object payload)
  2 — system error (write failure / internal error)
`;

/**
 * Print an error diagnostic to stderr and exit with the given code. When
 * `--json` is set, also writes a JSON result object to stdout so machine
 * callers get a parseable signal on both streams (data→stdout, diag→stderr).
 *
 * @param {string} message — human-readable diagnostic (stderr)
 * @param {number} exitCode — 1 (user/input) or 2 (system)
 * @param {boolean} jsonMode — whether to also emit JSON to stdout
 */
function fail(message, exitCode, jsonMode) {
  process.stderr.write(`emit-event: ${message}\n`);
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
  }
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// --help (before any parsing; never errors)
// ---------------------------------------------------------------------------

const rawArgv = process.argv.slice(2);
if (rawArgv.includes('--help') || rawArgv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

// Detect --json early so error paths can honour it even if parseArgs throws.
const jsonMode = rawArgv.includes('--json');

// ---------------------------------------------------------------------------
// Top-level guard — uncaught errors become a system error (exit 2), not a stack
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  fail(`internal error: ${err?.message ?? String(err)}`, 2, jsonMode);
});

// ---------------------------------------------------------------------------
// Parse argv
// ---------------------------------------------------------------------------

let parsed;
try {
  parsed = parseArgs({
    args: rawArgv,
    options: {
      type:    { type: 'string' },
      payload: { type: 'string' },
      file:    { type: 'string' },
      json:    { type: 'boolean' },
    },
    strict: false, // tolerate unknown flags as positionals rather than throwing
  });
} catch (err) {
  fail(`failed to parse arguments: ${err.message}`, 1, jsonMode);
}

const type = parsed.values['type'];
const payloadRaw = parsed.values['payload'];
const filePath = parsed.values['file'];

// --- Validate --type (user/input error → exit 1) ---
if (typeof type !== 'string' || type.length === 0) {
  fail('--type is required', 1, jsonMode);
}

// --- Parse --payload JSON (default {}); must be a plain object (exit 1) ---
let payload = {};
if (payloadRaw !== undefined) {
  try {
    payload = JSON.parse(payloadRaw);
  } catch (err) {
    fail(`--payload is not valid JSON: ${err.message}`, 1, jsonMode);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('--payload must be a JSON object', 1, jsonMode);
  }
}

// ---------------------------------------------------------------------------
// Emit via the canonical path
// ---------------------------------------------------------------------------

let emitEvent;
try {
  ({ emitEvent } = await import(join(__dirname, 'lib', 'events.mjs')));
} catch (err) {
  fail(`failed to load events.mjs: ${err.message}`, 2, jsonMode);
}

try {
  await emitEvent(type, payload, filePath ? { filePath } : {});
} catch (err) {
  // Write/IO failures are system errors (exit 2).
  fail(`failed to emit event: ${err.message}`, 2, jsonMode);
}

if (jsonMode) {
  process.stdout.write(
    JSON.stringify({ ok: true, event: type, ...(filePath ? { file: filePath } : {}) }) + '\n',
  );
}

process.exit(0);
