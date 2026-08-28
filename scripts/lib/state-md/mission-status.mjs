/**
 * Mission-status helpers for STATE.md.
 *
 * Handles both the frontmatter `mission-status:` block-seq field and the
 * `## Mission Status` body section (body-level per-task status lines).
 *
 * Pure functions — no file I/O.
 *
 * Plus on-disk wrappers (`writeMissionStatusOnDisk`, `setMissionStatusOnDisk`)
 * added for PRD 2026-05-22 § 4 Pattern 1 (issue #518). The on-disk wrappers
 * delegate to the pure helpers above and route the read+write cycle through
 * `writeStateMd` from frontmatter-mutators.mjs, which acquires
 * `.orchestrator/state.lock` for mechanical serialization (PSA-004).
 *
 * #1104 resolved the two remaining recovery limits with **Option 1 (skip-and-warn)
 * + Option 2 (id gate)**: body recovery now skips the individual lines it cannot
 * parse instead of abandoning the section at the first one, reports them through
 * `recoverFrontmatterMissionStatusDetailed`, and `setMissionStatusOnDisk` — the
 * layer that already does I/O, so the pure contract above survives — turns a
 * non-empty skip list into one stderr WARN. `setMissionStatus` refuses a task id
 * the recovery grammar cannot read, so the writer stops manufacturing the very
 * lines the recovery has to skip.
 */

import { parseStateMd, serializeStateMd } from './yaml-parser.mjs';
import { updateFrontmatterFields, writeStateMd } from './frontmatter-mutators.mjs';

const MISSION_STATUS_HEADING_RE = /^##\s+Mission Status\s*$/;
const WRITER_TIMESTAMP_SOURCE = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';
const WRITER_TIMESTAMP_RE = new RegExp(`^${WRITER_TIMESTAMP_SOURCE}$`);

/**
 * Task-ID grammar, shared by THREE surfaces on purpose: the body writer's own
 * `taskId` gate in `setMissionStatus` (#1104 Option 2), the body recovery regex
 * below, and the frontmatter validator in `parseMissionStatusStrict`. ONE source:
 * a reader whose ID grammar is narrower than the writer's drops entries the
 * writer just produced — the two-surface divergence class this module exists to
 * close (#960/#1084/#1104). Accepts `m-1`, `docs-2`, `w2-1`, `w2-a-10`; rejects
 * `M-1`, `m1`, `Docs_2`, `docs`.
 *
 * The example list is measured, not asserted: this docblock advertised `w2-a10`
 * until #1104, and the grammar rejects it — every segment but the last must be
 * separated by `-`, so `a10` is not a segment boundary. Harmless while the
 * grammar only gated the READER; load-bearing since `setMissionStatus` gates its
 * `taskId` on it, where a wrong example buys a silent no-op. Pinned by
 * `tests/lib/state-md-mission-status.test.mjs` ("refuses an id its own recovery
 * cannot read").
 */
const MISSION_STATUS_ID_SOURCE = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\\d+';
const MISSION_STATUS_ID_RE = new RegExp(`^${MISSION_STATUS_ID_SOURCE}$`);
const CANONICAL_MISSION_STATUS_ENTRY_RE = new RegExp(
  `^- (${MISSION_STATUS_ID_SOURCE}): (.*) \\(updated (${WRITER_TIMESTAMP_SOURCE})\\)$`
);

/**
 * The 5-value mission-status vocabulary (`skills/session-plan/SKILL.md` §
 * Mission-Status Enum). A VOCABULARY, not a state machine and not a gate: an
 * out-of-enum value is reported as a WARNING by `parseMissionStatusStrict` and
 * still returned by `parseMissionStatus`, because dropping it on the read side
 * would hide on the frontmatter surface exactly what `setMissionStatus`
 * deliberately makes visible on both.
 *
 * @type {readonly string[]}
 */
export const MISSION_STATUS_VALUES = Object.freeze([
  'brainstormed',
  'validated',
  'in-dev',
  'testing',
  'completed',
]);

