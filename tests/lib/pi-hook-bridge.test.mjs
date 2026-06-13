/**
 * tests/lib/pi-hook-bridge.test.mjs
 *
 * Unit tests for the Pi extension bridge. The tests exercise normalization,
 * manifest selection, and the block contract without requiring a Pi runtime.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadPiHookManifest,
  mapPiToolName,
  normalizePiHookPayload,
  runPiHookEvent,
  selectPiHooks,
} from '@lib/pi-hook-bridge.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('mapPiToolName', () => {
  it('maps Pi built-in tool names to Claude/Codex hook names', () => {
    expect(mapPiToolName('bash')).toBe('Bash');
    expect(mapPiToolName('write')).toBe('Write');
    expect(mapPiToolName('edit')).toBe('Edit');
  });

  it('passes through unknown tool names', () => {
    expect(mapPiToolName('custom_tool')).toBe('custom_tool');
  });
});

describe('normalizePiHookPayload', () => {
  it('normalizes tool_call into a PreToolUse payload', () => {
    const payload = normalizePiHookPayload(
      'tool_call',
      { toolName: 'bash', toolCallId: 'call-1', input: { command: 'npm test' } },
      { cwd: '/tmp/project' },
    );

    expect(payload.hook_event_name).toBe('PreToolUse');
    expect(payload.pi_event_name).toBe('tool_call');
    expect(payload.tool_name).toBe('Bash');
    expect(payload.tool_input).toEqual({ command: 'npm test' });
    expect(payload.tool_call_id).toBe('call-1');
    expect(payload.cwd).toBe('/tmp/project');
  });

  it('normalizes session_start into a SessionStart payload', () => {
    const payload = normalizePiHookPayload('session_start', { reason: 'startup' }, {});
    expect(payload.hook_event_name).toBe('SessionStart');
    expect(payload.reason).toBe('startup');
  });

  it('normalizes Pi write path into file_path for existing guards', () => {
    const payload = normalizePiHookPayload(
      'tool_call',
      { toolName: 'write', input: { path: 'src/app.ts', content: 'export {};' } },
      { cwd: '/tmp/project' },
    );

    expect(payload.tool_name).toBe('Write');
    expect(payload.tool_input).toMatchObject({
      path: 'src/app.ts',
      file_path: 'src/app.ts',
      content: 'export {};',
    });
  });

  it('normalizes Pi edit oldText/newText aliases into old_string/new_string', () => {
    const payload = normalizePiHookPayload(
      'tool_call',
      {
        toolName: 'edit',
        input: {
          path: 'src/app.ts',
          edits: [{ oldText: 'old', newText: 'new' }],
        },
      },
      { cwd: '/tmp/project' },
    );

    expect(payload.tool_name).toBe('Edit');
    expect(payload.tool_input).toMatchObject({
      file_path: 'src/app.ts',
      old_string: 'old',
      new_string: 'new',
      edits: [{ old_string: 'old', new_string: 'new' }],
    });
  });

  it('normalizes Pi multi-edit payloads into MultiEdit shape', () => {
    const payload = normalizePiHookPayload(
      'tool_call',
      {
        toolName: 'edit',
        input: {
          path: 'src/app.ts',
          edits: [
            { oldText: 'one', newText: 'two' },
            { oldText: 'three', newText: 'four' },
          ],
        },
      },
      { cwd: '/tmp/project' },
    );

    expect(payload.tool_name).toBe('MultiEdit');
    expect(payload.tool_input.file_path).toBe('src/app.ts');
    expect(payload.tool_input.edits).toEqual([
      { oldText: 'one', newText: 'two', old_string: 'one', new_string: 'two' },
      { oldText: 'three', newText: 'four', old_string: 'three', new_string: 'four' },
    ]);
  });
});

describe('selectPiHooks', () => {
  it('selects bash pre-tool hooks from the real Pi manifest', () => {
    const manifest = loadPiHookManifest(REPO_ROOT);
    const hooks = selectPiHooks(manifest, 'tool_call', { toolName: 'bash' });
    const commands = hooks.map((h) => h.command);

    expect(commands).toContain('node "$PI_PLUGIN_ROOT/hooks/pre-bash-destructive-guard.mjs"');
    expect(commands).toContain('node "$PI_PLUGIN_ROOT/hooks/enforce-commands.mjs"');
  });

  it('selects wildcard tool_result hooks', () => {
    const manifest = loadPiHookManifest(REPO_ROOT);
    const hooks = selectPiHooks(manifest, 'tool_result', { toolName: 'read' });
    const commands = hooks.map((h) => h.command);

    expect(commands).toEqual(['node "$PI_PLUGIN_ROOT/hooks/loop-guard.mjs"']);
  });
});

describe('runPiHookEvent', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'pi-hook-bridge-'));
    mkdirSync(path.join(tmp, 'hooks'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'hooks', 'hooks-pi.json'),
      JSON.stringify({
        hooks: {
          tool_call: [
            {
              matcher: 'bash',
              hooks: [
                {
                  command: 'node "$PI_PLUGIN_ROOT/hooks/deny.mjs"',
                  timeout: 5,
                },
              ],
            },
          ],
        },
      }),
      'utf8',
    );
    writeFileSync(
      path.join(tmp, 'hooks', 'deny.mjs'),
      [
        'let raw = "";',
        'process.stdin.on("data", (chunk) => { raw += chunk; });',
        'process.stdin.on("end", () => {',
        '  const payload = JSON.parse(raw);',
        '  console.log(JSON.stringify({ permissionDecision: "deny", reason: `blocked ${payload.tool_name}` }));',
        '  process.exit(2);',
        '});',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns a Pi block response when an underlying hook denies', async () => {
    const result = await runPiHookEvent(
      'tool_call',
      { toolName: 'bash', input: { command: 'rm -rf /tmp/x' } },
      { cwd: tmp },
      { pluginRoot: tmp },
    );

    expect(result.block).toBe(true);
    expect(result.reason).toBe('blocked Bash');
    expect(result.results).toHaveLength(1);
  });

  it('sets PI_PLUGIN_ROOT for hook subprocesses', async () => {
    writeFileSync(
      path.join(tmp, 'hooks', 'deny.mjs'),
      [
        'console.log(JSON.stringify({ permissionDecision: "deny", reason: process.env.PI_PLUGIN_ROOT }));',
        'process.exit(2);',
      ].join('\n'),
      'utf8',
    );

    const result = await runPiHookEvent(
      'tool_call',
      { toolName: 'bash', input: { command: 'echo ok' } },
      { cwd: tmp },
      { pluginRoot: tmp },
    );

    expect(result.reason).toBe(tmp);
  });

  it('isolates Pi hook subprocesses from leaked Claude/Codex env vars', async () => {
    writeFileSync(
      path.join(tmp, 'hooks', 'deny.mjs'),
      [
        'const leaked = process.env.CLAUDE_PLUGIN_ROOT || process.env.CODEX_PROJECT_DIR || "clean";',
        'const reason = `${leaked}|${process.env.PI_PLUGIN_ROOT}|${process.env.PI_PROJECT_DIR}|${process.env.SO_PLATFORM}`;',
        'console.log(JSON.stringify({ permissionDecision: "deny", reason }));',
        'process.exit(2);',
      ].join('\n'),
      'utf8',
    );

    const result = await runPiHookEvent(
      'tool_call',
      { toolName: 'bash', input: { command: 'echo ok' } },
      { cwd: tmp },
      {
        pluginRoot: tmp,
        env: {
          CLAUDE_PLUGIN_ROOT: '/wrong/plugin',
          CODEX_PROJECT_DIR: '/wrong/project',
        },
      },
    );

    expect(result.reason).toBe(`clean|${tmp}|${tmp}|pi`);
  });

  it('fails closed for PreToolUse hook infrastructure failures', async () => {
    writeFileSync(
      path.join(tmp, 'hooks', 'hooks-pi.json'),
      JSON.stringify({
        hooks: {
          tool_call: [
            {
              matcher: 'bash',
              hooks: [{ command: 'node "$PI_PLUGIN_ROOT/hooks/missing.mjs"', timeout: 5 }],
            },
          ],
        },
      }),
      'utf8',
    );

    const result = await runPiHookEvent(
      'tool_call',
      { toolName: 'bash', input: { command: 'echo ok' } },
      { cwd: tmp },
      { pluginRoot: tmp },
    );

    expect(result.block).toBe(true);
    expect(result.reason).toContain('missing.mjs');
  });
});
