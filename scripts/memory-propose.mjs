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
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isWaveAgentContext, WAVE_AGENT_ENV_VAR, WAVE_AGENT_ENV_VALUE } from './lib/wave-context.mjs';
import { readProcessLocalSessionIds, manifestSessionBinding } from './lib/session-identity/own-session.mjs';
import { readLockDetailed } from './lib/session-lock.mjs';

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
    '--insight "..." --evidence "..." --confidence <0-1> ' +
    '[--file-paths "a.mjs,b.mjs"] [--dry-run]\n\n' +
    'Environment:\n' +
    '  SO_WAVE_AGENT=1 — REQUIRED. The CLI returns exit 3 (rejected-wrong-context)\n' +
    '                    when this env-var is absent or not exactly "1".\n' +
    '                    Bypassed under --dry-run.\n\n' +
    'Flags:\n' +
    '  --dry-run — Validate the proposal (argv + schema) but do NOT write to\n' +
    '              proposals.jsonl. Bypasses the STATE.md / SO_WAVE_AGENT /\n' +
    '              current-wave context gates so it can be run safely from\n' +
    '              coordinator context (issue #741.3).\n' +
    '  --file-paths — Optional. Repo-relative path(s) this learning applies to.\n' +
    '                 Repeatable AND/OR comma-separated (`--file-paths a.mjs\n' +
    '                 --file-paths b.mjs,c.mjs`), deduped. Rejects absolute\n' +
    '                 paths, ".." segments, embedded newlines, entries over 256\n' +
    '                 chars, and more than 20 entries (exit 4). Without\n' +
    '                 --file-paths this learning can never become /reconcile-\n' +
    '                 eligible (issue #900).\n\n' +
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
      type:          { type: 'string' },
      subject:       { type: 'string' },
      insight:       { type: 'string' },
      evidence:      { type: 'string' },
      confidence:    { type: 'string' },
      'dry-run':     { type: 'boolean' },
      'file-paths':  { type: 'string', multiple: true },
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

// ---------------------------------------------------------------------------
// Step 1b — Parse + validate --file-paths (issue #900 C)
// ---------------------------------------------------------------------------
//
// --file-paths is repeatable AND each occurrence may itself be comma-separated
// (`--file-paths a.mjs --file-paths b.mjs,c.mjs`). Flattened, trimmed,
// empty-filtered, and deduped BEFORE validation so callers see one clean
// error per genuinely-bad entry rather than noise from formatting.
//
// Validation runs here (Step 1, argv-level) — BEFORE createProposalRecord
// (Step 6) — so a malformed --file-paths value produces the same exit-4
// argv-error contract as every other required/optional flag, never a
// downstream schema-validation surprise.

const FILE_PATHS_MAX_COUNT = 20;
const FILE_PATH_MAX_CHARS = 256;

const filePathsRaw = parsedArgs.values['file-paths'];
/** @type {string[]|undefined} */
let filePaths;
if (Array.isArray(filePathsRaw) && filePathsRaw.length > 0) {
  const flattened = filePathsRaw
    .flatMap((entry) => String(entry).split(','))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  filePaths = [...new Set(flattened)];
}

