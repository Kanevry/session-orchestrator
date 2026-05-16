#!/usr/bin/env node
/**
 * operator-steer.mjs — PostToolBatch hook for operator in-band steering.
 *
 * Hook event: PostToolBatch (issue #409).
 * Fires after a batch of tool invocations completes within a single wave turn.
 * Reads `.orchestrator/STEER.md` and, if non-empty, emits its contents as a
 * `systemMessage` payload to stdout so Claude Code injects the guidance into
 * the active session context. The file is then truncated (set to empty) so the
 * message fires exactly once per write — a one-shot handshake.
 *
 * Operator workflow:
 *   echo "Focus on error handling in wave 3" > .orchestrator/STEER.md
 *   # Claude picks it up at the next PostToolBatch boundary, clears the file.
 *
 * Decision flow:
 *   1. shouldRunHook gate — exit 0 immediately when the hook is disabled.
 *   2. Resolve steerPath: $SO_PROJECT_DIR/.orchestrator/STEER.md
 *   3. If the file is absent or whitespace-only → exit 0 silently.
 *   4. If non-empty: emit { systemMessage: <contents> } to stdout, then
 *      truncate the file to '' so it fires only once.
 *
 * Output contract (PostToolBatch):
 *   stdout: JSON — { systemMessage: string }
 *   stderr: nothing (diagnostic errors swallowed)
 *   exit code: 0 always (informational — must never block Claude)
 *
 * TODO(#409): Cursor support — hooks-cursor.json uses a different event model
 *   (no PostToolBatch equivalent) and is not wired here. Register this hook
 *   in hooks-cursor.json when Cursor gains a suitable between-batch event.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('operator-steer')) process.exit(0);

import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const steerPath = path.join(SO_PROJECT_DIR, '.orchestrator', 'STEER.md');

  // File absent — nothing to do.
  if (!existsSync(steerPath)) return;

  // Read contents and check for meaningful (non-whitespace) content.
  const contents = readFileSync(steerPath, 'utf8');
  if (!contents.trim()) return;

  // Emit the systemMessage payload so Claude Code injects it into the session.
  console.log(JSON.stringify({ systemMessage: contents }));

  // Truncate the file — one-shot handshake, fires exactly once per write.
  writeFileSync(steerPath, '', 'utf8');
}

// Exit 0 always — informational hook must never block Claude.
main().catch(() => {}).finally(() => process.exit(0));
