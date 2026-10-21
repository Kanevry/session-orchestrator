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
import {
  assertStoreRoleUsable,
  resolveStoreRole,
  isCanonicalStore,
  inboxPathFor,
  receiptsPathFor,
  archivePathFor,
} from './store-role.mjs';

// ---------------------------------------------------------------------------
// Inbox store role (GitLab #1516)
// ---------------------------------------------------------------------------
//
// Only the canonical `learnings.jsonl` takes part. A host on the `inbox` role
// (see store-role.mjs) never rewrites it: appends and rewrite-new records go to
// the sibling `learnings-inbox.jsonl`, which readers union in and which the
// `writer` host ingests on its next rewrite, recording each ingested id in
// `learnings-inbox-ingested.jsonl`.
//
// Ceiling (BV-004): the inbox host DROPS updates to existing learnings
// (confidence boosts, decay, prune) — there is no operation-receipt contract,
// only "new id" records travel. The inbox file is never truncated, because
// deleting lines from a merge=union file resurrects them on the next merge;
// receipts hide ingested records instead. Compaction is future work.
// Revisit-trigger: the inbox file exceeds 1 MiB, or a resurrected record is
// measured.

/**
 * Raw text of `filePath`, or `null` when the file does not exist.
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function readRawOrNull(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Ids of every JSONL line in `raw` that parses to an object with a non-empty
 * string `id`. Malformed lines are tolerated (skipped).
 * @param {string|null} raw
 * @returns {Set<string>}
 */
function idsOfJsonl(raw) {
  const ids = new Set();
  if (!raw) return ids;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const rec = JSON.parse(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);
      if (rec && typeof rec.id === 'string' && rec.id.length > 0) ids.add(rec.id);
    } catch {
      // another file's malformed line — not ours to report
    }
  }
  return ids;
}

/**
 * The inbox view of a canonical store: which inbox records are visible beside
 * `liveEntries`. Returns `null` when `filePath` is not the canonical store or
 * no inbox file exists — callers then behave exactly as before #1516.
 *
 * A record is visible iff it has a non-empty string `id` that is not in the
 * live entries, the archive or the receipts, and it is the first inbox record
 * with that id.
 *
 * @param {string} filePath
 * @param {object[]} liveEntries
 * @returns {Promise<null | {visible: object[], visibleIds: Set<string>,
 *   unreceiptedArchivedIds: Set<string>, unreceiptedLiveIds: Set<string>,
 *   counts: {visible: number, hidden: number, malformed: number}, tokenText: string}>}
 */
async function readInboxView(filePath, liveEntries) {
  if (!isCanonicalStore(filePath)) return null;
  const inboxRaw = await readRawOrNull(inboxPathFor(filePath));
  if (inboxRaw === null) return null;
  const receiptsRaw = (await readRawOrNull(receiptsPathFor(filePath))) ?? '';
  const archiveRaw = (await readRawOrNull(archivePathFor(filePath))) ?? '';
  const receiptedIds = idsOfJsonl(receiptsRaw);
  const archivedIds = idsOfJsonl(archiveRaw);
  const excluded = new Set([...receiptedIds, ...archivedIds]);
  for (const e of liveEntries) {
    if (typeof e?.id === 'string' && e.id.length > 0) excluded.add(e.id);
  }
  const parsed = parseLearningsText(inboxRaw);
  const visible = [];
  const visibleIds = new Set();
  // Inbox ids the LOCAL archive hides but no receipt covers: a writer that
  // died between its archive append and its receipt (expiry-sweep.mjs
  // archiveThenRewrite) left them so. The archive is not synced, so the inbox
  // host still shows them; the next writer rewrite receipts them.
  const unreceiptedArchivedIds = new Set();
  // Inbox ids already LIVE but not receipted: a writer that died between its
  // rename and its receipt (rewriteLearnings) left them so. Without a receipt
  // a later removal from live (no archive) would resurrect them from the inbox.
  const liveIds = new Set(
    liveEntries.map((e) => e?.id).filter((id) => typeof id === 'string' && id.length > 0)
  );
  const unreceiptedLiveIds = new Set();
  for (const e of parsed.entries) {
    const id = e?.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (archivedIds.has(id) && !receiptedIds.has(id)) unreceiptedArchivedIds.add(id);
    if (liveIds.has(id) && !receiptedIds.has(id)) unreceiptedLiveIds.add(id);
    if (excluded.has(id) || visibleIds.has(id)) continue;
    visibleIds.add(id);
    visible.push(e);
  }
  return {
    visible,
    visibleIds,
    unreceiptedArchivedIds,
    unreceiptedLiveIds,
    counts: {
      visible: visible.length,
      hidden: parsed.entries.length - visible.length,
      malformed: parsed.malformed.length,
    },
    tokenText: `\u0000${inboxRaw}\u0000${receiptsRaw}\u0000${archiveRaw}`,
  };
}

