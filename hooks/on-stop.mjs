#!/usr/bin/env node
/**
 * on-stop.mjs — consolidated Stop + SubagentStop hook.
 *
 * Replaces hooks/on-stop.sh and hooks/on-subagent-stop.sh. Handles both Claude Code
 * hook events in a single file, discriminating by the `hook_event_name` field first,
 * then falling back to presence of `agent_name` (SubagentStop) vs absence (Stop).
 *
 * Part of v3.0.0 Windows-native migration. Issue #141.
 *
 * Exit codes: 0 always (informational hooks must never block).
 *
 * JSONL format (`.orchestrator/metrics/events.jsonl`):
 *   Stop:        {"event":"stop","timestamp":<ISO>,"session_id":"...","wave":<int>,"branch":"...","commit":"...","duration_ms":<int>}
 *   SubagentStop: {"event":"subagent_stop","timestamp":<ISO>,"agent":"<name>"}
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { $ } from 'zx';

import { appendJsonl } from '../scripts/lib/common.mjs';
import { eventsFilePath } from '../scripts/lib/events.mjs';
import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';

// ---------------------------------------------------------------------------
// stdin reading (inline — no io.mjs because Stop hooks exit 0 always, never deny)
// ---------------------------------------------------------------------------

/**
 * Read stdin to EOF and parse as JSON. Returns null on empty or parse failure.
 * @returns {Promise<object|null>}
 */
async function readStdinJson() {
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => {
      process.stdin.destroy();
      resolve(null);
    }, 8000); // generous guard; contract says 5s (Stop) / 3s (SubagentStop)

    if (process.stdin.readableEnded) {
      clearTimeout(timer);
      resolve(null);
      return;
    }

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
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
// discriminate hook event type
// ---------------------------------------------------------------------------

/**
 * Determine whether the parsed stdin represents a Stop or SubagentStop event.
 * Precedence: hook_event_name field → presence of agent_name field → default Stop.
 * @param {object|null} input
 * @returns {"stop"|"subagent_stop"}
 */
function discriminate(input) {
  if (!input) return 'stop';
  const name = input.hook_event_name;
  if (typeof name === 'string') {
    if (name === 'SubagentStop') return 'subagent_stop';
    return 'stop';
  }
  // Fallback: SubagentStop always provides agent_name; Stop does not.
  if (typeof input.agent_name === 'string') return 'subagent_stop';
  return 'stop';
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

/**
 * Returns { commit, branch } from the git repo at projectRoot, or null values
 * if git is unavailable or the directory is not a git repo.
 * @param {string} projectRoot — working directory for git commands
 * @returns {Promise<{commit:string|null, branch:string|null}>}
 */
async function gitInfo(projectRoot) {
  $.verbose = false;
  $.quiet = true;
  const opts = projectRoot ? { cwd: projectRoot } : {};
  try {
    const commitResult = await $({ ...opts })`git rev-parse HEAD`;
    const branchResult = await $({ ...opts })`git rev-parse --abbrev-ref HEAD`;
    return {
      commit: commitResult.stdout.trim() || null,
      branch: branchResult.stdout.trim() || null,
    };
  } catch {
    return { commit: null, branch: null };
  }
}

// ---------------------------------------------------------------------------
// wave-scope.json helpers
// ---------------------------------------------------------------------------

/**
 * Try to read the wave number from .claude/wave-scope.json (or .codex / .cursor).
 * Returns 0 if no scope file is found or the file cannot be parsed.
 * @param {string} projectRoot
 * @returns {Promise<number>}
 */
async function readWaveNumber(projectRoot) {
  const dirs = ['.claude', '.codex', '.cursor'];
  for (const dir of dirs) {
    const scopePath = path.join(projectRoot, dir, 'wave-scope.json');
    try {
      const raw = await fs.readFile(scopePath, 'utf8');
      const obj = JSON.parse(raw);
      const wave = typeof obj.wave === 'number' ? obj.wave : 0;
      return wave;
    } catch {
      // file missing or unparseable — try next
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// webhook fire-and-forget
// ---------------------------------------------------------------------------

/**
 * POST event to Clank Event Bus if CLANK_EVENT_SECRET is configured.
 * Swallows all errors — fire and forget.
 * @param {string} type
 * @param {object} payload
 */
function fireWebhook(type, payload) {
  if (!process.env.CLANK_EVENT_SECRET) return;
  const url = process.env.CLANK_EVENT_URL || 'https://events.gotzendorfer.at';
  const body = JSON.stringify({
    event_type: type,
    source: 'session-orchestrator',
    payload,
  });
  fetch(`${url}/api/webhooks/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.CLANK_EVENT_SECRET}`,
    },
    body,
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// event handlers
// ---------------------------------------------------------------------------

/**
 * Handle a Stop event. Reads wave from scope file + git info, appends JSONL.
 * @param {object|null} input
 */
async function handleStop(input) {
  const timestamp = new Date().toISOString();
  const projectRoot = SO_PROJECT_DIR;

  const wave = await readWaveNumber(projectRoot);
  const { commit, branch } = await gitInfo(projectRoot);

  // Extract session_id from input if provided
  const sessionId = input?.session_id ?? input?.sessionId ?? null;
  // duration_ms: if input provides a start time we compute from it, else 0
  const durationMs =
    typeof input?.start_ms === 'number' ? Date.now() - input.start_ms : 0;

  const record = {
    event: 'stop',
    timestamp,
    ...(sessionId !== null ? { session_id: sessionId } : {}),
    wave,
    ...(branch !== null ? { branch } : {}),
    ...(commit !== null ? { commit } : {}),
    duration_ms: durationMs,
  };

  const filePath = eventsFilePath();
  await appendJsonl(filePath, record);

  fireWebhook('orchestrator.session.stopped', { wave });
}

/**
 * Handle a SubagentStop event. Extracts agent name, appends JSONL.
 * @param {object|null} input
 */
async function handleSubagentStop(input) {
  const timestamp = new Date().toISOString();
  const agent = input?.agent_name ?? 'unknown';

  const record = {
    event: 'subagent_stop',
    timestamp,
    agent,
  };

  const filePath = eventsFilePath();
  await appendJsonl(filePath, record);

  fireWebhook('orchestrator.agent.stopped', { agent });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdinJson();
  const eventType = discriminate(input);

  if (eventType === 'subagent_stop') {
    await handleSubagentStop(input);
  } else {
    await handleStop(input);
  }
}

// Exit 0 always — informational hook must never block Claude.
main().catch(() => {}).finally(() => process.exit(0));
