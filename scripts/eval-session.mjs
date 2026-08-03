#!/usr/bin/env node
/**
 * eval-session.mjs — CLI front-end for the aiat-llm-eval deterministic engine
 * (Epic #803, S3). Evaluates ONE completed orchestrator session against the
 * rubric-v1 dimensions from local metrics files, appends the record to the
 * eval journal, and can re-verify a stored record for scoring drift.
 *
 * Follows .claude/rules/cli-design.md:
 *   - `--json` for machine output; human-readable by default.
 *   - Data → stdout, diagnostics → stderr.
 *   - Exit codes: 0 success/match · 1 user-error/drift · 2 system error.
 *
 * ## Append failures are NOT exit 0 (GitLab #969)
 *
 * `appendEvalRecord` is a never-throw sink: it returns
 * `{ ok:false, reason:'validation'|'fs-error' }` instead of raising. This CLI
 * used to log that WARN and still `process.exit(0)` — the caller saw success
 * while the journal had no record, one surface reporting a fact the other did
 * not carry. A failed append now exits non-zero, split by reason:
 *
 *   - `fs-error`  → EXIT_SYSTEM (2). The filesystem refused the append
 *     (permissions, ENOTDIR, full disk) — "system error" per cli-design.md.
 *   - `validation` → EXIT_USER (1). Reachable from the invocation: `--handle ""`
 *     survives the `?? null` default as an empty string and trips the
 *     "handle must be a non-empty string or null" rule in eval/schema.mjs.
 *     Malformed metrics input reaches the same path, and cli-design.md maps
 *     "bad args, invalid file" to 1. This matches the rest of this file, where
 *     every input-derived failure is EXIT_USER and only engine crashes are
 *     EXIT_SYSTEM. (An engine-internal invariant breach also lands here — a
 *     mild under-classification, accepted so the reachable case stays honest.)
 *
 * Both branches emit the `--json` / human payload to stdout BEFORE exiting, and
 * do so via `writeStdoutLineSync` rather than a queued write: `process.stdout`
 * is asynchronous on a pipe on macOS, so `process.exit()` discards whatever is
 * still in libuv's queue past the 65 536-byte kernel buffer. Losing the record
 * alongside the error is the exact fail-open shape #906 fixed in the hook layer.
 * Real records measure ≤ 5 210 bytes today, but `evidence` strings are
 * engine-generated free text, so the bound is empirical, not structural.
 *
 * Session-end Phase 3.7d remains advisory and MUST NOT gate on this exit code —
 * it catches a non-zero exit and logs a WARN (skills/session-end/SKILL.md).
 *
 * Usage:
 *   eval-session.mjs [--session <id>] [--json] [--no-write]
 *                    [--metrics-dir <path>] [--rubric <path>]
 *                    [--model-id <id>] [--model-source <self-report|env|config>]
 *                    [--handle <s>]
 *   eval-session.mjs --verify <run-id> [--json] [--metrics-dir <path>]
 *   eval-session.mjs --help | --version
 *
 * The eval `timestamp` is captured HERE (the one sanctioned Date.now read); the
 * engine receives it as a parameter so its scoring path stays clock-free.
 */

import { parseArgs } from 'node:util';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { evaluateSession, diffDimensions, DEFAULT_RUBRIC_PATH, RUBRIC_VERSION } from './lib/eval/engine.mjs';
import { appendEvalRecord, readEvalRecords } from './lib/eval/sink.mjs';
import { writeStdoutLineSync } from './lib/io.mjs';
import { VALID_MODEL_SOURCES } from './lib/eval/schema.mjs';
import { SessionResolutionError } from './lib/eval/session-resolve.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXIT_OK = 0;
const EXIT_USER = 1;
const EXIT_SYSTEM = 2;

function readPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const HELP = `eval-session — deterministic session evaluator (aiat-llm-eval / ${RUBRIC_VERSION})

USAGE
  eval-session.mjs [options]                 evaluate + append a session-eval record
  eval-session.mjs --verify <run-id>         re-evaluate a stored record, diff for drift
  eval-session.mjs --help | --version

OPTIONS
  --session <id>          session_id to evaluate (default: last completed session)
  --json                  emit the record (or verify result) as JSON on stdout
  --no-write              evaluate without appending to the eval journal
  --metrics-dir <path>    metrics directory (default: .orchestrator/metrics)
  --rubric <path>         rubric file to hash for provenance (default: ${DEFAULT_RUBRIC_PATH})
  --model-id <id>         evaluated model id (default: $ANTHROPIC_MODEL or "unknown")
  --model-source <src>    ${VALID_MODEL_SOURCES.join(' | ')} (default: self-report)
  --handle <s>            optional self-chosen pseudonym (omit ⇒ anonymized)
  --verify <run-id>       re-run the stored record and diff per-dimension
  --help                  show this help
  --version               print version

EXIT CODES
  0  success / verify match
  1  user error (session not found, unknown run-id, record failed validation)
     / verify drift
  2  system error (could not append the record to the eval journal)
`;

function fail(exitCode, message) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

/** Render the human-readable per-dimension summary. */
function renderHuman(record, summary, writeResult) {
  const lines = [];
  lines.push(`Session:  ${record.session_id}  (resolved via ${summary.resolvedVia})`);
  lines.push(`Run:      ${record.run_id}`);
  lines.push(`Rubric:   ${record.rubric_version}  (${record.standard_version})`);
  lines.push(`Model:    ${record.model.id}  [${record.model.source}]`);
  if (summary.contaminated) {
    lines.push(`WARNING:  time-window contaminated by ${summary.peerCount} peer session(s) [${summary.peers.join(', ')}]`);
  }
  lines.push('');
  lines.push('Dimensions (no global score — by construction):');
  for (const d of record.dimensions) {
    lines.push(`  ${d.id.padEnd(22)} [${d.method}]  ${d.status.toUpperCase()}`);
    lines.push(`      ${d.evidence}`);
  }
  lines.push('');
  const k = record.kpis;
  const fmt = (v) => (v === null || v === undefined ? 'null' : String(v));
  lines.push(
    `KPIs (reported): duration=${fmt(k.duration_seconds)}s waves=${fmt(k.total_waves)} agents=${fmt(k.total_agents)} tok_in=${fmt(k.token_input)} tok_out=${fmt(k.token_output)} carryover=${fmt(k.carryover)}`,
  );
  if (writeResult === null) {
    lines.push('(dry-run: --no-write, record NOT persisted)');
  } else if (writeResult.ok) {
    lines.push(`Written:  ${writeResult.path}`);
  } else {
    lines.push(`NOT written (${writeResult.reason}): ${writeResult.error}`);
  }
  return lines.join('\n');
}

function runEvaluate(values) {
  const metricsDir = values['metrics-dir'] || '.orchestrator/metrics';
  const rubricPath = values.rubric || DEFAULT_RUBRIC_PATH;
  const modelSource = values['model-source'] || 'self-report';
  if (!VALID_MODEL_SOURCES.includes(modelSource)) {
    fail(EXIT_USER, `--model-source must be one of ${VALID_MODEL_SOURCES.join(' | ')} (got: ${modelSource})`);
  }
  const modelId = values['model-id'] || process.env.ANTHROPIC_MODEL || 'unknown';
  const handle = values.handle ?? null;

  // The one sanctioned clock read — the engine gets this as a parameter.
  const timestamp = new Date().toISOString();

  let result;
  try {
    result = evaluateSession({
      sessionId: values.session,
      metricsDir,
      rubricPath,
      timestamp,
      model: { id: modelId, source: modelSource },
      handle,
    });
  } catch (err) {
    if (err instanceof SessionResolutionError) {
      fail(EXIT_USER, `Cannot evaluate: ${err.message}`);
    }
    fail(EXIT_SYSTEM, `Evaluation error: ${err?.message ?? String(err)}`);
    return;
  }

  const { record, summary } = result;

  let writeResult = null;
  let appendFailureReason = null;
  if (!values['no-write']) {
    writeResult = appendEvalRecord(record, { path: path.join(metricsDir, 'eval.jsonl') });
    if (!writeResult.ok) {
      // The never-throw sink already emitted its own stderr WARN; add the
      // CLI-level line, then carry the reason to the exit code below.
      process.stderr.write(`[eval-session] append failed (${writeResult.reason}): ${writeResult.error}\n`);
      appendFailureReason = writeResult.reason;
    }
  }

  // stdout FIRST, synchronously — the caller must not lose the payload along
  // with the error (see the append-failure note in the module docblock).
  if (values.json) {
    writeStdoutLineSync(JSON.stringify(record));
  } else {
    writeStdoutLineSync(renderHuman(record, summary, writeResult));
  }

  if (appendFailureReason !== null) {
    process.exit(appendFailureReason === 'validation' ? EXIT_USER : EXIT_SYSTEM);
  }
  process.exit(EXIT_OK);
}

