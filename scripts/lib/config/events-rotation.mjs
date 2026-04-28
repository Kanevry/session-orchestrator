/**
 * events-rotation.mjs — Parser for the top-level `events-rotation:` YAML block.
 *
 * Bounds: max-size-mb 1..1024, max-backups 1..20. Out-of-range values fall
 * back to defaults (silently; tolerant parser — hard errors would break
 * session-start, which must never block).
 */

/**
 * Parse the top-level `events-rotation:` YAML block from markdown content.
 * Defaults: enabled=true, max-size-mb=10, max-backups=5.
 * @param {string} content — full file contents
 * @returns {{enabled: boolean, "max-size-mb": number, "max-backups": number}}
 */
export function _parseEventsRotation(content) {
  const defaults = { enabled: true, 'max-size-mb': 10, 'max-backups': 5 };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (/^events-rotation:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let erEnabled = true;
  let erMaxSize = 10;
  let erMaxBackups = 5;

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
        erEnabled = v.toLowerCase() !== 'false';
        break;
      case 'max-size-mb': {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n >= 1 && n <= 1024) erMaxSize = n;
        }
        break;
      }
      case 'max-backups': {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n >= 1 && n <= 20) erMaxBackups = n;
        }
        break;
      }
    }
  }

  return { enabled: erEnabled, 'max-size-mb': erMaxSize, 'max-backups': erMaxBackups };
}
