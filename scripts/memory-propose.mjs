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
 *   SO_WAVE_AGENT=1 node scripts/memory-propose.mjs \
 *     --type <enum> --subject "..." --insight "..." \
 *     --evidence "..." --confidence <0-1>
 *
 * The `SO_WAVE_AGENT=1` env-var is REQUIRED — without it the CLI exits 3
 * with `rejected-wrong-context`. This is the per-process guard against
 * accidental coordinator-context invocations (issue #543 H3).
 *
 * Pass `--dry-run` to VALIDATE a proposal (argv + schema) without writing to
 * proposals.jsonl. Under `--dry-run` the wrong-context gates above (STATE.md
 * active-check, SO_WAVE_AGENT, current-wave presence) are bypassed entirely —
 * a dry-run never reaches the write step, so their protective purpose is
 * moot, and bypassing them is what makes the flag safely runnable from
 * coordinator context for CLI verification (issue #741.3).
 *
 * Stdout status values (canonical, see STATUS dict below):
 *   queued                   — proposal accepted (exit 0)
 *   dry-run-ok               — validation passed under --dry-run, no write (exit 0)
 *   quota-exceeded           — wave quota reached (exit 1)
 *   rejected-low-confidence  — confidence < floor (exit 2)
 *   rejected-wrong-context   — STATE.md not active OR SO_WAVE_AGENT != "1" (exit 3)
 *   error                    — argv invalid or internal error (exit 4)
 *
 * Related issues: #501, #543 (H3 env-var guard), #544 (M2 status-dict), #741.3 (--dry-run)
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

import { isWaveAgentContext, WAVE_AGENT_ENV_VAR, WAVE_AGENT_ENV_VALUE } from './lib/wave-context.mjs';

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

const DEFAULT_QUOTA_PER_WAVE = 5;
const DEFAULT_CONFIDENCE_FLOOR = 0.5;

/**
 * Canonical stdout `status` values + corresponding exit codes.
 * Wire-format strings are part of the caller-facing contract (#544 M2) —
 * never change these literals without a major-version contract bump.
 * Audit-trail / coordinator (`memory-proposal-collector`) parses these
 * exact strings from stdout JSON.
 */
const STATUS = Object.freeze({
  QUEUED: 'queued',
  DRY_RUN_OK: 'dry-run-ok',
  QUOTA_EXCEEDED: 'quota-exceeded',
  REJECTED_LOW_CONFIDENCE: 'rejected-low-confidence',
  REJECTED_WRONG_CONTEXT: 'rejected-wrong-context',
  ERROR: 'error',
});

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
  exit({ status: STATUS.ERROR, validation: [`Internal error: ${err.message}`] }, 4);
});

// ---------------------------------------------------------------------------
// --help (non-blocking, exits 0)
// ---------------------------------------------------------------------------

const rawArgv = process.argv.slice(2);
if (rawArgv.includes('--help') || rawArgv.includes('-h')) {
  process.stdout.write(
    'Usage: SO_WAVE_AGENT=1 memory-propose.mjs --type <type> --subject "..." ' +
    '--insight "..." --evidence "..." --confidence <0-1> [--dry-run]\n\n' +
    'Environment:\n' +
    '  SO_WAVE_AGENT=1 — REQUIRED. The CLI returns exit 3 (rejected-wrong-context)\n' +
    '                    when this env-var is absent or not exactly "1".\n' +
    '                    Bypassed under --dry-run.\n\n' +
    'Flags:\n' +
    '  --dry-run — Validate the proposal (argv + schema) but do NOT write to\n' +
    '              proposals.jsonl. Bypasses the STATE.md / SO_WAVE_AGENT /\n' +
    '              current-wave context gates so it can be run safely from\n' +
    '              coordinator context (issue #741.3).\n\n' +
    'Exit codes / stdout status:\n' +
    `  0 — ${STATUS.QUEUED} (or ${STATUS.DRY_RUN_OK} under --dry-run)\n` +
    `  1 — ${STATUS.QUOTA_EXCEEDED}\n` +
    `  2 — ${STATUS.REJECTED_LOW_CONFIDENCE}\n` +
    `  3 — ${STATUS.REJECTED_WRONG_CONTEXT}\n` +
    `  4 — ${STATUS.ERROR} (argv invalid or internal error)\n`,
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
      'dry-run':  { type: 'boolean' },
    },
    strict: false, // emit unknown flags as positionals rather than throwing
  });
} catch (err) {
  exit({ status: STATUS.ERROR, validation: [`Failed to parse arguments: ${err.message}`] }, 4);
}