/** Scalar shapes this YAML subset can produce for an entry field. */
function isScalarField(value) {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Validates ONE `mission-status` entry.
 *
 * Hard requirements are exactly the fields a consumer cannot work without: the
 * entry must be a mapping, `id` must match the writer's own ID grammar, and
 * `status` must be a non-empty string. `task` and `wave` are OPTIONAL — the
 * recovery path in `recoverFrontmatterMissionStatus` emits truthful partial
 * `{ id, status }` entries on purpose, and requiring the metadata here would
 * delete them on read (measured: `setMissionStatus` on a legacy body yields
 * `[{"id":"docs-2","status":"completed"}]`). When present they must still be
 * scalars — an object or array there is a parse gone sideways, and renders as
 * `[object Object]` in the vault rollup table.
 *
 * @param {unknown} entry
 * @returns {{ valid: true, warning: string|null }|{ valid: false, reason: string }}
 */
function validateMissionStatusEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { valid: false, reason: 'not-a-mapping' };
  }
  if (typeof entry.id !== 'string' || !MISSION_STATUS_ID_RE.test(entry.id)) {
    return { valid: false, reason: 'invalid-id' };
  }
  if (typeof entry.status !== 'string' || entry.status.trim() === '') {
    return { valid: false, reason: 'invalid-status' };
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'task') && !isScalarField(entry.task)) {
    return { valid: false, reason: 'invalid-task' };
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'wave') && !isScalarField(entry.wave)) {
    return { valid: false, reason: 'invalid-wave' };
  }
  return {
    valid: true,
    warning: MISSION_STATUS_VALUES.includes(entry.status) ? null : 'status-not-in-enum',
  };
}

/**
 * Finds the first exact `## Mission Status` section and its closing heading.
 *
 * @param {string[]} lines
 * @returns {{ headingIdx: number, sectionEnd: number }|null}
 */
function findMissionStatusSection(lines) {
  if (!Array.isArray(lines)) return null;
  const headingIdx = lines.findIndex((line) => MISSION_STATUS_HEADING_RE.test(line));
  if (headingIdx === -1) return null;

  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  return { headingIdx, sectionEnd };
}

function isWriterTimestamp(timestamp) {
  if (!WRITER_TIMESTAMP_RE.test(timestamp)) return false;
  const parsed = new Date(timestamp);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === timestamp;
}

/**
 * Parses the optional `mission-status:` block from a STATE.md frontmatter object
 * (as returned by `parseStateMd(...).frontmatter`), keeping only entries that pass
 * `validateMissionStatusEntry`.
 *
 * Returns `null` when the `mission-status` key is absent (backward-compat: pre-#340
 * STATE.md files) or holds a non-array. Returns `[]` when the key is present but the
 * value is an empty array — or when every entry in it was rejected.
 *
 * The rejects are NOT surfaced here (the return type is unchanged for existing
 * callers). Use `parseMissionStatusStrict` when you need to report them; a caller
 * that only counts or renders entries wants the clean list.
 *
 * @param {object} frontmatter
 * @returns {object[]|null}
 */
export function parseMissionStatus(frontmatter) {
  return parseMissionStatusStrict(frontmatter).items;
}

/**
 * `parseMissionStatus` with its rejects and vocabulary warnings attached.
 *
 * Before #1111 nothing in this repo validated entry shape, so a malformed entry —
 * a flow-mapping list item mangled into a key literally named `{ id`, a bare
 * scalar left in the array, an entry with no `status` — reached session-end Phase
 * 1.9/1.10 and `vault-status/narrative-mirror.mjs` as a plausible-looking task and
 * was counted. `items` is what a consumer may trust; `invalid` is what a reporter
 * must show instead of silently dropping.
 *
 * The `{ id` mangling itself no longer originates HERE: yaml-parser.mjs now parses
 * a single-line flow mapping into the same object a block item yields. This
 * validator stays the reader-side net for every OTHER source of a malformed entry
 * — a hand-built array passed to `writeMissionStatus`, a future parser change, a
 * third-party writer — none of which the parser fix can speak for.
 *
 * - `items` — mirrors `parseMissionStatus` exactly (`null` when the key is absent
 *   or not an array; otherwise the entries that validated, in source order).
 * - `invalid` — `{ index, reason }` per rejected entry, `index` addressing the RAW
 *   array. Reasons: `not-a-mapping`, `invalid-id`, `invalid-status`, `invalid-task`,
 *   `invalid-wave`.
 * - `warnings` — `{ index, reason }` for entries that are structurally fine but
 *   suspect: `duplicate-id` (a second entry with an id already seen — the sync in
 *   `syncFrontmatterMissionStatus` only ever updates the FIRST match, so the copy
 *   keeps a stale status forever and Phase 1.10 counts the task twice) and
 *   `status-not-in-enum`. Both stay in `items` on purpose.
 *
 * @param {object} frontmatter
 * @returns {{ items: object[]|null, invalid: Array<{index: number, reason: string}>, warnings: Array<{index: number, reason: string}> }}
 */
