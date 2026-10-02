/**
 * learnings/io.mjs — I/O layer for learnings JSONL files.
 *
 * Extracted from scripts/lib/learnings.mjs (issue #358).
 * Depends on the schema/validator layer in the parent module.
 */

import {
  readFile,
  writeFile,
  appendFile,
  mkdir,
  rename,
  copyFile,
  readdir,
  unlink,
  open,
} from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { withFileLock } from '../file-lock.mjs';
import { digestSha256 } from '../crypto-digest-utils.mjs';
import {
  validateLearning,
  normalizeLearning,
  CURRENT_SCHEMA_VERSION,
  deriveExpiresAt,
  ValidationError,
} from './schema.mjs';

// ---------------------------------------------------------------------------
// Store lock (GitLab #1447 point 8)
// ---------------------------------------------------------------------------

/**
 * How long a writer waits for the store lock before giving up — the
 * `withFileLock` default. Every critical section here is one read plus one
 * append or rewrite of a JSONL file (milliseconds), so ten seconds of
 * contention means a stuck holder, not a slow one.
 */
export const LEARNINGS_LOCK_TIMEOUT_MS = 10000;

/**
 * Thrown when the learnings store lock cannot be acquired. Every writer takes
 * the lock BEFORE it touches the store, so this error always means nothing was
 * written. The message is one line and names the lock file.
 */
export class LearningsLockError extends Error {
  /**
   * @param {string} lockPath
   * @param {'timeout'|'fs-error'} reason
   * @param {number} timeoutMs
   * @param {string} [detail]
   */
  constructor(lockPath, reason, timeoutMs, detail) {
    const why =
      reason === 'timeout'
        ? `held by another writer, waited ${timeoutMs} ms`
        : `${reason}${detail ? `: ${detail}` : ''}`;
    super(`learnings store lock ${lockPath} not acquired (${why}) — nothing written`);
    this.name = 'LearningsLockError';
    this.lockPath = lockPath;
    this.reason = reason;
  }
}

/**
 * Store locks held by the CURRENT async call chain, so a nested writer inside a
 * critical section (apply → prune → rewrite, sweep → rewrite, promote →
 * rewrite) runs straight through instead of waiting on its own lock until the
 * timeout. Keyed per async context, deliberately NOT per process: a concurrent
 * call chain in the same process does not inherit the entry and waits like a
 * second process would — which is exactly the interleaving the lock exists for.
 * @type {AsyncLocalStorage<Map<string, {live: boolean}>>}
 */
const heldStoreLocks = new AsyncLocalStorage();

/**
 * `<store>.lock` beside the store. The directory is canonicalised so two
 * spellings of one store (`/var` vs `/private/var`, a realpath'd repo root as
 * `memory-proposals/sink.mjs` passes it) contend on ONE lock file. Creates the
 * directory: the lock file needs it, and every caller is about to write there.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function resolveStoreLockPath(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  await mkdir(dir, { recursive: true });
  return path.join(realpathSync(dir), `${path.basename(filePath)}.lock`);
}

/**
 * Run `fn` while holding the exclusive lock of the learnings store at
 * `filePath`. Every read-modify-write of the store must run its WHOLE
 * read → write sequence inside one call: a write outside the lock is silently
 * lost when a rewriter that read before it renames its next generation over
 * the file. `appendLearning()` and `rewriteLearnings()` take the lock
 * themselves.
 *
 * Reentrant within one async call chain (see `heldStoreLocks`). Reentrancy
 * prevents a deadlock, not a lost write: an `appendLearning()` issued INSIDE a
 * read → rewrite section lands in the file that section is about to replace —
 * fold such a record into the rewrite batch instead.
 *
 * Crash safety comes from `withFileLock`'s default `staleCheck: 'pid'`: a lock
 * whose holder process is gone is overridden (WARN on stderr); a live holder or
 * one on another host is waited for until `timeoutMs`.
 *
 * @template T
 * @param {string} filePath — the learnings store (the lock file sits beside it)
 * @param {() => (T | Promise<T>)} fn
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<T>}
 * @throws {LearningsLockError} when the lock is not acquired — `fn` never ran
 */
