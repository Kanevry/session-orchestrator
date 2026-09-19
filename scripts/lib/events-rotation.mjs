/**
 * events-rotation.mjs — size-based rotation for .orchestrator/metrics/events.jsonl.
 *
 * Contract: called from the session-start hook. Returns a result object; never
 * throws on fs errors (rotation failure must not break session-start). Uses
 * synchronous fs calls (the hook is short-lived; async adds complexity).
 *
 * Issue #251 (CRITICAL). Rotation fires only at session-start, not per-append —
 * per-append overhead is wasteful given ~6 KiB/day growth.
 *
 * Rename safety (POSIX): atomic rename is safe with in-flight writers. Old fds
 * continue writing to the original inode (now the archive); new writers will
 * open the new file on next append.
 *
 * ## The ledger carries its own break (#1401)
 *
 * Rotation used to be INVISIBLE. It wrote no event and no durable log line —
 * success surfaced only as a `console.error` from the SessionStart hook, whose
 * stderr the harness discards. So a rotation and a DELETED archive produced
 * byte-identical evidence: an events.jsonl that simply starts later than it
 * used to. Measured 2026-09-19: `events.jsonl.1` (53,896 lines, 2026-04-12 →
 * 2026-09-18) was destroyed by a wave subagent's `touch <path> && rm -f <path>`
 * ignore-probe that adopted the existing 10 MB file, and nothing anywhere
 * recorded that the file had ever existed.
 *
 * Since #1401 the FIRST line of every new active file is an
 * `orchestrator.events.rotated` record naming the archive, its size, its line
 * count and its timestamp range. That record is the tombstone: it is what lets
 * {@link readEventsWithRotations} in `events.mjs` report a MISSING archive as a
 * finding instead of silently returning a shorter history.
 *
 * ## Why `_archive/<name>` and not the `.1`..`.N` ring
 *
 * The ring was replaced in #1401, for a structural reason rather than taste:
 * its shift step RENAMES every surviving archive on each rotation, so the
 * `archived_as` pointer above would go stale the moment the next rotation ran
 * and every reader would report a phantom gap. A durable pointer needs a
 * durable name. Three further consequences, all measured or direct:
 *
 *   - `_archive/events-<first>_<last>.jsonl` says what it holds; `.1` does not,
 *     which is how a 5-month ledger read as scratch to the agent that deleted it.
 *   - `.orchestrator/metrics/_archive/` is already gitignored (`.gitignore`) and
 *     already the repo's archive convention for ledger data.
 *   - Census 2026-09-19 @ 8f15f77b — `rg -n 'jsonl\.1|jsonl\.[0-9]' scripts/ hooks/`
 *     (excluding tests) found ZERO code readers of the ring, so nothing in the
 *     codebase breaks. Two live fleet repos DO carry a ~10 MB `events.jsonl.1`
 *     on disk, which is why the READER still reads the legacy ring; this writer
 *     never creates, shifts or prunes one.
 */