export function parseMissionStatusStrict(frontmatter) {
  const empty = { items: null, invalid: [], warnings: [] };
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return empty;
  }
  if (!Object.prototype.hasOwnProperty.call(frontmatter, 'mission-status')) {
    return empty;
  }
  const raw = frontmatter['mission-status'];
  if (!Array.isArray(raw)) {
    // Present but not an array (e.g. null scalar from empty key) — treat as absent
    return empty;
  }

  // A fresh array (never `raw` itself) keeps the shallow-copy contract: callers may
  // push/splice their result without touching the parsed frontmatter.
  const items = [];
  const invalid = [];
  const warnings = [];
  const seenIds = new Set();
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    const verdict = validateMissionStatusEntry(entry);
    if (!verdict.valid) {
      invalid.push({ index, reason: verdict.reason });
      continue;
    }
    if (seenIds.has(entry.id)) {
      warnings.push({ index, reason: 'duplicate-id' });
    } else {
      seenIds.add(entry.id);
    }
    if (verdict.warning !== null) {
      warnings.push({ index, reason: verdict.warning });
    }
    items.push(entry);
  }
  return { items, invalid, warnings };
}

/**
 * Writes (or replaces) the `mission-status:` field in STATE.md frontmatter.
 *
 * - When `missionStatusArray` is an empty array, writes `mission-status:` with an
 *   empty block sequence — preserving the key so consumers know the feature is active.
 * - When `missionStatusArray` is null or undefined, DELETES the key (opt-out / reset).
 * - Works on string input (pure — no file I/O). Returns the updated STATE.md contents.
 * - No-ops if `contents` has no parseable frontmatter (returns input unchanged).
 *
 * Individual entry objects are expected to carry `{ id, task, wave, status }`. This
 * WRITER does not enforce that shape — whatever it is handed is serialized, so a
 * malformed entry lands visibly in the file rather than being dropped on the way in.
 * The READER is where the shape is checked since #1111: `parseMissionStatus` returns
 * only entries that validate, and `parseMissionStatusStrict` reports the rest.
 *
 * @param {string} contents
 * @param {object[]|null|undefined} missionStatusArray
 * @returns {string}
 */
export function writeMissionStatus(contents, missionStatusArray) {
  if (missionStatusArray === null || missionStatusArray === undefined) {
    return updateFrontmatterFields(contents, { 'mission-status': null });
  }
  if (!Array.isArray(missionStatusArray)) {
    return contents;
  }
  // isBlockSeqOfMappings requires at least 1 entry to classify as block-seq; for an empty
  // array we store it as an empty block seq by treating it as a plain empty array which
  // serializeScalar renders as `[]`.  For non-empty arrays of objects, use the block format.
  return updateFrontmatterFields(contents, { 'mission-status': missionStatusArray.slice() });
}

