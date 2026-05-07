/**
 * STATE.md helpers (issue #184).
 *
 * Minimal hand-rolled YAML-subset parser + serializer for the fields used by
 * the session-orchestrator STATE.md contract. Not a general-purpose YAML
 * implementation — handles:
 *   - Scalar strings, booleans, integers, nulls
 *   - Flow-style integer arrays (`[1, 2, 3]`)
 *   - Block-style sequences of mappings (issue #244), e.g. `docs-tasks:` with
 *     indented `- key: value` entries. Only one nesting level supported.
 *
 * That is the full grammar permitted by skills/_shared/state-ownership.md.
 *
 * Never throws. Returns null for unparseable input rather than raising.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parses a STATE.md file into frontmatter + body.
 *
 * @param {string} contents
 * @returns {{frontmatter: object, body: string}|null}
 */
export function parseStateMd(contents) {
  if (typeof contents !== 'string') return null;
  const match = FRONTMATTER_RE.exec(contents);
  if (!match) return null;
  const [, fmText, body] = match;
  const frontmatter = parseFrontmatter(fmText);
  if (frontmatter === null) return null;
  return { frontmatter, body: body.startsWith('\n') ? body.slice(1) : body };
}

/**
 * Serializes a frontmatter object + body back into STATE.md format.
 *
 * @param {{frontmatter: object, body: string}} input
 * @returns {string}
 */
export function serializeStateMd({ frontmatter, body }) {
  const fmLines = [];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (isBlockSeqOfMappings(v)) {
      fmLines.push(`${k}:`);
      for (const entry of v) {
        serializeBlockSeqEntry(entry, fmLines);
      }
    } else {
      fmLines.push(`${k}: ${serializeScalar(v)}`);
    }
  }
  const bodyOut = body.startsWith('\n') ? body : `\n${body}`;
  return `---\n${fmLines.join('\n')}\n---\n${bodyOut}`;
}

/**
 * Sets frontmatter.updated to the given ISO 8601 timestamp and returns the
 * new contents. If the file has no frontmatter, returns input unchanged.
 *
 * @param {string} contents
 * @param {string} isoTimestamp
 * @returns {string}
 */
export function touchUpdatedField(contents, isoTimestamp) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  parsed.frontmatter.updated = isoTimestamp;
  return serializeStateMd(parsed);
}

/**
 * Additively writes frontmatter keys. Only keys present in `fields` are
 * touched; all other existing frontmatter keys (including unknown
 * extensions) are preserved verbatim.
 *
 * Value semantics:
 *   - `null` or `undefined` value → key is DELETED from the frontmatter
 *   - anything else → key is set/overwritten
 *
 * No-ops if `contents` has no frontmatter (returns input unchanged).
 *
 * @param {string} contents
 * @param {object} fields
 * @returns {string}
 */
export function updateFrontmatterFields(contents, fields) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    return contents;
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) {
      delete parsed.frontmatter[k];
    } else {
      parsed.frontmatter[k] = v;
    }
  }
  return serializeStateMd(parsed);
}

/**
 * Parses the 5 v1.1 Recommendation fields from a STATE.md frontmatter object
 * (as returned by `parseStateMd(...).frontmatter`).
 *
 * Returns `null` when NONE of the 5 fields are present (backward-compat:
 * pre-v1.1 STATE.md files).
 *
 * When a subset is present, populates the object with the parsed values and
 * sets missing fields to null. Type-mismatched fields are also coerced to
 * null (defensive — do not propagate garbage into downstream Mode-Selector).
 * Caller is responsible for emitting partial/type-mismatch warn events.
 *
 * @param {object} frontmatter
 * @returns {{mode: string|null, priorities: number[]|null, carryoverRatio: number|null, completionRate: number|null, rationale: string|null}|null}
 */
export function parseRecommendations(frontmatter) {
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return null;
  }
  const keys = [
    'recommended-mode',
    'top-priorities',
    'carryover-ratio',
    'completion-rate',
    'rationale',
  ];
  const anyPresent = keys.some((k) => Object.prototype.hasOwnProperty.call(frontmatter, k));
  if (!anyPresent) return null;

  const mode = typeof frontmatter['recommended-mode'] === 'string'
    ? frontmatter['recommended-mode']
    : null;
  const priorities = Array.isArray(frontmatter['top-priorities'])
    && frontmatter['top-priorities'].every((x) => Number.isInteger(x))
    ? frontmatter['top-priorities'].slice()
    : null;
  const carryoverRatio = typeof frontmatter['carryover-ratio'] === 'number'
    && !Number.isNaN(frontmatter['carryover-ratio'])
    ? frontmatter['carryover-ratio']
    : null;
  const completionRate = typeof frontmatter['completion-rate'] === 'number'
    && !Number.isNaN(frontmatter['completion-rate'])
    ? frontmatter['completion-rate']
    : null;
  const rationale = typeof frontmatter.rationale === 'string'
    ? frontmatter.rationale
    : null;

  return { mode, priorities, carryoverRatio, completionRate, rationale };
}

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

