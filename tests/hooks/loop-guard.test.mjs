/**
 * tests/hooks/loop-guard.test.mjs
 *
 * Tests for hooks/loop-guard.mjs (#619).
 *
 * The hook is a NON-BLOCKING PostToolUse loop detector: it maintains a
 * per-session ring buffer of the last `window` {tool, argsHash} pairs and,
 * when the same (tool+argsHash) recurs >= `threshold` times in that window,
 * writes a `hookSpecificOutput.additionalContext` loop-warning to stdout +
 * appends an `orchestrator.loop.warning` event. After firing, the ring resets
 * (cooldown) so a 4th identical call does NOT re-warn. Exit 0 ALWAYS.
 *
 * Strategy (mirrors tests/hooks/post-tool-batch.test.mjs): spawn the hook via
 * node with stdin piped, CLAUDE_PROJECT_DIR + SO_LOOP_GUARD_DIR pointing to a
 * tmp sandbox. Assert exit code + stdout shape + events.jsonl contents
 * (behaviour, not implementation).
 *
 * Coverage:
 *   1. fires at threshold — 3 identical calls → 3rd emits additionalContext +
 *      orchestrator.loop.warning event with count >= 3.
 *   2. cooldown — a 4th identical call right after a fire → no new warning.
 *   3. distinct args do NOT trip — 3 calls, same tool, different tool_input.
 *   4. no-op single call → exit 0, no stdout, no event.
 *   5. disabled via sandbox CLAUDE.md → 3 identical → no warning, no event.
 *   6. malformed stdin / missing session_id → exit 0, no crash.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = new URL('../../hooks/loop-guard.mjs', import.meta.url).pathname;
const EVENTS_REL = join('.orchestrator', 'metrics', 'events.jsonl');

const CLAUDE_MD_DISABLED = [
  '# Sandbox',
  '',
  'loop-guard:',
  '  enabled: false',
  '',
].join('\n');

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'loop-guard-test-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

/** Spawn the hook with the given stdin payload object. */
function runHook(payloadObj) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmp,
      SO_LOOP_GUARD_DIR: tmp,
      SO_HOOK_PROFILE: 'full',
      SO_DISABLED_HOOKS: '',
    },
    timeout: 10_000,
  });
}

/** Write CLAUDE.md into the sandbox so loadConfig() can read it. */
function writeClaudeMd(content) {
  writeFileSync(join(tmp, 'CLAUDE.md'), content, 'utf8');
}

/** Read + parse the events.jsonl records (skips blank lines). */
function readEvents() {
  const path = join(tmp, EVENTS_REL);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** PostToolUse payload for a tool call. */
function toolPayload(toolName, toolInput, extra = {}) {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'loop-test-session',
    tool_name: toolName,
    tool_input: toolInput,
    ...extra,
  };
}

describe('loop-guard hook', () => {
  it('fires at threshold: 3 identical calls → 3rd warns + emits loop event', () => {
    const payload = toolPayload('Bash', { command: 'npm test' });

    const r1 = runHook(payload);
    const r2 = runHook(payload);
    const r3 = runHook(payload);

    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    expect(r3.status).toBe(0);

    // First two calls do NOT warn (below threshold).
    expect(r1.stdout.trim()).toBe('');
    expect(r2.stdout.trim()).toBe('');

    // Third call fires: additionalContext on stdout with the PostToolUse event name.
    const out = JSON.parse(r3.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('Bash');
    expect(out.hookSpecificOutput.additionalContext).toContain('tool loop');

    // Exactly one loop-warning event with count >= 3.
    const events = readEvents().filter((e) => e.event === 'orchestrator.loop.warning');
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('Bash');
    expect(events[0].count).toBeGreaterThanOrEqual(3);
    expect(events[0].session_id).toBe('loop-test-session');
  });

  it('cooldown: a 4th identical call right after a fire does NOT re-warn', () => {
    const payload = toolPayload('Bash', { command: 'npm test' });

    runHook(payload); // 1
    runHook(payload); // 2
    const r3 = runHook(payload); // 3 → fires
    const r4 = runHook(payload); // 4 → cooldown, must NOT re-warn

    // The fire happened on call 3.
    expect(JSON.parse(r3.stdout).hookSpecificOutput.hookEventName).toBe('PostToolUse');
    // Call 4 writes nothing to stdout (ring was reset on fire).
    expect(r4.status).toBe(0);
    expect(r4.stdout.trim()).toBe('');

    // Still exactly one warning event total (no second fire).
    const events = readEvents().filter((e) => e.event === 'orchestrator.loop.warning');
    expect(events).toHaveLength(1);
  });

  it('distinct args do NOT trip: 3 calls same tool, different tool_input', () => {
    const r1 = runHook(toolPayload('Bash', { command: 'ls' }));
    const r2 = runHook(toolPayload('Bash', { command: 'pwd' }));
    const r3 = runHook(toolPayload('Bash', { command: 'whoami' }));

    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    expect(r3.status).toBe(0);
    expect(r1.stdout.trim()).toBe('');
    expect(r2.stdout.trim()).toBe('');
    expect(r3.stdout.trim()).toBe('');

    const events = readEvents().filter((e) => e.event === 'orchestrator.loop.warning');
    expect(events).toEqual([]);
  });

  it('no-op single call: exit 0, no stdout, no event', () => {
    const result = runHook(toolPayload('Read', { file_path: '/tmp/x' }));

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('disabled via CLAUDE.md: 3 identical calls → no warning, no event', () => {
    writeClaudeMd(CLAUDE_MD_DISABLED);
    const payload = toolPayload('Bash', { command: 'npm test' });

    const r1 = runHook(payload);
    const r2 = runHook(payload);
    const r3 = runHook(payload);

    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    expect(r3.status).toBe(0);
    expect(r3.stdout.trim()).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('malformed stdin → exit 0, no crash, no event', () => {
    const result = runHook('{{not valid json}}');

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('missing session_id → keys under "default", still fires without crash', () => {
    // No session_id / parent_session_id → resolves to the 'default' key.
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    };

    const r1 = runHook(payload);
    const r2 = runHook(payload);
    const r3 = runHook(payload);

    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    expect(r3.status).toBe(0);

    const out = JSON.parse(r3.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');

    // The event must NOT carry a session_id field when keyed under 'default'.
    const events = readEvents().filter((e) => e.event === 'orchestrator.loop.warning');
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBeUndefined();
    expect(events[0].tool).toBe('Bash');
  });
});
