#!/usr/bin/env node
/**
 * Materialize both wave file-scope declaration shapes from one canonical array.
 *
 * Usage:
 *   node scripts/materialize-wave-scope.mjs --state-dir <dir> --wave <positive-int> [--json] < scopes.json
 *
 * The stdin document is an array of `{ id, files }` records. The command writes
 * each bare `files` array first, then writes the complete record array as the
 * aggregate sidecar consumed by validate-wave-scope's --assert-disjoint and
 * --union modes.
 *
 * After the aggregate is published, per-agent declarations left behind by an
 * earlier materialization of the SAME wave are reconciled away (#1103) — but
 * only against a proven session owner. See {@link reconcileOrphans}.
 *
 * PEER RECORDS (`peer-session-*`, #1195) get NO per-agent file: shape (a) is
 * `$AGENT_FILESCOPE_JSON`, addressed by an agent id at dispatch time, and no
 * agent is ever dispatched for a peer session — nothing reads it. They are
 * still written into the aggregate, where `--assert-disjoint` and
 * `hooks/post-bash-write-verify.mjs` do read them; `--union` excludes them so
 * `allowedPaths` never grants a peer's territory to this wave's agents.
 */

import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomicSync } from './lib/io.mjs';
import { isPeerRecordId } from './lib/scope-gate.mjs';
import {
  MANIFEST_SESSION_KEYS,
  manifestSessionBinding,
} from './lib/session-identity/own-session.mjs';

const HELP = `Usage: node scripts/materialize-wave-scope.mjs --state-dir <dir> --wave <positive-int> [--json]

Read one JSON array of {id, files} records from stdin and materialize both
wave-scope declaration shapes from that canonical record array.

Required:
  --state-dir <dir>   State directory that owns filescopes/.
  --wave <positive-int>
                      Positive wave number used in filescopes/wave-N/.

Options:
  --session <id>      This session's id (session_id or its semantic twin). Used
                      ONLY to prove ownership before an orphaned per-agent
                      declaration of the same wave is removed (#1103). Without
                      it, orphans are reported and RETAINED, never deleted.
  --json              Emit {ok, aggregatePath, perAgentPaths, removedOrphans,
                      retainedOrphans} to stdout.
  -h, --help          Show this help and exit 0.

Output:
  Human mode prints only the aggregate sidecar path. --json prints one JSON
  object. Diagnostics are written only to stderr.

Examples:
  printf '%s' '[{"id":"W1-I1","files":["scripts/example.mjs"]},{"id":"coordinator","files":[]}]' | \\
    node scripts/materialize-wave-scope.mjs --state-dir .claude --wave 1
  node scripts/materialize-wave-scope.mjs --state-dir .claude --wave 1 --json < scopes.json

Writes:
  <state-dir>/filescopes/wave-N/<id>.json       Bare string[] for each record
                      EXCEPT a peer-session-* record (#1195), which is
                      aggregate-only: no agent is dispatched for it, so nothing
                      would read its per-agent file.
  <state-dir>/filescopes/wave-N.scopes.json     Aggregate [{id, files}, ...]

Removes (only with a proven owner — see --session):
  <state-dir>/filescopes/wave-N/<stale-id>.json Per-agent declarations of this
                      wave whose id is absent from the new record array. An
                      orphan that cannot be proven owned is named on stderr and
                      LEFT IN PLACE; that is a WARN, never a failure.

Exit codes:
  0  All declaration files and the aggregate sidecar were written.
  1  Usage or input validation error; no write was attempted.
  2  Filesystem or write error; earlier per-agent writes are retained and any
     previous aggregate is invalidated before per-agent writes begin.
`;

class InputError extends Error {}
class WriteError extends Error {}

/**
 * @param {string[]} argv
 * @returns {{ stateDir: string, wave: number, session: string|null, json: boolean, help: boolean }}
 */
