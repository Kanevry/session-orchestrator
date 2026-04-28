/**
 * vault-staleness.mjs — Parser for the top-level `vault-staleness:` YAML block.
 */

/**
 * Parse the top-level `vault-staleness:` YAML block from markdown content.
 * Defaults: enabled=false, thresholds={top:30,active:60,archived:180}, mode="warn".
 * @param {string} content — full file contents
 * @returns {{enabled: boolean, thresholds: {top: number, active: number, archived: number}, mode: string}}
 */
export function _parseVaultStaleness(content) {
  const defaults = {
    enabled: false,
    thresholds: { top: 30, active: 60, archived: 180 },
    mode: 'warn',
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (/^vault-staleness:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let vsEnabled = false;
  let vsMode = 'warn';
  const vsThresholds = { top: 30, active: 60, archived: 180 };
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
      if (['top', 'active', 'archived'].includes(k)) {
        const n = parseFloat(v);
        if (Number.isFinite(n) && n > 0) vsThresholds[k] = n;
      }
      continue;
    }

    // Top-level key under vault-staleness (2-space indent)
    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    inThresholdsBlock = false;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        vsEnabled = v.toLowerCase() === 'true';
        break;
      case 'mode':
        if (['strict', 'warn', 'off'].includes(v)) vsMode = v;
        break;
      case 'thresholds':
        inThresholdsBlock = true;
        break;
    }
  }

  return { enabled: vsEnabled, thresholds: vsThresholds, mode: vsMode };
}
