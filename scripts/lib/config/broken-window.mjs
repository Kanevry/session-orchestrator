import { matchBlockHeader } from './block-header.mjs';

/**
 * broken-window.mjs — Parser for the top-level `broken-window-budget:` YAML block
 * (#730 Epic H / H5 — "Broken-Window Budget").
 *
 * Drives session-end Phase 2.6: a "shipped-but-broken" shipment (Full-Gate PASS
 * with documented exceptions, overridden findings) mechanically files a
 * hard-terminated closure issue + Override-Ratio tracking via events.jsonl.
 *
 * Returns `{ enabled, "due-days" }`.
 * Tolerant parser: malformed values silently fall back to defaults, EXCEPT
 * `due-days` — a malformed, non-positive, or non-integer value emits a stderr
 * WARN before falling back (mirrors the handover-gate `max-open-questions`
 * WARN discipline: a runtime-critical bound deserves a loud fallback).
 *
 * Consumer: `scripts/lib/config.mjs`, `skills/session-end/SKILL.md` Phase 2.6.
 */

// Upper bound for due-days (~10 years). Guards against Date#setUTCDate
// overflowing into an Invalid Date downstream (#794 GAP-4).
const MAX_DUE_DAYS = 3650;

/**
 * Parse the top-level `broken-window-budget:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   enabled:  false (opt-in — the whole Phase 2.6 is silent when disabled)
 *   due-days: 7 (integer >= 1 and <= 3650 [~10 years]; the closure issue's hard
 *             due-date = today + this). Malformed, non-integer, < 1, or > 3650
 *             input falls back to 7 and emits a stderr WARN. The upper bound
 *             guards against `Date#setUTCDate` overflowing into an Invalid Date
 *             (RangeError on `.toISOString()` downstream in
 *             `spiral-carryover.mjs` `computeDueDate` — #794 GAP-4).
 *
 * YAML shape:
 *   broken-window-budget:
 *     enabled: false
 *     due-days: 7
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean, "due-days": number }}
 */
export function _parseBrokenWindow(content) {
  const defaults = {
    enabled: false,
    'due-days': 7,
  };

  const lines = String(content ?? '').split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'broken-window-budget')) inBlock = true;
      continue;
    }
    // Stop at next column-0 non-empty line (sibling top-level key or H2 heading)
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let enabled = false;
  let dueDays = 7;

  for (const rawLine of blockLines) {
    // Strip inline comments and trailing whitespace
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        // Default is false → only flip to true on explicit "true"
        enabled = v.toLowerCase() === 'true';
        break;

      case 'due-days': {
        const parsed = /^\d+$/.test(v) ? parseInt(v, 10) : NaN;
        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_DUE_DAYS) {
          // Positive integer within bounds (>= 1 — a 0-day due-date is
          // nonsensical for a hard-terminated closure issue; <= MAX_DUE_DAYS —
          // guards against Date overflow downstream, #794 GAP-4).
          dueDays = parsed;
        } else {
          // Malformed (non-numeric, empty), non-integer, < 1, or > MAX_DUE_DAYS
          // — emit a stderr WARN on this fallback path (handover-gate parity).
          process.stderr.write(
            `⚠ broken-window-budget.due-days: '${v}' invalid — falling back to 7\n`
          );
          dueDays = 7;
        }
        break;
      }
    }
  }

  return {
    enabled,
    'due-days': dueDays,
  };
}
