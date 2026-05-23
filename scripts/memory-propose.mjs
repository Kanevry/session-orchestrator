#!/usr/bin/env node
/**
 * memory-propose.mjs — CLI entrypoint for proposing a memory learning.
 *
 * Agents invoke this via Bash during a session wave to submit a candidate
 * learning for human review. The proposal is persisted to a per-wave JSONL
 * file by the store; the memory-cleanup flow later promotes accepted proposals
 * to the persistent learnings store.
 *
 * Usage:
 *   node scripts/memory-propose.mjs \
 *     --type <enum> --subject "..." --insight "..." \
 *     --evidence "..." --confidence <0-1>
 *
 * Exit codes:
 *   0 — queued    (stdout: {"status":"queued","position":"N/Q","wave":"Wn"})
 *   1 — quota-exceeded
 *   2 — below-floor (confidence < floor)
 *   3 — wrong-context (STATE.md missing / unparseable / status != 'active')
 *   4 — arg-error (missing or invalid arguments)
 *
 * Related issues: #501
 * Related modules:
 *   scripts/lib/memory-proposals/schema.mjs — createProposalRecord, PROPOSAL_TYPES
 *   scripts/lib/memory-proposals/store.mjs  — appendProposal
 *   scripts/lib/state-md.mjs               — resolveStateMdPath, parseStateMd
 *   scripts/parse-config.mjs               — Session Config subprocess
 */

import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

const DEFAULT_QUOTA_PER_WAVE = 5;
const DEFAULT_CONFIDENCE_FLOOR = 0.5;

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Stdout helpers — all output is JSON; never let uncaught errors hit stderr
// ---------------------------------------------------------------------------

/**
 * Emit a JSON payload to stdout and exit with the given code.
 * Never throws — the JSON.stringify of plain objects cannot fail.
 *
 * @param {object} payload
 * @param {number} exitCode
 */
function exit(payload, exitCode) {
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Top-level error guard — ensures uncaught exceptions emit JSON, not stack traces
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  exit({ status: 'error', validation: [`Internal error: ${err.message}`] }, 4);
});

// ---------------------------------------------------------------------------
// --help (non-blocking, exits 0)
// ---------------------------------------------------------------------------

