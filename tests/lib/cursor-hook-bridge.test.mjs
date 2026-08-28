/**
 * tests/lib/cursor-hook-bridge.test.mjs
 *
 * Unit tests for the Cursor IDE hook bridge. Exercises payload normalisation
 * and the #919 closure: a Cursor beforeShellExecution payload must become
 * tool_name === 'Bash' so enforce-commands can deny.
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
  CURSOR_TO_CANONICAL_EVENT,
  loadCursorHookManifest,
  mapCursorToolName,
  normalizeCursorHookPayload,
  runCursorHookEvent,
  selectCursorHooks,
  toCursorHookOutput,
} from '@lib/cursor-hook-bridge.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('mapCursorToolName', () => {
  it('maps Cursor tool names to Claude/Codex hook names', () => {
    expect(mapCursorToolName('Shell')).toBe('Bash');
    expect(mapCursorToolName('Write')).toBe('Write');
    expect(mapCursorToolName('StrReplace')).toBe('Edit');
  });
});

describe('normalizeCursorHookPayload', () => {
  it('normalizes beforeShellExecution into a Bash PreToolUse payload', () => {
    const payload = normalizeCursorHookPayload(
      'beforeShellExecution',
      { command: 'rm -rf /tmp/x' },
      { cwd: '/tmp/project' },
    );

    expect(payload.hook_event_name).toBe('PreToolUse');
    expect(payload.cursor_event_name).toBe('beforeShellExecution');
    expect(payload.tool_name).toBe('Bash');
    expect(payload.tool_input).toEqual({ command: 'rm -rf /tmp/x' });
    expect(payload.cwd).toBe('/tmp/project');
  });

  it('normalizes afterFileEdit path aliases into file_path', () => {
    const payload = normalizeCursorHookPayload(
      'afterFileEdit',
      { filePath: 'src/app.ts' },
      { cwd: '/tmp/project' },
    );

    expect(payload.hook_event_name).toBe('PostToolUse');
    expect(payload.tool_name).toBe('Write');
    expect(payload.tool_input.file_path).toBe('src/app.ts');
  });

  it('normalizes sessionStart into SessionStart', () => {
    const payload = normalizeCursorHookPayload('sessionStart', { reason: 'startup' }, {});
    expect(payload.hook_event_name).toBe('SessionStart');
    expect(payload.reason).toBe('startup');
  });
});

describe('selectCursorHooks', () => {
  it('selects bash pre-tool hooks from the real Cursor manifest', () => {
    const manifest = loadCursorHookManifest(REPO_ROOT);
    const hooks = selectCursorHooks(manifest, 'beforeShellExecution', { command: 'npm test' });
    const commands = hooks.map((h) => h.command);

    expect(commands).toContain('sh "$CURSOR_PLUGIN_ROOT/hooks/run-node.sh" "$CURSOR_PLUGIN_ROOT/hooks/pre-bash-destructive-guard.mjs"');
    expect(commands).toContain('sh "$CURSOR_PLUGIN_ROOT/hooks/run-node.sh" "$CURSOR_PLUGIN_ROOT/hooks/enforce-commands.mjs"');
  });
});

describe('toCursorHookOutput', () => {
  it('maps a blocking deny onto Cursor permission deny', () => {
    expect(toCursorHookOutput('beforeShellExecution', { block: true, reason: 'blocked' })).toEqual({
      permission: 'deny',
      user_message: 'blocked',
      agent_message: 'blocked',
    });
  });

  it('maps afterFileEdit denies onto additional_context instead of permission', () => {
    expect(toCursorHookOutput('afterFileEdit', { block: true, reason: 'too late' })).toEqual({
      additional_context: 'too late',
    });
  });
});

describe('runCursorHookEvent', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'cursor-hook-bridge-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('denies a Cursor beforeShellExecution payload that matches a blocked command', async () => {
    mkdirSync(path.join(tmp, 'hooks'), { recursive: true });
    mkdirSync(path.join(tmp, '.cursor'), { recursive: true });
    writeFileSync(path.join(tmp, '.cursor', 'wave-scope.json'), JSON.stringify({
      wave: 1,
      role: 'impl',
      enforcement: 'strict',
      allowedPaths: ['src/**'],
      blockedCommands: ['rm -rf'],
    }));

    const result = await runCursorHookEvent(
      'beforeShellExecution',
      { command: 'rm -rf /tmp/danger' },
      { cwd: tmp },
      { pluginRoot: REPO_ROOT, env: { CLAUDE_PROJECT_DIR: tmp, CURSOR_PROJECT_DIR: tmp } },
    );

    expect(result.payload.tool_name).toBe('Bash');
    expect(result.payload.tool_input.command).toBe('rm -rf /tmp/danger');
    expect(result.block).toBe(true);
    expect(result.reason).toBeTruthy();
  });
});

describe('CURSOR_TO_CANONICAL_EVENT', () => {
  it('projects every Cursor-native event the manifest declares', () => {
    const manifest = loadCursorHookManifest(REPO_ROOT);
    for (const eventName of Object.keys(manifest.hooks)) {
      if (eventName.startsWith('_')) continue;
      expect(CURSOR_TO_CANONICAL_EVENT[eventName]).toBeTruthy();
    }
  });
});