function parseFrontmatter(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const rstripped = lines[i].replace(/\s+$/, '');
    if (rstripped === '' || /^\s*#/.test(rstripped)) {
      i++;
      continue;
    }
    if (/^\s/.test(rstripped)) return null;
    const idx = rstripped.indexOf(':');
    if (idx === -1) return null;
    const key = rstripped.slice(0, idx).trim();
    if (key === '') return null;
    const valuePart = rstripped.slice(idx + 1).trim();
    if (valuePart === '') {
      const result = parseBlockValue(lines, i + 1);
      if (result === null) return null;
      out[key] = result.value;
      i = result.nextIndex;
    } else {
      out[key] = parseScalar(valuePart);
      i++;
    }
  }
  return out;
}

/**
 * Parses an optional block-sequence-of-mappings value following an empty
 * `key:` line. Returns `{ value, nextIndex }` where:
 *   - `value === null` means no block sequence was present (the `key:` has
 *     no body) and `nextIndex === start` so the caller resumes at `start`.
 *   - `value === [...]` means a block sequence was consumed.
 * Returns `null` on malformed block syntax.
 */
function parseBlockValue(lines, start) {
  let i = start;
  while (i < lines.length) {
    const rstripped = lines[i].replace(/\s+$/, '');
    if (rstripped === '' || /^\s*#/.test(rstripped)) {
      i++;
      continue;
    }
    break;
  }
  if (i >= lines.length) return { value: null, nextIndex: start };
  const peek = lines[i].replace(/\s+$/, '');
  const bulletMatch = peek.match(/^(\s+)- /);
  if (!bulletMatch) return { value: null, nextIndex: start };
  const indent = bulletMatch[1];
  const contIndent = indent + '  ';
  const entries = [];
  while (i < lines.length) {
    const rstripped = lines[i].replace(/\s+$/, '');
    if (rstripped === '' || /^\s*#/.test(rstripped)) {
      i++;
      continue;
    }
    if (!rstripped.startsWith(indent + '- ')) break;
    const firstBody = rstripped.slice(indent.length + 2);
    const firstColon = firstBody.indexOf(':');
    if (firstColon === -1) return null;
    const firstKey = firstBody.slice(0, firstColon).trim();
    if (firstKey === '') return null;
    const entry = {};
    entry[firstKey] = parseScalar(firstBody.slice(firstColon + 1).trim());
    i++;
    while (i < lines.length) {
      const inner = lines[i].replace(/\s+$/, '');
      if (inner === '' || /^\s*#/.test(inner)) {
        i++;
        continue;
      }
      if (!inner.startsWith(contIndent) || inner.startsWith(indent + '- ')) break;
      const body = inner.slice(contIndent.length);
      if (/^\s/.test(body)) return null;
      const colon = body.indexOf(':');
      if (colon === -1) return null;
      const key = body.slice(0, colon).trim();
      if (key === '') return null;
      entry[key] = parseScalar(body.slice(colon + 1).trim());
      i++;
    }
    entries.push(entry);
  }
  return { value: entries, nextIndex: i };
}

function parseScalar(raw) {
  if (raw === '' || raw === 'null' || raw === '~') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => parseScalar(s.trim()));
  }
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function isBlockSeqOfMappings(v) {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))
  );
}

function serializeBlockSeqEntry(entry, fmLines) {
  const entries = Object.entries(entry);
  if (entries.length === 0) {
    fmLines.push('  - {}');
    return;
  }
  const [firstKey, firstValue] = entries[0];
  fmLines.push(`  - ${firstKey}: ${serializeScalar(firstValue)}`);
  for (let idx = 1; idx < entries.length; idx++) {
    const [key, value] = entries[idx];
    fmLines.push(`    ${key}: ${serializeScalar(value)}`);
  }
}

function serializeScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(serializeScalar).join(', ')}]`;
  const s = String(v);
  if (/^[\w\-./:+@]+$/.test(s)) return s;
  return JSON.stringify(s);
}