if (filePaths !== undefined) {
  if (filePaths.length > FILE_PATHS_MAX_COUNT) {
    argErrors.push(
      `--file-paths accepts at most ${FILE_PATHS_MAX_COUNT} paths (got ${filePaths.length})`,
    );
  }
  for (const p of filePaths) {
    if (isAbsolute(p)) {
      argErrors.push(`--file-paths must be repo-relative — absolute path rejected: "${p}"`);
    } else if (p.split(/[\\/]/).includes('..')) {
      argErrors.push(`--file-paths must not contain ".." path segments: "${p}"`);
    } else if (/[\r\n]/.test(p)) {
      argErrors.push(`--file-paths entries must not contain newline characters: "${p}"`);
    } else if (/[*?[\]{}]/.test(p)) {
      argErrors.push(
        `--file-paths must not contain glob metacharacters (* ? [ ] { }) — a literal repo-relative path is required: "${p}"`,
      );
    } else if (p.length > FILE_PATH_MAX_CHARS) {
      argErrors.push(
        `--file-paths entry exceeds ${FILE_PATH_MAX_CHARS} chars (got ${p.length}): "${p.slice(0, 40)}..."`,
      );
    }
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
/** Directory holding STATE.md — the same state-dir the wave manifest lives in (#1166). */
let stateDir = null;

try {
  // resolveStateMdPath from state-md.mjs: falls back to .claude/STATE.md
  const stateMdMod = await import('./lib/state-md.mjs');
  const stateMdPath = stateMdMod.resolveStateMdPath(process.cwd());
  stateDir = dirname(stateMdPath);

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
// Step 3 — Build the RUNNING wave ID (#1166)
// ---------------------------------------------------------------------------
//
// #1166 — two writers, two semantics: `skills/wave-executor/wave-loop.md` § 3a
// writes STATE.md `current-wave` = the JUST-COMPLETED wave, while the
// coordinator's `<state-dir>/wave-scope.json` carries `wave` = the RUNNING
// wave. Stamping proposals off `current-wave` verbatim filed every wave-N+1
// proposal into the W<N> quota bucket. Priority: the manifest ONLY when it is
// bound to THIS session, else `current-wave + 1`. An UNBOUND manifest is not
// trusted (#1177 FX1) — since #1123 both writers stamp the binding, so a
// binding-less manifest is a peer's or a stale artefact.
//
// The session binding compares the manifest's `semantic_session_id` — the SEMANTIC label
// — against the semantic id looked up in `session.lock`, and that lookup is only
// honoured when this PROCESS's own raw session id equals the lock's raw
// `session_id` (#1188). STATE.md's `session` field is NOT a witness here: it is
// written by the lock owner, so under a peer's lock both "sides" name the peer.

/** @returns {string|undefined} */
function resolveRunningWaveId() {
  if (stateDir !== null) {
    try {
      const manifestPath = join(stateDir, 'wave-scope.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        // #1153 P2 — key spellings resolved in ONE place (own-session.mjs),
        // which also reads the pre-#1153 `session` / `semantic_session` names
        // for one transition release. Absent slots come back as `undefined`.
        const binding = manifestSessionBinding(manifest);
        const boundSession = binding.semantic_session_id ?? binding.session_id;
        const unbound =
          boundSession === undefined || boundSession === null || boundSession === '';
        // BOTH sides must be non-empty strings. `undefined === undefined` is
        // true, so a STATE.md WITHOUT a `session` key previously "matched" any
        // manifest whose `semantic_session` was also absent-but-present-in-the
        // -comparison — adopting a foreign coordinator's wave number as its own.
        const mineSide = binding.semantic_session_id;
        // #1188 — STATE.md is a working-copy artefact of the LOCK OWNER, not a
        // process-local witness: when a peer holds the lock the peer wrote BOTH
        // STATE.md and the manifest, so the two "independent" sides agree about
        // the PEER. Same class as #1177 FX1; same shape as attributionForRecord
        // (scripts/lib/events.mjs): the lock is a raw->semantic LOOKUP,
        // authorised by a process-local match on the RAW id. Measured
        // 2026-09-02: a wave-agent process carries the COORDINATOR's raw uuid in
        // CLAUDE_CODE_SESSION_ID and no semantic id at all, so comparing the
        // process-local id against `semantic_session` directly never matches.
        // CEILING (BV-004): a harness exporting no session id (Codex CLI,
        // Cursor) resolves no process-local id -> binding unprovable ->
        // current-wave + 1 fallback with a stderr line. REVISIT if that fallback
        // rate is measured non-trivial in events.jsonl.
        //
        // #1207 — kept hand-rolled rather than calling `attributionForRecord()`
        // (scripts/lib/events.mjs): that function's contract is `{}`-on-any-
        // mismatch with no detail, but the stderr diagnostics below (raw id,
        // lock status, process-local id list) are load-bearing for debugging a
        // wrongly-bucketed proposal, and attributionForRecord() has no lock-
        // status channel to source them from (it swallows `readLock()` errors
        // silently by design). `readLockDetailed()` is used here specifically
        // for that `.status` field `readLock()` (attributionForRecord's own
        // primitive) does not return.
        const lock = readLockDetailed({ repoRoot: process.cwd() });
        const processLocal = readProcessLocalSessionIds();
        const lockRaw =
          lock.status === 'ok' ? String(lock.lock.session_id ?? '').trim() : '';
        const authorised = lockRaw !== '' && processLocal.includes(lockRaw);
        const oursSide = authorised ? (lock.lock.semantic_session_id ?? '') : '';
        if (!authorised) {
          // A SILENT non-match is the exact failure mode this fix exists to make
          // visible: without this line, a proposal bucketed by the fallback is
          // indistinguishable from one bucketed by a trusted manifest.
          process.stderr.write(
            `⚠ memory-propose: session binding unprovable (session.lock ${lock.status}` +
              `${lockRaw ? `, raw ${lockRaw}` : ''}; process-local ids: ` +
              `${processLocal.length > 0 ? processLocal.join(', ') : 'none'}) — ` +
              'ignoring wave-scope.json, falling back to current-wave + 1\n',
          );
        }
        const mine =
          typeof mineSide === 'string' && mineSide.length > 0 &&
          typeof oursSide === 'string' && oursSide.length > 0 &&
          mineSide === oursSide;
        // An UNBOUND manifest is NOT trusted (#1177 FX1). It used to be, as
        // "legacy" — but since #1123 BOTH writers stamp the binding, so a
        // manifest without one today is a PEER's or a stale artefact, and
        // trusting it files this session's proposals into a foreign quota
        // bucket. Unbound → say so once on stderr and fall back.
        if (unbound) {
          process.stderr.write(
            'memory-propose: wave-scope.json unbound (no semantic_session_id) — ignored\n',
          );
        }
        if (mine) {
          const raw = manifest?.wave;
          const num =
            typeof raw === 'number'
              ? raw
              : typeof raw === 'string' && raw.trim() !== ''
                ? Number(raw)
                : NaN;
          if (Number.isInteger(num)) return `W${num}`;
        }
      }
    } catch (err) {
      // Unreadable / malformed manifest → fall through to the +1 fallback, but
      // SAY SO. A swallowed parse error makes a wrongly-bucketed proposal look
      // like ordinary fallback behaviour; the operator then has no signal that
      // the coordinator's own manifest is corrupt. Diagnostics on stderr keeps
      // the stdout JSON contract intact (cli-design.md § JSON-First Output).
      process.stderr.write(
        `⚠ memory-propose: cannot read ${join(stateDir, 'wave-scope.json')} ` +
          `(${err?.message ?? String(err)}) — falling back to current-wave + 1\n`,
      );
    }
  }

  if (currentWaveRaw === undefined || currentWaveRaw === null || currentWaveRaw === '') {
    return undefined;
  }
  const completed = Number(currentWaveRaw);
  if (!Number.isFinite(completed)) return undefined; // never 'WNaN'
  // CEILING (BV-004): `+1` assumes waves run consecutively and that STATE.md is
  // maintained — it is WRONG when a wave is skipped, when the plan is adapted
  // mid-session, or under `persistence: false` where `current-wave` never
  // advances. It is the fallback precisely because wave-scope.json is the only
  // artefact that KNOWS the running wave.
  // REVISIT when a wave-scope.json manifest is present in every dispatch (then
  // delete the fallback and reject instead), or when a proposal is observed in
  // the wrong quota bucket while the manifest was readable.
  return `W${completed + 1}`;
}

const resolvedWaveId = resolveRunningWaveId();

if (!dryRun && resolvedWaveId === undefined) {
  exit(
    {
      status: STATUS.REJECTED_WRONG_CONTEXT,
      detail: `Cannot resolve the running wave: no usable wave-scope.json and STATE.md 'current-wave' is not numeric (got '${currentWaveRaw}')`,
    },
    3,
  );
}

const waveId = dryRun ? (resolvedWaveId ?? 'W-dryrun') : resolvedWaveId;

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
    filePaths,
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
