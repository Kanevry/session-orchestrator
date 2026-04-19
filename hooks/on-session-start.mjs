#!/usr/bin/env node
/**
 * on-session-start.mjs — SessionStart hook: emit orchestrator.session.started event.
 *
 * Node.js port of hooks/on-session-start.sh. Part of v3.0.0 migration
 * (Epic #124, issue #140). ESM, Node 20+, no external dependencies beyond stdlib.
 *
 * Behaviour:
 *   1. Resolves project name and current git branch.
 *   2. Emits "orchestrator.session.started" event to .orchestrator/metrics/events.jsonl.
 *   3. Optionally POSTs to Clank Event Bus if CLANK_EVENT_SECRET is set.
 *
 * Exit codes:
 *   0 — always (informational, never blocking)
 *
 * hooks.json wiring (SessionStart, async: true, timeout: 3s) is managed separately.
 * stdin: none expected.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { emitEvent } from '../scripts/lib/events.mjs';
import { SO_PLATFORM, resolveProjectDir } from '../scripts/lib/platform.mjs';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in cwd; return trimmed stdout. Returns null on failure.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function gitOutput(args, cwd) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectRoot = resolveProjectDir();

  // Resolve project name: basename of git toplevel, falling back to cwd basename.
  const topLevel = await gitOutput(['rev-parse', '--show-toplevel'], projectRoot);
  const projectName = topLevel
    ? topLevel.split(/[/\\]/).filter(Boolean).pop() ?? 'unknown'
    : projectRoot.split(/[/\\]/).filter(Boolean).pop() ?? 'unknown';

  // Resolve current branch; fall back to "unknown" when detached HEAD or no git.
  const branch = (await gitOutput(['branch', '--show-current'], projectRoot)) ?? 'unknown';

  await emitEvent('orchestrator.session.started', {
    platform: process.env.SO_PLATFORM ?? SO_PLATFORM,
    project: projectName,
    branch,
  });
}

// Top-level guard — always exit 0 (non-blocking informational hook).
main().catch(() => {}).finally(() => {
  process.exit(0);
});