/**
 * Mirrors `status` onto the frontmatter `mission-status` entry whose `id` matches
 * `taskId`, returning a NEW frontmatter object (copy-on-write at object, array and
 * entry level — the input is never mutated, which keeps `parseMissionStatus`'s
 * shallow-copy contract intact for anything else holding the same nested entries).
 *
 * UPDATE-ONLY by design: when the key is absent, is not an array, or holds no
 * matching entry in a populated array, the frontmatter is returned unchanged. It is
 * deliberately neither created nor an error, because `setMissionStatus(contents,
 * taskId, status)` knows only `id` and `status` — it lacks the `task` and `wave`
 * fields a full entry carries, so a synthesised entry would be shape-invalid yet look
 * authoritative to frontmatter consumers such as `vault-status/narrative-mirror.mjs`.
 * Throwing is likewise excluded by the never-throw contract of `setMissionStatus`.
 *
 * An empty array is recovered from the final body by
 * `recoverFrontmatterMissionStatus`, which persists only the truthful `id` and
 * `status` values available there. It does not fabricate absent metadata.
 *
 * `status` is mirrored verbatim without an enum check on purpose: gating it would
 * reintroduce the exact divergence (body says X, frontmatter says Y) this sync exists
 * to remove. An out-of-enum value therefore lands visibly on BOTH surfaces rather than
 * being silently rejected on one.
 *
 * There is deliberately NO transition validator behind this. A `mission-status-schema.mjs`
 * once existed (#340) offering `isValidMissionStatusTransition`; it was never wired and
 * was removed, because the only guard form it enabled — read the current status, reject a
 * disallowed transition — would reject legitimate live writes. Measured against a copy of
 * this repo's own STATE.md carrying 24 items: 12 had no body entry yet (current status
 * reads `null`, so every transition out of them is "invalid"), and the routine
 * `in-dev` → `completed` write is not in the strict forward chain either — 18 of 24
 * writes would have been refused. The enum is a vocabulary, not a state machine.
 *
 * @param {object} frontmatter
 * @param {string} taskId
 * @param {string} status
 * @returns {object}
 */
function syncFrontmatterMissionStatus(frontmatter, taskId, status) {
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return frontmatter;
  }
  const raw = frontmatter['mission-status'];
  if (!Array.isArray(raw)) return frontmatter;
  const idx = raw.findIndex(
    (e) => e !== null && typeof e === 'object' && !Array.isArray(e) && e.id === taskId
  );
  if (idx === -1) return frontmatter;
  const entries = raw.slice();
  entries[idx] = { ...raw[idx], status };
  return { ...frontmatter, 'mission-status': entries };
}

/**
 * `recoverFrontmatterMissionStatus` with the lines it declined attached.
 *
 * Mirrors body-only task IDs into the frontmatter `mission-status` registry as
 * partial `{ id, status }` entries. This is a SUPERSET merge: existing entries are
 * never rewritten or reordered, so their full metadata (`task`, `wave`) survives —
 * only IDs absent from the registry are appended.
 *
 * It must not be gated on an EMPTY registry. Recovering only from empty froze the
 * registry after its first recovery: the sync path (`syncFrontmatterMissionStatus`)
 * is update-only, so every subsequently added task ID was never mirrored again, and
 * Phase 1.9/1.10 read a plausible undercount instead of the obvious zero. That is
 * #1084 one write later — measured m-1/m-2/m-3 in the body against `[m-1]` in the
 * frontmatter.
 *
 * **#1104 decision — Option 1 (skip-and-warn) + Option 2 (id gate).** The parse was
 * all-or-nothing until #1104: ONE nonblank line that was not a unique canonical
 * writer bullet aborted the whole merge. Measured over all 16 host-local
 * `<repo>/.claude/STATE.md` (2026-08-21), exactly one repo carried the #1084 shape,
 * and its bullets were hand-written (`- m-1 D1 ADR-Delta: completed`, no
 * `(updated <ISO>)`), so the abort fired on line 1 and the class the recovery was
 * built for was served 0 of 1.
 * The abort is now per LINE: a line that does not parse is skipped and reported here,
 * every other line still recovers. Nothing is ever fabricated — a skipped line
 * contributes no entry, exactly as before. Option 2 is the other half, in
 * `setMissionStatus`: the writer now refuses an id its own recovery cannot read, so
 * the writer can no longer manufacture the lines this function has to skip.
 *
 * Option 3 (WARN) is honoured at the seam rather than here: this function stays pure,
 * and `setMissionStatusOnDisk` — which already does I/O — turns a non-empty `skipped`
 * into ONE stderr WARN. That is what makes "recovery declined N lines" distinguishable
 * from "nothing to do", the third #1104 acceptance criterion.
 *
 * `skipped` reasons, in evaluation order per line:
 * - `non-canonical` — not a writer bullet at all: prose, an id outside
 *   `MISSION_STATUS_ID_SOURCE` (`Docs_2`, `m_1`), or a timestamp of the wrong SHAPE
 *   (`(updated yesterday)`). This is the legacy hand-written class.
 * - `unsafe-status` — canonical shape, but the status is empty or carries a `|`,
 *   which the block-seq serializer cannot round-trip.
 * - `invalid-timestamp` — right shape, not a real instant (e.g. `2026-02-30T…`).
 * - `duplicate-id` — a SECOND bullet for an id already recovered from this section.
 *   The FIRST wins, matching `setMissionStatus`/`readMissionStatus`, which both
 *   operate on the first matching bullet.
 *
 * @param {object} frontmatter
 * @param {string} body
 * @returns {{ frontmatter: object, skipped: Array<{line: string, reason: string}> }}
 */
