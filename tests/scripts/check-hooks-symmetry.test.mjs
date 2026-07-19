import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/lib/validate/check-hooks-symmetry.mjs',
);
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REQUIRED_CODEX_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
];
const REQUIRED_PI_HANDLER_FILES = [
  'pre-bash-destructive-guard.mjs',
  'enforce-commands.mjs',
  'enforce-scope.mjs',
  'config-protection.mjs',
];

let fixtureRoot;

const norm = (value) => (value ?? '').replace(/\r\n/g, '\n');

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

function runValidator(pluginRoot) {
  const result = spawnSync(process.execPath, [SCRIPT, pluginRoot], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { ...result, stdout: norm(result.stdout), stderr: norm(result.stderr) };
}

function makeFixture() {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), 'hooks-symmetry-'));
  mkdirSync(path.join(fixtureRoot, 'hooks'), { recursive: true });
  return fixtureRoot;
}

function commandHook(rootVar, handler) {
  return { type: 'command', command: `node "$${rootVar}/hooks/${handler}"` };
}

function handlerGroup(rootVar = 'CLAUDE_PLUGIN_ROOT', handler = 'handler.mjs') {
  return [{ matcher: '*', hooks: [commandHook(rootVar, handler)] }];
}

function claudeHooks(extraEvents = {}) {
  const hooks = Object.fromEntries(
    [
      'SessionStart',
      'SessionEnd',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SubagentStart',
      'SubagentStop',
      'PostToolUseFailure',
      'PostToolBatch',
      'CwdChanged',
    ].map((event) => [event, handlerGroup()]),
  );
  return { hooks: { ...hooks, ...extraEvents } };
}

function codexHooks() {
  return {
    description: 'Codex fixture',
    hooks: Object.fromEntries(
      REQUIRED_CODEX_EVENTS.map((event) => [event, handlerGroup('PLUGIN_ROOT')]),
    ),
  };
}

function cursorHooks(events = {}) {
  return {
    hooks: Object.fromEntries(
      Object.entries(events).map(([event, handler]) => [
        event,
        { script: `hooks/${handler}` },
      ]),
    ),
  };
}

function piToolEntry(toolName, handlers) {
  return {
    matcher: toolName,
    hooks: handlers.map((handler) => commandHook('PI_PLUGIN_ROOT', handler)),
  };
}

function validPiHooks() {
  return {
    hooks: {
      session_start: handlerGroup('PI_PLUGIN_ROOT'),
      session_shutdown: handlerGroup('PI_PLUGIN_ROOT'),
      tool_call: [
        piToolEntry('bash', [
          'pre-bash-destructive-guard.mjs',
          'enforce-commands.mjs',
        ]),
        piToolEntry('edit', ['enforce-scope.mjs', 'config-protection.mjs']),
        piToolEntry('write', ['enforce-scope.mjs', 'config-protection.mjs']),
      ],
      tool_result: handlerGroup('PI_PLUGIN_ROOT'),
      agent_end: handlerGroup('PI_PLUGIN_ROOT'),
    },
  };
}

function writeHandlerFiles(handlers) {
  for (const handler of handlers) {
    writeFileSync(path.join(fixtureRoot, 'hooks', handler), '// fixture');
  }
}

function writeBaseFiles({
  claude = claudeHooks(),
  codex = codexHooks(),
  cursor,
  pi,
  packageJson = { name: 'fixture' },
  handlers = [],
} = {}) {
  const hooksDir = path.join(fixtureRoot, 'hooks');
  writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify(packageJson));
  writeHandlerFiles(['handler.mjs', ...handlers]);
  if (claude !== null) {
    writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify(claude));
  }
  if (codex !== null) {
    writeFileSync(path.join(hooksDir, 'hooks-codex.json'), JSON.stringify(codex));
  }
  if (cursor !== undefined) {
    writeFileSync(path.join(hooksDir, 'hooks-cursor.json'), JSON.stringify(cursor));
  }
  if (pi !== undefined) {
    writeFileSync(path.join(hooksDir, 'hooks-pi.json'), JSON.stringify(pi));
  }
}

function removePiToolHandler(pi, toolName, handlerName) {
  const entry = pi.hooks.tool_call.find(({ matcher }) => matcher === toolName);
  entry.hooks = entry.hooks.filter(({ command }) => !command.includes(`/hooks/${handlerName}`));
}