export async function withLearningsLock(filePath, fn, { timeoutMs = LEARNINGS_LOCK_TIMEOUT_MS } = {}) {
  const lockPath = await resolveStoreLockPath(filePath);
  const held = heldStoreLocks.getStore();
  if (held?.get(lockPath)?.live === true) return fn();

  const token = { live: true };
  const scope = new Map(held ?? []);
  scope.set(lockPath, token);
  let result;
  try {
    result = await withFileLock(lockPath, () => heldStoreLocks.run(scope, fn), {
      timeoutMs,
      // A per-acquisition holder makes the owner-guarded release delete only
      // THIS acquisition's lock, never a successor's (#1285).
      holder: `learnings-store:${process.pid}:${randomUUID()}`,
    });
  } finally {
    // A continuation `fn` left running past its own return must not keep
    // treating the released lock as held.
    token.live = false;
  }
  if (!result.ok) throw new LearningsLockError(lockPath, result.reason, timeoutMs, result.error);
  return result.value;
}

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
 * @param {{ legacyTolerant?: boolean }} [opts] — EventDrop #386. When `true`,
 *   a field that was ALREADY ABSENT on `validated` (e.g. a legacy record with
 *   no `source_session`, tolerated by `readLearnings()`) stays tolerated after
 *   the round-trip too — the re-validation call below runs in the same
 *   tolerant mode. This does NOT weaken the #662 guarantee: a key that WAS
 *   present on `validated` (even `undefined`) and is no longer a key on the
 *   reparsed object is genuine JSON.stringify corruption, detected by the
 *   dedicated `droppedKeys` check below and thrown regardless of
 *   `legacyTolerant`. Default `false` — `appendLearning`'s single-record path
 *   calls this with no options and is unaffected.
 * @returns {string} the verified JSONL line (newline-terminated)
 * @throws {ValidationError} when the serialized line does not round-trip
 */
