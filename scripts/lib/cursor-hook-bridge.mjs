/**
 * cursor-hook-bridge.mjs — map Cursor IDE hook events onto existing handlers.
 *
 * Cursor emits native events (`beforeShellExecution`, `preToolUse`, …) with its
 * own stdin JSON and reads `{ permission, user_message, agent_message }` back.
 * Existing Session Orchestrator hooks speak the Claude/Codex contract:
 * `{ hook_event_name, tool_name, tool_input, ... }` plus an exit-0
 * `hookSpecificOutput.permissionDecision` envelope (#906).
 *
 * This bridge is the Cursor counterpart of `pi-hook-bridge.mjs`. It closes the
 * #919 silent-no-op: without it, `enforce-commands.mjs` sees no `tool_name ===
 * "Bash"` on a Cursor payload and writes 0 bytes / exit 0, so the command runs.
 *
 * Usage (`.cursor/hooks.json`):
 *   sh hooks/run-node.sh scripts/lib/cursor-hook-bridge.mjs --event beforeShellExecution
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { matcherMatches, readHookDecision } from './pi-hook-bridge.mjs';
import { resolvePluginRoot } from './plugin-root.mjs';

export const CURSOR_TO_CANONICAL_EVENT = Object.freeze({
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  beforeShellExecution: 'PreToolUse',
  afterShellExecution: 'PostToolUse',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  afterFileEdit: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure',
  stop: 'Stop',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
});

export const CURSOR_BLOCKING_EVENTS = Object.freeze([
  'beforeShellExecution',
  'preToolUse',
  'beforeMCPExecution',
  'subagentStart',
]);

const TOOL_NAME_MAP = Object.freeze({
  shell: 'Bash',
  bash: 'Bash',
  write: 'Write',
  tabwrite: 'Write',
  strreplace: 'Edit',
  edit: 'Edit',
  multiedit: 'MultiEdit',
  read: 'Read',
  tabread: 'Read',
  delete: 'Write',
  task: 'Agent',
});

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * @param {string|undefined} toolName
 * @returns {string|undefined}
 */
