/**
 * vault-sync.mjs — Parser for the top-level `vault-sync:` YAML block.
 *
 * Ported from config-yaml-parser.sh (v2).
 */

/**
 * Parse the top-level `vault-sync:` YAML block from markdown content.
 * The block can appear anywhere (inside or outside ## Session Config).
 * Defaults: enabled=false, mode="warn", vault-dir=null, exclude=[].
 * @param {string} content — full file contents
 * @returns {{enabled: boolean, mode: string, "vault-dir": string|null, exclude: string[]}}
 */
export function _parseVaultSync(content) {
  const defaults = { enabled: false, mode: 'warn', 'vault-dir': null, exclude: [] };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    if (!inBlock) {
      // Detect `vault-sync:` at column 0 with optional trailing spaces
      if (/^vault-sync:\s*$/.test(line)) {
        inBlock = true;
      }
      continue;
    }

    // Block terminates at first non-indented (non-whitespace-leading) line
    if (line.length > 0 && !/^\s/.test(line)) break;

    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let vsEnabled = false;
  let vsMode = 'warn';
  let vsDir = null;
  const vsExclude = [];
  let inExclude = false;

  for (const rawLine of blockLines) {
    // Strip inline comment and trailing whitespace, preserving leading indent
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    // Dash-prefixed list item
    if (/^\s+-\s+/.test(clean)) {
      if (inExclude) {
        let item = clean.replace(/^\s+-\s+/, '').trim();
        // Strip surrounding quotes
        if (item.startsWith('"') && item.endsWith('"')) item = item.slice(1, -1);
        else if (item.startsWith("'") && item.endsWith("'")) item = item.slice(1, -1);
        if (item) vsExclude.push(item);
      }
      continue;
    }

    // Any non-list line resets the exclude block state
    inExclude = false;

    // key: value under indentation
    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    // Strip surrounding quotes
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        vsEnabled = v.toLowerCase() === 'true';
        break;
      case 'mode':
        if (['strict', 'warn', 'off'].includes(v)) vsMode = v;
        // invalid mode silently defaults to 'warn' (matches shell behaviour)
        break;
      case 'vault-dir':
        if (v && v !== 'none' && v !== 'null') vsDir = v;
        break;
      case 'exclude':
        if (!v) inExclude = true;
        break;
    }
  }

  return { enabled: vsEnabled, mode: vsMode, 'vault-dir': vsDir, exclude: vsExclude };
}
