import { matchBlockHeader } from './block-header.mjs';

/**
 * discovery-validator.mjs — Parser for the top-level `discovery-validator:`
 * YAML block (PSA-006 mechanical enforcement / issue #567).
 *
 * Drives the non-blocking SubagentStop hook that flags distributional
 * claims ("N of M", "100% of", "all N", "no remaining", "every X", "none of")
 * in a subagent's transcript tail that lack an adjacent fenced grep/rg/find
 * transcript. v1 is log+warn only (events.jsonl + stderr WARN); exit 2
 * (blocking) is reserved for a future hard-gate.
 *
 * Returns `{ enabled }`.
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumer: `hooks/post-subagent-discovery-validator.mjs`.
 */

/**
 * Parse the top-level `discovery-validator:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   enabled: true
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean }}
 */
export function _parseDiscoveryValidator(content) {
  const defaults = {
    enabled: true,
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'discovery-validator')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let dvEnabled = false;

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
        // Only literal "true" (case-insensitive) flips enabled; any other value → false
        dvEnabled = v.toLowerCase() === 'true';
        break;
    }
  }

  return {
    enabled: dvEnabled,
  };
}