export function recoverFrontmatterMissionStatusDetailed(frontmatter, body) {
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return { frontmatter, skipped: [] };
  }
  const raw = frontmatter['mission-status'];
  if (!Array.isArray(raw) || typeof body !== 'string') return { frontmatter, skipped: [] };

  const lines = body.split('\n');
  const section = findMissionStatusSection(lines);
  if (section === null) return { frontmatter, skipped: [] };

  const entries = [];
  const ids = new Set();
  const skipped = [];
  for (let i = section.headingIdx + 1; i < section.sectionEnd; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;

    const match = CANONICAL_MISSION_STATUS_ENTRY_RE.exec(line);
    if (match === null) {
      skipped.push({ line, reason: 'non-canonical' });
      continue;
    }
    // A status can never contain `\n` here — `line` came out of a `\n` split.
    const [, id, status, timestamp] = match;
    if (status.length === 0 || status.includes('|')) {
      skipped.push({ line, reason: 'unsafe-status' });
      continue;
    }
    if (!isWriterTimestamp(timestamp)) {
      skipped.push({ line, reason: 'invalid-timestamp' });
      continue;
    }
    if (ids.has(id)) {
      skipped.push({ line, reason: 'duplicate-id' });
      continue;
    }
    ids.add(id);
    entries.push({ id, status });
  }

  const known = new Set(
    raw
      .filter((e) => e !== null && typeof e === 'object' && !Array.isArray(e))
      .map((e) => e.id)
  );
  const added = entries.filter((e) => !known.has(e.id));
  if (added.length === 0) return { frontmatter, skipped };
  return { frontmatter: { ...frontmatter, 'mission-status': [...raw, ...added] }, skipped };
}

/**
 * The merge result alone — see `recoverFrontmatterMissionStatusDetailed` for the
 * contract. Internal callers that cannot report skipped lines (the pure
 * `setMissionStatus` path) use this shape.
 *
 * @param {object} frontmatter
 * @param {string} body
 * @returns {object}
 */
function recoverFrontmatterMissionStatus(frontmatter, body) {
  return recoverFrontmatterMissionStatusDetailed(frontmatter, body).frontmatter;
}

function serializeMissionStatusUpdate(frontmatter, body) {
  return serializeStateMd({
    frontmatter: recoverFrontmatterMissionStatus(frontmatter, body),
    body,
  });
}

