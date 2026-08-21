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
 */

import { parseStateMd, serializeStateMd } from './yaml-parser.mjs';
import { updateFrontmatterFields, writeStateMd } from './frontmatter-mutators.mjs';

const MISSION_STATUS_HEADING_RE = /^##\s+Mission Status\s*$/;
const WRITER_TIMESTAMP_SOURCE = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';
const WRITER_TIMESTAMP_RE = new RegExp(`^${WRITER_TIMESTAMP_SOURCE}$`);
const CANONICAL_MISSION_STATUS_ENTRY_RE = new RegExp(
  `^- ([a-z][a-z0-9]*(?:-[a-z0-9]+)*-\\d+): (.*) \\(updated (${WRITER_TIMESTAMP_SOURCE})\\)$`
);

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
 * (as returned by `parseStateMd(...).frontmatter`).
 *
 * Returns `null` when the `mission-status` key is absent (backward-compat: pre-#340
 * STATE.md files). Returns `[]` when the key is present but the value is an empty
 * array. Returns the array of entries when present and non-empty.
 *
 * Does NOT validate individual entry shapes, and no helper in this repo does:
 * entry shape and the `status` enum are coordinator convention, deliberately not a
 * mechanical gate (see `syncFrontmatterMissionStatus` below for why).
 *
 * @param {object} frontmatter
 * @returns {object[]|null}
 */
export function parseMissionStatus(frontmatter) {
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(frontmatter, 'mission-status')) {
    return null;
  }
  const raw = frontmatter['mission-status'];
  if (!Array.isArray(raw)) {
    // Present but not an array (e.g. null scalar from empty key) — treat as absent
    return null;
  }
  // Return a shallow copy to prevent mutation of the parsed frontmatter
  return raw.slice();
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
 * Individual entry objects are expected to carry `{ id, task, wave, status }`, but
 * this function does NOT enforce that shape and no validator in this repo does —
 * callers own the invariant.
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
 * The section parse stays strict and all-or-nothing: any nonblank line that is not a
 * unique canonical writer bullet (unsafe ID, pipe, malformed timestamp, duplicate,
 * prose) aborts the whole merge rather than fabricating entries from an ambiguous
 * body. Known limitation: one foreign-but-writer-accepted ID (e.g. `Docs_2`) or a
 * hand-written legacy bullet without a timestamp therefore suppresses the merge for
 * the whole file, silently.
 *
 * @param {object} frontmatter
 * @param {string} body
 * @returns {object}
 */
function recoverFrontmatterMissionStatus(frontmatter, body) {
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return frontmatter;
  }
  const raw = frontmatter['mission-status'];
  if (!Array.isArray(raw) || typeof body !== 'string') return frontmatter;

  const lines = body.split('\n');
  const section = findMissionStatusSection(lines);
  if (section === null) return frontmatter;

  const entries = [];
  const ids = new Set();
  for (let i = section.headingIdx + 1; i < section.sectionEnd; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;

    const match = CANONICAL_MISSION_STATUS_ENTRY_RE.exec(line);
    if (match === null) return frontmatter;
    const [, id, status, timestamp] = match;
    if (
      status.length === 0 ||
      status.includes('|') ||
      status.includes('\n') ||
      !isWriterTimestamp(timestamp) ||
      ids.has(id)
    ) {
      return frontmatter;
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
  if (added.length === 0) return frontmatter;
  return { ...frontmatter, 'mission-status': [...raw, ...added] };
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
 * without fabricated metadata. Ambiguous legacy bodies remain empty; other unmatched
 * populated entries remain update-only. See `syncFrontmatterMissionStatus`.
 *
 * Pure function — no I/O. Returns original `contents` unchanged on bad input.
 *
 * @param {string} contents - Current STATE.md file contents (string)
 * @param {string} taskId - Task identifier (e.g. 'm-1', 'docs-2')
 * @param {string} status - One of: brainstormed | validated | in-dev | testing | completed
 * @returns {string}
 */
export function setMissionStatus(contents, taskId, status) {
  if (typeof contents !== 'string') return contents;
  if (!taskId || typeof taskId !== 'string') return contents;
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

  // Reader-only legacy compatibility. Recovery remains canonical and all-or-nothing.
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
 * @param {string|undefined} repoRoot
 * @param {string} taskId
 * @param {string} status   brainstormed | validated | in-dev | testing | completed
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 */
export async function setMissionStatusOnDisk(repoRoot, taskId, status, opts = {}) {
  return writeStateMd(
    repoRoot,
    (contents) => setMissionStatus(contents, taskId, status),
    opts
  );
}
