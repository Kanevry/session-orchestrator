import { matchBlockHeader } from './block-header.mjs';

/**
 * docs-staleness.mjs — Parser for the top-level `docs-staleness:` YAML block.
 *
 * Config block shape (see docs/session-config-template.md):
 *   docs-staleness:
 *     enabled: false
 *     mode: warn
 *     thresholds:
 *       living: 90
 *
 * Mirrors the vault-staleness.mjs parser design (issue #781, Epic #774), but
 * with a single "living" tier instead of top/active/archived — living docs
 * (docs/*.md root-level + docs/examples/*.md) have one staleness threshold,
 * not a per-tier map.
 */

/**
 * Parse the top-level `docs-staleness:` YAML block from markdown content.
 * Defaults: enabled=false, thresholds={living:90}, mode="warn".
 * @param {string} content — full file contents
 * @returns {{enabled: boolean, thresholds: {living: number}, mode: string}}
 */
export function _parseDocsStaleness(content) {
  const defaults = {
    enabled: false,
    thresholds: { living: 90 },
    mode: 'warn',
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'docs-staleness')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let dsEnabled = false;
  let dsMode = 'warn';
  const dsThresholds = { living: 90 };
  let inThresholdsBlock = false;

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    // Deeper indented key (thresholds sub-keys)
    const deepMatch = clean.match(/^\s{4,}([a-zA-Z_-]+):\s*(.*)/);
    if (deepMatch && inThresholdsBlock) {
      const k = deepMatch[1];
      let v = deepMatch[2].trim();
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
      else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);
      if (k === 'living') {
        const n = parseFloat(v);
        if (Number.isFinite(n) && n > 0) dsThresholds[k] = n;
      }
      continue;
    }

    // Top-level key under docs-staleness (2-space indent)
    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    inThresholdsBlock = false;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        dsEnabled = v.toLowerCase() === 'true';
        break;
      case 'mode':
        if (['strict', 'warn', 'off'].includes(v)) dsMode = v;
        break;
      case 'thresholds':
        inThresholdsBlock = true;
        break;
    }
  }

  return { enabled: dsEnabled, thresholds: dsThresholds, mode: dsMode };
}
