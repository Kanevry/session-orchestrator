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
 * Valid `base-branch` character set — mirrors `ENTER_WORKTREE_BRANCH_RE` in
 * scripts/lib/autopilot/worktree-pipeline.mjs (itself mirroring the private
 * `isValidBranch()` in scripts/lib/session-id.mjs). Duplicated rather than
 * imported because this parser is dependency-free by contract (see header) and
 * `isValidBranch` is module-private; worktree-pipeline.mjs sets the precedent
 * for mirroring it locally.
 */
const BASE_BRANCH_CHARSET = /^[A-Za-z0-9._/-]+$/;

/**
 * Decide whether a `base-branch` value is safe to hand to the Phase 4b sweep.
 *
 * The consumer (scripts/lib/session-end/worktree-orphan-sweep.mjs) interpolates
 * this value into the argv token `` `${baseBranch}..${branch}` `` for
 * `git rev-list --count`. Two failure modes make a charset check load-bearing:
 *
 *  1. OPTION-SHAPED values. `git rev-list` parses a leading-`-` token as an
 *     OPTION, not a revision. `--glob=refs/heads/*` makes rev-list answer about
 *     a completely different ref set and exit 0 with `0` — a silent WRONG
 *     answer, not an error, so the sweep's conservative-on-error guard never
 *     fires and every worktree is reported as a 0-ahead orphan.
 *  2. RANGE-CORRUPTING values. A value containing `..` yields `a..b..branch`.
 *
 * No shell-out: `git check-ref-format --branch` is the semantic reference, but
 * a config parser must stay a pure function. The charset + prefix/suffix rules
 * below are a conservative SUBSET of what git accepts — a rejected value falls
 * back to the `main` default rather than failing the parse, because a
 * mistyped branch name must never escalate into a broken session config.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function _isSafeBaseBranch(v) {
  if (typeof v !== 'string' || v.length === 0) return false;
  // Rejects whitespace and every shell-ish character (= * ; | & $ ` ' " ( ) < >),
  // which also rejects `--glob=refs/heads/*` on the `=` and `*` alone.
  if (!BASE_BRANCH_CHARSET.test(v)) return false;
  // The charset permits `-` so that `my-branch` works; a LEADING `-` is the
  // option-shaped case and must be rejected explicitly.
  if (v.startsWith('-')) return false;
  // Would corrupt the `<base>..<branch>` range token at the sink.
  if (v.includes('..')) return false;
  // git check-ref-format: no leading/trailing `/` or `.`, no `.lock` suffix.
  if (v.startsWith('/') || v.endsWith('/')) return false;
  if (v.startsWith('.') || v.endsWith('.')) return false;
  if (v.endsWith('.lock')) return false;
  return true;
}

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
        // NOT "any non-empty scalar": an option-shaped or range-corrupting
        // value is silently dropped in favour of the safe `main` default.
        // See _isSafeBaseBranch() for why this is a security boundary.
        if (_isSafeBaseBranch(v)) woBaseBranch = v;
        break;
      case 'mode':
        if (['warn', 'off'].includes(v)) woMode = v;
        break;
    }
  }

  return { enabled: woEnabled, 'base-branch': woBaseBranch, mode: woMode };
}
