/**
 * learnings/surface.mjs — surface top-N active learnings from a JSONL file.
 *
 * Extracted from scripts/autopilot.mjs (pre-refactor was L128-167) so multiple
 * consumers can share the same filter + sort + cap pipeline (autopilot loop
 * signals + session-start banner, etc.). Pure, stdlib-only, async fs.
 *
 * Filter semantics:
 *   - confidence is strictly > floor (default 0.3). 0.31 is kept; 0.30 is dropped.
 *   - entries without a numeric `confidence` field are treated as 0 (dropped).
 *   - entries with a parseable `expires_at` whose epoch is <= now are dropped.
 *     Entries without `expires_at` are considered not-expired.
 *   - malformed JSON lines are silently skipped (no throw).
 *   - missing file returns `[]` (no throw).
 *
 * Sort: confidence DESC, then created_at DESC tiebreaker (newest first).
 * Slice: `.slice(0, n)` after sort.
 */

import { readFile } from 'node:fs/promises';

/**
 * Surface the top-N active learnings from a learnings.jsonl file.
 *
 * @param {string} filePath - absolute path to learnings.jsonl
 * @param {number} [n=5] - how many to surface (cap)
 * @param {object} [opts]
 * @param {Date|number} [opts.now] - injectable clock; defaults to new Date()
 * @param {number} [opts.confidenceFloor=0.3] - filter threshold (entries with confidence <= floor are dropped)
 * @returns {Promise<Array<{id?: string, type?: string, subject?: string, confidence: number, created_at?: string}>>}
 *   Entries are sorted by confidence DESC, then created_at DESC (tiebreaker),
 *   then sliced to `n`. Returns [] on missing/unreadable file or all-empty input.
 */
export async function surfaceTopN(filePath, n = 5, opts = {}) {
  const { now: nowOpt, confidenceFloor = 0.3 } = opts;
  const nowMs =
    nowOpt instanceof Date
      ? nowOpt.getTime()
      : typeof nowOpt === 'number'
        ? nowOpt
        : Date.now();

  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const active = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // skip malformed lines
      continue;
    }
    if (typeof entry.confidence !== 'number' || entry.confidence <= confidenceFloor) continue;
    if (typeof entry.expires_at === 'string') {
      const expiresMs = Date.parse(entry.expires_at);
      if (Number.isFinite(expiresMs) && expiresMs <= nowMs) continue;
    }
    active.push(entry);
  }

  // Sort by confidence DESC, then created_at DESC (newest first as tiebreaker).
  active.sort((a, b) => {
    const confDiff = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (confDiff !== 0) return confDiff;
    const aTime = typeof a.created_at === 'string' ? Date.parse(a.created_at) : 0;
    const bTime = typeof b.created_at === 'string' ? Date.parse(b.created_at) : 0;
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });

  return active.slice(0, n);
}
