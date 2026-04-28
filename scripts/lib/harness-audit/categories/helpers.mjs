/**
 * helpers.mjs — Shared helpers for harness-audit category checks.
 *
 * Stdlib only: node:fs.
 */

import { readFileSync } from 'node:fs';

/**
 * Parse YAML-subset frontmatter from a string.
 * Returns null if no --- delimiters found.
 */
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (start === -1) { start = i; }
      else { end = i; break; }
    }
  }
  if (start === -1 || end === -1) return null;
  const fm = {};
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    fm[key] = val;
  }
  return fm;
}

/**
 * Read file contents safely. Returns null if missing or unreadable.
 */
export function safeRead(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * Parse JSON safely. Returns null on failure.
 */
export function safeJson(text) {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Count lines in a string (including partial final line).
 */
export function lineCount(text) {
  if (!text) return 0;
  const lines = text.split('\n');
  // Don't count trailing empty string from trailing newline
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/**
 * Parse a JSONL file into an array of parsed objects.
 * Returns { lines, validLines } where validLines are successfully parsed.
 */
export function parseJsonl(text) {
  if (!text) return { lines: 0, validLines: [] };
  const rawLines = text.split('\n').filter((l) => l.trim().length > 0);
  const validLines = [];
  for (const l of rawLines) {
    try { validLines.push(JSON.parse(l)); } catch { /* skip */ }
  }
  return { lines: rawLines.length, validLines };
}

/**
 * Make a passing check result.
 *
 * Preferred call (options-object):
 *   pass({ category, name, message, severity, weight, evidence })
 *   pass({ checkId, points, maxPoints, path, evidence, message })
 *
 * @param {object|string} optsOrCheckId
 *   Options object (preferred) or legacy positional checkId (string).
 *   Options fields:
 *     - checkId    {string}  Check identifier (maps to check_id in output)
 *     - points     {number}  Points earned
 *     - maxPoints  {number}  Maximum possible points
 *     - path       {string}  File path for the check
 *     - evidence   {object}  Evidence object attached to the check result
 *     - message    {string}  Human-readable result message
 * @param {number}  [points]    (positional compat) points earned
 * @param {number}  [maxPoints] (positional compat) max points
 * @param {string}  [path]      (positional compat) file path
 * @param {object}  [evidence]  (positional compat) evidence
 * @param {string}  [message]   (positional compat) message
 *
 * @deprecated Positional call form is deprecated. Migrate to options-object:
 *   pass({ checkId, points, maxPoints, path, evidence, message })
 */
let _passWarnedOnce = false;
export function pass(optsOrCheckId, points, maxPoints, path, evidence, message) {
  if (typeof optsOrCheckId === 'string') {
    if (!_passWarnedOnce) {
      _passWarnedOnce = true;
       
      console.warn(
        '[harness-audit] pass(): positional call form is deprecated. ' +
        'Migrate to options-object: pass({ checkId, points, maxPoints, path, evidence, message })'
      );
    }
    return { check_id: optsOrCheckId, status: 'pass', points, max_points: maxPoints, path, evidence, message };
  }
  const { checkId, points: p, maxPoints: mp, path: pt, evidence: ev, message: msg } = optsOrCheckId;
  return { check_id: checkId, status: 'pass', points: p, max_points: mp, path: pt, evidence: ev, message: msg };
}

/**
 * Make a failing check result.
 *
 * Preferred call (options-object):
 *   fail({ checkId, maxPoints, path, evidence, message })
 *
 * @param {object|string} optsOrCheckId
 *   Options object (preferred) or legacy positional checkId (string).
 *   Options fields:
 *     - checkId    {string}  Check identifier (maps to check_id in output)
 *     - maxPoints  {number}  Maximum possible points (points earned is always 0)
 *     - path       {string}  File path for the check
 *     - evidence   {object}  Evidence object attached to the check result
 *     - message    {string}  Human-readable result message
 * @param {number}  [maxPoints] (positional compat) max points
 * @param {string}  [path]      (positional compat) file path
 * @param {object}  [evidence]  (positional compat) evidence
 * @param {string}  [message]   (positional compat) message
 *
 * @deprecated Positional call form is deprecated. Migrate to options-object:
 *   fail({ checkId, maxPoints, path, evidence, message })
 */
let _failWarnedOnce = false;
export function fail(optsOrCheckId, maxPoints, path, evidence, message) {
  if (typeof optsOrCheckId === 'string') {
    if (!_failWarnedOnce) {
      _failWarnedOnce = true;
       
      console.warn(
        '[harness-audit] fail(): positional call form is deprecated. ' +
        'Migrate to options-object: fail({ checkId, maxPoints, path, evidence, message })'
      );
    }
    return { check_id: optsOrCheckId, status: 'fail', points: 0, max_points: maxPoints, path, evidence, message };
  }
  const { checkId, maxPoints: mp, path: pt, evidence: ev, message: msg } = optsOrCheckId;
  return { check_id: checkId, status: 'fail', points: 0, max_points: mp, path: pt, evidence: ev, message: msg };
}

/**
 * Reset the one-time deprecation warning flags.
 * Intended for test isolation only — do not call in production code.
 * @internal
 */
export function _resetWarnFlags() {
  _passWarnedOnce = false;
  _failWarnedOnce = false;
}