function runVerify(runId, values) {
  const metricsDir = values['metrics-dir'] || '.orchestrator/metrics';
  const rubricPath = values.rubric || DEFAULT_RUBRIC_PATH;

  const records = readEvalRecords(path.join(metricsDir, 'eval.jsonl'));
  const stored = records.find((r) => r && r.run_id === runId);
  if (!stored) {
    fail(EXIT_USER, `--verify: run-id not found in eval journal: ${runId}`);
  }

  let fresh;
  try {
    fresh = evaluateSession({
      sessionId: stored.session_id,
      metricsDir,
      rubricPath,
      timestamp: stored.timestamp,
      model: stored.model && stored.model.id ? stored.model : { id: 'unknown', source: 'self-report' },
      handle: stored.handle ?? null,
      pluginVersion: stored.harness?.plugin_version,
      platform: stored.harness?.platform,
      resolveModelFromEnv: false, // reproduce the stored model verbatim — never env-override
    }).record;
  } catch (err) {
    if (err instanceof SessionResolutionError) {
      fail(EXIT_USER, `--verify: ${err.message}`);
    }
    fail(EXIT_SYSTEM, `--verify evaluation error: ${err?.message ?? String(err)}`);
    return;
  }

  const diffs = diffDimensions(stored.dimensions, fresh.dimensions);

  if (diffs.length === 0) {
    if (values.json) {
      writeStdoutLineSync(JSON.stringify({ run_id: runId, match: true, dimensions: fresh.dimensions.length }));
    } else {
      writeStdoutLineSync(`MATCH: ${runId} re-evaluates identically across ${fresh.dimensions.length} dimension(s).`);
    }
    process.exit(EXIT_OK);
  }

  if (values.json) {
    writeStdoutLineSync(JSON.stringify({ run_id: runId, match: false, diffs }));
  } else {
    const out = [`DRIFT: ${runId} re-evaluation differs from the stored record:`];
    for (const d of diffs) {
      if (d.reason) {
        out.push(`  ${d.id}: ${d.reason}`);
      } else {
        out.push(`  ${d.id}.${d.field}: stored=${JSON.stringify(d.stored)} fresh=${JSON.stringify(d.fresh)}`);
      }
    }
    writeStdoutLineSync(out.join('\n'));
  }
  process.exit(EXIT_USER);
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        session: { type: 'string' },
        json: { type: 'boolean', default: false },
        'no-write': { type: 'boolean', default: false },
        'metrics-dir': { type: 'string' },
        rubric: { type: 'string' },
        'model-id': { type: 'string' },
        'model-source': { type: 'string' },
        handle: { type: 'string' },
        verify: { type: 'string' },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    }));
  } catch (err) {
    fail(EXIT_USER, `Argument error: ${err?.message ?? String(err)}`);
    return;
  }

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(EXIT_OK);
  }
  if (values.version) {
    process.stdout.write(`${readPkgVersion()}\n`);
    process.exit(EXIT_OK);
  }

  if (values.verify) {
    runVerify(values.verify, values);
    return;
  }

  runEvaluate(values);
}

main();