export function parseCliArgs(argv) {
  let stateDir;
  let waveRaw;
  let session = null;
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--state-dir' || arg === '--wave' || arg === '--session') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new InputError(`${arg} requires a value`);
      }
      if (arg === '--state-dir') {
        if (stateDir !== undefined) throw new InputError('--state-dir may be specified only once');
        stateDir = value;
      } else if (arg === '--session') {
        if (session !== null) throw new InputError('--session may be specified only once');
        // An empty or whitespace-only id proves nothing and must not be read as
        // an owner: it would make every orphan deletable by any caller.
        if (value.trim().length === 0) throw new InputError('--session must be a non-empty id');
        session = value.trim();
      } else {
        if (waveRaw !== undefined) throw new InputError('--wave may be specified only once');
        waveRaw = value;
      }
      index++;
      continue;
    }
    throw new InputError(`unknown argument: ${arg}`);
  }

  if (help) return { stateDir: '', wave: 0, session, json, help: true };
  if (stateDir === undefined) throw new InputError('--state-dir is required');
  if (waveRaw === undefined) throw new InputError('--wave is required');
  if (stateDir.length === 0 || /[\0\r\n]/.test(stateDir)) {
    throw new InputError('--state-dir must be a non-empty path without NUL or newline characters');
  }
  if (!/^[1-9]\d*$/.test(waveRaw)) {
    throw new InputError('--wave must be a positive integer');
  }

  const wave = Number(waveRaw);
  if (!Number.isSafeInteger(wave)) throw new InputError('--wave must be a safe positive integer');
  return { stateDir, wave, session, json, help: false };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A path is scope data rather than an output target, so absolute paths remain
 * valid for sanctioned out-of-repository grants. Traversal/control characters
 * are rejected because no scope consumer can safely interpret them verbatim.
 *
 * @param {unknown} value
 * @param {number} recordIndex
 * @param {number} fileIndex
 */
function validateScopePath(value, recordIndex, fileIndex) {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    throw new InputError(`record #${recordIndex} files[${fileIndex}] must be a non-empty string`);
  }
  if (/[\0\r\n]/.test(value)) {
    throw new InputError(`record #${recordIndex} files[${fileIndex}] must not contain NUL or newline characters`);
  }
  if (value.split(/[\\/]+/).includes('..')) {
    throw new InputError(`record #${recordIndex} files[${fileIndex}] must not contain path traversal`);
  }
}

/**
 * Validate the canonical record array completely before a write is attempted.
 * The original values are returned without sorting, deduplication, or expansion.
 *
 * @param {unknown} value
 * @returns {Array<{id: string, files: string[]}>}
 */
export function validateScopeRecords(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InputError('stdin must be a non-empty JSON array of {id, files} records');
  }

  const seenIds = new Set();
  let coordinatorCount = 0;
  for (let recordIndex = 0; recordIndex < value.length; recordIndex++) {
    const record = value[recordIndex];
    if (!isRecord(record)) {
      throw new InputError(`record #${recordIndex} must be an object with id and files`);
    }
    if (typeof record.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(record.id)) {
      throw new InputError(`record #${recordIndex} has an unsafe id`);
    }
    const idKey = record.id.toLowerCase();
    if (seenIds.has(idKey)) {
      throw new InputError(`record #${recordIndex} has duplicate id (case-insensitive): ${record.id}`);
    }
    seenIds.add(idKey);
    if (idKey === 'coordinator') {
      if (record.id !== 'coordinator') {
        throw new InputError(`record #${recordIndex} id must be exactly coordinator (lowercase)`);
      }
      coordinatorCount++;
    }

    if (!Array.isArray(record.files)) {
      throw new InputError(`record #${recordIndex} (${record.id}) must have a files string array`);
    }
    for (let fileIndex = 0; fileIndex < record.files.length; fileIndex++) {
      validateScopePath(record.files[fileIndex], recordIndex, fileIndex);
    }
  }

  if (coordinatorCount !== 1) {
    throw new InputError(`input must contain exactly one coordinator record; found ${coordinatorCount}`);
  }
  return value;
}


/**
 * Read the session ids the sibling manifest `<state-dir>/wave-scope.json`
 * declares for this state directory (#1123 wrote both `session` — the raw
 * `session_id` — and its human-readable twin `semantic_session_id`; the
 * pre-#1153 spellings `session` / `semantic_session` are still read).
 *
 * A caller may legitimately hold either spelling, so BOTH are returned and a
 * match against either proves ownership. Any failure to read or parse the
 * manifest returns an empty list, which the caller must treat as "ownership NOT
 * established" — never as "no owner, therefore mine".
 *
 * @param {string} stateDir
 * @param {typeof readFileSync} [readFile]
 * @returns {string[]}
 */
