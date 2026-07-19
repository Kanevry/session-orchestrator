import { matchBlockHeader } from './block-header.mjs';

/**
 * vault-mirror-quality.mjs — Parser for the top-level `vault-mirror:` YAML block,
 * extracting the nested `quality:` sub-block (PRD F1.2 / issue #504).
 *
 * Returns the consumer-facing shape `{ quality: { "min-narrative-chars": int, "min-confidence": float } }`.
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumer: `scripts/vault-mirror.mjs` (I4's code).
 */

/**
 * Parse the top-level `vault-mirror:` YAML block from markdown content, extracting
 * the nested `quality:` sub-block. Independent of the `## Session Config` section
 * boundary (mirrors `_parseEventsRotation` / `_parseVaultStaleness` design).
 *
 * Defaults:
 *   quality.min-narrative-chars: 400 (integer ≥ 0)
 *   quality.min-confidence:      0.5 (float in [0.0, 1.0])
 *
 * @param {string} content — full file contents
 * @returns {{ quality: { "min-narrative-chars": number, "min-confidence": number } }}
 */
export function _parseVaultMirrorQuality(content) {
  const defaults = {
    quality: {
      'min-narrative-chars': 400,
      'min-confidence': 0.5,
    },
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'vault-mirror')) inBlock = true;
      continue;
    }
    // Stop at next top-level (non-indented, non-empty) key
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let qMinChars = 400;
  let qMinConfidence = 0.5;
  let inQualityBlock = false;

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    // Deeper-indented key (4+ spaces) → quality sub-key
    const deepMatch = clean.match(/^\s{4,}([a-zA-Z_-]+):\s*(.*)/);
    if (deepMatch && inQualityBlock) {
      const k = deepMatch[1];
      let v = deepMatch[2].trim();
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
      else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

      if (k === 'min-narrative-chars') {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n >= 0) qMinChars = n;
        }
      } else if (k === 'min-confidence') {
        if (/^\d+(\.\d+)?$/.test(v)) {
          const f = parseFloat(v);
          if (Number.isFinite(f) && f >= 0.0 && f <= 1.0) qMinConfidence = f;
        }
      }
      continue;
    }

    // Top-level key inside vault-mirror (2-space indent) — looking for `quality:`
    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    inQualityBlock = false;
    const k = kvMatch[1];
    const v = kvMatch[2].trim();

    if (k === 'quality' && v === '') {
      inQualityBlock = true;
    }
  }

  return {
    quality: {
      'min-narrative-chars': qMinChars,
      'min-confidence': qMinConfidence,
    },
  };
}
