/**
 * learnings/io.mjs — I/O layer for learnings JSONL files.
 *
 * Extracted from scripts/lib/learnings.mjs (issue #358).
 * Depends on the schema/validator layer in the parent module.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  validateLearning,
  normalizeLearning,
  CURRENT_SCHEMA_VERSION,
  deriveExpiresAt,
  ValidationError,
} from './schema.mjs';

// ---------------------------------------------------------------------------
// Pre-write self-validation seam (issue #662)
// ---------------------------------------------------------------------------

/**
 * Serialize `validated` to a single JSONL line and prove it round-trips:
 * the line MUST be JSON-parseable AND the parsed-back object MUST still pass
 * `validateLearning`. This closes the gap where `JSON.stringify` silently
 * drops or coerces non-serializable values (`undefined`, `NaN`, `Infinity`,
 * `BigInt`, circular refs) — a line that stringifies "fine" but parses back
 * to a schema-invalid shape would otherwise corrupt the file and only surface
 * on the NEXT session's read (learning #5,
 * `metrics-jsonl-schema-strict-needs-self-validation`, conf 1.0).
 *
 * Throws ValidationError (matching the existing writer error style) BEFORE any
 * append touches disk, so a bad write can never reach the file.
 *
 * @param {object} validated — already validated+normalized learning entry
 * @returns {string} the verified JSONL line (newline-terminated)
 * @throws {ValidationError} when the serialized line does not round-trip
 */
function serializeLearningLineChecked(validated) {
  let line;
  try {
    line = JSON.stringify(validated);
  } catch (err) {
    // Circular refs / BigInt make JSON.stringify itself throw a TypeError.
    throw new ValidationError(
      `learning is not JSON-serializable: ${err.message}`
    );
  }
  if (typeof line !== 'string' || line.length === 0) {
    throw new ValidationError('learning serialized to an empty line');
  }
  let reparsed;
  try {
    reparsed = JSON.parse(line);
  } catch (err) {
    throw new ValidationError(
      `serialized learning line does not parse back as JSON: ${err.message}`
    );
  }
  // Re-validate the round-tripped shape — catches required fields that were
  // present as `undefined`/`NaN` before stringify but vanished after.
  validateLearning(reparsed);
  return line + '\n';
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read all learnings from the given JSONL path. Returns normalized entries
 * (missing extended fields are defaulted). Malformed lines are skipped with
 * their raw text preserved in the result's `malformed` array.
 *
 * @param {string} filePath — absolute or project-relative path to learnings.jsonl
 * @returns {Promise<{entries: object[], malformed: string[]}>}
 */
export async function readLearnings(filePath) {
  if (!existsSync(filePath)) return { entries: [], malformed: [] };
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const entries = [];
  const malformed = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      entries.push(normalizeLearning(parsed));
    } catch {
      malformed.push(line);
    }
  }
  return { entries, malformed };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Append a single validated learning to the JSONL file. Returns the
 * validated (normalized) entry. Creates the parent directory if missing.
 *
 * All records are validated against `schema_version: 1` requirements
 * before appending. New records missing `schema_version` are auto-stamped
 * with `CURRENT_SCHEMA_VERSION` prior to validation so every newly written
 * line carries a version tag.
 *
 * Atomic append via write-temp-then-concat is NOT used here — JSONL
 * lines shorter than PIPE_BUF (~4KB on Linux, ~512B on macOS) are
 * atomic on POSIX append. For very large insight/evidence fields that
 * might exceed that boundary, use rewriteLearnings() instead.
 *
 * @param {string} filePath
 * @param {object} entry
 * @returns {Promise<object>} validated entry
 */
export async function appendLearning(filePath, entry) {
  // Ensure created_at is set first — many writers omit it, and expires_at
  // derivation depends on it. Use ISO 8601 UTC.
  const createdAt =
    typeof entry?.created_at === 'string' && entry.created_at.length > 0
      ? entry.created_at
      : new Date().toISOString();

  // Auto-stamp expires_at when caller omits it (issue #323). If caller
  // PASSES expires_at (even an empty string is treated as omitted), respect it.
  const expiresAt =
    typeof entry?.expires_at === 'string' && entry.expires_at.length > 0
      ? entry.expires_at
      : deriveExpiresAt(createdAt, entry?.type);

  const stamped = {
    ...entry,
    created_at: createdAt,
    expires_at: expiresAt,
    schema_version: entry?.schema_version ?? CURRENT_SCHEMA_VERSION,
  };
  const validated = validateLearning(stamped);
  // Pre-write round-trip self-validation (#662): prove the serialized line
  // parses back AND re-validates before any append touches disk. Throws
  // ValidationError on a non-round-tripping record — file is left untouched.
  const line = serializeLearningLineChecked(validated);
  await mkdir(path.dirname(filePath), { recursive: true });
  const { appendFile } = await import('node:fs/promises');
  await appendFile(filePath, line, 'utf8');
  return validated;
}

/**
 * Atomically rewrite the entire JSONL file from a validated entries array.
 * Use when bulk-updating (prune + decay + new appends all at once). Mirrors
 * the shell behavior of `jq | ... > tmp && mv tmp learnings.jsonl`.
 *
 * @param {string} filePath
 * @param {object[]} entries
 * @returns {Promise<object[]>} validated entries written
 */
export async function rewriteLearnings(filePath, entries) {
  const validated = entries.map((e) =>
    validateLearning({
      ...e,
      schema_version: e?.schema_version ?? CURRENT_SCHEMA_VERSION,
    })
  );
  // Pre-write round-trip self-validation (#662): serialize ALL entries through
  // the checked serializer before touching disk — a single bad entry throws
  // ValidationError and the file is left untouched (atomicity preserved because
  // we validate the full batch first, then write once).
  const lines = validated.map((e) => serializeLearningLineChecked(e));
  const body = lines.join('');
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, filePath);
  return validated;
}
