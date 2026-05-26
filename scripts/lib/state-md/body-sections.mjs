/**
 * Body-section helpers for STATE.md.
 *
 * Pure functions — no file I/O.
 *
 * Plus on-disk wrappers (`appendDeviationOnDisk`, `markExpressPathCompleteOnDisk`,
 * `recordAutoCommitOnDisk`) added for PRD 2026-05-22 § 4 Pattern 1 (issue #518).
 * The on-disk wrappers delegate to the pure helpers above and route the
 * read+write cycle through `writeStateMd` from frontmatter-mutators.mjs, which
 * acquires `.orchestrator/state.lock` for mechanical serialization (PSA-004).
 */

import { parseStateMd, serializeStateMd } from './yaml-parser.mjs';
import {
  updateFrontmatterFields,
  touchUpdatedField,
  writeStateMd,
} from './frontmatter-mutators.mjs';

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
 * Defensive guard (issue #560): when `isoTimestamp` is omitted, `undefined`, `null`,
 * or a non-string value, defaults to `new Date().toISOString()`. This prevents the
 * literal text `undefined` from rendering in the deviations log when a caller
 * forgets to compute the timestamp (the deep-2115 inter-wave 2→3 incident).
 *
 * @param {string} contents
 * @param {string} [isoTimestamp] - ISO 8601 UTC, e.g. '2026-05-01T17:50:00Z'.
 *   When omitted or not a non-empty string, defaults to `new Date().toISOString()`.
 * @param {string} message - free text; no leading dash, no surrounding brackets
 * @returns {string}
 */
export function appendDeviation(contents, isoTimestamp, message) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  const ts = (typeof isoTimestamp === 'string' && isoTimestamp.length > 0)
    ? isoTimestamp
    : new Date().toISOString();
  const bullet = `- [${ts}] ${message}`;
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
 * Records an auto-commit checkpoint in the `## Deviations` section of STATE.md.
 *
 * Phase-1 stub — appends a human-readable deviation entry only. Does NOT perform
 * any git operations. The procedural commit body (`scripts/lib/auto-commit.mjs`)
 * is deferred to V3.6 (GitLab #214). Until then, callers (wave-executor coordinator)
 * invoke this function AFTER the git commit succeeds to create the audit trail.
 *
 * @param {string} contents - current STATE.md text
 * @param {object} options
 * @param {string} options.sha - short git SHA of the auto-commit (e.g. 'a1b2c3d')
 * @param {number} options.waveN - wave number that triggered the checkpoint
 * @param {string} options.waveResultSummary - one-line summary, e.g. 'Impl-Core, Quality-Lite PASS, 12 files'
 * @param {string} [options.timestamp] - ISO 8601 UTC; defaults to current time
 * @returns {string} updated STATE.md text
 */
export function recordAutoCommit(contents, options) {
  const opts = options || {};
  const { sha, waveN, waveResultSummary } = opts;
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const message = `Wave ${waveN} auto-commit: ${sha} (${waveResultSummary})`;
  return appendDeviation(contents, timestamp, message);
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

// ---------------------------------------------------------------------------
// On-disk wrappers (PRD 2026-05-22 § 4 — Pattern 1, issue #518)
// ---------------------------------------------------------------------------

/**
 * Guard: throws a clear Error when repoRoot is undefined, null, or empty.
 * Parallel-session CWD drift (PSA rules) makes `process.cwd()` fallbacks a
 * footgun — callers MUST be explicit about which repo root they target.
 *
 * @param {unknown} repoRoot
 * @param {string} fnName  — name of the calling function, for error messages
 */
function requireRepoRoot(repoRoot, fnName) {
  if (!repoRoot) {
    throw new Error(
      `${fnName}: repoRoot is required (got ${typeof repoRoot}). Pass an explicit repo root, e.g. via execSync('git rev-parse --show-toplevel').`
    );
  }
}

/**
 * Lock-guarded append to the `## Deviations` section.
 *
 * Delegates to the pure `appendDeviation` helper; the read+write cycle is
 * serialized via `withStateMdLock` (PSA-004 mechanical enforcement).
 *
 * When `isoTimestamp` is omitted, `undefined`, `null`, or a non-string value,
 * the underlying `appendDeviation` defaults to `new Date().toISOString()` (issue #560).
 *
 * @param {string} repoRoot  — absolute path to the repository root (required)
 * @param {string} [isoTimestamp]  — defaults to current time if omitted
 * @param {string} message
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 * @throws {Error} when repoRoot is undefined, null, or empty
 */
export async function appendDeviationOnDisk(repoRoot, isoTimestamp, message, opts = {}) {
  requireRepoRoot(repoRoot, 'appendDeviationOnDisk');
  return writeStateMd(
    repoRoot,
    (contents) => appendDeviation(contents, isoTimestamp, message),
    opts
  );
}

/**
 * Lock-guarded `recordAutoCommit` for express-path / wave-checkpoint flows.
 *
 * @param {string} repoRoot  — absolute path to the repository root (required)
 * @param {{ sha: string, waveN: number, waveResultSummary: string, timestamp?: string }} options
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 * @throws {Error} when repoRoot is undefined, null, or empty
 */
export async function recordAutoCommitOnDisk(repoRoot, options, opts = {}) {
  requireRepoRoot(repoRoot, 'recordAutoCommitOnDisk');
  return writeStateMd(
    repoRoot,
    (contents) => recordAutoCommit(contents, options),
    opts
  );
}

/**
 * Lock-guarded `markExpressPathComplete` — used by session-end and the
 * express-path skill flow.
 *
 * @param {string} repoRoot  — absolute path to the repository root (required)
 * @param {object} options  See markExpressPathComplete signature above.
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 * @throws {Error} when repoRoot is undefined, null, or empty
 */
export async function markExpressPathCompleteOnDisk(repoRoot, options, opts = {}) {
  requireRepoRoot(repoRoot, 'markExpressPathCompleteOnDisk');
  return writeStateMd(
    repoRoot,
    (contents) => markExpressPathComplete(contents, options),
    opts
  );
}
