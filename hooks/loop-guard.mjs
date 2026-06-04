#!/usr/bin/env node
/**
 * loop-guard.mjs — PostToolUse hook that detects runaway tool loops.
 *
 * Issue #619 (ecc-analysis). Lean, warn-only, NON-BLOCKING. Maintains a
 * per-session ring buffer of the last `window` (~5) {tool, argsHash} pairs and
 * injects an `additionalContext` loop-warning when the same (tool+argsHash)
 * recurs >= `threshold` (3) times inside that window. After firing, the ring is
 * reset (cooldown) so the next `threshold` identical calls are needed to
 * re-warn. NO cost / rate-table logic — that is explicitly out of scope.
 *
 * Decision flow:
 *   1. shouldRunHook('loop-guard') gate — exit 0 when disabled via profile.
 *   2. Read JSON payload from stdin (null-on-failure; never throws).
 *   3. Session Config gate: read CLAUDE.md/AGENTS.md `loop-guard.enabled` —
 *      exit 0 when explicitly false.
 *   4. Key the ring buffer on session_id (fallback parent_session_id, then
 *      'default'). Hash tool_input via sha256 (first 16 hex chars).
 *   5. Read → push → truncate to `window` → atomic write. On fire, emit
 *      additionalContext + an orchestrator.loop.warning event, then reset the
 *      ring (cooldown).
 *   6. Output: hookSpecificOutput JSON on fire; nothing otherwise.
 *
 * Exit codes: 0 always (informational, never blocking).
 */

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('loop-guard')) process.exit(0);

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';
import { emitEvent } from '../scripts/lib/events.mjs';
import { writeJsonAtomicSync } from '../scripts/lib/io.mjs';
import { _parseLoopGuard } from '../scripts/lib/config/loop-guard.mjs';

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
// config gate
// ---------------------------------------------------------------------------

/**
 * Read `loop-guard.*` from CLAUDE.md (or AGENTS.md) at the project root. Cheap
 * inline read — avoids importing the full config orchestrator from a hot hook
 * path. Default ON (enabled:true): a read failure resolves to the parser
 * defaults. Mirrors the isEnabled() shape in
 * hooks/post-subagent-discovery-validator.mjs.
 *
 * @returns {Promise<{ enabled: boolean, threshold: number, window: number }>}
 */
async function loadConfig() {
  const candidates = [
    path.join(SO_PROJECT_DIR, 'CLAUDE.md'),
    path.join(SO_PROJECT_DIR, 'AGENTS.md'),
  ];
  for (const file of candidates) {
    try {
      const content = await fs.readFile(file, 'utf8');
      return _parseLoopGuard(content);
    } catch {
      // missing or unreadable — try next candidate
    }
  }
  // No CLAUDE.md/AGENTS.md → parser defaults (enabled:true, threshold:3, window:5).
  return _parseLoopGuard('');
}

// ---------------------------------------------------------------------------
// ring-buffer helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the ring-buffer storage directory. The env override is REQUIRED for
 * test isolation — without it, parallel test runs would share os.tmpdir() and
 * collide on session-id keys.
 *
 * @returns {string}
 */
function ringDir() {
  return process.env.SO_LOOP_GUARD_DIR || os.tmpdir();
}

/**
 * Resolve the session key for the ring buffer. Precedence:
 *   session_id → parent_session_id → 'default'.
 *
 * @param {object|null} input
 * @returns {string}
 */
function resolveSessionKey(input) {
  if (input) {
    if (typeof input.session_id === 'string' && input.session_id.length > 0) {
      return input.session_id;
    }
    if (typeof input.parent_session_id === 'string' && input.parent_session_id.length > 0) {
      return input.parent_session_id;
    }
  }
  return 'default';
}

/**
 * Sanitize a session id to the safe filename charset [A-Za-z0-9_-]. Any other
 * character is replaced with '_'. Keeps the per-session ring files collision-
 * resistant without traversing directories.
 *
 * @param {string} sessionKey
 * @returns {string}
 */
function sanitizeSessionId(sessionKey) {
  return sessionKey.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Absolute path to this session's ring-buffer file.
 *
 * @param {string} sessionKey
 * @returns {string}
 */
function ringPath(sessionKey) {
  return path.join(ringDir(), `so-loop-guard-${sanitizeSessionId(sessionKey)}.json`);
}

/**
 * Read the ring-buffer state. Starts fresh on any read/parse failure.
 *
 * @param {string} filePath
 * @returns {Promise<{ recent: Array<{tool: string, hash: string}>, lastWarn: object|null }>}
 */
async function readRing(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const recent = Array.isArray(parsed?.recent) ? parsed.recent : [];
    const lastWarn = parsed && typeof parsed.lastWarn === 'object' ? parsed.lastWarn : null;
    return { recent, lastWarn };
  } catch {
    return { recent: [], lastWarn: null };
  }
}

/**
 * sha256(JSON.stringify(tool_input ?? {})) truncated to 16 hex chars.
 *
 * @param {*} toolInput
 * @returns {string}
 */
function hashArgs(toolInput) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(toolInput ?? {}))
    .digest('hex')
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdinJson();
  // No payload at all → nothing to track. Exit 0 (handled in finally).
  if (!input) return;

  const config = await loadConfig();
  if (config.enabled === false) return;

  const threshold = config.threshold;
  const window = config.window;

  const toolName = typeof input.tool_name === 'string' ? input.tool_name : null;
  // No tool_name → cannot key a loop signature. Skip silently.
  if (!toolName) return;

  const sessionKey = resolveSessionKey(input);
  const argsHash = hashArgs(input.tool_input);
  const filePath = ringPath(sessionKey);

  const ring = await readRing(filePath);

  // Push the current call, then truncate to the last `window` entries.
  ring.recent.push({ tool: toolName, hash: argsHash });
  if (ring.recent.length > window) {
    ring.recent = ring.recent.slice(-window);
  }

  // Count identical (tool+hash) signatures inside the window.
  const signature = `${toolName}:${argsHash}`;
  const count = ring.recent.filter((e) => `${e.tool}:${e.hash}` === signature).length;

  if (count >= threshold) {
    // FIRE: reset the ring (cooldown) so a 4th identical call right after a
    // fire does NOT re-warn — the next `threshold` identical calls are needed.
    const fired = { recent: [], lastWarn: { hash: argsHash, atCount: count } };
    writeJsonAtomicSync(filePath, fired, { tmpPrefix: '.tmp-loop-guard' });

    // Best-effort telemetry — must never block the hook.
    try {
      await emitEvent('orchestrator.loop.warning', {
        ...(sessionKey !== 'default' ? { session_id: sessionKey } : {}),
        tool: toolName,
        args_hash: argsHash,
        count,
      });
    } catch { /* best-effort — hook must remain non-blocking */ }

    const warning =
      `⚠ Possible tool loop on \`${toolName}\` — same call repeated ${count}× ` +
      `in the last ${window} tool calls. Re-evaluate before repeating.`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: warning,
      },
    }));
    return;
  }

  // NOT warning: persist the updated ring and write nothing to stdout.
  writeJsonAtomicSync(filePath, { recent: ring.recent, lastWarn: ring.lastWarn }, {
    tmpPrefix: '.tmp-loop-guard',
  });
}

// Exit 0 always — informational hook must never block Claude (#619).
main().catch(() => {}).finally(() => process.exit(0));
