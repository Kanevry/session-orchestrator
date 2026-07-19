import { matchBlockHeader } from './block-header.mjs';

/**
 * auto-dream.mjs — Parser for the top-level `auto-dream:` YAML block (issue #566).
 *
 * Returns `{ "min-confidence": float in [0.0, 1.0] }`.
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumer: `scripts/lib/memory-proposals/collector.mjs` reads the value via
 * Session Config and applies the filter inside `collectProposals()` at
 * session-end Phase 3.6.3 (collect-emit time). This is a SECOND confidence
 * gate above the existing write-time `memory.proposals.confidence-floor`
 * floor enforced by `scripts/memory-propose.mjs`.
 *
 * Structurally mirrors `scripts/lib/config/cold-start.mjs` (single-level
 * nested block, top-level boundary detection). Float-range validation copied
 * verbatim from `scripts/lib/config/vault-mirror-quality.mjs:69-73`.
 */

/**
 * Parse the top-level `auto-dream:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   min-confidence: 0.5 (float in [0.0, 1.0])
 *
 * @param {string} content — full file contents
 * @returns {{ "min-confidence": number }}
 */
export function _parseAutoDream(content) {
  const defaults = {
    'min-confidence': 0.5,
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'auto-dream')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let minConfidence = 0.5;

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    if (k === 'min-confidence') {
      // Float-range validation copied verbatim from vault-mirror-quality.mjs:69-73.
      if (/^\d+(\.\d+)?$/.test(v)) {
        const f = parseFloat(v);
        if (Number.isFinite(f) && f >= 0.0 && f <= 1.0) minConfidence = f;
      }
    }
  }

  return {
    'min-confidence': minConfidence,
  };
}
