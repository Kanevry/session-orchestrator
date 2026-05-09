/**
 * Body-section helpers for STATE.md.
 *
 * Pure functions — no file I/O.
 */

import { parseStateMd, serializeStateMd } from './yaml-parser.mjs';
import { updateFrontmatterFields, touchUpdatedField } from './frontmatter-mutators.mjs';

/**
 * Extracts the current-wave banner info from the `## Current Wave` body
 * section: first non-blank line after the heading.
 *
 * @param {string} contents
 * @returns {{waveNumber: number|null, description: string}|null}
 */
export function readCurrentTask(contents) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return null;
  const lines = parsed.body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^##\s+Current Wave\b/.test(lines[i])) i++;
  if (i === lines.length) return null;
  i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i === lines.length) return null;
  const description = lines[i].trim();
  const waveMatch = /^Wave\s+(\d+)\b/.exec(description);
  const waveNumber = waveMatch ? parseInt(waveMatch[1], 10) : null;
  return { waveNumber, description };
}

/**
 * Appends a timestamped bullet to the `## Deviations` section in the STATE.md body.
 * Creates the section if missing. Replaces a `(none yet)` placeholder if present.
 *
 * @param {string} contents
 * @param {string} isoTimestamp - ISO 8601 UTC, e.g. '2026-05-01T17:50:00Z'
 * @param {string} message - free text; no leading dash, no surrounding brackets
 * @returns {string}
 */
export function appendDeviation(contents, isoTimestamp, message) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  const bullet = `- [${isoTimestamp}] ${message}`;
  const lines = parsed.body.split('\n');
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Deviations\b/.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) {
    // Append section at end of body. Ensure trailing newline before adding section.
    let bodyOut = parsed.body;
    if (!bodyOut.endsWith('\n')) bodyOut += '\n';
    bodyOut += `\n## Deviations\n\n${bullet}\n`;
    return serializeStateMd({ frontmatter: parsed.frontmatter, body: bodyOut });
  }
  // Find end-of-section: next `## ` heading or end of lines.
  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  // Within section body (headingIdx+1 .. sectionEnd-1), look for placeholder
  // or last bullet.
  let placeholderIdx = -1;
  let lastBulletIdx = -1;
  for (let i = headingIdx + 1; i < sectionEnd; i++) {
    const t = lines[i].trim();
    if (t === '(none yet)' || t === '_(none yet)_' || t === '*(none yet)*') {
      placeholderIdx = i;
    }
    if (/^-\s+/.test(t)) {
      lastBulletIdx = i;
    }
  }
  if (placeholderIdx !== -1) {
    lines[placeholderIdx] = bullet;
  } else if (lastBulletIdx !== -1) {
    lines.splice(lastBulletIdx + 1, 0, bullet);
  } else {
    // Insert after heading, with one blank line between heading and bullet.
    // Trim any leading blank lines in section, then insert.
    let insertAt = headingIdx + 1;
    // Skip existing blank lines after heading
    while (insertAt < sectionEnd && lines[insertAt].trim() === '') insertAt++;
    // We want exactly: heading, blank, bullet, [existing trailing content].
    const before = lines.slice(0, headingIdx + 1);
    const after = lines.slice(insertAt);
    const rebuilt = [...before, '', bullet, ...after];
    return serializeStateMd({
      frontmatter: parsed.frontmatter,
      body: rebuilt.join('\n'),
    });
  }
  return serializeStateMd({
    frontmatter: parsed.frontmatter,
    body: lines.join('\n'),
  });
}

/**
 * Finalizes a STATE.md after express-path coord-direct execution.
 * Sets `status: completed`, appends an `Express path:` deviation, refreshes `updated`.
 * No-op (returns input unchanged) if `contents` is unparseable.
 *
 * @param {string} contents
 * @param {object} options
 * @param {number} options.taskCount - number of tasks executed coord-direct (required)
 * @param {string} [options.sessionType='housekeeping']
 * @param {boolean} [options.expressPathEnabled=true]
 * @param {string} [options.timestamp] - ISO 8601, defaults to current time
 * @returns {string}
 */
export function markExpressPathComplete(contents, options) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  const opts = options || {};
  const taskCount = opts.taskCount;
  const sessionType = opts.sessionType ?? 'housekeeping';
  const expressPathEnabled = opts.expressPathEnabled ?? true;
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const message = `Express path: ${taskCount} tasks executed coord-direct (express-path.enabled: ${expressPathEnabled}, session-type: ${sessionType}, scope: ${taskCount} issues)`;
  let next = updateFrontmatterFields(contents, { status: 'completed' });
  next = appendDeviation(next, timestamp, message);
  next = touchUpdatedField(next, timestamp);
  return next;
}
