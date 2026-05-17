#!/usr/bin/env node
/**
 * post-tool-failure-corrective-context.mjs — PostToolUseFailure hook.
 *
 * Hook event: PostToolUseFailure (issue #342).
 * Fires after a tool invocation exits with a non-zero status or produces an
 * error payload. Appends a structured corrective-context note to the
 * `corrective_context` array in `.orchestrator/current-session.json` so the
 * coordinator and downstream skills can inspect recent tool failures without
 * re-reading the full event log.
 *
 * Decision flow:
 *   1. shouldRunHook gate — exit 0 immediately when the hook is disabled.
 *   2. Read JSON payload from stdin: { tool_name, tool_input, error, exit_code }.
 *   3. Build a compact note: { timestamp, tool_name, error_summary, exit_code }.
 *      error_summary is capped at 256 chars to keep the session file lean.
 *   4. Atomic read-modify-write of .orchestrator/current-session.json:
 *      append to `corrective_context` array (create if absent), keep last 20
 *      entries to bound file growth.
 *   5. Write to stderr only (stdout must remain clean — hook is informational).
 *
 * Exit codes: 0 always (informational, never blocking).
 *
 * hooks.json wiring is managed separately (W3-C4 scope).
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('post-tool-failure-corrective-context')) process.exit(0);

import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of corrective context entries retained per session. */
const MAX_ENTRIES = 20;

/** Maximum length of error_summary field (chars). */
const MAX_ERROR_SUMMARY_CHARS = 256;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read stdin to EOF (best-effort). Returns parsed JSON or null on failure.
 * Uses a 5 s timeout consistent with Claude Code hook contract.
 *
 * @returns {Promise<object|null>}
 */
function readStdinJson() {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded || process.stdin.closed) {
      resolve(null);
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => { resolve(null); }, 5_000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      const raw = chunks.join('').trim();
      if (!raw) { resolve(null); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(null); });
    process.stdin.resume();
  });
}

/**
 * Atomic read-modify-write of a JSON file.
 * Reads the existing file (or starts with `defaultValue` when absent),
 * applies `mutate`, writes to a tmp file, renames over the original.
 *
 * @param {string} filePath
 * @param {object} defaultValue — used when the file does not exist
 * @param {function(object): object} mutate — pure transformer
 */
async function atomicMutateJson(filePath, defaultValue, mutate) {
  let current = defaultValue;
  try {
    const raw = await readFile(filePath, 'utf8');
    current = JSON.parse(raw);
  } catch {
    // File absent or unparseable — start from defaultValue.
  }

  const updated = mutate(current);
  const tmp = `${filePath}.tmp-ptf-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tmp, JSON.stringify(updated, null, 2) + '\n', 'utf8');

  // Rename is atomic on POSIX (same-filesystem). On Windows this is best-effort
  // via the fs.rename syscall (may fail if target is locked — swallowed by
  // the catch in main()).
  await rename(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Derive a short cause-hint and suggestion based on the tool name and
 * error text. All strings are kept short to stay within the ~500-char
 * additionalContext budget.
 *
 * @param {string|null} toolName
 * @param {string|null} errorSummary
 * @returns {{ cause: string, suggestion: string }}
 */
function deriveHints(toolName, errorSummary) {
  const err = (errorSummary ?? '').toLowerCase();

  if (toolName === 'Bash') {
    if (err.includes('permission denied') || err.includes('eacces')) {
      return {
        cause: 'insufficient file permissions',
        suggestion: 'check file mode with `ls -la` and adjust with `chmod` if needed',
      };
    }
    if (err.includes('command not found') || err.includes('enoent')) {
      return {
        cause: 'command or binary not on PATH',
        suggestion: 'verify the binary is installed and `which <cmd>` resolves it',
      };
    }
    if (err.includes('timeout') || err.includes('timed out')) {
      return {
        cause: 'command exceeded time limit',
        suggestion: 'increase the timeout parameter or break the command into smaller steps',
      };
    }
    return {
      cause: 'shell command exited non-zero',
      suggestion: 'inspect the error output above, fix the root cause, and retry',
    };
  }

  if (toolName === 'Edit' || toolName === 'Write') {
    if (err.includes('no such file') || err.includes('enoent')) {
      return {
        cause: 'target file or parent directory does not exist',
        suggestion: 'create the missing directory with `mkdir -p` before writing',
      };
    }
    if (err.includes('old_string not found') || err.includes('not unique')) {
      return {
        cause: 'old_string did not match any text in the file',
        suggestion: 're-read the file to confirm the exact text, then retry with a wider context window',
      };
    }
    return {
      cause: 'file edit failed',
      suggestion: 're-read the file to verify its current state, then retry',
    };
  }

  if (toolName === 'Read') {
    return {
      cause: 'file could not be read (missing or unreadable)',
      suggestion: 'verify the path exists and is accessible before retrying',
    };
  }

  if (toolName === 'Glob' || toolName === 'Grep') {
    return {
      cause: 'search returned an error (bad pattern or missing directory)',
      suggestion: 'check the pattern syntax and confirm the search root exists',
    };
  }

  // Fallback for unknown tools.
  return {
    cause: 'tool invocation failed',
    suggestion: 'check the error details above and retry with corrected parameters',
  };
}

async function main() {
  const input = await readStdinJson();

  // Extract fields from the hook payload. All optional — missing fields are
  // represented as null in the stored note.
  const toolName = typeof input?.tool_name === 'string' ? input.tool_name : null;
  const exitCode = typeof input?.exit_code === 'number' ? input.exit_code : null;

  const rawError =
    typeof input?.error === 'string'
      ? input.error
      : (input?.error !== null && input?.error !== undefined ? String(input.error) : null);

  const errorSummary = rawError !== null
    ? rawError.slice(0, MAX_ERROR_SUMMARY_CHARS)
    : null;

  const note = {
    timestamp: new Date().toISOString(),
    tool_name: toolName,
    error_summary: errorSummary,
    exit_code: exitCode,
  };

  const sessionFile = path.join(SO_PROJECT_DIR, '.orchestrator', 'current-session.json');

  await atomicMutateJson(sessionFile, {}, (current) => {
    const existing = Array.isArray(current.corrective_context)
      ? current.corrective_context
      : [];
    // Append the new note and cap at MAX_ENTRIES (keep most-recent).
    const updated = [...existing, note].slice(-MAX_ENTRIES);
    return { ...current, corrective_context: updated };
  });

  // Surface corrective context to Claude via additionalContext on the next turn.
  // PostToolUseFailure hookSpecificOutput shape per CC docs:
  //   { hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "<string>" } }
  // Keep the message under ~500 chars so it stays readable.
  const { cause, suggestion } = deriveHints(toolName, errorSummary);
  const toolLabel = toolName ?? 'unknown tool';
  const exitLabel = exitCode !== null ? ` (exit ${exitCode})` : '';
  // Strip control chars (newlines, ANSI escapes) before forwarding to additionalContext —
  // SEC-016 (Log Injection): tool errors may contain attacker-controlled bytes.
  const safeSummary = errorSummary
    ? errorSummary.replace(/[\r\n]/g, ' ').split('').join(' ').slice(0, 120)
    : '';
  const summaryLabel = safeSummary ? ` Error: ${safeSummary}` : '';
  const additionalContext =
    `Tool failure: ${toolLabel}${exitLabel}.${summaryLabel} ` +
    `Common cause: ${cause}. Try: ${suggestion}.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure',
      additionalContext: additionalContext.slice(0, 500),
    },
  }));
}

// Exit 0 always — informational hook must never block Claude.
main().catch(() => {}).finally(() => process.exit(0));
