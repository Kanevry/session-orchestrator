/**
 * test.mjs — Parser for the top-level `test:` YAML block.
 *
 * Mirrors the docs-orchestrator / events-rotation block-parser pattern.
 * Promoted from the inline _parseTestBlock in scripts/parse-config.mjs
 * as part of the /test epic (#378) Track B wiring.
 */

import path from 'node:path';
import { realpathSync } from 'node:fs';
import { isPathInside } from '../path-utils.mjs';

/**
 * Parse the top-level `test:` YAML block from markdown content.
 * Returns defaults when the block is absent.
 * @param {string} content — full CLAUDE.md / AGENTS.md content
 * @returns {{enabled: boolean, "default-profile": string, "profiles-path": string, mode: string, "retention-days": number}}
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
          // SEC-IR-LOW-2 + SEC-Q2-LOW-1: reject path-traversal and symlink-escape in profiles-path (CWE-23)
          // Phase 1 — lexical guard: reject traversal-escaped paths without filesystem access.
          // Phase 2 — symlink-escape guard: when the path exists, resolve symlinks and re-check.
          const projectRoot = process.cwd();
          const resolved = path.resolve(projectRoot, v);
          if (isPathInside(resolved, projectRoot)) {
            // Phase 2: if path already exists on disk, verify realpath stays inside project root.
            let symlinksOk = true;
            try {
              const resolvedReal = realpathSync(resolved);
              if (!isPathInside(resolvedReal, projectRoot)) {
                symlinksOk = false;
              }
            } catch {
              // path not on disk yet — lexical check is sufficient
            }
            if (symlinksOk) tcProfilesPath = v;
          }
          // Silent skip on traversal/symlink-escape — matches the lenient pattern used by other case branches
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
