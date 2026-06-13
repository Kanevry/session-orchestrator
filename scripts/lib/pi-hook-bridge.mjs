/**
 * pi-hook-bridge.mjs — map Pi extension events onto the existing hook handlers.
 *
 * Pi exposes native extension events such as `tool_call` and `session_start`.
 * The session-orchestrator hooks already speak the Claude/Codex stdin contract:
 * `{ hook_event_name, tool_name, tool_input, ... }`. This bridge keeps that
 * contract stable by normalising Pi payloads before spawning the existing
 * `hooks/*.mjs` commands listed in hooks/hooks-pi.json.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { resolvePluginRoot } from './plugin-root.mjs';

export const PI_TO_CANONICAL_EVENT = Object.freeze({
  session_start: 'SessionStart',
  session_shutdown: 'SessionEnd',
  tool_call: 'PreToolUse',
  tool_result: 'PostToolUse',
  agent_end: 'Stop',
});

const TOOL_NAME_MAP = Object.freeze({
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  multiedit: 'MultiEdit',
  multi_edit: 'MultiEdit',
  read: 'Read',
  grep: 'Grep',
  find: 'Find',
  ls: 'LS',
});

/**
 * @param {string|undefined} toolName
 * @returns {string|undefined}
 */
export function mapPiToolName(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return undefined;
  const key = toolName.toLowerCase();
  return TOOL_NAME_MAP[key] ?? toolName;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Pi built-in tools use their native argument names (`path`, `oldText`,
 * `newText`). Existing Session Orchestrator hooks expect the Claude/Codex
 * shape (`file_path`, `old_string`, `new_string`). Normalize only by adding
 * canonical aliases; keep the original Pi fields intact for diagnostics.
 *
 * @param {string|undefined} toolName
 * @param {Record<string, unknown>} input
 * @returns {{ toolName: string|undefined, toolInput: Record<string, unknown> }}
 */
function normalizePiToolInput(toolName, input) {
  const next = { ...input };
  const lowerToolName = typeof toolName === 'string' ? toolName.toLowerCase() : '';

  if (typeof next.file_path !== 'string' && typeof next.path === 'string') {
    next.file_path = next.path;
  }

  if (lowerToolName === 'write') {
    return { toolName: 'Write', toolInput: next };
  }

  if (lowerToolName === 'edit') {
    if (Array.isArray(next.edits)) {
      const edits = next.edits.map((edit) => {
        const e = objectOrEmpty(edit);
        return {
          ...e,
          old_string: typeof e.old_string === 'string' ? e.old_string : e.oldText,
          new_string: typeof e.new_string === 'string' ? e.new_string : e.newText,
        };
      });
      next.edits = edits;
      if (edits.length === 1) {
        next.old_string = next.old_string ?? edits[0].old_string;
        next.new_string = next.new_string ?? edits[0].new_string;
        return { toolName: 'Edit', toolInput: next };
      }
      return { toolName: 'MultiEdit', toolInput: next };
    }

    next.old_string = typeof next.old_string === 'string' ? next.old_string : next.oldText;
    next.new_string = typeof next.new_string === 'string' ? next.new_string : next.newText;
    return { toolName: 'Edit', toolInput: next };
  }

  return { toolName: mapPiToolName(toolName), toolInput: next };
}

/**
 * Build the hook stdin payload expected by existing session-orchestrator hooks.
 *
 * @param {string} piEventName
 * @param {Record<string, unknown>} [event]
 * @param {Record<string, unknown>} [ctx]
 * @returns {Record<string, unknown>}
 */
export function normalizePiHookPayload(piEventName, event = {}, ctx = {}) {
  const eventObject = objectOrEmpty(event);
  const ctxObject = objectOrEmpty(ctx);
  const rawToolName = eventObject.toolName ?? eventObject.tool_name;
  const mappedToolName = mapPiToolName(typeof rawToolName === 'string' ? rawToolName : undefined);
  const rawToolInput = objectOrEmpty(eventObject.input ?? eventObject.args ?? eventObject.tool_input);
  const { toolName, toolInput } = normalizePiToolInput(
    typeof rawToolName === 'string' ? rawToolName : mappedToolName,
    rawToolInput,
  );
  const cwd = typeof ctxObject.cwd === 'string'
    ? ctxObject.cwd
    : (typeof eventObject.cwd === 'string' ? eventObject.cwd : process.cwd());

  return {
    hook_event_name: PI_TO_CANONICAL_EVENT[piEventName] ?? piEventName,
    pi_event_name: piEventName,
    session_id: eventObject.sessionId ?? eventObject.session_id ?? ctxObject.sessionId,
    cwd,
    reason: eventObject.reason,
    tool_name: toolName,
    tool_input: toolInput,
    tool_call_id: eventObject.toolCallId ?? eventObject.tool_call_id,
    tool_response: eventObject.result ?? eventObject.toolResult ?? eventObject.tool_response,
    is_error: eventObject.isError ?? eventObject.is_error,
    timestamp: eventObject.timestamp ?? new Date().toISOString(),
  };
}

/**
 * @param {string} pluginRoot
 * @returns {Record<string, unknown>}
 */
export function loadPiHookManifest(pluginRoot = resolvePluginRoot()) {
  const manifestPath = path.join(pluginRoot, 'hooks', 'hooks-pi.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Pi hook manifest not found at ${manifestPath}`);
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

/**
 * @param {string} matcher
 * @param {string[]} targets
 * @returns {boolean}
 */
export function matcherMatches(matcher, targets) {
  if (!matcher || matcher === '*') return true;
  const normalizedTargets = targets.filter(Boolean).map((t) => t.toLowerCase());
  const alternatives = matcher.split('|').map((p) => p.trim().toLowerCase()).filter(Boolean);
  return alternatives.some((part) => normalizedTargets.includes(part));
}

/**
 * @param {string} piEventName
 * @param {Record<string, unknown>} event
 * @returns {string[]}
 */
function matcherTargets(piEventName, event) {
  const rawToolName = event.toolName ?? event.tool_name;
  const canonicalToolName = mapPiToolName(typeof rawToolName === 'string' ? rawToolName : undefined);
  const reason = typeof event.reason === 'string' ? event.reason : '';
  return [
    piEventName,
    reason,
    typeof rawToolName === 'string' ? rawToolName : '',
    canonicalToolName ?? '',
  ].map((v) => v.toLowerCase());
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {string} piEventName
 * @param {Record<string, unknown>} [event]
 * @returns {Array<Record<string, unknown>>}
 */
export function selectPiHooks(manifest, piEventName, event = {}) {
  const hooksByEvent = objectOrEmpty(manifest.hooks);
  const matchers = Array.isArray(hooksByEvent[piEventName]) ? hooksByEvent[piEventName] : [];
  const targets = matcherTargets(piEventName, objectOrEmpty(event));
  const selected = [];

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
 * @param {string} stdout
 * @returns {Record<string, unknown>|null}
 */
function parseLastJsonLine(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Try the previous line.
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} hook
 * @param {Record<string, unknown>} payload
 * @param {{ pluginRoot: string, cwd?: string, env?: NodeJS.ProcessEnv }} options
 * @returns {{ command: string, status: number|null, stdout: string, stderr: string, blocked: boolean, reason: string|null }}
 */
export function runPiHookCommand(hook, payload, options) {
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
  delete env.CURSOR_RULES_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_PROJECT_DIR;
  delete env.CURSOR_PROJECT_DIR;
  env.PI_PLUGIN_ROOT = options.pluginRoot;
  env.PLUGIN_ROOT = options.pluginRoot;
  env.SO_PLATFORM = 'pi';
  if (typeof payload.cwd === 'string') env.PI_PROJECT_DIR = payload.cwd;

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
  const parsed = parseLastJsonLine(stdout);
  const isPreToolUse = payload.hook_event_name === 'PreToolUse';
  const infraFailure = Boolean(result.error) ||
    result.status === null ||
    (result.status !== 0 && result.status !== 2);
  const blocked = result.status === 2 ||
    parsed?.permissionDecision === 'deny' ||
    (isPreToolUse && infraFailure);
  const reason = typeof parsed?.reason === 'string'
    ? parsed.reason
    : (blocked
        ? (result.error?.message || stdout.trim() || stderr.trim() || `Hook command blocked: ${command}`)
        : null);

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
 * Run all hooks configured for one Pi event. For `tool_call`, a blocking hook
 * returns a Pi-compatible `{ block, reason }` response to the extension.
 *
 * @param {string} piEventName
 * @param {Record<string, unknown>} [event]
 * @param {Record<string, unknown>} [ctx]
 * @param {{ pluginRoot?: string, manifest?: Record<string, unknown>, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ block: boolean, reason: string|null, payload: Record<string, unknown>, results: Array<object> }>}
 */
export async function runPiHookEvent(piEventName, event = {}, ctx = {}, options = {}) {
  const pluginRoot = options.pluginRoot ?? resolvePluginRoot();
  const manifest = options.manifest ?? loadPiHookManifest(pluginRoot);
  const payload = normalizePiHookPayload(piEventName, event, ctx);
  const hooks = selectPiHooks(manifest, piEventName, event);
  const results = [];

  for (const hook of hooks) {
    const result = runPiHookCommand(hook, payload, {
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