const rawArgv = process.argv.slice(2);
if (rawArgv.includes('--help') || rawArgv.includes('-h')) {
  process.stdout.write(
    'Usage: memory-propose.mjs --type <type> --subject "..." --insight "..." ' +
    '--evidence "..." --confidence <0-1>\n\n' +
    'Exit codes:\n' +
    '  0 — queued\n' +
    '  1 — quota-exceeded\n' +
    '  2 — rejected-low-confidence\n' +
    '  3 — rejected-wrong-context\n' +
    '  4 — arg-error\n',
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Step 1 — Parse argv (stdlib parseArgs)
// ---------------------------------------------------------------------------

let parsedArgs;
try {
  parsedArgs = parseArgs({
    args: rawArgv,
    options: {
      type:       { type: 'string' },
      subject:    { type: 'string' },
      insight:    { type: 'string' },
      evidence:   { type: 'string' },
      confidence: { type: 'string' },
    },
    strict: false, // emit unknown flags as positionals rather than throwing
  });
} catch (err) {
  exit({ status: 'error', validation: [`Failed to parse arguments: ${err.message}`] }, 4);
}

// Collect validation errors for arg-error (all at once, not first-fail)
const argErrors = [];

const typeVal       = parsedArgs.values['type'];
const subjectVal    = parsedArgs.values['subject'];
const insightVal    = parsedArgs.values['insight'];
const evidenceVal   = parsedArgs.values['evidence'];
const confidenceRaw = parsedArgs.values['confidence'];

if (!typeVal)       argErrors.push('--type is required');
if (!subjectVal)    argErrors.push('--subject is required');
if (!insightVal)    argErrors.push('--insight is required');
if (!evidenceVal)   argErrors.push('--evidence is required');
if (!confidenceRaw) argErrors.push('--confidence is required');

let confidenceVal = NaN;
if (confidenceRaw !== undefined) {
  confidenceVal = Number(confidenceRaw);
  if (!Number.isFinite(confidenceVal) || confidenceVal < 0 || confidenceVal > 1) {
    argErrors.push('--confidence must be a finite number in [0, 1]');
  }
}

if (argErrors.length > 0) {
  exit({ status: 'error', validation: argErrors }, 4);
}

// At this point all required flags are present; type narrowing is safe
const type       = /** @type {string} */ (typeVal);
const subject    = /** @type {string} */ (subjectVal);
const insight    = /** @type {string} */ (insightVal);
const evidence   = /** @type {string} */ (evidenceVal);
const confidence = confidenceVal;

// ---------------------------------------------------------------------------
// Step 2 — Read STATE.md and validate context
// ---------------------------------------------------------------------------

// resolveStateMdPath from state-md.mjs: falls back to .claude/STATE.md
let stateMdPath;
try {
  const stateMdMod = await import('./lib/state-md.mjs');
  stateMdPath = stateMdMod.resolveStateMdPath(process.cwd());
} catch {
  // If the import fails, use the canonical default path directly
  stateMdPath = join(process.cwd(), '.claude', 'STATE.md');
}

if (!existsSync(stateMdPath)) {
  exit(
    { status: 'rejected-wrong-context', detail: 'STATE.md missing or unparseable' },
    3,
  );
}

let stateContents;
try {
  stateContents = readFileSync(stateMdPath, 'utf8');
} catch {
  exit(
    { status: 'rejected-wrong-context', detail: 'STATE.md missing or unparseable' },
    3,
  );
}

let parsedState;
try {
  const stateMdMod = await import('./lib/state-md.mjs');
  parsedState = stateMdMod.parseStateMd(stateContents);
} catch {
  parsedState = null;
}

if (parsedState === null) {
  exit(
    { status: 'rejected-wrong-context', detail: 'STATE.md missing or unparseable' },
    3,
  );
}

const { frontmatter } = parsedState;
const stateStatus = frontmatter['status'];
if (stateStatus !== 'active') {
  exit(
    {
      status: 'rejected-wrong-context',
      detail: `STATE.md status is '${stateStatus ?? 'missing'}', not 'active'`,
    },
    3,
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Extract wave ID from STATE.md
// ---------------------------------------------------------------------------

const currentWaveRaw = frontmatter['current-wave'];
const waveId = currentWaveRaw !== undefined && currentWaveRaw !== null
  ? `W${currentWaveRaw}`
  : 'W?';

// ---------------------------------------------------------------------------
// Step 4 — Read Session Config (quota + floor)
// ---------------------------------------------------------------------------

let quotaPerWave = DEFAULT_QUOTA_PER_WAVE;
let confidenceFloor = DEFAULT_CONFIDENCE_FLOOR;

try {
  const parseConfigPath = join(__dirname, 'parse-config.mjs');
  if (existsSync(parseConfigPath)) {
    const result = spawnSync('node', [parseConfigPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    if (result.status === 0 && result.stdout) {
      const cfg = JSON.parse(result.stdout);
      // I6 is adding memory.proposals.{quota-per-wave, confidence-floor} in parallel.
      // Use those keys when present; fall back to flat-key alternatives, then to defaults.
      const proposals = cfg?.memory?.proposals;
      if (proposals && typeof proposals === 'object') {
        if (typeof proposals['quota-per-wave'] === 'number') {
          quotaPerWave = proposals['quota-per-wave'];
        }
        if (typeof proposals['confidence-floor'] === 'number') {
          confidenceFloor = proposals['confidence-floor'];
        }
      }
    }
  }
} catch {
  // Non-fatal: fall back to defaults
}

// ---------------------------------------------------------------------------
// Step 5 — Check confidence floor
// ---------------------------------------------------------------------------

if (confidence < confidenceFloor) {
  exit(
    { status: 'rejected-low-confidence', floor: confidenceFloor, provided: confidence },
    2,
  );
}

// ---------------------------------------------------------------------------
// Step 6 — Build proposal record
// ---------------------------------------------------------------------------

let record;
try {
  const schemaMod = await import('./lib/memory-proposals/schema.mjs');
  record = schemaMod.createProposalRecord({
    type,
    subject,
    insight,
    evidence,
    confidence,
    waveId,
  });
} catch (err) {
  exit({ status: 'error', validation: [`Failed to create proposal record: ${err.message}`] }, 4);
}

// ---------------------------------------------------------------------------
// Step 7 — Validate type against schema enum (I1 schema module)
// ---------------------------------------------------------------------------

try {
  const schemaMod = await import('./lib/memory-proposals/schema.mjs');
  const validation = schemaMod.validateProposalRecord(record);
  if (!validation.ok) {
    exit({ status: 'error', validation: validation.errors }, 4);
  }
} catch (err) {
  exit({ status: 'error', validation: [`Schema validation error: ${err.message}`] }, 4);
}

// ---------------------------------------------------------------------------
// Step 8 — Append proposal via store
// ---------------------------------------------------------------------------

let storeResult;
try {
  const storeMod = await import('./lib/memory-proposals/store.mjs');
  storeResult = await storeMod.appendProposal({
    record,
    repoRoot: process.cwd(),
    waveId,
    quotaPerWave,
    confidenceFloor,
    lockTimeoutMs: 1000,
  });
} catch (err) {
  exit({ status: 'error', validation: [`Store error: ${err.message}`] }, 4);
}

// ---------------------------------------------------------------------------
// Step 9 — Translate store result to exit code + stdout JSON
// ---------------------------------------------------------------------------

const storeStatus = storeResult?.status;

if (storeStatus === 'queued') {
  exit(
    {
      status: 'queued',
      position: storeResult.position,
      wave: waveId,
    },
    0,
  );
} else if (storeStatus === 'quota-exceeded') {
  exit(
    {
      status: 'quota-exceeded',
      quota: quotaPerWave,
      dropped: storeResult.dropped ?? 1,
    },
    1,
  );
} else if (storeStatus === 'rejected-low-confidence') {
  // Store enforces floor independently (defensive — CLI already checked above)
  exit(
    { status: 'rejected-low-confidence', floor: confidenceFloor, provided: confidence },
    2,
  );
} else {
  // Unexpected store result
  exit(
    {
      status: 'error',
      validation: [`Unexpected store result: ${JSON.stringify(storeResult)}`],
    },
    4,
  );
}
