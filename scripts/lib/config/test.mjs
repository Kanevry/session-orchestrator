/**
 * test.mjs — Parser for the top-level `test:` YAML block.
 *
 * Mirrors the docs-orchestrator / events-rotation block-parser pattern.
 * Promoted from the inline _parseTestBlock in scripts/parse-config.mjs
 * as part of the /test epic (#378) Track B wiring.
 */

import { validatePathInsideProject } from '../path-utils.mjs';

/**
 * Parse the top-level `test:` YAML block from markdown content.
 * Returns defaults when the block is absent.
 * @param {string} content — full CLAUDE.md / AGENTS.md content
 * @returns {{enabled: boolean, "default-profile": string, "profiles-path": string, mode: string, "retention-days": number}}
 *   `profiles-path` is stored as an absolute path (realpath-resolved when the target exists,
 *   lexically-resolved via `path.resolve(cwd, v)` when the target does not exist yet) —
 *   defeats post-validation symlink-swap TOCTOU (#405, deep-4 deep-5).
 */
export function _parseTest(content) {
  const defaults = {
    enabled: false,
    'default-profile': 'smoke',
    'profiles-path': '.orchestrator/policy/test-profiles.json',
    mode: 'warn',
    'retention-days': 30,
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      // Match top-level `test:` key (not indented, no inline value after colon)
      if (/^test:\s*$/.test(line)) {
        inBlock = true;
      }
      continue;
    }
    // Any non-empty, non-indented line closes the block
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let tcEnabled = false;
  let tcDefaultProfile = 'smoke';
  let tcProfilesPath = '.orchestrator/policy/test-profiles.json';
  let tcMode = 'warn';
  let tcRetentionDays = 30;

  const validModes = new Set(['warn', 'strict', 'off']);

  for (const rawLine of blockLines) {
    // Strip inline YAML comments and trailing whitespace
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    // Strip surrounding quotes
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        tcEnabled = v.toLowerCase() === 'true';
        break;
      case 'default-profile':
        if (v) tcDefaultProfile = v;
        break;
      case 'profiles-path':
        if (v) {
          // SEC-IR-LOW-2 + SEC-Q2-LOW-1 + #402 + #405:
          // Delegate two-phase path-traversal + symlink-escape guard to the shared helper.
          // Store the resolved path (not raw v) to defeat TOCTOU symlink-swap attacks (#405).
          const projectRoot = process.cwd();
          const result = validatePathInsideProject(v, projectRoot);
          if (result.ok) {
            // Store resolved path, not raw v, to defeat TOCTOU symlink-swap (#405)
            tcProfilesPath = result.realPath || result.lexicalPath;
          }
          // Silent skip on failure — matches the lenient pattern of other case branches
        }
        break;
      case 'mode':
        if (validModes.has(v.toLowerCase())) tcMode = v.toLowerCase();
        break;
      case 'retention-days': {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n >= 0) tcRetentionDays = n;
        }
        break;
      }
    }
  }

  return {
    enabled: tcEnabled,
    'default-profile': tcDefaultProfile,
    'profiles-path': tcProfilesPath,
    mode: tcMode,
    'retention-days': tcRetentionDays,
  };
}
