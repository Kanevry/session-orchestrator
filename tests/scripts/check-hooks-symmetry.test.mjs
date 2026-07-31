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
        // Mirrors the claudeHooks() fixture's PreToolUse handler so the
        // Check-6 per-event handler-set parity (#942) holds for the fixture.
        { matcher: '*', hooks: [commandHook('PI_PLUGIN_ROOT', 'handler.mjs')] },
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
  });

  describe('Codex event subset', () => {
    // Consolidated: absorbed the Check-4 positive pin from 'passes when every
    // referenced handler exists on disk', which ran a byte-identical fixture
    // (makeFixture(); writeBaseFiles();) and asserted a strict subset of this.
    it('allows Claude to expose supported events outside the Codex subset', () => {
      makeFixture();
      writeBaseFiles();

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('handler files exist on disk');
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
    // Consolidated: one fixture, both documented-asymmetry directions
    // (missing main events + Cursor-native extras) — previously two tests
    // asserting two PASS lines of the same run.
    it('passes when Cursor has only documented missing and Cursor-native events', () => {
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
      expect(result.stdout).toContain('cursor-only events are all documented (2 events');
    });

    it('fails when Cursor is missing an undocumented main event', () => {
      makeFixture();
      const claude = claudeHooks({ BrandNewEvent: handlerGroup() });
      writeBaseFiles({ claude, cursor: cursorHooks({ afterFileEdit: 'handler.mjs' }) });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('missing UNDOCUMENTED events: BrandNewEvent');
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

  describe('per-event handler-set parity (#942)', () => {
    // Bug class: a handler wired on ONE platform's event only was structurally
    // invisible to checks 1-4 (event keys + file existence both symmetric).
    // post-bash-write-verify.mjs shipped Claude-only exactly this way.
    it('fails when a handler is wired on a Claude event but missing from the same Codex event', () => {
      makeFixture();
      const claude = claudeHooks({
        PostToolUse: [{
          matcher: '*',
          hooks: [
            commandHook('CLAUDE_PLUGIN_ROOT', 'handler.mjs'),
            commandHook('CLAUDE_PLUGIN_ROOT', 'one-platform-only.mjs'),
          ],
        }],
      });
      writeBaseFiles({ claude, handlers: ['one-platform-only.mjs'] });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        'hooks-codex.json missing UNDOCUMENTED handlers on shared events: PostToolUse → one-platform-only.mjs',
      );
    });

    it('fails when the #942 handler is on Claude PostToolUse but missing from Pi tool_result', () => {
      makeFixture();
      const claude = claudeHooks({
        PostToolUse: [{
          matcher: '*',
          hooks: [
            commandHook('CLAUDE_PLUGIN_ROOT', 'handler.mjs'),
            commandHook('CLAUDE_PLUGIN_ROOT', 'post-bash-write-verify.mjs'),
          ],
        }],
      });
      writeBaseFiles({
        claude,
        pi: validPiHooks(),
        handlers: ['post-bash-write-verify.mjs', ...REQUIRED_PI_HANDLER_FILES],
      });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        'hooks-pi.json missing UNDOCUMENTED handlers on shared events: PostToolUse → post-bash-write-verify.mjs',
      );
    });

    // Bug class: a counterpart declaring a FOREIGN event namespace matched no
    // Claude event key, so the per-event loop `continue`d every iteration and
    // reported PASS having compared nothing. hooks-cursor.json passed this way
    // with 20 of 22 handlers missing. Projecting the Cursor namespace onto the
    // logical Claude events is what makes the comparison real.
    it('fails when a Cursor-native event omits a handler wired on the Claude event it maps to', () => {
      makeFixture();
      const claude = claudeHooks({
        PreToolUse: [{
          matcher: '*',
          hooks: [
            commandHook('CLAUDE_PLUGIN_ROOT', 'handler.mjs'),
            commandHook('CLAUDE_PLUGIN_ROOT', 'enforce-commands.mjs'),
          ],
        }],
      });
      writeBaseFiles({
        claude,
        // beforeShellExecution projects onto PreToolUse but drops the handler
        // it is supposed to map there.
        cursor: cursorHooks({
          afterFileEdit: 'handler.mjs',
          beforeShellExecution: 'handler.mjs',
        }),
        handlers: ['enforce-commands.mjs'],
      });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        'hooks-cursor.json missing UNDOCUMENTED handlers on shared events: PreToolUse → enforce-commands.mjs',
      );
    });

    // Vacuum guard: the same PASS-without-comparing state, reached from the
    // other side — the counterpart's events project onto nothing hooks.json
    // declares. Without this the loop is silent and the file reports parity.
    it('fails when a counterpart shares zero logical events with hooks.json', () => {
      makeFixture();
      const claude = claudeHooks();
      delete claude.hooks.PreToolUse;
      delete claude.hooks.PostToolUse;
      writeBaseFiles({
        claude,
        cursor: cursorHooks({
          afterFileEdit: 'handler.mjs',
          beforeShellExecution: 'handler.mjs',
        }),
      });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        'hooks-cursor.json shares ZERO logical events with hooks.json after projection (declares: PostToolUse, PreToolUse)',
      );
    });

    // Bug class (#946): the vacuum guard only fired when EVERY projection was
    // lost (`sharedEvents.length === 0`). Drop ONE entry from cursorEventMap and
    // the affected native event projects onto nothing, the per-event loop
    // `continue`s on the logical event it was supposed to cover, and Check 6
    // still reports PASS — the only moving signal is the `documented
    // asymmetries:` count. Measured 2026-07-31 on a copy of the tree with just
    // `afterFileEdit: 'PostToolUse'` removed: cursor went from "documented
    // asymmetries: 12" to "8" and the run stayed "Results: 12 passed, 0 failed".
    // `afterFileWrite` below stands in for that dropped projection — a
    // Cursor-native event with no cursorEventMap entry. (Check 2 flags it as an
    // undocumented extra as collateral; the assertions pin Check 6, the surface
    // that was blind.)
    it('fails when a Cursor-native event projects onto nothing while hooks.json carries an uncompared handler', () => {
      makeFixture();
      const claude = claudeHooks({
        PostToolUse: [{
          matcher: '*',
          hooks: [
            commandHook('CLAUDE_PLUGIN_ROOT', 'handler.mjs'),
            commandHook('CLAUDE_PLUGIN_ROOT', 'one-platform-only.mjs'),
          ],
        }],
      });
      // Keep Codex in parity so the only Check-6 finding is the Cursor one.
      const codex = codexHooks();
      codex.hooks.PostToolUse = [{
        matcher: '*',
        hooks: [
          commandHook('PLUGIN_ROOT', 'handler.mjs'),
          commandHook('PLUGIN_ROOT', 'one-platform-only.mjs'),
        ],
      }];
      writeBaseFiles({
        claude,
        codex,
        cursor: cursorHooks({
          beforeShellExecution: 'handler.mjs', // projects onto PreToolUse — shared
          afterFileWrite: 'handler.mjs',       // no cursorEventMap entry — projects onto nothing
        }),
        handlers: ['one-platform-only.mjs'],
      });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        'FAIL: hooks-cursor.json declares events with no logical counterpart in hooks.json after projection: afterFileWrite',
      );
      // The vacuous PASS is the defect itself: HEAD printed this line while
      // PostToolUse → one-platform-only.mjs was never compared.
      expect(result.stdout).not.toContain(
        'PASS: hooks-cursor.json per-event handler sets match hooks.json',
      );
    });

    // Bug class (#946): handlersByMainEvent ASSIGNED per native event
    // (`byMain[target] = handlers`), so two counterpart events projecting onto
    // the same logical event silently dropped the first handler set. Both live
    // maps are injective, but the identity fallback already reaches the case: a
    // counterpart may declare the logical event AND a native event that projects
    // onto it. Union semantics must keep both handler sets.
    it('unions handler sets when two counterpart events project onto the same logical event', () => {
      makeFixture();
      const claude = claudeHooks({
        PreToolUse: [{
          matcher: '*',
          hooks: [
            commandHook('CLAUDE_PLUGIN_ROOT', 'handler.mjs'),
            commandHook('CLAUDE_PLUGIN_ROOT', 'enforce-commands.mjs'),
          ],
        }],
      });
      const codex = codexHooks();
      codex.hooks.PreToolUse = [{
        matcher: '*',
        hooks: [
          commandHook('PLUGIN_ROOT', 'handler.mjs'),
          commandHook('PLUGIN_ROOT', 'enforce-commands.mjs'),
        ],
      }];
      writeBaseFiles({
        claude,
        codex,
        // PreToolUse (identity projection) carries enforce-commands.mjs;
        // beforeShellExecution projects onto the SAME PreToolUse with
        // handler.mjs. Union → both present. Assignment → the identity set is
        // overwritten and enforce-commands.mjs is reported missing.
        cursor: cursorHooks({
          PreToolUse: 'enforce-commands.mjs',
          beforeShellExecution: 'handler.mjs',
        }),
        handlers: ['enforce-commands.mjs'],
      });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'PASS: hooks-cursor.json per-event handler sets match hooks.json (documented asymmetries: 0)',
      );
    });

    it('passes when the missing handler is a documented asymmetry (Codex allowlist)', () => {
      // Guards the allowlist mechanism itself: deleting handlerAsymmetries
      // would turn every documented platform gap into a gate-breaking FAIL.
      makeFixture();
      const claude = claudeHooks({
        PostToolUse: [{
          matcher: '*',
          hooks: [
            commandHook('CLAUDE_PLUGIN_ROOT', 'handler.mjs'),
            commandHook('CLAUDE_PLUGIN_ROOT', 'post-bash-write-verify.mjs'),
          ],
        }],
      });
      writeBaseFiles({ claude, handlers: ['post-bash-write-verify.mjs'] });

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'hooks-codex.json per-event handler sets match hooks.json (documented asymmetries: 1)',
      );
    });
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

    it('reports an unreferenced hook file without failing', () => {
      makeFixture();
      writeBaseFiles();
      writeHandlerFiles(['orphan.mjs']);

      const result = runValidator(fixtureRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('unreferenced .mjs files');
      expect(result.stdout).toContain('orphan.mjs');
    });
  });
});
