/**
 * memory.mjs — Parser for the top-level `memory:` YAML block (issue #505).
 *
 * Drives the memory-banner that surfaces at session-start when the operator
 * has accumulated significant learnings.
 *
 * Returns `{ banner: { enabled } }`.
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumer: `scripts/lib/memory-banner.mjs`.
 */

/**
 * Parse the top-level `memory:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   memory.banner.enabled: true
 *
 * @param {string} content — full file contents
 * @returns {{ banner: { enabled: boolean } }}
 */
export function _parseMemory(content) {
  const defaults = { banner: { enabled: true } };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (/^memory:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let bannerEnabled = true;
  let inBannerBlock = false;

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    // Detect `  banner:` sub-block header (2-space indent)
    if (/^\s{2}banner:\s*$/.test(clean)) {
      inBannerBlock = true;
      continue;
    }

    // If we hit a sibling top-level key inside the memory block, exit banner sub-block
    if (/^\s{2}[a-zA-Z_-]+:/.test(clean) && !/^\s{4}/.test(clean)) {
      inBannerBlock = false;
    }

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    if (inBannerBlock && k === 'enabled') {
      // Default is true → only flip to false on explicit "false"
      bannerEnabled = v.toLowerCase() !== 'false';
    }
  }

  return { banner: { enabled: bannerEnabled } };
}