import {
  statSync,
  renameSync,
  unlinkSync,
  existsSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import {
  ARCHIVE_DIR_NAME,
  ARCHIVE_NAME_RE,
  ROTATION_EVENT,
  parseEventLines,
  stampEventSchemaVersion,
  summarizeEventRecords,
  validateEventRecord,
} from './events-schema.mjs';

// The archive naming contract (`ROTATION_EVENT`, `ARCHIVE_DIR_NAME`,
// `ARCHIVE_NAME_RE`, `LEGACY_RING_MAX`) is defined in `events-schema.mjs`, the
// zero-fs module the reader in `events.mjs` also loads — see the comment there
// for the hook-closure measurement that put it on that side.

/**
 * `2026-04-12T06:33:01.123Z` → `20260412T063301Z` — filename-safe, and
 * lexicographically ordered, which is what lets the pruner sort archives
 * chronologically by name alone.
 * @param {string} iso
 * @returns {string}
 */
function compactStamp(iso) {
  return iso.replace(/\.\d+/, '').replace(/[-:]/g, '');
}

/**
 * An archive path inside `dir` that does not yet exist.
 *
 * `renameSync` overwrites its destination SILENTLY, so a name collision would
 * destroy an existing archive — the exact loss class #1401 exists to prevent.
 * Exhausting the suffix range therefore THROWS rather than returning a path
 * that would overwrite: the caller's catch turns that into `reason: 'error'`,
 * leaving the active log in place and losing nothing.
 *
 * @param {string} dir
 * @param {string|null} firstTs
 * @param {string|null} lastTs
 * @returns {string}
 */
function uniqueArchivePath(dir, firstTs, lastTs) {
  const from = firstTs ? compactStamp(firstTs) : 'unknown';
  const to = lastTs ? compactStamp(lastTs) : compactStamp(new Date().toISOString());
  const base = `events-${from}_${to}`;
  let candidate = path.join(dir, `${base}.jsonl`);
  // Ceiling (BV-004): 999 same-range archives. Rotation fires 2-3x/year at the
  // measured ~6 KiB/day growth, and the range is content-derived, so a second
  // collision already implies something is re-rotating identical content.
  // Revisit if a `pruned`-less archive dir is ever seen holding a `-3` suffix.
  for (let n = 2; existsSync(candidate); n += 1) {
    if (n > 999) {
      throw new Error(`events-rotation: no free archive name for ${base} in ${dir}`);
    }
    candidate = path.join(dir, `${base}-${n}.jsonl`);
  }
  return candidate;
}

/**
 * Enforce `maxBackups` over the archives in `dir`, oldest first.
 *
 * The cap is kept rather than dropped because `events-rotation.max-backups` is
 * a live, documented config key: a key whose reader silently stops enforcing it
 * is the "config key nobody produces" defect in reverse. At the measured
 * rotation rate `max-backups: 5` is roughly two years of history.
 *
 * Only names matching {@link ARCHIVE_NAME_RE} are eligible, and the archive
 * just written is never a candidate. A failed unlink is swallowed: leaving one
 * archive too many is strictly better than aborting a completed rotation.
 *
 * @param {string} dir
 * @param {number} maxBackups
 * @param {string} keepPath — absolute path of the archive written by this run.
 * @returns {string[]} absolute paths actually deleted.
 */
function pruneArchives(dir, maxBackups, keepPath) {
  const pruned = [];
  let names;
  try {
    names = readdirSync(dir).filter((name) => ARCHIVE_NAME_RE.test(name)).sort();
  } catch {
    return pruned;
  }
  // `sort()` orders by the leading `YYYYMMDDTHHMMSSZ` first stamp, i.e. oldest
  // first. An `unknown_` prefix sorts AFTER every digit, so an archive whose
  // range could not be derived is treated as newest and outlives the dated ones
  // — conservative on purpose: never delete the file you understand least.
  const excess = names.length - maxBackups;
  for (let i = 0; i < excess; i += 1) {
    const victim = path.join(dir, names[i]);
    if (victim === keepPath) continue;
    try {
      unlinkSync(victim);
      pruned.push(victim);
    } catch {
      /* keep it — an un-prunable archive is not a rotation failure */
    }
  }
  return pruned;
}

/**
 * Rotate the events log if it exceeds `maxSizeMb`.
 *
 * On rotation the active file is renamed into
 * `<dir>/_archive/events-<firstTs>_<lastTs>.jsonl` and an
 * `orchestrator.events.rotated` record is appended to the now-absent active
 * path, making it that file's first line. Archives beyond `maxBackups` are
 * pruned (oldest first) and named in the record's `pruned` field, so the
 * deletion is itself in the ledger.
 *
 * The record is written SYNCHRONOUSLY here rather than via `emitEvent()` for
 * two reasons: it must land between the rename and any other writer's first
 * append to be the first line, and `emitEvent()`'s async correlation lookups
 * (session lock, wave manifest) describe a session, not a file operation. It
 * still goes through the schema module's own stamper and validator, so it is
 * not a raw writer inventing a shape.
 *
 * @param {object} opts
 * @param {string}  opts.logPath     — absolute path to `events.jsonl`
 * @param {number}  opts.maxSizeMb   — integer 1..1024
 * @param {number}  opts.maxBackups  — integer 1..20
 * @param {boolean} opts.enabled     — if false, returns early
 * @returns {{rotated: boolean, reason?: string, archivedAs?: string, sizeBefore?: number,
 *            maxBackups?: number, lines?: number, firstTs?: string|null, lastTs?: string|null,
 *            malformedLines?: number, pruned?: string[], recordWritten?: boolean, error?: string}}
 */
export function maybeRotate({ logPath, maxSizeMb, maxBackups, enabled } = {}) {
  // --- Input validation (throw — programmer error, not runtime fs failure) ---
  if (typeof logPath !== 'string' || logPath.length === 0) {
    throw new Error(`events-rotation: logPath must be a non-empty string, got ${typeof logPath}`);
  }
  if (!Number.isInteger(maxSizeMb) || maxSizeMb < 1 || maxSizeMb > 1024) {
    throw new Error(`events-rotation: maxSizeMb must be integer 1..1024, got ${maxSizeMb}`);
  }
  if (!Number.isInteger(maxBackups) || maxBackups < 1 || maxBackups > 20) {
    throw new Error(`events-rotation: maxBackups must be integer 1..20, got ${maxBackups}`);
  }

  if (enabled === false) {
    return { rotated: false, reason: 'disabled' };
  }

  // Set once the rename has happened. After that point the 10 MB HAS moved, so
  // a later failure must never be reported as `rotated: false` — a caller that
  // believes nothing happened is exactly how a rotation goes unnoticed.
  let archivedAs = null;
  let sizeBefore = 0;

  try {
    if (!existsSync(logPath)) {
      return { rotated: false, reason: 'no-file' };
    }

    sizeBefore = statSync(logPath).size;
    const threshold = maxSizeMb * 1024 * 1024;
    if (sizeBefore < threshold) {
      return { rotated: false, reason: 'under-threshold' };
    }

    // Read BEFORE the rename: the content is what names the archive. Cost
    // ceiling (BV-004): one full read of a file at the rotation threshold —
    // ~50 ms and ~40 MB transient at the default 10 MB cap, paid 2-3x/year.
    // Revisit if `max-size-mb` is ever raised past ~100.
    const { records, malformedLines } = parseEventLines(readFileSync(logPath, 'utf8'));
    const { firstTs, lastTs } = summarizeEventRecords(records);
    const lines = records.length + malformedLines;

    const archiveDir = path.join(path.dirname(logPath), ARCHIVE_DIR_NAME);
    mkdirSync(archiveDir, { recursive: true });
    const destination = uniqueArchivePath(archiveDir, firstTs, lastTs);

    renameSync(logPath, destination);
    archivedAs = destination;

    const pruned = pruneArchives(archiveDir, maxBackups, archivedAs);

    // The tombstone. `first_ts` / `last_ts` are `null` — present, never absent —
    // when the archive held no parseable timestamp: a reader must be able to
    // tell "range unknown" from "field not written by this version".
    const record = stampEventSchemaVersion({
      timestamp: new Date().toISOString(),
      event: ROTATION_EVENT,
      archived_as: archivedAs,
      size_before: sizeBefore,
      lines,
      first_ts: firstTs,
      last_ts: lastTs,
      malformed_lines: malformedLines,
      ...(pruned.length > 0 ? { pruned } : {}),
    });
    const verdict = validateEventRecord(record);
    let recordWritten = false;
    if (verdict.valid) {
      appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
      recordWritten = true;
    }

    return {
      rotated: true,
      archivedAs,
      sizeBefore,
      maxBackups,
      lines,
      firstTs,
      lastTs,
      malformedLines,
      pruned,
      recordWritten,
      ...(recordWritten ? {} : { error: `invalid rotation record: ${verdict.errors.join('; ')}` }),
    };
  } catch (err) {
    const message = err?.message ?? String(err);
    // Never throw — rotation failure must not break session-start. But once the
    // rename landed, the archive EXISTS and the caller must hear about it.
    if (archivedAs !== null) {
      return { rotated: true, archivedAs, sizeBefore, maxBackups, recordWritten: false, error: message };
    }
    return { rotated: false, reason: 'error', error: message };
  }
}
