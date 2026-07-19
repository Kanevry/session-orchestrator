/**
 * frontend-slop-hook.mjs — Parser + loader for the top-level
 * `frontend-slop-hook:` YAML block (#684, Track 2 / item B).
 *
 * Drives the OPT-IN, NON-BLOCKING PostToolUse hook that runs the deterministic
 * frontend-slop detector (scripts/lib/frontend-detect/detect.mjs) on a UI file
 * right after it is edited and surfaces findings as an `additionalContext`
 * roll-up. Warn-only / never blocks; profile-gate also applies.
 *
 * Returns `{ enabled }`. DEFAULT OFF (`enabled: false`) — opt-in by design,
 * unlike loop-guard which defaults on. The flag only flips to `true` on an
 * explicit `enabled: true` line under a column-0 `frontend-slop-hook:` block.
 * Tolerant parser: any other value (or an absent block) resolves to disabled.
 *
 * Consumer: `hooks/post-tooluse-frontend-slop.mjs`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { SO_PROJECT_DIR } from '../platform.mjs';
import { matchBlockHeader } from './block-header.mjs';

/**
 * Parse the top-level `frontend-slop-hook:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary (mirrors
 * `_parseLoopGuard`).
 *
 * Default:
 *   enabled: false   (OPT-IN — only an explicit `enabled: true` enables it)
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean }}
 */
export function _parseFrontendSlopHook(content) {
  const defaults = { enabled: false };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'frontend-slop-hook')) inBlock = true;
      continue;
    }
    // A column-0 (non-indented) non-blank line ends the block.
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let fshEnabled = false;

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    if (k === 'enabled') {
      // Default is false → only flip to true on explicit "true".
      fshEnabled = v.toLowerCase() === 'true';
    }
  }

  return { enabled: fshEnabled };
}

/**
 * Load `frontend-slop-hook.*` from CLAUDE.md (or AGENTS.md) at the project root.
 * Cheap inline read — avoids importing the full config orchestrator from a hot
 * hook path. Default OFF: a read failure (no instruction file) resolves to the
 * parser defaults (`enabled: false`). Mirrors `loadConfig()` in
 * hooks/loop-guard.mjs.
 *
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<{ enabled: boolean }>}
 */
export async function loadFrontendSlopHookConfig(opts = {}) {
  const root = opts.repoRoot || SO_PROJECT_DIR;
  const candidates = [
    path.join(root, 'CLAUDE.md'),
    path.join(root, 'AGENTS.md'),
  ];
  for (const file of candidates) {
    try {
      const content = await fs.readFile(file, 'utf8');
      return _parseFrontendSlopHook(content);
    } catch {
      // missing or unreadable — try next candidate
    }
  }
  // No CLAUDE.md/AGENTS.md → parser defaults (enabled:false).
  return _parseFrontendSlopHook('');
}
