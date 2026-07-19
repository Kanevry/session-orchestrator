import { matchBlockHeader } from './block-header.mjs';

/**
 * wave-reviewers.mjs — Parser for the `wave-reviewers` / `persona-reviewers` sub-block.
 *
 * Supports the backward-compat shim: if only `persona-reviewers` is present, its values
 * are used and the `deprecated` flag is set; the caller (config.mjs) emits the WARN.
 * See issue #461, #478.
 *
 * Fields: enabled (boolean), reviewers (string[]), mode (string enum), deprecated (boolean).
 * Defaults: { enabled: false, reviewers: [], mode: 'warn', deprecated: false }.
 */

const DEFAULTS = {
  enabled: false,
  reviewers: [],
  mode: 'warn',
  deprecated: false,
};

/**
 * Parse a `wave-reviewers:` or `persona-reviewers:` YAML block from markdown content.
 *
 * Dual-key shim:
 *   - `wave-reviewers` wins when present (even if both present).
 *   - `persona-reviewers` is accepted as a deprecated alias; the `deprecated` flag is set;
 *     the caller (config.mjs) emits the WARN to stderr.
 *   - If both are present, `wave-reviewers` wins and `deprecated` is still true.
 *
 * @param {string} content — full CLAUDE.md / AGENTS.md file content
 * @returns {{ enabled: boolean, reviewers: string[], mode: string, deprecated: boolean }}
 */
export function _parseWaveReviewers(content) {
  const newBlockLines = _extractBlock(content, 'wave-reviewers');
  const oldBlockLines = _extractBlock(content, 'persona-reviewers');

  const hasNew = newBlockLines.length > 0;
  const hasOld = oldBlockLines.length > 0;

  // New key wins; fall back to old key only when new is absent
  const blockLines = hasNew ? newBlockLines : hasOld ? oldBlockLines : [];

  if (blockLines.length === 0) return { ...DEFAULTS, deprecated: false };

  return { ..._parseBlockLines(blockLines), deprecated: hasOld };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the indented block lines for a given top-level key from markdown content.
 * Returns an empty array if the key is not present.
 *
 * @param {string} content
 * @param {string} key — e.g. 'wave-reviewers'
 * @returns {string[]}
 */
function _extractBlock(content, key) {
  const lines = content.split(/\r?\n/);
  const blockLines = [];
  let inBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, key)) {
        inBlock = true;
      }
      continue;
    }
    // Stop at a non-empty line that has no leading whitespace (next top-level key)
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  return blockLines;
}

/**
 * Parse the indented block lines into { enabled, reviewers, mode }.
 *
 * @param {string[]} blockLines
 * @returns {{ enabled: boolean, reviewers: string[], mode: string }}
 */
function _parseBlockLines(blockLines) {
  let enabled = false;
  let reviewers = [];
  let mode = 'warn';

  for (const rawLine of blockLines) {
    // Strip inline comments and trailing whitespace
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();

    // Strip surrounding quotes
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        enabled = v.toLowerCase() === 'true';
        break;
      case 'mode':
        if (['strict', 'warn', 'off'].includes(v)) mode = v;
        break;
      case 'reviewers': {
        // Accept inline array notation: [] or [a, b, c]
        const stripped = v.replace(/^\s*\[/, '').replace(/\]\s*$/, '').trim();
        if (stripped === '') {
          reviewers = [];
        } else {
          reviewers = stripped
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
        break;
      }
      default:
        break;
    }
  }

  return { enabled, reviewers, mode };
}