export function mapCursorToolName(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return undefined;
  const key = toolName.toLowerCase();
  return TOOL_NAME_MAP[key] ?? toolName;
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * @param {string} cursorEventName
 * @param {Record<string, unknown>} event
 * @returns {string|undefined}
 */
function inferCursorToolName(cursorEventName, event) {
  if (cursorEventName === 'beforeShellExecution' || cursorEventName === 'afterShellExecution') {
    return 'Bash';
  }
  if (cursorEventName === 'afterFileEdit') {
    return mapCursorToolName(typeof event.tool_type === 'string' ? event.tool_type : 'Write');
  }
  const raw = firstString(
    typeof event.tool_name === 'string' ? event.tool_name : undefined,
    typeof event.toolName === 'string' ? event.toolName : undefined,
    typeof event.tool_type === 'string' ? event.tool_type : undefined,
    typeof event.toolType === 'string' ? event.toolType : undefined,
  );
  return mapCursorToolName(raw);
}

/**
 * @param {Record<string, unknown>} event
 * @returns {Record<string, unknown>}
 */
function collectToolInput(event) {
  const nested = objectOrEmpty(event.tool_input ?? event.arguments ?? event.args ?? event.input);
  const next = { ...nested };
  const command = firstString(
    typeof event.command === 'string' ? event.command : undefined,
    typeof next.command === 'string' ? next.command : undefined,
  );
  if (command) next.command = command;

  const filePath = firstString(
    typeof next.file_path === 'string' ? next.file_path : undefined,
    typeof event.file_path === 'string' ? event.file_path : undefined,
    typeof event.filePath === 'string' ? event.filePath : undefined,
    typeof event.path === 'string' ? event.path : undefined,
    typeof next.path === 'string' ? next.path : undefined,
  );
  if (filePath) {
    next.file_path = filePath;
    if (typeof next.path !== 'string') next.path = filePath;
  }

  if (typeof next.old_string !== 'string' && typeof next.oldText === 'string') {
    next.old_string = next.oldText;
  }
  if (typeof next.new_string !== 'string' && typeof next.newText === 'string') {
    next.new_string = next.newText;
  }

  return next;
}

/**
 * Build the hook stdin payload expected by existing session-orchestrator hooks.
 *
 * @param {string} cursorEventName
 * @param {Record<string, unknown>} [event]
 * @param {Record<string, unknown>} [ctx]
 * @returns {Record<string, unknown>}
 */
export function normalizeCursorHookPayload(cursorEventName, event = {}, ctx = {}) {
  const eventObject = objectOrEmpty(event);
  const ctxObject = objectOrEmpty(ctx);
  const toolName = inferCursorToolName(cursorEventName, eventObject);
  const toolInput = collectToolInput(eventObject);
  const cwd = firstString(
    typeof ctxObject.cwd === 'string' ? ctxObject.cwd : undefined,
    typeof eventObject.cwd === 'string' ? eventObject.cwd : undefined,
    process.cwd(),
  );

  return {
    hook_event_name: CURSOR_TO_CANONICAL_EVENT[cursorEventName] ?? cursorEventName,
    cursor_event_name: cursorEventName,
    session_id: eventObject.session_id ?? eventObject.sessionId ?? ctxObject.sessionId,
    cwd,
    reason: eventObject.reason,
    tool_name: toolName,
    tool_input: toolInput,
    tool_call_id: eventObject.tool_call_id ?? eventObject.toolCallId,
    tool_response: eventObject.tool_response ?? eventObject.result ?? eventObject.output,
    is_error: eventObject.is_error ?? eventObject.isError,
    timestamp: eventObject.timestamp ?? new Date().toISOString(),
  };
}

/**
 * @param {string} pluginRoot
 * @returns {Record<string, unknown>}
 */
export function loadCursorHookManifest(pluginRoot = resolvePluginRoot()) {
  const manifestPath = path.join(pluginRoot, 'hooks', 'hooks-cursor.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Cursor hook manifest not found at ${manifestPath}`);
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

/**
 * @param {string} cursorEventName
 * @param {Record<string, unknown>} event
 * @param {string|undefined} canonicalToolName
 * @returns {string[]}
 */
function matcherTargets(cursorEventName, event, canonicalToolName) {
  const rawToolName = firstString(
    typeof event.tool_name === 'string' ? event.tool_name : undefined,
    typeof event.toolName === 'string' ? event.toolName : undefined,
    typeof event.tool_type === 'string' ? event.tool_type : undefined,
  );
  return [
    cursorEventName,
    typeof event.reason === 'string' ? event.reason : '',
    rawToolName ?? '',
    canonicalToolName ?? '',
    cursorEventName === 'beforeShellExecution' || cursorEventName === 'afterShellExecution' ? 'bash' : '',
    cursorEventName === 'beforeShellExecution' || cursorEventName === 'afterShellExecution' ? 'shell' : '',
  ].map((v) => v.toLowerCase());
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {string} cursorEventName
 * @param {Record<string, unknown>} [event]
 * @returns {Array<Record<string, unknown>>}
 */
export function selectCursorHooks(manifest, cursorEventName, event = {}) {
  const hooksByEvent = objectOrEmpty(manifest.hooks);
  const entry = hooksByEvent[cursorEventName];
  const eventObject = objectOrEmpty(event);
  const canonicalToolName = inferCursorToolName(cursorEventName, eventObject);
  const targets = matcherTargets(cursorEventName, eventObject, canonicalToolName);
  const selected = [];

  if (entry && !Array.isArray(entry) && typeof objectOrEmpty(entry).script === 'string') {
    const script = objectOrEmpty(entry).script;
    selected.push({
      type: 'command',
      command: `sh "$CURSOR_PLUGIN_ROOT/hooks/run-node.sh" "$CURSOR_PLUGIN_ROOT/${script}"`,
    });
    return selected;
  }

  const matchers = Array.isArray(entry) ? entry : [];
  for (const matcherConfig of matchers) {
    const config = objectOrEmpty(matcherConfig);
    const matcher = typeof config.matcher === 'string' ? config.matcher : '';
    if (!matcherMatches(matcher, targets)) continue;
    const hooks = Array.isArray(config.hooks) ? config.hooks : [];
    for (const hook of hooks) {
      selected.push(objectOrEmpty(hook));
    }
  }

  return selected;
}

/**
 * @param {Record<string, unknown>} hook
 * @param {Record<string, unknown>} payload
 * @param {{ pluginRoot: string, cwd?: string, env?: NodeJS.ProcessEnv }} options
 * @returns {{ command: string, status: number|null, stdout: string, stderr: string, blocked: boolean, reason: string|null }}
 */
export function runCursorHookCommand(hook, payload, options) {
  const command = typeof hook.command === 'string' ? hook.command : '';
  if (!command) {
    return { command, status: 0, stdout: '', stderr: '', blocked: false, reason: null };
  }

  const timeoutSeconds = Number.isFinite(hook.timeout) ? Number(hook.timeout) : 5;
  const cwd = options.cwd || (typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
  const env = {
    ...process.env,
    ...options.env,
  };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.CODEX_PLUGIN_ROOT;
  delete env.PI_PLUGIN_ROOT;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_PROJECT_DIR;
  delete env.PI_PROJECT_DIR;
  env.CURSOR_PLUGIN_ROOT = options.pluginRoot;
  env.CURSOR_RULES_DIR = options.pluginRoot;
  env.PLUGIN_ROOT = options.pluginRoot;
  env.SO_PLATFORM = 'cursor';
  if (typeof payload.cwd === 'string') env.CURSOR_PROJECT_DIR = payload.cwd;

  const result = spawnSync(command, {
    shell: true,
    cwd,
    env,
    input: JSON.stringify(payload) + '\n',
    encoding: 'utf8',
    timeout: timeoutSeconds * 1000,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const decision = readHookDecision(stdout);
  const isPreToolUse = payload.hook_event_name === 'PreToolUse';
  const infraFailure = Boolean(result.error) ||
    result.status === null ||
    (result.status !== 0 && result.status !== 2) ||
    decision.malformed;
  const blocked = result.status === 2 ||
    decision.deny ||
    (isPreToolUse && infraFailure);

  let reason = decision.reason;
  if (reason === null && blocked) {
    reason = result.error?.message
      || (decision.malformed
        ? `Hook stdout is not a parseable decision envelope (possible truncated output) — failing closed: ${command}`
        : '')
      || stdout.trim()
      || stderr.trim()
      || `Hook command blocked: ${command}`;
  }

  return {
    command,
    status: result.status,
    stdout,
    stderr,
    blocked,
    reason,
  };
}

/**
 * @param {string} cursorEventName
 * @param {Record<string, unknown>} [event]
 * @param {Record<string, unknown>} [ctx]
 * @param {{ pluginRoot?: string, manifest?: Record<string, unknown>, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ block: boolean, reason: string|null, payload: Record<string, unknown>, results: Array<object> }>}
 */
export async function runCursorHookEvent(cursorEventName, event = {}, ctx = {}, options = {}) {
  const pluginRoot = options.pluginRoot ?? resolvePluginRoot();
  const manifest = options.manifest ?? loadCursorHookManifest(pluginRoot);
  const payload = normalizeCursorHookPayload(cursorEventName, event, ctx);
  const hooks = selectCursorHooks(manifest, cursorEventName, event);
  const results = [];

  for (const hook of hooks) {
    const result = runCursorHookCommand(hook, payload, {
      pluginRoot,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : process.cwd(),
      env: options.env,
    });
    results.push(result);
    if (result.blocked) {
      return {
        block: true,
        reason: result.reason,
        payload,
        results,
      };
    }
  }

  return {
    block: false,
    reason: null,
    payload,
    results,
  };
}

/**
 * Map a bridge result onto Cursor's hook stdout contract.
 *
 * @param {string} cursorEventName
 * @param {{ block: boolean, reason: string|null }} result
 * @returns {Record<string, unknown>}
 */
export function toCursorHookOutput(cursorEventName, result) {
  const blocking = CURSOR_BLOCKING_EVENTS.includes(cursorEventName);
  if (result.block && blocking) {
    const reason = result.reason || 'Blocked by Session Orchestrator';
    return {
      permission: 'deny',
      user_message: reason,
      agent_message: reason,
    };
  }
  if (result.block && (cursorEventName === 'afterFileEdit' || cursorEventName === 'postToolUse')) {
    return {
      additional_context: result.reason || 'Session Orchestrator post-hoc warning',
    };
  }
  if (blocking) {
    return { permission: 'allow' };
  }
  return {};
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  const eventIdx = process.argv.indexOf('--event');
  const eventName = eventIdx >= 0 ? process.argv[eventIdx + 1] : '';
  if (!eventName || typeof CURSOR_TO_CANONICAL_EVENT[eventName] !== 'string') {
    process.stderr.write(`cursor-hook-bridge: missing or unknown --event ${eventName || '(none)'}\n`);
    process.stdout.write(`${JSON.stringify({ permission: 'allow' })}\n`);
    return;
  }

  const raw = readStdinSync();
  let event;
  try {
    event = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    const blocking = CURSOR_BLOCKING_EVENTS.includes(eventName);
    if (blocking) {
      const reason = `Cursor hook payload is not valid JSON: ${err instanceof Error ? err.message : err}`;
      process.stdout.write(`${JSON.stringify({
        permission: 'deny',
        user_message: reason,
        agent_message: reason,
      })}\n`);
      return;
    }
    process.stdout.write('{}\n');
    return;
  }

  const result = await runCursorHookEvent(eventName, objectOrEmpty(event), { cwd: process.cwd() });
  process.stdout.write(`${JSON.stringify(toCursorHookOutput(eventName, result))}\n`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`cursor-hook-bridge: ${err instanceof Error ? err.message : err}\n`);
    process.stdout.write(`${JSON.stringify({ permission: 'allow' })}\n`);
  });
}
