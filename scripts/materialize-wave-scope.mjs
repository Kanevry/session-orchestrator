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
 */

import { readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomicSync } from './lib/io.mjs';

const HELP = `Usage: node scripts/materialize-wave-scope.mjs --state-dir <dir> --wave <positive-int> [--json]

Read one JSON array of {id, files} records from stdin and materialize both
wave-scope declaration shapes from that canonical record array.

Required:
  --state-dir <dir>   State directory that owns filescopes/.
  --wave <positive-int>
                      Positive wave number used in filescopes/wave-N/.

Options:
  --json              Emit {ok, aggregatePath, perAgentPaths} to stdout.
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
  <state-dir>/filescopes/wave-N.scopes.json     Aggregate [{id, files}, ...]

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
 * @returns {{ stateDir: string, wave: number, json: boolean, help: boolean }}
 */
export function parseCliArgs(argv) {
  let stateDir;
  let waveRaw;
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
    if (arg === '--state-dir' || arg === '--wave') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new InputError(`${arg} requires a value`);
      }
      if (arg === '--state-dir') {
        if (stateDir !== undefined) throw new InputError('--state-dir may be specified only once');
        stateDir = value;
      } else {
        if (waveRaw !== undefined) throw new InputError('--wave may be specified only once');
        waveRaw = value;
      }
      index++;
      continue;
    }
    throw new InputError(`unknown argument: ${arg}`);
  }

  if (help) return { stateDir: '', wave: 0, json, help: true };
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
  return { stateDir, wave, json, help: false };
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
 * Materialize validated declarations in their required write order.
 *
 * The optional writer is a narrow seam for deterministic write-failure tests;
 * production always delegates to writeJsonAtomicSync. There is intentionally no
 * rollback: a prior aggregate is invalidated before per-agent writes, then the
 * aggregate publication marker is written only after every per-agent declaration
 * has succeeded.
 *
 * @param {Array<{id: string, files: string[]}>} records
 * @param {{ stateDir: string, wave: number, writeJson?: typeof writeJsonAtomicSync }} options
 * @returns {{ aggregatePath: string, perAgentPaths: string[] }}
 */
export function materializeWaveScope(records, { stateDir, wave, writeJson = writeJsonAtomicSync }) {
  const scopeDir = resolve(stateDir, 'filescopes', `wave-${wave}`);
  const aggregatePath = resolve(stateDir, 'filescopes', `wave-${wave}.scopes.json`);
  const perAgentPaths = records.map(({ id }) => resolve(scopeDir, `${id}.json`));

  try {
    unlinkSync(aggregatePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new WriteError(`cannot invalidate aggregate declaration ${aggregatePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (let index = 0; index < records.length; index++) {
    const result = writeJson(perAgentPaths[index], records[index].files, { tmpPrefix: '.materialize-wave-scope' });
    if (!result?.ok) {
      throw new WriteError(`cannot write per-agent declaration ${perAgentPaths[index]}: ${result?.error ?? 'unknown write failure'}`);
    }
  }

  const aggregateResult = writeJson(aggregatePath, records, { tmpPrefix: '.materialize-wave-scope' });
  if (!aggregateResult?.ok) {
    throw new WriteError(`cannot write aggregate declaration ${aggregatePath}: ${aggregateResult?.error ?? 'unknown write failure'}`);
  }
  return { aggregatePath, perAgentPaths };
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
    const { aggregatePath, perAgentPaths } = materializeWaveScope(records, args);
    process.stdout.write(
      args.json
        ? `${JSON.stringify({ ok: true, aggregatePath, perAgentPaths })}\n`
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