describe('check-hooks-symmetry.mjs', () => {
  describe('real repository', () => {
    it('passes against the current plugin repository', () => {
      const result = runValidator(PLUGIN_ROOT);

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Results: \d+ passed, 0 failed/);
    });

    it('reports the required Codex six-event subset', () => {
      const result = runValidator(PLUGIN_ROOT);

      expect(result.stdout).toContain(
        'required Codex event subset is present (SessionStart, PreToolUse, PostToolUse, SubagentStart, SubagentStop, Stop)',
      );
    });
  });

  describe('Codex event subset', () => {
    it('allows Claude to expose supported events outside the Codex subset', () => {
      makeFixture();
      writeBaseFiles();

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(0);
    });

    it.each([
      ['SessionStart', 'missing required events: SessionStart'],
      ['PreToolUse', 'missing required events: PreToolUse'],
      ['PostToolUse', 'missing required events: PostToolUse'],
      ['SubagentStart', 'missing required events: SubagentStart'],
      ['SubagentStop', 'missing required events: SubagentStop'],
      ['Stop', 'missing required events: Stop'],
    ])('fails when Codex omits required event %s', (event, expectedMessage) => {
      makeFixture();
      const codex = codexHooks();
      delete codex.hooks[event];
      writeBaseFiles({ codex });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(expectedMessage);
    });

    it.each([
      ['SessionEnd', 'forbidden unsupported events: SessionEnd'],
      ['PostToolUseFailure', 'forbidden unsupported events: PostToolUseFailure'],
      ['PostToolBatch', 'forbidden unsupported events: PostToolBatch'],
      ['CwdChanged', 'forbidden unsupported events: CwdChanged'],
    ])('fails when Codex includes forbidden Claude-only event %s', (event, expectedMessage) => {
      makeFixture();
      const codex = codexHooks();
      codex.hooks[event] = handlerGroup('PLUGIN_ROOT');
      writeBaseFiles({ codex });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(expectedMessage);
    });

    it('fails when a Codex event references a missing handler', () => {
      makeFixture();
      const codex = codexHooks();
      codex.hooks.Stop = handlerGroup('PLUGIN_ROOT', 'missing-codex.mjs');
      writeBaseFiles({ codex });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('handler files referenced but missing: missing-codex.mjs');
    });

    it('fails when hooks-codex.json is missing', () => {
      makeFixture();
      writeBaseFiles({ codex: null });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAIL: hooks-codex.json:');
    });

    it('fails when hooks-codex.json contains malformed JSON', () => {
      makeFixture();
      writeBaseFiles();
      writeFileSync(path.join(fixtureRoot, 'hooks', 'hooks-codex.json'), '{ broken codex');

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAIL: hooks-codex.json:');
    });
  });

  describe('Cursor asymmetries and parsing', () => {
    it('passes when Cursor is missing only documented main events', () => {
      makeFixture();
      writeBaseFiles({
        cursor: cursorHooks({
          afterFileEdit: 'handler.mjs',
          beforeShellExecution: 'handler.mjs',
        }),
      });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('hooks-cursor.json missing events are all documented');
    });

    it('fails when Cursor is missing an undocumented main event', () => {
      makeFixture();
      const claude = claudeHooks({ BrandNewEvent: handlerGroup() });
      writeBaseFiles({ claude, cursor: cursorHooks({ afterFileEdit: 'handler.mjs' }) });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('missing UNDOCUMENTED events: BrandNewEvent');
    });

    it('passes when Cursor contains only documented Cursor-native events', () => {
      makeFixture();
      writeBaseFiles({
        cursor: cursorHooks({
          afterFileEdit: 'handler.mjs',
          beforeShellExecution: 'handler.mjs',
        }),
      });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('cursor-only events are all documented (2 events');
    });

    it('fails when Cursor contains an undocumented native event', () => {
      makeFixture();
      writeBaseFiles({ cursor: cursorHooks({ WeirdCursorEvent: 'handler.mjs' }) });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('UNDOCUMENTED extra events: WeirdCursorEvent');
    });

    it('treats an absent hooks-cursor.json as optional', () => {
      makeFixture();
      writeBaseFiles();

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('hooks-cursor.json absent (optional config)');
    });

    it('fails when hooks-cursor.json contains malformed JSON', () => {
      makeFixture();
      writeBaseFiles();
      writeFileSync(path.join(fixtureRoot, 'hooks', 'hooks-cursor.json'), '{ broken cursor');

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAIL: hooks-cursor.json:');
    });
  });

  describe('Pi mappings and required tool handlers', () => {
    it('passes when Pi native events cover every mapped main event', () => {
      makeFixture();
      writeBaseFiles({ pi: validPiHooks(), handlers: REQUIRED_PI_HANDLER_FILES });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('hooks-pi.json covers mapped main events');
      expect(result.stdout).toContain(
        'hooks-pi.json wires required tool_call handlers for bash, edit, and write',
      );
    });

    it('fails when Pi is missing a documented main-event mapping implementation', () => {
      makeFixture();
      const pi = validPiHooks();
      delete pi.hooks.tool_result;
      writeBaseFiles({ pi, handlers: REQUIRED_PI_HANDLER_FILES });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('missing UNDOCUMENTED main-event mappings: PostToolUse');
    });

    it('fails when Pi contains an undocumented Pi-native event', () => {
      makeFixture();
      const pi = validPiHooks();
      pi.hooks.strange_pi_event = handlerGroup('PI_PLUGIN_ROOT');
      writeBaseFiles({ pi, handlers: REQUIRED_PI_HANDLER_FILES });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('UNDOCUMENTED pi-native events: strange_pi_event');
    });

    it('fails when a Pi package omits hooks-pi.json', () => {
      makeFixture();
      writeBaseFiles({ packageJson: { name: 'fixture', pi: {} } });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAIL: hooks-pi.json:');
    });

    it('fails when hooks-pi.json contains malformed JSON', () => {
      makeFixture();
      writeBaseFiles({ pi: validPiHooks(), handlers: REQUIRED_PI_HANDLER_FILES });
      writeFileSync(path.join(fixtureRoot, 'hooks', 'hooks-pi.json'), '{ broken pi');

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAIL: hooks-pi.json:');
    });

    it.each([
      [
        'bash',
        'pre-bash-destructive-guard.mjs',
        'bash → pre-bash-destructive-guard.mjs',
      ],
      ['bash', 'enforce-commands.mjs', 'bash → enforce-commands.mjs'],
      ['edit', 'enforce-scope.mjs', 'edit → enforce-scope.mjs'],
      ['edit', 'config-protection.mjs', 'edit → config-protection.mjs'],
      ['write', 'enforce-scope.mjs', 'write → enforce-scope.mjs'],
      ['write', 'config-protection.mjs', 'write → config-protection.mjs'],
    ])(
      'fails when Pi %s omits required handler %s',
      (toolName, handlerName, expectedGap) => {
        makeFixture();
        const pi = validPiHooks();
        removePiToolHandler(pi, toolName, handlerName);
        writeBaseFiles({ pi, handlers: REQUIRED_PI_HANDLER_FILES });

        const result = runValidator(fixtureRoot);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('missing required tool_call handlers');
        expect(result.stdout).toContain(expectedGap);
      },
    );
  });

  describe('main parser and handler existence', () => {
    it('fails when hooks.json contains malformed JSON', () => {
      makeFixture();
      writeBaseFiles();
      writeFileSync(path.join(fixtureRoot, 'hooks', 'hooks.json'), '{ broken main');

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAIL: hooks.json:');
    });

    it('fails when hooks.json references a missing handler', () => {
      makeFixture();
      const claude = claudeHooks({
        SessionStart: handlerGroup('CLAUDE_PLUGIN_ROOT', 'missing-main.mjs'),
      });
      writeBaseFiles({ claude });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('handler files referenced but missing: missing-main.mjs');
    });

    it('fails when hooks-cursor.json references a missing handler', () => {
      makeFixture();
      writeBaseFiles({ cursor: cursorHooks({ afterFileEdit: 'missing-cursor.mjs' }) });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('handler files referenced but missing: missing-cursor.mjs');
    });

    it('fails when hooks-pi.json references a missing handler', () => {
      makeFixture();
      const pi = validPiHooks();
      pi.hooks.agent_end = handlerGroup('PI_PLUGIN_ROOT', 'missing-pi.mjs');
      writeBaseFiles({ pi, handlers: REQUIRED_PI_HANDLER_FILES });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('handler files referenced but missing: missing-pi.mjs');
    });

    it('passes when every referenced handler exists on disk', () => {
      makeFixture();
      writeBaseFiles();

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('handler files exist on disk');
    });

    it('reports an unreferenced hook file without failing', () => {
      makeFixture();
      writeBaseFiles();
      writeHandlerFiles(['orphan.mjs']);

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('unreferenced .mjs files');
      expect(result.stdout).toContain('orphan.mjs');
    });

    it('always emits a Results summary for a complete fixture', () => {
      makeFixture();
      writeBaseFiles();

      const result = runValidator(fixtureRoot);

      expect(result.stdout).toMatch(/Results: \d+ passed, \d+ failed/);
    });
  });
});
