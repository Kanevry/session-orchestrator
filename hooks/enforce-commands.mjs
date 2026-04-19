#!/usr/bin/env node
/**
 * enforce-commands.mjs — PreToolUse hook: blocks dangerous Bash commands.
 *
 * Node.js port of hooks/enforce-commands.sh. Part of v3.0.0 migration
 * (Epic #124, issue #138). ESM, Node 20+, no external dependencies beyond stdlib.
 *
 * Decision flow (8 gates, early-exit):
 *   G1 tool filter — only Bash tool is gated
 *   G2 command present + string
 *   G3 wave-scope.json exists
 *   G4 command-guard gate enabled
 *   G5 enforcement != "off"
 *   G6 blocked pattern match against .blockedCommands[], or
 *      fallback safety list when .blockedCommands is empty
 *   G7 strict → deny (exit 2); warn → stderr + allow (exit 0); otherwise allow
 *
 * SECURITY-REQ-01: try/catch on main(). emitDeny on any unhandled error —
 *   exit 2, never exit 1. Null-guard readStdin() return.
 * SECURITY-REQ-07: FALLBACK_BLOCKED includes 'git push -f' and 'drop table'
 *   (short form + case variant gaps in the original Bash fallback list).
 * SECURITY-REQ-08: scope file read exactly once per invocation.
 */

import { readStdin, emitAllow, emitDeny, emitWarn } from '../scripts/lib/io.mjs';
import { resolveProjectDir } from '../scripts/lib/platform.mjs';
import {
  findScopeFile,
  commandMatchesBlocked,
  suggestForCommandBlock,
} from '../scripts/lib/hardening.mjs';
import { readJson } from '../scripts/lib/common.mjs';

// Fallback safety list — applied when scope.blockedCommands is empty.
// Keep in sync with hooks/enforce-commands.sh; v3 additions (#138, SECURITY-REQ-07)
// cover the short-form git push and the lowercase SQL variant the Bash version missed.
const FALLBACK_BLOCKED = [
  'rm -rf',
  'git push --force',
  'git push -f',
  'git reset --hard',
  'DROP TABLE',
  'drop table',
  'git checkout -- .',
];

async function main() {
  const input = await readStdin();
  if (!input) return emitAllow();

  // G1 — only Bash is gated
  if (input.tool_name !== 'Bash') return emitAllow();

  // G2 — command must be a non-empty string
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return emitAllow();

  const projectRoot = resolveProjectDir();

  // G3 — no scope file → allow
  const scopePath = findScopeFile(projectRoot);
  if (!scopePath) return emitAllow();

  // SECURITY-REQ-08: read scope file exactly once; use the parsed object
  // for all subsequent gate checks.
  let scope;
  try {
    scope = await readJson(scopePath);
  } catch {
    scope = {};
  }
  const enforcement = scope.enforcement || 'strict';
  const blockedCommands = Array.isArray(scope.blockedCommands)
    ? scope.blockedCommands
    : [];
  const gateOn = scope?.gates?.['command-guard'] !== false;

  // G4 — gate disabled → allow
  if (!gateOn) return emitAllow();
  // G5 — enforcement "off" → allow
  if (enforcement === 'off') return emitAllow();

  // G6 — determine which list to check
  const useFallback = blockedCommands.length === 0;
  const patternsToCheck = useFallback ? FALLBACK_BLOCKED : blockedCommands;

  for (const pattern of patternsToCheck) {
    if (commandMatchesBlocked(command, pattern)) {
      const prefix = useFallback
        ? 'Blocked by fallback safety list'
        : 'Blocked command';
      const reason = `${prefix}: '${pattern}' found in command`;
      const suggestion = suggestForCommandBlock(pattern);
      if (enforcement === 'strict') {
        return emitDeny(reason, suggestion);
      }
      return emitWarn(`${reason} — ${suggestion}`);
    }
  }

  // G7 — no match → allow
  return emitAllow();
}

// SECURITY-REQ-01 (F-03): top-level try/catch — never let exit 1 leak.
main().catch((e) => {
  emitDeny('Internal hook error — request blocked for safety', `${e?.message || e}`);
});
