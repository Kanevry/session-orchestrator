/**
 * cold-start.mjs — Parser for the top-level `cold-start:` YAML block (PRD F1.3 /
 * issue #500). Drives the cold-start detector that nudges operators about long
 * idle periods or memory silence.
 *
 * Returns `{ enabled, "nudge-after-hours", "silence-after-sessions" }`.
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumer: `scripts/lib/cold-start-detector.mjs` (I2's code).
 */

/**
 * Parse the top-level `cold-start:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   enabled:                  true
 *   nudge-after-hours:        1 (integer ≥ 0)
 *   silence-after-sessions:   1 (integer ≥ 0)
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean, "nudge-after-hours": number, "silence-after-sessions": number }}
 */
export function _parseColdStart(content) {
  const defaults = {
    enabled: true,
    'nudge-after-hours': 1,
    'silence-after-sessions': 1,
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (/^cold-start:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let csEnabled = true;
  let csNudgeAfterHours = 1;
  let csSilenceAfterSessions = 1;

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
        // Default is true → only flip to false on explicit "false"
        csEnabled = v.toLowerCase() !== 'false';
        break;
      case 'nudge-after-hours': {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n >= 0) csNudgeAfterHours = n;
        }
        break;
      }
      case 'silence-after-sessions': {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n >= 0) csSilenceAfterSessions = n;
        }
        break;
      }
    }
  }

  return {
    enabled: csEnabled,
    'nudge-after-hours': csNudgeAfterHours,
    'silence-after-sessions': csSilenceAfterSessions,
  };
}