/**
 * Sets (or updates) the mission status for a single task in the `## Mission Status` body
 * section of STATE.md. Creates the section if it does not exist.
 *
 * Format of each entry in the section:
 *   - <taskId>: <status> (updated <ISO timestamp>)
 *
 * Also mirrors `status` into the frontmatter `mission-status` entry with the same `id`
 * (issue #960 — one writer, two sinks). The body section is what the coordinator writes
 * during a wave; the frontmatter array is what `parseMissionStatus` consumers read
 * (`vault-status/narrative-mirror.mjs`, session-end Phase 1.9/1.10). Before this sync the
 * live writer and the reader sat on different surfaces and drifted apart in both
 * directions. A legacy empty registry is recovered from canonical body bullets as
 * partial `{ id, status }` entries, which lets frontmatter readers classify the work
 * without fabricated metadata. Since #1104 that recovery skips only the lines it cannot
 * parse instead of abandoning the whole section; other unmatched populated entries remain
 * update-only. See `syncFrontmatterMissionStatus` and
 * `recoverFrontmatterMissionStatusDetailed`.
 *
 * **#1104 Option 2 — `taskId` is gated on the reader's own grammar**
 * (`MISSION_STATUS_ID_SOURCE`: lowercase alphanumeric segments joined by `-`, ending in
 * `-<digits>` — `m-1`, `docs-2`, `w2-1`; NOT `M-1`, `m1`, `Docs_2`, `w2-a10`). Until #1104 this
 * gate was `typeof taskId === 'string'`, so the writer produced body lines
 * (`- Docs_2: in-dev (updated …)`) that its OWN recovery could never read back — the
 * mechanism behind "setMissionStatus in a loop seeds only the body". A non-conforming id
 * now returns `contents` unchanged rather than writing an unreadable line: refusing to
 * write is recoverable, writing a line no reader accepts is not.
 *
 * Pure function — no I/O. Returns original `contents` unchanged on bad input.
 *
 * @param {string} contents - Current STATE.md file contents (string)
 * @param {string} taskId - Task identifier matching `MISSION_STATUS_ID_SOURCE` (e.g. 'm-1', 'docs-2')
 * @param {string} status - One of: brainstormed | validated | in-dev | testing | completed
 * @returns {string}
 */
export function setMissionStatus(contents, taskId, status) {
  if (typeof contents !== 'string') return contents;
  if (!taskId || typeof taskId !== 'string') return contents;
  if (!MISSION_STATUS_ID_RE.test(taskId)) return contents;
  if (!status || typeof status !== 'string') return contents;
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;

  // Computed once so every return path below emits the same synced frontmatter.
  const frontmatter = syncFrontmatterMissionStatus(parsed.frontmatter, taskId, status);

  const timestamp = new Date().toISOString();
  const bullet = `- ${taskId}: ${status} (updated ${timestamp})`;
  const lines = parsed.body.split('\n');

  const section = findMissionStatusSection(lines);
  if (section === null) {
    // Section does not exist — append it at the end
    let bodyOut = parsed.body;
    if (!bodyOut.endsWith('\n')) bodyOut += '\n';
    bodyOut += `\n## Mission Status\n\n${bullet}\n`;
    return serializeMissionStatusUpdate(frontmatter, bodyOut);
  }

  const { headingIdx, sectionEnd } = section;

  // Look for an existing entry with this taskId within the section
  const entryRe = new RegExp(`^-\\s+${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`);
  let existingIdx = -1;
  for (let i = headingIdx + 1; i < sectionEnd; i++) {
    if (entryRe.test(lines[i])) {
      existingIdx = i;
      break;
    }
  }

  if (existingIdx !== -1) {
    // Replace existing entry in-place
    lines[existingIdx] = bullet;
  } else {
    // Append after the last bullet in this section (or right after heading if empty)
    let lastBulletIdx = -1;
    for (let i = headingIdx + 1; i < sectionEnd; i++) {
      if (/^-\s+/.test(lines[i])) lastBulletIdx = i;
    }
    if (lastBulletIdx !== -1) {
      lines.splice(lastBulletIdx + 1, 0, bullet);
    } else {
      // No bullets yet — insert after heading with blank line
      let insertAt = headingIdx + 1;
      while (insertAt < sectionEnd && lines[insertAt].trim() === '') insertAt++;
      const before = lines.slice(0, headingIdx + 1);
      const after = lines.slice(insertAt);
      const rebuilt = [...before, '', bullet, ...after];
      return serializeMissionStatusUpdate(frontmatter, rebuilt.join('\n'));
    }
  }

  return serializeMissionStatusUpdate(frontmatter, lines.join('\n'));
}

