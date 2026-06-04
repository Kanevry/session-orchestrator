/**
 * config-protection.mjs — Parser for the top-level `config-protection:` YAML
 * block (ecc-analysis / issue #622).
 *
 * Drives the PreToolUse Edit|Write guard that intercepts edits to a small
 * allow-list of quality-gate config files (eslint / vitest / tsconfig /
 * prettier / commitlint / gitleaks) and WARNs — or, in `strict` mode, blocks —
 * when an edit LOOSENS a gate (threshold lowered, disable/ignore directive
 * added, rule removed, gitleaks allowlist widened, tsconfig strictness
 * relaxed). The edit-tool analogue of the test-the-mock gate-cheating
 * anti-pattern. First-time creation, tightening, and neutral edits are always
 * allowed. A `allow-config-weakening: true` Session Config line bypasses the
 * guard for the session (mirrors `allow-destructive-ops`).
 *
 * Returns `{ enabled, mode }`.
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumer: `hooks/config-protection.mjs`.
 */

/** Valid `mode` values. Unknown values fall back to the default. */
const VALID_MODES = new Set(['warn', 'strict']);
const DEFAULT_MODE = 'warn';

/**
 * Parse the top-level `config-protection:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary (mirrors the other
 * config parsers in this directory — tolerant, defaults-on-malformed).
 *
 * Defaults:
 *   enabled: true
 *   mode:    'warn'   (warn → stderr + event + exit 0; strict → block, exit 2)
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean, mode: 'warn'|'strict' }}
 */
export function _parseConfigProtection(content) {
  const defaults = {
    enabled: true,
    mode: DEFAULT_MODE,
  };

  if (typeof content !== 'string' || content.length === 0) return defaults;

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (/^config-protection:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let cpEnabled = true;
  let cpMode = DEFAULT_MODE;

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
        // Default is true → only flip to false on explicit "false".
        cpEnabled = v.toLowerCase() !== 'false';
        break;
      case 'mode': {
        const lower = v.toLowerCase();
        cpMode = VALID_MODES.has(lower) ? lower : DEFAULT_MODE;
        break;
      }
    }
  }

  return {
    enabled: cpEnabled,
    mode: cpMode,
  };
}

/**
 * Detect the per-session bypass `allow-config-weakening: true`. This is a
 * top-level Session Config line (NOT inside the `config-protection:` block),
 * mirroring `allow-destructive-ops`. Line-scoped within the `## Session Config`
 * section, exactly like `pre-bash-destructive-guard.mjs`'s bypass scan.
 *
 * @param {string} content — full file contents
 * @returns {boolean} true when the bypass is explicitly set to `true`
 */
export function _isConfigWeakeningAllowed(content) {
  if (typeof content !== 'string' || content.length === 0) return false;

  const lines = content.split(/\r?\n/);
  let inConfig = false;
  for (const line of lines) {
    if (line === '## Session Config') { inConfig = true; continue; }
    if (inConfig && /^## /.test(line)) break;
    if (inConfig) {
      const m = line.match(/^\s*(?:-\s+\*\*)?allow-config-weakening(?::\*\*)?\s*:\s*(\S+)/);
      if (m && m[1].toLowerCase() === 'true') return true;
    }
  }
  return false;
}
