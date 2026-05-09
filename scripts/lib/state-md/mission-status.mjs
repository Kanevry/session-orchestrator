/**
 * Mission-status helpers for STATE.md.
 *
 * Handles both the frontmatter `mission-status:` block-seq field and the
 * `## Mission Status` body section (body-level per-task status lines).
 *
 * Pure functions — no file I/O.
 */

import { parseStateMd, serializeStateMd } from './yaml-parser.mjs';
import { updateFrontmatterFields } from './frontmatter-mutators.mjs';

/**
 * Parses the optional `mission-status:` block from a STATE.md frontmatter object
 * (as returned by `parseStateMd(...).frontmatter`).
 *
 * Returns `null` when the `mission-status` key is absent (backward-compat: pre-#340
 * STATE.md files). Returns `[]` when the key is present but the value is an empty
 * array. Returns the array of entries when present and non-empty.
 *
 * Does NOT validate individual entry shapes — callers that need schema validation
 * should use `validateMissionStatusEntry` from mission-status-schema.mjs.
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
 * Individual entry objects must conform to the shape validated by
 * `validateMissionStatusEntry` in mission-status-schema.mjs, but this function does
 * NOT enforce that constraint — callers are responsible for pre-validation.
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
 * Sets (or updates) the mission status for a single task in the `## Mission Status` body
 * section of STATE.md. Creates the section if it does not exist.
 *
 * Format of each entry in the section:
 *   - <taskId>: <status> (updated <ISO timestamp>)
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

  const timestamp = new Date().toISOString();
  const bullet = `- ${taskId}: ${status} (updated ${timestamp})`;
  const lines = parsed.body.split('\n');

  // Find existing ## Mission Status section
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Mission Status\b/.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }

  if (headingIdx === -1) {
    // Section does not exist — append it at the end
    let bodyOut = parsed.body;
    if (!bodyOut.endsWith('\n')) bodyOut += '\n';
    bodyOut += `\n## Mission Status\n\n${bullet}\n`;
    return serializeStateMd({ frontmatter: parsed.frontmatter, body: bodyOut });
  }

  // Find end of section: next ## heading or end of lines
  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

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
      return serializeStateMd({ frontmatter: parsed.frontmatter, body: rebuilt.join('\n') });
    }
  }

  return serializeStateMd({ frontmatter: parsed.frontmatter, body: lines.join('\n') });
}

/**
 * Reads the current mission status for a single task from the `## Mission Status` body
 * section of STATE.md.
 *
 * Returns the status string (e.g. `'in-dev'`) or `null` if the task is not found or the
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
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Mission Status\b/.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return null;

  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  // Match: - <taskId>: <status> (updated ...)
  const escapedId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entryRe = new RegExp(`^-\\s+${escapedId}:\\s+(\\S+)`);
  for (let i = headingIdx + 1; i < sectionEnd; i++) {
    const m = entryRe.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}