// Collect validation errors for arg-error (all at once, not first-fail)
const argErrors = [];

const typeVal       = parsedArgs.values['type'];
const subjectVal    = parsedArgs.values['subject'];
const insightVal    = parsedArgs.values['insight'];
const evidenceVal   = parsedArgs.values['evidence'];
const confidenceRaw = parsedArgs.values['confidence'];
// #741.3 — validate-only mode: skips Step 8's disk write, bypasses the
// wrong-context gates (Steps 2/2b/2c) below since they exist solely to
// prevent accidental WRITES from the wrong context.
const dryRun        = parsedArgs.values['dry-run'] === true;

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
  exit({ status: STATUS.ERROR, validation: argErrors }, 4);
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
//
// #741.3 — under --dry-run every REJECTED_WRONG_CONTEXT exit below is gated
// behind `!dryRun`. A dry-run never reaches Step 8 (the write), so these
// gates' protective purpose — preventing accidental WRITES from the wrong
// context — is moot for it. STATE.md is still read best-effort so a genuine
// wave-id flows through validation when available; frontmatter stays `{}`
// (and the placeholder waveId 'W-dryrun' is used at Step 3) when it isn't.

let frontmatter = {};
let stateMdReadOk = false;

try {
  // resolveStateMdPath from state-md.mjs: falls back to .claude/STATE.md
  const stateMdMod = await import('./lib/state-md.mjs');
  const stateMdPath = stateMdMod.resolveStateMdPath(process.cwd());

  if (!existsSync(stateMdPath)) {
    if (!dryRun) {
      exit(
        { status: STATUS.REJECTED_WRONG_CONTEXT, detail: 'STATE.md missing or unparseable' },
        3,
      );
    }
  } else {
    const stateContents = readFileSync(stateMdPath, 'utf8');
    const parsedState = stateMdMod.parseStateMd(stateContents);
    if (parsedState === null) {
      if (!dryRun) {
        exit(
          { status: STATUS.REJECTED_WRONG_CONTEXT, detail: 'STATE.md missing or unparseable' },
          3,
        );
      }
    } else {
      frontmatter = parsedState.frontmatter;
      stateMdReadOk = true;
    }
  }
} catch {
  if (!dryRun) {
    exit(
      { status: STATUS.REJECTED_WRONG_CONTEXT, detail: 'STATE.md missing or unparseable' },
      3,
    );
  }
}

if (stateMdReadOk) {
  const stateStatus = frontmatter['status'];
  if (stateStatus !== 'active' && !dryRun) {
    exit(
      {
        status: STATUS.REJECTED_WRONG_CONTEXT,
        detail: `STATE.md status is '${stateStatus ?? 'missing'}', not 'active'`,
      },
      3,
    );
  }
}

// ---------------------------------------------------------------------------
// Step 2b — Wrong-context env-var guard (#543 H3) — bypassed under --dry-run
// ---------------------------------------------------------------------------
//
// The wave-executor injects SO_WAVE_AGENT=1 into agent prompt CLI examples
// (skills/wave-executor/SKILL.md). Coordinator-context invocations omit the
// env-var by construction. Strict-equality check ('1' only — never '0',
// 'true', or undefined) ensures accidental flag-style values do not pass.
// Single source of truth: scripts/lib/wave-context.mjs (#548 A4).
if (!dryRun && !isWaveAgentContext()) {
  exit(
    {
      status: STATUS.REJECTED_WRONG_CONTEXT,
      detail: `Not invoked from wave-executor agent context (set ${WAVE_AGENT_ENV_VAR}=${WAVE_AGENT_ENV_VALUE})`,
    },
    3,
  );
}

