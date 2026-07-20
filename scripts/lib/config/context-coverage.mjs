import { matchBlockHeader } from './block-header.mjs';

/**
 * context-coverage.mjs — Parser for the top-level `context-coverage:` YAML block.
 *
 * Config block shape (see docs/session-config-template.md):
 *   context-coverage:
 *     enabled: false
 *     mode: warn
 *
 * Modelled on `./docs-staleness.mjs`'s parser design (issue #781, Epic #774) —
 * the block is scoped from the raw file content, independent of the
 * `## Session Config` section boundary, so a baseline using either the plain
 * `key:` header or the bold-bullet markdown rendering
 * (`- **context-coverage:**`, tolerated via `matchBlockHeader()`) parses
 * identically.
 *
 * ZERO imports other than `./block-header.mjs` — `tests/lib/config/cycle-guard.test.mjs`
 * forbids importing `../config.mjs` from this directory; this module keeps a
 * clean leaf with no other dependencies at all.
 *
 * Not registered in `scripts/lib/config.mjs` here — the coordinator wires
 * `_parseContextCoverage` into the orchestrator's config-object assembly
 * separately (see `context-coverage-banner.mjs`'s header for the exact
 * import + call lines to add there).
 *
 * Shipped default: `{ enabled: false, mode: 'warn' }` — opt-in (issue #831).
 */

/**
 * Parse the top-level `context-coverage:` YAML block from markdown content.
 * Defaults: enabled=false, mode="warn". Malformed values fall back per key.
 *
 * @param {string} content — full file contents
 * @returns {{enabled: boolean, mode: string}}
 */
export function _parseContextCoverage(content) {
  const defaults = { enabled: false, mode: 'warn' };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'context-coverage')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let ccEnabled = false;
  let ccMode = 'warn';

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
        ccEnabled = v.toLowerCase() === 'true';
        break;
      case 'mode':
        if (['strict', 'warn', 'off'].includes(v)) ccMode = v;
        break;
    }
  }

  return { enabled: ccEnabled, mode: ccMode };
}