/**
 * Reads the current mission status for a single task from the `## Mission Status` body
 * section of STATE.md.
 *
 * Returns the full status string before a current-writer timestamp (e.g. `'in-dev'`
 * or `'needs manual testing'`). For legacy body lines that lack that exact form, falls
 * back to the first status token. Returns `null` if the task is not found or the
 * section does not exist. Never throws — returns `null` on any bad input.
 *
 * @param {string} contents - Current STATE.md file contents (string)
 * @param {string} taskId - Task identifier to look up (e.g. 'm-1')
 * @returns {string|null}
 */
export function readMissionStatus(contents, taskId) {
  if (typeof contents !== 'string') return null;
  if (!taskId || typeof taskId !== 'string') return null;
  const parsed = parseStateMd(contents);
  if (parsed === null) return null;

  const lines = parsed.body.split('\n');
  const section = findMissionStatusSection(lines);
  if (section === null) return null;

  // Prefer the full current-writer status, including internal spaces.
  const escapedId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const writerEntryRe = new RegExp(
    `^- ${escapedId}: (.*) \\(updated ${WRITER_TIMESTAMP_SOURCE}\\)$`
  );
  for (let i = section.headingIdx + 1; i < section.sectionEnd; i++) {
    const match = writerEntryRe.exec(lines[i]);
    if (match) return match[1];
  }

  // Reader-only legacy compatibility. Recovery still accepts canonical bullets only —
  // since #1104 it skips the others per line instead of abandoning the section.
  const legacyEntryRe = new RegExp(`^-\\s+${escapedId}:\\s+(\\S+)`);
  for (let i = section.headingIdx + 1; i < section.sectionEnd; i++) {
    const match = legacyEntryRe.exec(lines[i]);
    if (match) return match[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// On-disk wrappers (PRD 2026-05-22 § 4 — Pattern 1, issue #518)
// ---------------------------------------------------------------------------

/**
 * Lock-guarded `writeMissionStatus` — replaces the frontmatter `mission-status`
 * block-seq under the state-lock.
 *
 * @param {string|undefined} repoRoot
 * @param {object[]|null|undefined} missionStatusArray
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 */
export async function writeMissionStatusOnDisk(repoRoot, missionStatusArray, opts = {}) {
  return writeStateMd(
    repoRoot,
    (contents) => writeMissionStatus(contents, missionStatusArray),
    opts
  );
}

/**
 * Lock-guarded `setMissionStatus` — sets or replaces a single task entry in
 * the `## Mission Status` body section under the state-lock.
 *
 * This is the #1104 Option-3 seam: `recoverFrontmatterMissionStatus` is pure and
 * cannot report the body lines it skipped, so the wrapper that already does I/O
 * emits ONE stderr WARN naming the count and the first reason. Without it a
 * declined recovery is byte-identical to "nothing to recover" — the silence the
 * issue's third acceptance criterion is about. It never blocks the write: the
 * skipped lines are pre-existing body content, not a defect in THIS write.
 *
 * @param {string|undefined} repoRoot
 * @param {string} taskId
 * @param {string} status   brainstormed | validated | in-dev | testing | completed
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 */
export async function setMissionStatusOnDisk(repoRoot, taskId, status, opts = {}) {
  return writeStateMd(
    repoRoot,
    (contents) => {
      if (typeof taskId === 'string' && !MISSION_STATUS_ID_RE.test(taskId)) {
        // The pure setMissionStatus() below refuses this id by returning contents
        // unchanged; without this line the refusal is indistinguishable from a
        // successful write (W2 review F1). Grammar: MISSION_STATUS_ID_SOURCE.
        process.stderr.write(
          `⚠ setMissionStatusOnDisk: taskId "${taskId}" does not match the mission-status id grammar — nothing written\n`
        );
      }
      const parsed = typeof contents === 'string' ? parseStateMd(contents) : null;
      if (parsed !== null) {
        const { skipped } = recoverFrontmatterMissionStatusDetailed(
          parsed.frontmatter,
          parsed.body
        );
        if (skipped.length > 0) {
          process.stderr.write(
            `⚠ setMissionStatusOnDisk: mission-status recovery skipped ${skipped.length} ` +
              `body line(s) — first: ${skipped[0].reason} (${skipped[0].line.trim()})\n`
          );
        }
      }
      return setMissionStatus(contents, taskId, status);
    },
    opts
  );
}
