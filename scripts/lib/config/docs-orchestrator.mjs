/**
 * docs-orchestrator.mjs — Parser for the top-level `docs-orchestrator:` YAML block.
 */

/**
 * Parse the top-level `docs-orchestrator:` YAML block from markdown content.
 * Defaults: enabled=false, audiences=["user","dev","vault"], mode="warn".
 * @param {string} content — full file contents
 * @returns {{enabled: boolean, audiences: string[], mode: string}}
 */
export function _parseDocsOrchestrator(content) {
  const defaults = { enabled: false, audiences: ['user', 'dev', 'vault'], mode: 'warn' };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (/^docs-orchestrator:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let doEnabled = false;
  let doMode = 'warn';
  const doAudiences = [];
  let inAudiencesList = false;
  const validAudiences = new Set(['user', 'dev', 'vault']);

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    if (/^\s+-\s+/.test(clean)) {
      if (inAudiencesList) {
        let item = clean.replace(/^\s+-\s+/, '').trim();
        if (item.startsWith('"') && item.endsWith('"')) item = item.slice(1, -1);
        else if (item.startsWith("'") && item.endsWith("'")) item = item.slice(1, -1);
        if (item && validAudiences.has(item)) doAudiences.push(item);
      }
      continue;
    }

    inAudiencesList = false;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        doEnabled = v.toLowerCase() === 'true';
        break;
      case 'mode':
        if (['strict', 'warn', 'off'].includes(v)) doMode = v;
        break;
      case 'audiences':
        if (!v) {
          inAudiencesList = true;
        } else {
          // Inline list: audiences: [user, dev, vault]
          const stripped = v.replace(/^\s*\[/, '').replace(/\]\s*$/, '').trim();
          if (stripped) {
            for (const item of stripped.split(',').map(s => s.trim())) {
              if (item && validAudiences.has(item)) doAudiences.push(item);
            }
          }
        }
        break;
    }
  }

  return {
    enabled: doEnabled,
    audiences: doAudiences.length > 0 ? doAudiences : ['user', 'dev', 'vault'],
    mode: doMode,
  };
}
