/**
 * memory-paths.mjs — Memory-directory path resolution (Issue #512).
 *
 * Single-source helper for resolving the Claude Code memory directory layout.
 * Extracted from `scripts/lib/auto-dream.mjs` so memory-banner.mjs (and any
 * future consumer) can import the path helper without pulling in the entire
 * auto-dream surface (dream signals, sidecar I/O, decision logic).
 *
 * No external deps — Node 20+ stdlib only.
 */

import path from 'node:path';
import os from 'node:os';

/**
 * Resolve the project-specific memory directory used by the Claude Code harness.
 *
 * Mirrors the harness convention: `~/.claude/projects/<encoded-root>/memory/`
 * where `<encoded-root>` is the project root with BOTH `/` AND `.` replaced by
 * `-`. The dot replacement matters for users with a trailing-`.` in their home
 * dir (e.g. `/Users/<owner>.`) — without it the resolved path diverges from
 * what the harness actually wrote.
 *
 * Verified empirically against `~/.claude/projects/` directory naming.
 *
 * `repoRoot` is explicit (#1071) because every OTHER banner input is already
 * bound to it: with the memory dir alone derived from the ambient `process.cwd()`,
 * a caller reading sessions/learnings/peer-cards out of the primary checkout
 * reported `0 memory files` whenever the process ran from a worktree or a
 * subdirectory. Defaulted, so existing zero-arg callers keep their behaviour.
 *
 * @param {string} [repoRoot] — absolute project root; defaults to `process.cwd()`.
 * @returns {string} Absolute path to the memory directory (not guaranteed to exist).
 */
export function resolveMemoryDir(repoRoot = process.cwd()) {
  const root =
    typeof repoRoot === 'string' && repoRoot.length > 0 ? repoRoot : process.cwd();
  const encoded = root.replaceAll('/', '-').replaceAll('.', '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded, 'memory');
}
