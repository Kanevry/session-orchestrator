/**
 * verification-auto-fix.mjs — Parser for the top-level `verification-auto-fix:`
 * YAML block (PRD gsd Pattern Adoption Quick-Wins — Pattern 4 / issues #517, #521).
 *
 * Drives the opt-in auto-fix retry loop that dispatches a fixer-agent after
 * a wave Quality-Gate failure with the corrective context bundle, up to
 * `max-retries` times before aborting the wave.
 *
 * Returns `{ enabled, "max-retries" }`.
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumer: `scripts/lib/quality-gate.mjs` + `skills/wave-executor/` (Wave 4).
 */

/**
 * Parse the top-level `verification-auto-fix:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   enabled:     false (opt-in)
 *   max-retries: 2 (integer ≥ 0)
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean, "max-retries": number }}
 */
export function _parseVerificationAutoFix(content) {
  const defaults = {
    enabled: false,
    'max-retries': 2,
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (/^verification-auto-fix:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let vafEnabled = false;
  let vafMaxRetries = 2;

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
        vafEnabled = v.toLowerCase() === 'true';
        break;
      case 'max-retries': {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n >= 0) vafMaxRetries = n;
        }
        break;
      }
    }
  }

  return {
    enabled: vafEnabled,
    'max-retries': vafMaxRetries,
  };
}
