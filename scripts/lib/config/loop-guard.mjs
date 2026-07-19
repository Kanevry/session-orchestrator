import { matchBlockHeader } from './block-header.mjs';

/**
 * loop-guard.mjs — Parser for the top-level `loop-guard:` YAML block
 * (ecc-analysis / issue #619).
 *
 * Drives the lean PostToolUse hook that maintains a per-session ring buffer of
 * recent {tool, argsHash} pairs and injects an additionalContext loop-warning
 * when the same (tool+argsHash) recurs >= `threshold` times within the last
 * `window` tool calls. Warn-only / non-blocking; profile-gate also applies.
 *
 * Returns `{ enabled, threshold, window }`.
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumer: `hooks/loop-guard.mjs`.
 */

/** Lower bounds — fewer than 2 identical calls / a window < 2 is nonsensical. */
const MIN_THRESHOLD = 2;
const MIN_WINDOW = 2;

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW = 5;

/**
 * Coerce a raw string value into a bounded positive integer, falling back to
 * `fallback` when the value is not a finite integer >= `min`.
 *
 * @param {string} raw
 * @param {number} fallback
 * @param {number} min
 * @returns {number}
 */
function parseBoundedInt(raw, fallback, min) {
  if (!/^-?\d+$/.test(raw)) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

/**
 * Parse the top-level `loop-guard:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   enabled:   true
 *   threshold: 3   (bounded >= 2)
 *   window:    5   (bounded >= 2)
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean, threshold: number, window: number }}
 */
export function _parseLoopGuard(content) {
  const defaults = {
    enabled: true,
    threshold: DEFAULT_THRESHOLD,
    window: DEFAULT_WINDOW,
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'loop-guard')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let lgEnabled = true;
  let lgThreshold = DEFAULT_THRESHOLD;
  let lgWindow = DEFAULT_WINDOW;

  for (const rawLine of blockLines) {
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
        // Default is true → only flip to false on explicit "false"
        lgEnabled = v.toLowerCase() !== 'false';
        break;
      case 'threshold':
        lgThreshold = parseBoundedInt(v, DEFAULT_THRESHOLD, MIN_THRESHOLD);
        break;
      case 'window':
        lgWindow = parseBoundedInt(v, DEFAULT_WINDOW, MIN_WINDOW);
        break;
    }
  }

  // Clamp: a `window` smaller than `threshold` is dead config — the same
  // (tool+argsHash) can never recur `threshold` times inside a shorter ring, so
  // the guard would silently never fire. Self-heal by widening the window to at
  // least `threshold` (#619 / #628 hardening).
  if (lgWindow < lgThreshold) lgWindow = lgThreshold;

  return {
    enabled: lgEnabled,
    threshold: lgThreshold,
    window: lgWindow,
  };
}
