#!/usr/bin/env node
/**
 * post-tooluse-frontend-slop.mjs — PostToolUse hook that runs the deterministic
 * frontend-slop detector on a UI file right after it is edited.
 *
 * Issue #684 (Track 2 / item B). OPT-IN, warn-only, NON-BLOCKING. PostToolUse
 * fires AFTER the edit is already applied, so this hook can never block — it
 * only surfaces an `additionalContext` roll-up of detector findings so the
 * agent sees the slop signal on its next turn. Mirrors hooks/loop-guard.mjs.
 *
 * Decision flow:
 *   1. shouldRunHook('frontend-slop-hook') gate — exit 0 when disabled via profile.
 *   2. Read JSON payload from stdin (null-on-failure; never throws).
 *   3. tool_name gate: proceed only for Edit | Write | MultiEdit, else exit 0.
 *   4. file_path gate: exit 0 if absent / non-string.
 *   5. Extension gate: exit 0 unless path.extname(file) ∈ SCANNABLE_EXTS (SSOT).
 *   6. Session Config gate: exit 0 unless `frontend-slop-hook.enabled === true`
 *      (OPT-IN — default off).
 *   7. detectFiles([file]) (fail-soft). No findings → exit 0 silently.
 *   8. Output: additionalContext roll-up on stdout (NEVER blocks). Best-effort
 *      orchestrator.frontend_slop.warning event.
 *
 * Exit codes: 0 always (informational, never blocking).
 */

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('frontend-slop-hook')) process.exit(0);

import path from 'node:path';

import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';
import { emitEvent } from '../scripts/lib/events.mjs';
import { detectFiles, SCANNABLE_EXTS } from '../scripts/lib/frontend-detect/detect.mjs';
import { loadFrontendSlopHookConfig } from '../scripts/lib/config/frontend-slop-hook.mjs';

// ---------------------------------------------------------------------------
// stdin reading (inline null-on-failure — PostToolUse hooks never throw)
// ---------------------------------------------------------------------------

/**
 * Read stdin to EOF (best-effort). Returns parsed JSON or null on failure.
 * Uses a 5 s timeout consistent with the Claude Code hook contract.
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Tool names whose payloads carry an editable file path. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/**
 * Resolve the session id from the hook payload. Precedence:
 *   session_id → parent_session_id → null.
 *
 * @param {object} input
 * @returns {string|null}
 */
function resolveSessionId(input) {
  if (typeof input.session_id === 'string' && input.session_id.length > 0) {
    return input.session_id;
  }
  if (typeof input.parent_session_id === 'string' && input.parent_session_id.length > 0) {
    return input.parent_session_id;
  }
  return null;
}

/**
 * Render the file path relative to the project root for display, falling back
 * to the basename when it lives outside the root (e.g. a temp sandbox).
 *
 * @param {string} filePath — absolute or cwd-relative file path
 * @returns {string}
 */
function toRelPath(filePath) {
  try {
    const rel = path.relative(SO_PROJECT_DIR, filePath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  } catch { /* fall through */ }
  return path.basename(filePath);
}

/**
 * Build a compact one-line warning roll-up from the detector findings.
 *
 * @param {import('../scripts/lib/frontend-detect/detect.mjs').Finding[]} findings
 * @param {string} relPath
 * @returns {string}
 */
function buildWarning(findings, relPath) {
  const total = findings.length;
  // Show up to the first 5 findings as "<rule-id> L<line>"; aggregate fpRisk.
  const shown = findings.slice(0, 5).map((f) => `${f.rule} L${f.line}`);
  const more = total > shown.length ? `, +${total - shown.length} more` : '';
  const fpRisks = [...new Set(findings.map((f) => f.fpRisk))];
  return (
    `⚠ frontend-slop: ${total} finding(s) in ${relPath} — ` +
    `${shown.join(', ')}${more} (fpRisk: ${fpRisks.join('/')}). ` +
    `See rules/opt-in-stack/frontend.md`
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdinJson();
  // No payload at all → nothing to scan. Exit 0 (handled in finally).
  if (!input) return;

  const toolName = typeof input.tool_name === 'string' ? input.tool_name : null;
  // Only edit-shaped tools carry a file path worth scanning.
  if (!toolName || !EDIT_TOOLS.has(toolName)) return;

  const toolInput = input.tool_input;
  const filePath =
    toolInput && typeof toolInput.file_path === 'string' ? toolInput.file_path : null;
  if (!filePath) return;

  // Extension gate — reuse the detector's SSOT set, never re-list extensions.
  const ext = path.extname(filePath).toLowerCase();
  if (!SCANNABLE_EXTS.has(ext)) return;

  // Session Config gate — OPT-IN (default off).
  const config = await loadFrontendSlopHookConfig({ repoRoot: SO_PROJECT_DIR });
  if (config.enabled !== true) return;

  // Run the deterministic detector (fail-soft: unreadable files → []).
  const findings = detectFiles([filePath]);
  if (findings.length === 0) return;

  const relPath = toRelPath(filePath);
  const sessionId = resolveSessionId(input);

  // Best-effort telemetry — must never block the hook.
  const high = findings.filter((f) => f.severity === 'high').length;
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  try {
    await emitEvent('orchestrator.frontend_slop.warning', {
      ...(sessionId ? { session_id: sessionId } : {}),
      file: relPath,
      total: findings.length,
      high,
      by_rule: byRule,
    });
  } catch { /* best-effort — hook must remain non-blocking */ }

  // Output: PostToolUse cannot block an applied edit — surface the roll-up only.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: buildWarning(findings, relPath),
    },
  }));
}

// Exit 0 always — informational hook must never block Claude (#684).
main().catch(() => {}).finally(() => process.exit(0));