export function manifestSessionIds(stateDir, readFile = readFileSync) {
  let manifest;
  try {
    manifest = JSON.parse(readFile(resolve(stateDir, 'wave-scope.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!isRecord(manifest)) return [];
  // #1153 P2 — the key spellings live in own-session.mjs, which also reads the
  // pre-#1153 `session`/`semantic_session` names for one transition release.
  const binding = manifestSessionBinding(manifest);
  return MANIFEST_SESSION_KEYS.current
    .map((key) => binding[key])
    .filter((value) => typeof value === 'string' && value.length > 0);
}

/**
 * Reconcile per-agent declarations left behind by an earlier materialization of
 * the SAME wave (#1103).
 *
 * The write loop is a pure upsert over the new id set, so a file whose id was
 * dropped from the plan survives: it is in no aggregate — `--assert-disjoint`
 * and `--union` cannot see it — while every by-id consumer (FILE-SCOPE
 * injection, the Learnings-Index, `--assert-subset`) still reads it. A live
 * scope claim with zero aggregate coverage.
 *
 * ## Why this is NOT a directory wipe
 *
 * The wave number is not a session-unique key: two sessions sharing one working
 * copy both call their first wave `wave-1` and both resolve to
 * `<state-dir>/filescopes/wave-1/`. Clearing the directory would convert a
 * stale-read bug into cross-session data loss — the class
 * `.claude/rules/parallel-sessions.md` PSA-003 forbids by name ("Did I create
 * this file? If not, it is not mine to touch"). So removal needs a two-part
 * test, and only the second part is about the file:
 *
 *   1. the id is absent from the new record array (it is an orphan), AND
 *   2. this invocation can PROVE it owns the state directory — `sessionId`
 *      matches an id the sibling manifest declares.
 *
 * Failing (2) is not an error and never blocks: the orphan is returned in
 * `retained` WITH its reason so the caller can name the file. A silent skip is
 * the one outcome forbidden here, because it is byte-identical to a clean run.
 *
 * ## Named ceiling (BV-004)
 *
 * Bounded by WHEN materialization runs, not by what it inspects: a session that
 * re-materializes wave N *while its own agents are still in flight* would delete
 * the scope files those agents are reading. That is safe today only because
 * `skills/wave-executor/wave-loop.md` § Scope Manifest 3.2 places
 * (re-)materialization strictly PRE-dispatch, so no reader exists yet. REVISIT
 * TRIGGER: any caller that materializes a wave after its dispatch has begun — a
 * mid-wave scope amendment, a repair pass reusing the same wave number, or a
 * dispatch loop that re-runs the materializer per agent. Ownership does not
 * protect against that case; the ordering does.
 *
 * @param {object} params
 * @param {string} params.scopeDir           `<state-dir>/filescopes/wave-N`
 * @param {string[]} params.keepIds          ids present in the new record array
 * @param {string[]} params.ownerIds         session ids the manifest declares
 * @param {string|null} params.sessionId     this invocation's session id
 * @param {typeof readdirSync} [params.readDir]
 * @param {typeof unlinkSync} [params.removeFile]
 * @returns {{removed: string[], retained: Array<{file: string, reason: string}>}}
 */
export function reconcileOrphans({
  scopeDir,
  keepIds,
  ownerIds,
  sessionId,
  readDir = readdirSync,
  removeFile = unlinkSync,
}) {
  let entries;
  try {
    entries = readDir(scopeDir, { withFileTypes: true });
  } catch {
    // No directory yet (first materialization) or unreadable — nothing to
    // reconcile. Not a failure: the aggregate is already published.
    return { removed: [], retained: [] };
  }

  // Case-INSENSITIVE keep set. validateScopeRecords already rejects two ids that
  // differ only in case within one input, so this cannot hide a real orphan —
  // but on a case-insensitive filesystem `A2.json` and `a2.json` are ONE file,
  // and deleting the "orphan" would delete the declaration just written.
  const keep = new Set(keepIds.map((id) => `${id}.json`.toLowerCase()));
  const orphans = [];
  for (const entry of entries) {
    if (typeof entry?.isFile === 'function' && !entry.isFile()) continue;
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name !== 'string' || !name.endsWith('.json')) continue;
    if (keep.has(name.toLowerCase())) continue;
    orphans.push(name);
  }
  if (orphans.length === 0) return { removed: [], retained: [] };

  const proven = typeof sessionId === 'string' && sessionId.length > 0 && ownerIds.includes(sessionId);
  if (!proven) {
    const reason = sessionId === null || sessionId === undefined
      ? 'no --session given, so this state directory has no provable owner'
      : ownerIds.length === 0
        ? 'wave-scope.json declares no session, so ownership cannot be established'
        : `wave-scope.json is owned by a different session (${ownerIds.join(' / ')})`;
    return { removed: [], retained: orphans.map((file) => ({ file, reason })) };
  }

  const removed = [];
  const retained = [];
  for (const file of orphans) {
    try {
      removeFile(resolve(scopeDir, file));
      removed.push(file);
    } catch (error) {
      // A failed unlink leaves a live orphan behind — report it, never throw:
      // the aggregate is already published and the materialization succeeded.
      retained.push({ file, reason: `could not remove: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return { removed, retained };
}

/**
 * Materialize validated declarations in their required write order.
 *
 * The optional writer is a narrow seam for deterministic write-failure tests;
 * production always delegates to writeJsonAtomicSync. There is intentionally no
 * rollback: a prior aggregate is invalidated before per-agent writes, then the
 * aggregate publication marker is written only after every per-agent declaration
 * has succeeded.
 *
 * @param {Array<{id: string, files: string[]}>} records
 * @param {{ stateDir: string, wave: number, session?: string|null,
 *          writeJson?: typeof writeJsonAtomicSync,
 *          readDir?: typeof readdirSync, removeFile?: typeof unlinkSync,
 *          readFile?: typeof readFileSync }} options
 * @returns {{ aggregatePath: string, perAgentPaths: string[],
 *             removedOrphans: string[], retainedOrphans: Array<{file: string, reason: string}> }}
 */
export function materializeWaveScope(records, {
  stateDir,
  wave,
  session = null,
  writeJson = writeJsonAtomicSync,
  readDir = readdirSync,
  removeFile = unlinkSync,
  readFile = readFileSync,
}) {
  const scopeDir = resolve(stateDir, 'filescopes', `wave-${wave}`);
  const aggregatePath = resolve(stateDir, 'filescopes', `wave-${wave}.scopes.json`);
  // #1195 — peer records are aggregate-only (see the header note): no reader
  // exists for a per-agent file that no dispatch will ever address. Excluding
  // them from `keepIds` below also lets a stale `peer-session-*.json` written
  // before this rule be reconciled away like any other orphan.
  const agentRecords = records.filter((r) => !isPeerRecordId(r.id));
  const perAgentPaths = agentRecords.map(({ id }) => resolve(scopeDir, `${id}.json`));

  try {
    unlinkSync(aggregatePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new WriteError(`cannot invalidate aggregate declaration ${aggregatePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (let index = 0; index < agentRecords.length; index++) {
    const result = writeJson(perAgentPaths[index], agentRecords[index].files, { tmpPrefix: '.materialize-wave-scope' });
    if (!result?.ok) {
      throw new WriteError(`cannot write per-agent declaration ${perAgentPaths[index]}: ${result?.error ?? 'unknown write failure'}`);
    }
  }

  const aggregateResult = writeJson(aggregatePath, records, { tmpPrefix: '.materialize-wave-scope' });
  if (!aggregateResult?.ok) {
    throw new WriteError(`cannot write aggregate declaration ${aggregatePath}: ${aggregateResult?.error ?? 'unknown write failure'}`);
  }

  // #1103 — strictly AFTER the aggregate write. The aggregate is this command's
  // publication marker (see the write-order note above), so reconciling before
  // it would remove a live declaration while the run could still fail and leave
  // no aggregate at all — deleting coverage that nothing replaced.
  const { removed, retained } = reconcileOrphans({
    scopeDir,
    keepIds: agentRecords.map(({ id }) => id),
    ownerIds: manifestSessionIds(stateDir, readFile),
    sessionId: session,
    readDir,
    removeFile,
  });

  return { aggregatePath, perAgentPaths, removedOrphans: removed, retainedOrphans: retained };
}

/**
 * @param {string} message
 * @param {number} code
 */
function fail(message, code) {
  process.stderr.write(`materialize-wave-scope: ${message}\n`);
  process.exitCode = code;
}

function readStdinJson() {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch (error) {
    throw new WriteError(`cannot read stdin: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new InputError('stdin is not valid JSON');
  }
}

/** Execute the CLI, mapping usage/input and I/O failures to its exit contract. */
export function main() {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(HELP);
      return;
    }
    const records = validateScopeRecords(readStdinJson());
    const { aggregatePath, perAgentPaths, removedOrphans, retainedOrphans } =
      materializeWaveScope(records, args);

    // stderr carries ONLY the anomalous cases. Measured constraint, not taste:
    // the corpus pins byte-empty stderr on this command's success path
    // (tests/scripts/materialize-wave-scope.test.mjs and
    // tests/integration/wave-scope-producer.test.mjs), and a wave with no
    // orphans IS the success path. Both lists always reach --json.
    for (const file of removedOrphans) {
      process.stderr.write(`materialize-wave-scope: removed orphaned declaration ${file} (id absent from this wave's records)\n`);
    }
    for (const { file, reason } of retainedOrphans) {
      process.stderr.write(`materialize-wave-scope: WARN orphaned declaration ${file} RETAINED — ${reason}\n`);
    }

    process.stdout.write(
      args.json
        ? `${JSON.stringify({ ok: true, aggregatePath, perAgentPaths, removedOrphans, retainedOrphans })}\n`
        : `${aggregatePath}\n`,
    );
  } catch (error) {
    if (error instanceof InputError) {
      fail(error.message, 1);
      return;
    }
    if (error instanceof WriteError) {
      fail(error.message, 2);
      return;
    }
    fail(`unexpected system error: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
