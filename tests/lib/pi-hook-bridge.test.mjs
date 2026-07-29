/**
 * tests/lib/pi-hook-bridge.test.mjs
 *
 * Unit tests for the Pi extension bridge. The tests exercise normalization,
 * manifest selection, and the block contract without requiring a Pi runtime.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
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
  readHookDecision,
  runPiHookEvent,
  selectPiHooks,
} from '@lib/pi-hook-bridge.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const IO_DRIVER = fileURLToPath(new URL('../fixtures/io-driver.mjs', import.meta.url));

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

    expect(commands).toContain('sh "$PI_PLUGIN_ROOT/hooks/run-node.sh" "$PI_PLUGIN_ROOT/hooks/pre-bash-destructive-guard.mjs"');
    expect(commands).toContain('sh "$PI_PLUGIN_ROOT/hooks/run-node.sh" "$PI_PLUGIN_ROOT/hooks/enforce-commands.mjs"');
  });

  it('selects wildcard tool_result hooks', () => {
    const manifest = loadPiHookManifest(REPO_ROOT);
    const hooks = selectPiHooks(manifest, 'tool_result', { toolName: 'read' });
    const commands = hooks.map((h) => h.command);

    expect(commands).toEqual(['sh "$PI_PLUGIN_ROOT/hooks/run-node.sh" "$PI_PLUGIN_ROOT/hooks/loop-guard.mjs"']);
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

  // NOTE: the fixture written in beforeEach deliberately uses the LEGACY deny
  // protocol (flat `{permissionDecision, reason}` + exit 2). Third-party hooks
  // outside this repo still speak it, so this test pins backwards compatibility.
  // Do not migrate it to the current envelope — the test below covers that.
  it('returns a Pi block response when an underlying hook denies (legacy flat form + exit 2)', async () => {
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

  // Regression guard for the #906 protocol migration. Under the current contract
  // a denying hook exits 0 and nests its decision in `hookSpecificOutput`. The
  // pre-migration bridge keyed on `status === 2 || parsed.permissionDecision`,
  // so this shape produced block=false — the deny vanished silently on the pi
  // lane while every existing (legacy-format) fixture stayed green.
  it('blocks on the current hookSpecificOutput envelope emitted with exit 0', async () => {
    writeFileSync(
      path.join(tmp, 'hooks', 'deny.mjs'),
      [
        'let raw = "";',
        'process.stdin.on("data", (chunk) => { raw += chunk; });',
        'process.stdin.on("end", () => {',
        '  const payload = JSON.parse(raw);',
        '  console.log(JSON.stringify({',
        '    hookSpecificOutput: {',
        '      hookEventName: "PreToolUse",',
        '      permissionDecision: "deny",',
        '      permissionDecisionReason: `blocked ${payload.tool_name}`,',
        '    },',
        '    systemMessage: "\\u26d4 blocked",',
        '  }));',
        '  process.exit(0);',
        '});',
      ].join('\n'),
      'utf8',
    );

    const result = await runPiHookEvent(
      'tool_call',
      { toolName: 'bash', input: { command: 'rm -rf /tmp/x' } },
      { cwd: tmp },
      { pluginRoot: tmp },
    );

    expect(result.block).toBe(true);
    expect(result.results[0].status).toBe(0);
    // Must be the reason from inside the envelope — not the raw JSON line, which
    // is what the stdout.trim() fallback would surface.
    expect(result.reason).toBe('blocked Bash');
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

  // Bug this catches: with every in-repo hook now denying at exit 0 (#906), the
  // stdout parse is the SOLE remaining block signal on the pi lane. A deny
  // envelope truncated mid-flight parsed as nothing, `deny` stayed false, and
  // the status-based net could not fire because the status was 0 — measured
  // block=false before this guard. A guard whose output channel broke must not
  // read as "allow".
  it('fails closed when a PreToolUse decision envelope arrives truncated', async () => {
    writeFileSync(
      path.join(tmp, 'hooks', 'deny.mjs'),
      [
        'process.stdout.write(\'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionRea\');',
        'process.exit(0);',
      ].join('\n'),
      'utf8',
    );

    const result = await runPiHookEvent(
      'tool_call',
      { toolName: 'bash', input: { command: 'rm -rf /tmp/x' } },
      { cwd: tmp },
      { pluginRoot: tmp },
    );

    expect(result.block).toBe(true);
    expect(result.results[0].status).toBe(0);
    // Diagnosis, not an echo of the mangled blob — `stdout.trim()` would dump
    // the whole truncated payload into the operator-facing reason.
    expect(result.reason).toContain('not a parseable decision envelope');
  });

  // Bug this catches: the scan used to take the LAST parseable JSON line, so any
  // line printed after the verdict — `emitSystemMessage`, or a third-party
  // hook's trailing JSON — shadowed the deny and the bridge read "no decision"
  // ⇒ allow. First-envelope-wins skips non-decision lines instead.
  it('honours the first decision envelope, not the last JSON line', async () => {
    writeFileSync(
      path.join(tmp, 'hooks', 'deny.mjs'),
      [
        'console.log(JSON.stringify({ hookSpecificOutput: {',
        '  hookEventName: "PreToolUse",',
        '  permissionDecision: "deny",',
        '  permissionDecisionReason: "policy X",',
        '} }));',
        'console.log(JSON.stringify({ systemMessage: "trailing note" }));',
        'process.exit(0);',
      ].join('\n'),
      'utf8',
    );

    const result = await runPiHookEvent(
      'tool_call',
      { toolName: 'bash', input: { command: 'rm -rf /tmp/x' } },
      { cwd: tmp },
      { pluginRoot: tmp },
    );

    expect(result.block).toBe(true);
    expect(result.reason).toBe('policy X');
  });

  // Bug this catches: over-blocking. The naive fail-closed rule ("stdout
  // non-empty but unparseable ⇒ block") makes every third-party hook that logs
  // progress a permanent blocker — the bridge spawns whatever the Pi manifest
  // points at, not just hooks this repo owns. An earlier cut of
  // `looksLikeBrokenEnvelope` treated a leading `[` as a JSON opener and blocked
  // on the progress bar below; this pins the carve-out.
  it('does not block on non-JSON chatter from an allowing hook', async () => {
    writeFileSync(
      path.join(tmp, 'hooks', 'deny.mjs'),
      [
        'console.log("checking policy...");',
        'console.log("[####----] 50%");',
        'process.exit(0);',
      ].join('\n'),
      'utf8',
    );

    const result = await runPiHookEvent(
      'tool_call',
      { toolName: 'bash', input: { command: 'echo ok' } },
      { cwd: tmp },
      { pluginRoot: tmp },
    );

    expect(result.block).toBe(false);
    expect(result.reason).toBe(null);
  });
});

// Wiring test (`.claude/rules/test-value.md` TV-005): producer and consumer of
// the deny envelope are otherwise only ever tested against their own doubles —
// `tests/lib/io.test.mjs` asserts what `emitDeny` writes, this file asserts what
// the bridge reads, and neither ever sees the other. Renaming
// `hookSpecificOutput` in io.mjs turns io.test.mjs red while every hand-built
// fixture here stays green, exactly while the bridge starts letting every deny
// through. This spawns the REAL producer and feeds its REAL stdout to the
// consumer, so that rename lands red here too.
describe('readHookDecision ↔ emitDeny wiring', () => {
  it('reads a deny out of the envelope emitDeny actually emits', () => {
    const produced = spawnSync(process.execPath, [IO_DRIVER, 'emit-deny', 'policy violation'], {
      encoding: 'utf8',
    });

    expect(produced.status).toBe(0);
    expect(readHookDecision(produced.stdout)).toMatchObject({
      deny: true,
      reason: 'policy violation',
      malformed: false,
    });
  });
});
