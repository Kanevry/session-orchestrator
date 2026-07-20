import { matchBlockHeader } from './block-header.mjs';

/**
 * worktree-orphans.mjs — Parser for the top-level `worktree-orphans:` YAML block.
 *
 * Config block shape (see docs/session-config-template.md):
 *   worktree-orphans:
 *     enabled: false
 *     base-branch: main
 *     mode: warn
 *
 * Mirrors the docs-staleness.mjs parser design (issue #831 / B5), but flat —
 * there is no nested threshold map, just three scalar keys.
 *
 * Opt-in by design: `enabled` defaults to `false`, so a repo that has never
 * heard of this block never pays a single git invocation for it.
 *
 * ZERO IMPORTS beyond ./block-header.mjs: tests/lib/config/cycle-guard.test.mjs
 * forbids any scripts/lib/config/*.mjs from importing ../config.mjs.
 */

/**
 * Parse the top-level `worktree-orphans:` YAML block from markdown content.
 * Defaults: enabled=false, base-branch="main", mode="warn".
 *
 * @param {string} content — full file contents
 * @returns {{enabled: boolean, 'base-branch': string, mode: string}}
 */
export function _parseWorktreeOrphans(content) {
  const defaults = {
    enabled: false,
    'base-branch': 'main',
    mode: 'warn',
  };

  if (typeof content !== 'string' || content === '') return defaults;

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      // #830: bold-tolerant header match — never a hand-rolled regex.
      if (matchBlockHeader(line, 'worktree-orphans')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let woEnabled = false;
  let woBaseBranch = 'main';
  let woMode = 'warn';

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
        woEnabled = v.toLowerCase() === 'true';
        break;
      case 'base-branch':
        // Any non-empty scalar is accepted — branch names are repo-specific.
        if (v.length > 0) woBaseBranch = v;
        break;
      case 'mode':
        if (['warn', 'off'].includes(v)) woMode = v;
        break;
    }
  }

  return { enabled: woEnabled, 'base-branch': woBaseBranch, mode: woMode };
}
