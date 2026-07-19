import { matchBlockHeader } from './block-header.mjs';

/**
 * slopcheck.mjs — Parser for the top-level `slopcheck:` YAML block
 * (PRD gsd Pattern Adoption Quick-Wins — Pattern 2 / issues #517, #520).
 *
 * Drives the opt-in package-legitimacy gate that defends against LLM-
 * hallucinated npm/pip/cargo package names ("slopsquatting"). Plugged into
 * /plan PRD generation and /discovery supply-chain probes.
 *
 * Returns `{ enabled, sources }`.
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumers:
 *  - `scripts/lib/slopcheck.mjs` (classifyPackages())
 *  - `skills/discovery/probes/supply-chain-slopcheck.mjs` (discovery probe)
 */

const ALLOWED_SOURCES = new Set(['plan', 'discovery']);
const DEFAULT_SOURCES = ['plan', 'discovery'];

/**
 * Parse the top-level `slopcheck:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   enabled:  false (opt-in)
 *   sources:  ['plan', 'discovery']
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean, sources: string[] }}
 */
export function _parseSlopcheck(content) {
  const defaults = {
    enabled: false,
    sources: [...DEFAULT_SOURCES],
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'slopcheck')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let scEnabled = false;
  let scSources = [...DEFAULT_SOURCES];

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
        // Default is false → only flip to true on explicit "true"
        scEnabled = v.toLowerCase() === 'true';
        break;
      case 'sources': {
        // Accept inline array notation: [] or [a, b, c]
        const stripped = v.replace(/^\s*\[/, '').replace(/\]\s*$/, '').trim();
        if (stripped === '') {
          scSources = [];
        } else {
          const items = stripped
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .filter((s) => ALLOWED_SOURCES.has(s));
          // Only override the default when the parsed list is non-empty after filtering;
          // a malformed list silently falls back to defaults.
          if (items.length > 0) scSources = items;
        }
        break;
      }
    }
  }

  return {
    enabled: scEnabled,
    sources: scSources,
  };
}
