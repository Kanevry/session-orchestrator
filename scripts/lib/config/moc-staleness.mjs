import { matchBlockHeader } from './block-header.mjs';

/**
 * moc-staleness.mjs — Parser for the top-level `moc-staleness:` YAML block.
 *
 * Config block shape (see docs/session-config-template.md):
 *   moc-staleness:
 *     enabled: false
 *     thresholds:
 *       moc: 90
 *     mode: warn
 *
 * Mirrors the docs-staleness.mjs parser design (issue #831) — a single
 * "moc" tier threshold (days), not a per-tier map like vault-staleness.mjs.
 *
 * ZERO IMPORTS other than ./block-header.mjs by design:
 * tests/lib/config/cycle-guard.test.mjs forbids any scripts/lib/config/*.mjs
 * from importing ../config.mjs.
 */

/**
 * Parse the top-level `moc-staleness:` YAML block from markdown content.
 * Defaults: enabled=false, thresholds={moc:90}, mode="warn".
 * @param {string} content — full file contents
 * @returns {{enabled: boolean, thresholds: {moc: number}, mode: string}}
 */
export function _parseMocStaleness(content) {
  const defaults = {
    enabled: false,
    thresholds: { moc: 90 },
    mode: 'warn',
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'moc-staleness')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let msEnabled = false;
  let msMode = 'warn';
  const msThresholds = { moc: 90 };
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
      if (k === 'moc') {
        const n = parseFloat(v);
        if (Number.isFinite(n) && n > 0) msThresholds[k] = n;
      }
      continue;
    }

    // Top-level key under moc-staleness (2-space indent)
    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    inThresholdsBlock = false;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        msEnabled = v.toLowerCase() === 'true';
        break;
      case 'mode':
        if (['strict', 'warn', 'off'].includes(v)) msMode = v;
        break;
      case 'thresholds':
        inThresholdsBlock = true;
        break;
    }
  }

  return { enabled: msEnabled, thresholds: msThresholds, mode: msMode };
}