/**
 * Write inbox receipts (#1516) for `ids` — the single receipt writer, used for
 * ids the writer carries into the live store AND for ids it archives straight
 * from the inbox. The archive is not synced between hosts, so without a
 * receipt an archived inbox record turns visible again on the inbox host.
 *
 * No-op unless `storePath` is the canonical store and its inbox file exists.
 * Only ids present in the inbox file and not yet receipted get a line, so a
 * repeated call never duplicates a receipt. The caller MUST hold the store
 * lock (`withLearningsLock(storePath, …)`): the read-filter-append below is
 * not atomic on its own.
 *
 * @param {string} storePath — the canonical `learnings.jsonl`
 * @param {Iterable<string>} ids
 * @returns {Promise<number>} receipt lines appended
 */
export async function appendInboxReceipts(storePath, ids) {
  if (!isCanonicalStore(storePath)) return 0;
  const inboxRaw = await readRawOrNull(inboxPathFor(storePath));
  if (inboxRaw === null) return 0;
  const inInbox = idsOfJsonl(inboxRaw);
  const receiptsPath = receiptsPathFor(storePath);
  const receipted = idsOfJsonl((await readRawOrNull(receiptsPath)) ?? '');
  const fresh = [...new Set(ids)].filter(
    (id) => typeof id === 'string' && id.length > 0 && inInbox.has(id) && !receipted.has(id)
  );
  if (fresh.length === 0) return 0;
  const ingestedAt = new Date().toISOString();
  await appendWithTornTailGuard(
    receiptsPath,
    fresh.map((id) => `${JSON.stringify({ id, ingested_at: ingestedAt })}\n`).join('')
  );
  return fresh.length;
}

/**
 * Append newline-terminated `text` to `filePath`, first closing a torn last
 * line (#1489). Caller holds the lock guarding `filePath`.
 * @param {string} filePath
 * @param {string} text
 */