function serializeLearningLineChecked(validated, { legacyTolerant = false } = {}) {
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
  if (legacyTolerant) {
    // A key that existed on `validated` (present, even as `undefined`) but
    // vanished from `reparsed` was DROPPED by JSON.stringify — the exact
    // undefined/NaN/etc. corruption #662 exists to catch. A key that was
    // never on `validated` in the first place (the EventDrop #386
    // legacy-field case) cannot appear here, because we only iterate
    // `validated`'s own keys.
    const droppedKeys = Object.keys(validated).filter((k) => !(k in reparsed));
    if (droppedKeys.length > 0) {
      throw new ValidationError(
        `learning lost field(s) during JSON round-trip serialization ` +
          `(non-serializable value?): ${droppedKeys.join(', ')}`
      );
    }
  }
  // Re-validate the round-tripped shape — catches required fields that were
  // present as `undefined`/`NaN` before stringify but vanished/coerced after.
  validateLearning(reparsed, { legacyTolerant });
  return line + '\n';
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read all learnings from the given JSONL path. Returns normalized entries
 * (missing extended fields are defaulted). Malformed lines are skipped with
 * their raw text preserved in the result's `malformed` array, and their
 * 1-based line numbers in `malformedLineNumbers` (same order).
 *
 * @param {string} filePath — absolute or project-relative path to learnings.jsonl
 * @returns {Promise<{entries: object[], malformed: string[], malformedLineNumbers: number[]}>}
 */
export async function readLearnings(filePath) {
  if (!existsSync(filePath)) return { entries: [], malformed: [], malformedLineNumbers: [] };
  return parseLearningsText(await readFile(filePath, 'utf8'));
}

/**
 * Read a learnings store together with its generation token (#1486), both
 * from ONE read, so the token describes exactly the records returned.
 *
 * The token is `sha256:<hex>` over the file's full text: any append, rewrite
 * or sweep changes it. An absent store reads as empty text — zero records
 * either way, so the two states share a token.
 *
 * @param {string} filePath
 * @returns {Promise<{entries: object[], malformed: string[], malformedLineNumbers: number[],
 *   generation: string}>}
 */
export async function readLearningsSnapshot(filePath) {
  const raw = existsSync(filePath) ? await readFile(filePath, 'utf8') : '';
  return { ...parseLearningsText(raw), generation: `sha256:${digestSha256(raw)}` };
}

/**
 * Parse learnings JSONL text — the line parser behind {@link readLearnings},
 * exported for callers that must split a header off the text first.
 *
 * A blank line — empty, whitespace-only, or a lone `\r` from a CRLF blank line
 * — carries no record and is skipped, never counted as malformed: malformed
 * lines are kept verbatim by every rewrite and WARNed on every close, so a
 * stray blank would otherwise be reported forever (#1489).
 *
 * A line that parses but is not a JSON object (`null`, `42`, `[]`, `"x"`) is
 * malformed too (#1500): `normalizeLearning` turned it into a record of
 * defaults alone, and every rewrite wrote that invented record back.
 *
 * @param {string} raw
 * @returns {{entries: object[], malformed: string[], malformedLineNumbers: number[]}}
 *   `malformedLineNumbers[i]` is the 1-based line of `malformed[i]` in `raw`
 */
export function parseLearningsText(raw) {
  const entries = [];
  const malformed = [];
  const malformedLineNumbers = [];
  raw.split('\n').forEach((line, i) => {
    if (line.trim().length === 0) return;
    try {
      const parsed = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('not a JSON object');
      }
      entries.push(normalizeLearning(parsed));
    } catch {
      malformed.push(line);
      malformedLineNumbers.push(i + 1);
    }
  });
  return { entries, malformed, malformedLineNumbers };
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
 * The append runs under the store lock ({@link withLearningsLock}): an append
 * that landed between a rewriter's read and its rename was silently lost.
 * Validation runs first, outside the lock — a rejected record never waits.
 *
 * A store whose last line is torn (a crash mid-append left no trailing
 * newline) gets a `\n` written first, inside the same append: without it the
 * new record fused onto the torn text into ONE unparseable line, and no reader
 * ever saw the record (#1489).
 *
 * @param {string} filePath
 * @param {object} entry
 * @param {{ lockTimeoutMs?: number }} [opts] — store-lock wait, default
 *   {@link LEARNINGS_LOCK_TIMEOUT_MS}
 * @returns {Promise<object>} validated entry
 * @throws {LearningsLockError} when the store lock is not acquired (nothing appended)
 */
export async function appendLearning(filePath, entry, { lockTimeoutMs } = {}) {
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
  // The lock path resolution creates the parent directory. The torn-tail check
  // reads inside the lock, so no other writer can change the tail in between.
  await withLearningsLock(
    filePath,
    async () => {
      const lead = (await endsWithoutNewline(filePath)) ? '\n' : '';
      await appendFile(filePath, lead + line, 'utf8');
    },
    { timeoutMs: lockTimeoutMs }
  );
  return validated;
}

/**
 * True when `filePath` is a non-empty file whose last byte is not `\n`. An
 * absent file is `false` (the append creates it). Reads one byte, so the cost
 * does not grow with the store.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function endsWithoutNewline(filePath) {
  let fh;
  try {
    fh = await open(filePath, 'r');
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } finally {
    await fh.close();
  }
}

/**
 * Number of `${basename}.bak-<ISO>` siblings retained after a backup rotation.
 * The atomic rewrite is destructive on a gitignored store (no VCS restore), so
 * a small keep-N window is the last line of defence against an over-eager
 * validating writer (issue #721, the 2026-07-02 incident that destroyed 107
 * live learnings).
 */
const BACKUP_KEEP = 3;

/**
 * Timestamp suffix of a backup sibling of `baseName`, or `null` if `fileName`
 * is not one. Accepts BOTH historical delimiters after `.bak` (#1173): the
 * canonical `-` this module writes, and the legacy `.` that pre-#721 writers
 * (e.g. `learnings.jsonl.bak.evolve-<ts>`) still left on disk in consumer
 * repos — those files were invisible to rotation AND to restore.
 * The delimiter check is what keeps a `${baseName}.backfill-tmp-*` scratch
 * file out: `.bak` followed by `f` is not a backup.
 *
 * REVISIT-TRIGGER for the legacy `.` branch (BV-004): `-` has been the only
 * delimiter any writer emits since #721, so the `.` arm exists purely to keep
 * pre-#721 files on disk visible to rotation and restore. Drop it once no fleet
 * repo reports a `.bak.` sibling — re-measure via the fleet sweep, do not infer
 * it from this repo alone.
 *
 * @param {string} baseName — basename of the store file (e.g. `learnings.jsonl`)
 * @param {string} fileName — sibling filename to classify
 * @returns {string|null} the suffix after the delimiter, or `null`
 */
export function backupSuffixOf(baseName, fileName) {
  const stem = `${baseName}.bak`;
  if (!fileName.startsWith(stem)) return null;
  const delim = fileName[stem.length];
  return delim === '-' || delim === '.' ? fileName.slice(stem.length + 1) : null;
}

/**
 * True when `fileName` is a backup sibling of `baseName` in either delimiter
 * form. Shared by this module's rotation and by `backfill-learnings-from-vault`'s
 * restore sweep so the two can never drift apart again (#1173).
 *
 * @param {string} baseName
 * @param {string} fileName
 * @returns {boolean}
 */
export function isBackupOf(baseName, fileName) {
  return backupSuffixOf(baseName, fileName) !== null;
}

/**
 * Best-effort keep-N rotation of `${baseName}.bak[-.]*` siblings in `dir`.
 * The `.bak-<ISO>` naming uses ISO 8601 with `:`/`.` swapped for `-`, so a
 * plain lexical sort of the SUFFIX is chronological. Sorting on the suffix
 * rather than the whole filename is load-bearing across the two delimiter
 * forms (#1173): `-` (0x2D) sorts before `.` (0x2E), so a whole-name sort
 * would group every legacy dot-form file after every hyphen-form one
 * regardless of age, and rotation would prune only hyphen-form backups.
 * Oldest beyond `keep` are unlinked. Errors PROPAGATE — the single caller
 * wraps this in try/catch so a rotation failure can never abort the rewrite it
 * protects.
 *
 * @param {string} dir — directory holding the store + its backups
 * @param {string} baseName — basename of the store file (e.g. `learnings.jsonl`)
 * @param {number} keep — number of newest backups to retain
 */
async function rotateBackups(dir, baseName, keep = BACKUP_KEEP) {
  const names = await readdir(dir);
  // Lexical sort == chronological for the dash-normalized ISO suffix. Ascending
  // → oldest first, so the head of the list is what we prune.
  const backups = names
    .map((n) => ({ name: n, suffix: backupSuffixOf(baseName, n) }))
    .filter((e) => e.suffix !== null)
    // Sort key strips a leading non-digit label so a labelled legacy suffix
    // (`.bak.evolve-<ts>`) compares against a bare one (`.bak-<ts>`) on the
    // timestamp, not on the label. Ceiling (#1173): this assumes the label
    // PRECEDES the timestamp, which holds for every form observed on disk; a
    // suffix carrying no digits at all sorts oldest and is pruned first.
    // Revisit if a writer ever appends its label after the timestamp.
    .map((e) => ({ ...e, key: e.suffix.replace(/^\D*/, '') }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((e) => e.name);
  const stale = backups.slice(0, Math.max(0, backups.length - keep));
  for (const name of stale) {
    await unlink(path.join(dir, name));
  }
}

/**
 * Atomically rewrite the entire JSONL file from a validated entries array.
 * Use when bulk-updating (prune + decay + new appends all at once). Mirrors
 * the shell behavior of `jq | ... > tmp && mv tmp learnings.jsonl`.
 *
 * Full validation ALWAYS runs first (a single bad entry throws ValidationError
 * before any disk access), preserving the #662 atomicity guarantee.
 *
 * Options (issue #721):
 * - `dryRun` (default `false`): validate the batch but write NOTHING to disk —
 *   no rewrite, no `.bak`. This is the intended path for probing a live store
 *   safely; a validating writer aimed at the live file destroyed 107 learnings
 *   on 2026-07-02 precisely because no such guard existed.
 * - `backup` (default `true`): before the destructive rename, copy the current
 *   file to `${filePath}.bak-<ISO>`, then rotate to keep only the newest
 *   {@link BACKUP_KEEP}. Rotation is best-effort and never blocks the rewrite.
 * - `legacyTolerant` (default `true`, EventDrop #386): this function is a
 *   ROUND-TRIP writer — its usual caller (`sweepExpiredLearnings` /
 *   `pruneLearnings` in `expiry-sweep.mjs`) reads the store with
 *   `readLearnings()` first, and that reader already tolerates a legacy
 *   record missing e.g. `source_session` (WARN, pass through unchanged — see
 *   `normalizeLearning`). Before this option existed, `rewriteLearnings()`
 *   re-validated with the SAME strict gate `appendLearning()` uses for a
 *   brand-new single record, so re-writing the unchanged KEEP batch of a
 *   mechanical sweep could throw on data the reader itself had just accepted
 *   — `sweep-expired-learnings --apply` failed on ANY store holding one such
 *   record, even though the sweep never touches that record's fields. The
 *   default is `true` precisely because the sweep/prune call sites cannot be
 *   changed to opt in explicitly without touching `expiry-sweep.mjs`, which
 *   passes no `legacyTolerant`; every field that genuinely CANNOT survive a
 *   round-trip (a value JSON.stringify drops or coerces, e.g. `undefined`/
 *   `NaN`) is still caught by the #662 checked serializer regardless of this
 *   flag — see {@link serializeLearningLineChecked}. Pass `false` to restore
 *   the fully-strict behaviour from before EventDrop #386.
 * - `malformedLines` (#1489): raw text of store lines that did not parse —
 *   the `malformed` array {@link readLearnings} returns. Written back
 *   verbatim, one per line, AFTER the validated records. A round-trip writer
 *   that rewrites from parsed entries alone deletes every such line with no
 *   archive record (only the keep-3 `.bak` still holds it). OMITTED (the
 *   default), the store's OWN malformed lines are re-read under the lock and
 *   kept — so a caller that forgets this option no longer deletes them
 *   (`export-hw-learnings` did). Pass an array to write exactly those lines;
 *   `[]` is the explicit opt-out that drops them. Each entry must be a
 *   non-empty string without a newline; anything else throws a TypeError
 *   before any disk access, dry run included.
 *
 * @param {string} filePath
 * @param {object[]} entries
 * @param {{dryRun?: boolean, backup?: boolean, legacyTolerant?: boolean, malformedLines?: string[]}} [opts]
 * @returns {Promise<object[]>} validated entries (always returned, even dryRun)
 */
export async function rewriteLearnings(
  filePath,
  entries,
  { dryRun = false, backup = true, legacyTolerant = true, malformedLines } = {}
) {
  if (
    malformedLines !== undefined &&
    (!Array.isArray(malformedLines) ||
      malformedLines.some((l) => typeof l !== 'string' || l.length === 0 || l.includes('\n')))
  ) {
    throw new TypeError('rewriteLearnings: malformedLines must be an array of non-empty single-line strings');
  }
  const validated = entries.map((e) =>
    validateLearning(
      {
        ...e,
        schema_version: e?.schema_version ?? CURRENT_SCHEMA_VERSION,
      },
      { legacyTolerant }
    )
  );
  // Pre-write round-trip self-validation (#662): serialize ALL entries through
  // the checked serializer before touching disk — a single bad entry throws
  // ValidationError and the file is left untouched (atomicity preserved because
  // we validate the full batch first, then write once). This runs even under
  // dryRun, so an invalid entry is still rejected on a dry probe.
  const lines = validated.map((e) => serializeLearningLineChecked(e, { legacyTolerant }));

  // dryRun (#721): validation has run; deliberately do NOT touch disk — no
  // rewrite, no backup — and hand the validated entries back to the caller.
  if (dryRun) return validated;

  // Under the store lock (#1447 point 8) so no append lands between the backup
  // and the rename. The CALLER's read must sit inside the same lock for a
  // read-modify-write to be safe — this call joins it reentrantly.
  await withLearningsLock(filePath, async () => {
    // Default: the store's own malformed lines as they stand right now, read
    // under the lock that guards the rename below.
    const kept =
      malformedLines ??
      (existsSync(filePath) ? parseLearningsText(await readFile(filePath, 'utf8')).malformed : []);
    // Malformed lines last, each newline-terminated: a truncated final line
    // otherwise fuses with the next append into one more unparseable line.
    const body = lines.join('') + kept.map((l) => `${l}\n`).join('');


    // Backup-before-rewrite (#721): snapshot the current store to a timestamped
    // sidecar BEFORE the destructive rename, then prune to keep-N. Only meaningful
    // when the target already exists (a first-time write has nothing to lose).
    if (backup && existsSync(filePath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await copyFile(filePath, `${filePath}.bak-${ts}`);
      try {
        await rotateBackups(path.dirname(filePath), path.basename(filePath));
      } catch {
        // Rotation is best-effort — a stale/undeletable sibling must never abort
        // the rewrite. The fresh backup above is already safely on disk.
      }
    }

    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, filePath);
  });
  return validated;
}
