import { matchBlockHeader } from './block-header.mjs';

/**
 * state-md-lock.mjs — Parser for the top-level `state-md-lock:` YAML block
 * (PRD gsd Pattern Adoption Quick-Wins — Pattern 1 / issues #517, #518).
 *
 * Drives the mechanical STATE.md write lock that prevents race conditions
 * between parallel worker sessions writing the same STATE.md.
 *
 * Returns `{ enabled, "timeout-ms" }`.
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumer: `scripts/lib/session-lock.mjs` (Agent A — adds withStateMdLock()).
 */

/**
 * Parse the top-level `state-md-lock:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   enabled:    true
 *   timeout-ms: 10000 (integer ≥ 0)
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean, "timeout-ms": number }}
 */
export function _parseStateMdLock(content) {
  const defaults = {
    enabled: true,
    'timeout-ms': 10000,
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'state-md-lock')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let smlEnabled = true;
  let smlTimeoutMs = 10000;

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
        smlEnabled = v.toLowerCase() !== 'false';
        break;
      case 'timeout-ms': {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n >= 0) smlTimeoutMs = n;
        }
        break;
      }
    }
  }

  return {
    enabled: smlEnabled,
    'timeout-ms': smlTimeoutMs,
  };
}