async function appendWithTornTailGuard(filePath, text) {
  const lead = (await endsWithoutNewline(filePath)) ? '\n' : '';
  await appendFile(filePath, lead + text, 'utf8');
}

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
 * For the canonical `learnings.jsonl` with a sibling `learnings-inbox.jsonl`
 * (#1516), visible inbox records are appended AFTER the live entries and an
 * `inbox: {visible, hidden, malformed}` count object is added. Inbox malformed
 * lines are never part of `malformed` — they belong to another file. Without
 * an inbox file the result is unchanged (no `inbox` key).
 *
 * @param {string} filePath — absolute or project-relative path to learnings.jsonl
 * @returns {Promise<{entries: object[], malformed: string[], malformedLineNumbers: number[],
 *   inbox?: {visible: number, hidden: number, malformed: number}}>}
 */
export async function readLearnings(filePath) {
  const base = existsSync(filePath)
    ? parseLearningsText(await readFile(filePath, 'utf8'))
    : { entries: [], malformed: [], malformedLineNumbers: [] };
  const view = await readInboxView(filePath, base.entries);
  if (!view) return base;
  return { ...base, entries: [...base.entries, ...view.visible], inbox: view.counts };
}

/**
 * Read a learnings store together with its generation token (#1486), both
 * from ONE read, so the token describes exactly the records returned.
 *
 * The token is `sha256:<hex>` over the file's full text: any append, rewrite
 * or sweep changes it. An absent store reads as empty text — zero records
 * either way, so the two states share a token.
 *
 * With an inbox file beside the canonical store (#1516) the records are the
 * same union {@link readLearnings} returns, and the token also covers the
 * inbox, receipts and archive text, so it changes when any of them changes.
 *
 * @param {string} filePath
 * @returns {Promise<{entries: object[], malformed: string[], malformedLineNumbers: number[],
 *   generation: string, inbox?: {visible: number, hidden: number, malformed: number}}>}
 */
export async function readLearningsSnapshot(filePath) {
  const raw = existsSync(filePath) ? await readFile(filePath, 'utf8') : '';
  const base = parseLearningsText(raw);
  const view = await readInboxView(filePath, base.entries);
  if (!view) return { ...base, generation: `sha256:${digestSha256(raw)}` };
  return {
    ...base,
    entries: [...base.entries, ...view.visible],
    inbox: view.counts,
    generation: `sha256:${digestSha256(raw + view.tokenText)}`,
  };
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
 * A UTF-8 BOM (U+FEFF) in front of the FIRST line — an editor's save — is
 * stripped before parsing, so that line is an entry, not malformed (#1506.5b).
 * A BOM inside the file (line 2+) stays malformed: that is a concatenation
 * artefact the drop-malformed preview reports as `bom`.
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
      const parsed = JSON.parse(i === 0 && line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);
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
 * @throws {LearningsStoreRoleError} canonical store while the host's store role
 *   is invalid (#1516; nothing appended)
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
  // Fail-closed (#1516): an invalid store role refuses before any lock or write.
  assertStoreRoleUsable(filePath);
  // Inbox role (#1516): the canonical store is never written on this host —
  // the record goes to the sibling inbox file under that file's own lock.
  const target =
    isCanonicalStore(filePath) && resolveStoreRole().role === 'inbox'
      ? inboxPathFor(filePath)
      : filePath;
  // The lock path resolution creates the parent directory. The torn-tail check
  // reads inside the lock, so no other writer can change the tail in between.
  await withLearningsLock(target, () => appendWithTornTailGuard(target, line), {
    timeoutMs: lockTimeoutMs,
  });
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
function backupSuffixOf(baseName, fileName) {
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
 * @throws {LearningsStoreRoleError} non-dry rewrite of the canonical store while
 *   the host's store role is invalid (#1516; nothing written)
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

  // Fail-closed (#1516): an invalid store role refuses before any lock or write.
  assertStoreRoleUsable(filePath);
  const canonical = isCanonicalStore(filePath);
  if (canonical && resolveStoreRole().role === 'inbox') {
    await rewriteAsInbox(filePath, validated, lines);
    return validated;
  }

  // Under the store lock (#1447 point 8) so no append lands between the backup
  // and the rename. The CALLER's read must sit inside the same lock for a
  // read-modify-write to be safe — this call joins it reentrantly.
  await withLearningsLock(filePath, async () => {
    const liveRaw = canonical || malformedLines === undefined ? await readRawOrNull(filePath) : null;
    // Default: the store's own malformed lines as they stand right now, read
    // under the lock that guards the rename below.
    const kept =
      malformedLines ?? (liveRaw !== null ? parseLearningsText(liveRaw).malformed : []);
    // Inbox records visible BEFORE this rewrite (#1516); those the batch now
    // carries into the live store get a receipt after the rename.
    const inboxView = canonical
      ? await readInboxView(filePath, liveRaw !== null ? parseLearningsText(liveRaw).entries : [])
      : null;
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

    // Receipts (#1516): an ingested inbox record stays hidden even if a later
    // rewrite drops it from the live store without archiving it. Archived
    // inbox ids a crashed sweep left without a receipt are healed here too,
    // and so are ids a crashed rewrite left live without one (they were live
    // at read time, i.e. ingested — receipting them is correct).
    if (
      inboxView &&
      (inboxView.visibleIds.size > 0 ||
        inboxView.unreceiptedArchivedIds.size > 0 ||
        inboxView.unreceiptedLiveIds.size > 0)
    ) {
      await appendInboxReceipts(filePath, [
        ...validated.map((e) => e.id).filter((id) => inboxView.visibleIds.has(id)),
        ...inboxView.unreceiptedArchivedIds,
        ...inboxView.unreceiptedLiveIds,
      ]);
    }
  });
  return validated;
}

/**
 * The `inbox`-role half of {@link rewriteLearnings} (#1516): the live store is
 * not touched (no backup, no rename). Every validated entry whose id is in
 * neither the live store nor the inbox is appended to the inbox; updates to
 * existing records are dropped (see the BV-004 ceiling at the top of this
 * module) and one stderr notice per call says so.
 *
 * Lock order is store → inbox; `appendLearning` takes only the inbox lock, so
 * the two never wait on each other in reverse.
 *
 * @param {string} filePath — the canonical store
 * @param {object[]} validated
 * @param {string[]} lines — the checked serialized lines, same order
 */
async function rewriteAsInbox(filePath, validated, lines) {
  const inboxPath = inboxPathFor(filePath);
  await withLearningsLock(filePath, () =>
    withLearningsLock(inboxPath, async () => {
      const liveRaw = await readRawOrNull(filePath);
      const known = new Set([
        ...(liveRaw !== null ? parseLearningsText(liveRaw).entries : [])
          .map((e) => e?.id)
          .filter((id) => typeof id === 'string' && id.length > 0),
        ...idsOfJsonl(await readRawOrNull(inboxPath)),
      ]);
      const fresh = [];
      validated.forEach((e, i) => {
        if (typeof e?.id !== 'string' || e.id.length === 0 || known.has(e.id)) return;
        known.add(e.id);
        fresh.push(lines[i]);
      });
      if (fresh.length > 0) await appendWithTornTailGuard(inboxPath, fresh.join(''));
      console.warn(
        `[learnings] store-role inbox: rewrite of ${filePath} skipped ` +
          `(${validated.length - fresh.length} existing records unchanged, ` +
          `${fresh.length} new appended to learnings-inbox.jsonl)`
      );
    })
  );
}