// ---------------------------------------------------------------------------
// Step 2c — Guard against STATE.md active but missing current-wave field (#547)
// bypassed under --dry-run
// ---------------------------------------------------------------------------
//
// Without this guard, Step 3 would build waveId='W?' when current-wave is
// undefined/null/empty. The '?' character then crashes store.mjs:102
// summaryPathFor regex (/^[A-Za-z0-9_-]+$/), surfacing as STATUS.ERROR
// (exit 4) via the inner try/catch in Step 8 — violating the documented
// contract that wrong-context conditions return STATUS.REJECTED_WRONG_CONTEXT
// (exit 3). Fixing upstream here keeps store.mjs's regex defense intact
// while delivering the contracted exit code.
const currentWaveRaw = frontmatter['current-wave'];
if (!dryRun && (currentWaveRaw === undefined || currentWaveRaw === null || currentWaveRaw === '')) {
  exit(
    {
      status: STATUS.REJECTED_WRONG_CONTEXT,
      detail: "STATE.md active but missing 'current-wave' frontmatter field",
    },
    3,
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Build wave ID from STATE.md current-wave (guaranteed present by 2c
// when !dryRun; falls back to a 'W-dryrun' placeholder under --dry-run when
// STATE.md was absent/unparseable/missing the field — #741.3)
// ---------------------------------------------------------------------------

const frontmatterWaveId =
  currentWaveRaw !== undefined && currentWaveRaw !== null && currentWaveRaw !== ''
    ? `W${currentWaveRaw}`
    : undefined;

const waveId = dryRun ? (frontmatterWaveId ?? 'W-dryrun') : frontmatterWaveId;

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
    { status: STATUS.REJECTED_LOW_CONFIDENCE, floor: confidenceFloor, provided: confidence },
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
  exit({ status: STATUS.ERROR, validation: [`Failed to create proposal record: ${err.message}`] }, 4);
}

// ---------------------------------------------------------------------------
// Step 7 — Validate type against schema enum (I1 schema module)
// ---------------------------------------------------------------------------

try {
  const schemaMod = await import('./lib/memory-proposals/schema.mjs');
  const validation = schemaMod.validateProposalRecord(record);
  if (!validation.ok) {
    exit({ status: STATUS.ERROR, validation: validation.errors }, 4);
  }
} catch (err) {
  exit({ status: STATUS.ERROR, validation: [`Schema validation error: ${err.message}`] }, 4);
}

// ---------------------------------------------------------------------------
// Step 7b — Dry-run short-circuit (#741.3)
// ---------------------------------------------------------------------------
//
// Argv validation (Step 1) and schema/type-enum validation (Step 7) both
// passed. Under --dry-run we stop HERE — before Step 8's appendProposal —
// so nothing touches proposals.jsonl. This is the entire point of the flag:
// a safe way to verify a proposal is well-formed without a live write.

if (dryRun) {
  exit(
    {
      status: STATUS.DRY_RUN_OK,
      dryRun: true,
      type,
      subject,
      wave: waveId,
    },
    0,
  );
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
  exit({ status: STATUS.ERROR, validation: [`Store error: ${err.message}`] }, 4);
}

// ---------------------------------------------------------------------------
// Step 9 — Translate store result to exit code + stdout JSON
// ---------------------------------------------------------------------------

const storeStatus = storeResult?.status;

if (storeStatus === STATUS.QUEUED) {
  exit(
    {
      status: STATUS.QUEUED,
      position: storeResult.position,
      wave: waveId,
    },
    0,
  );
} else if (storeStatus === STATUS.QUOTA_EXCEEDED) {
  exit(
    {
      status: STATUS.QUOTA_EXCEEDED,
      quota: quotaPerWave,
      dropped: storeResult.dropped ?? 1,
    },
    1,
  );
} else if (storeStatus === STATUS.REJECTED_LOW_CONFIDENCE) {
  // Store enforces floor independently (defensive — CLI already checked above)
  exit(
    { status: STATUS.REJECTED_LOW_CONFIDENCE, floor: confidenceFloor, provided: confidence },
    2,
  );
} else {
  // Unexpected store result
  exit(
    {
      status: STATUS.ERROR,
      validation: [`Unexpected store result: ${JSON.stringify(storeResult)}`],
    },
    4,
  );
}
