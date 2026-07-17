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
  1  user error (session not found, unknown run-id) / verify drift
  2  system error
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
  if (!values['no-write']) {
    writeResult = appendEvalRecord(record, { path: path.join(metricsDir, 'eval.jsonl') });
    if (!writeResult.ok) {
      // never-throw sink already emitted a stderr WARN; surface it as a soft note.
      process.stderr.write(`[eval-session] append failed (${writeResult.reason}): ${writeResult.error}\n`);
    }
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } else {
    process.stdout.write(`${renderHuman(record, summary, writeResult)}\n`);
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
      process.stdout.write(`${JSON.stringify({ run_id: runId, match: true, dimensions: fresh.dimensions.length })}\n`);
    } else {
      process.stdout.write(`MATCH: ${runId} re-evaluates identically across ${fresh.dimensions.length} dimension(s).\n`);
    }
    process.exit(EXIT_OK);
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ run_id: runId, match: false, diffs })}\n`);
  } else {
    const out = [`DRIFT: ${runId} re-evaluation differs from the stored record:`];
    for (const d of diffs) {
      if (d.reason) {
        out.push(`  ${d.id}: ${d.reason}`);
      } else {
        out.push(`  ${d.id}.${d.field}: stored=${JSON.stringify(d.stored)} fresh=${JSON.stringify(d.fresh)}`);
      }
    }
    process.stdout.write(`${out.join('\n')}\n`);
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
