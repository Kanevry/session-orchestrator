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
 * Mirrors the harness convention: `~/.claude/projects/<encoded-cwd>/memory/`
 * where `<encoded-cwd>` is the cwd with BOTH `/` AND `.` replaced by `-`. The
 * dot replacement matters for users with a trailing-`.` in their home dir
 * (e.g. `/Users/<owner>.`) — without it the resolved path diverges from
 * what the harness actually wrote.
 *
 * Verified empirically against `~/.claude/projects/` directory naming.
 *
 * @returns {string} Absolute path to the memory directory (not guaranteed to exist).
 */
export function resolveMemoryDir() {
  const encoded = process.cwd().replaceAll('/', '-').replaceAll('.', '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded, 'memory');
}
