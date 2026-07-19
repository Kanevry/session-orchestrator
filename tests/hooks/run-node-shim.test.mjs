/**
 * tests/hooks/run-node-shim.test.mjs
 *
 * Regression tests for GH Kanevry/session-orchestrator#53:
 * plugin hooks failed noisily ("/bin/sh: node: command not found" on every
 * tool call) when `node` was not on the harness's hook-exec PATH. The fix is
 * hooks/run-node.sh — a POSIX-sh shim that resolves node robustly
 * (SO_NODE_BIN > PATH > well-known dirs > nvm), exec's it transparently, and
 * degrades gracefully (exit 0 + one rate-limited warning) when node is
 * missing. All command-shaped hook configs must route through the shim.
 */

import { afterEach, describe, it, expect } from 'vitest';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  chmodSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseCodexHookWrapperCommand } from '../../scripts/lib/codex/plugin-contract.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIM = path.join(REPO_ROOT, 'hooks', 'run-node.sh');

const COMMAND_CONFIGS = ['hooks/hooks.json', 'hooks/hooks-codex.json', 'hooks/hooks-pi.json'];

const TRUSTED_CLAUDE_PI_WRAPPER =
  /^sh "\$(CLAUDE|PI)_PLUGIN_ROOT\/hooks\/run-node\.sh" "\$\1_PLUGIN_ROOT\/hooks\/[\w-]+(?:\/[\w-]+)*\.mjs"$/;

function isTrustedWrapper(platform, command) {
  if (platform === 'Codex') return parseCodexHookWrapperCommand(command) !== null;
  return TRUSTED_CLAUDE_PI_WRAPPER.test(command);
}

const sandboxRoots = new Set();

afterEach(() => {
  for (const root of sandboxRoots) rmSync(root, { recursive: true, force: true });
  sandboxRoots.clear();
});

/** Build an isolated sandbox: empty PATH dir, HOME, TMPDIR, no-node search dir. */
function makeSandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'run-node-shim-'));
  sandboxRoots.add(root);
  const dirs = {
    root,
    emptyBin: path.join(root, 'emptybin'),
    home: path.join(root, 'home'),
    tmp: path.join(root, 'tmp'),
    fakeBin: path.join(root, 'fakebin'),
    none: path.join(root, 'none'),
  };
  for (const d of Object.values(dirs)) if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return dirs;
}

/** Minimal env that guarantees node is unreachable unless a test adds it back. */
function nodelessEnv(dirs, extra = {}) {
  return {
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    PATH: dirs.emptyBin,
    SO_NODE_SEARCH_DIRS: dirs.none,
    NVM_DIR: dirs.none,
    ...extra,
  };
}

function runShim(env, args, input) {
  return spawnSync('/bin/sh', [SHIM, ...args], { env, input, encoding: 'utf8', timeout: 10_000 });
}

/** Commands that reference a hooks/*.mjs handler but bypass the shim. */
function unwrappedNodeCommands(cfg) {
  const bad = [];
  for (const matchers of Object.values(cfg.hooks ?? {})) {
    for (const m of Array.isArray(matchers) ? matchers : [matchers]) {
      for (const h of m.hooks ?? []) {
        const cmd = typeof h.command === 'string' ? h.command : '';
        if (/\/hooks\/[\w/-]+\.mjs/.test(cmd) && !cmd.includes('run-node.sh')) {
          bad.push(cmd);
        }
      }
    }
  }
  return bad;
}

describe('run-node.sh — node resolution (GH#53)', () => {
  it('passes argv, stdout, stderr, and exit code through unchanged', () => {
    const dirs = makeSandbox();
    const hook = path.join(dirs.root, 'hook.mjs');
    writeFileSync(
      hook,
      'process.stdout.write("out:" + process.argv[2]); process.stderr.write("err:" + process.argv[3]); process.exit(3);',
    );
    symlinkSync(process.execPath, path.join(dirs.fakeBin, 'node'));

    const res = runShim(
      nodelessEnv(dirs, { PATH: dirs.fakeBin }),
      [hook, 'stdout-arg', 'stderr-arg'],
    );

    expect(res.stdout).toBe('out:stdout-arg');
    expect(res.stderr).toBe('err:stderr-arg');
    expect(res.status).toBe(3);
  });

  it('passes stdin through to the hook script (hook JSON contract)', () => {
    const dirs = makeSandbox();
    const hook = path.join(dirs.root, 'stdin.mjs');
    writeFileSync(
      hook,
      'let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => process.stdout.write("got:" + d));',
    );
    symlinkSync(process.execPath, path.join(dirs.fakeBin, 'node'));
    const res = runShim(nodelessEnv(dirs, { PATH: dirs.fakeBin }), [hook], '{"tool":"Bash"}');
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('got:{"tool":"Bash"}');
  });

  it('SO_NODE_BIN override wins over PATH', () => {
    const dirs = makeSandbox();
    const fakeNode = path.join(dirs.fakeBin, 'node');
    writeFileSync(fakeNode, '#!/bin/sh\necho "fake-node:$1"\nexit 0\n');
    chmodSync(fakeNode, 0o755);
    const res = runShim(nodelessEnv(dirs, { SO_NODE_BIN: fakeNode }), ['some-script.mjs']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('fake-node:some-script.mjs');
  });

  it('falls back to SO_NODE_SEARCH_DIRS when PATH has no node', () => {
    const dirs = makeSandbox();
    const fakeNode = path.join(dirs.fakeBin, 'node');
    writeFileSync(fakeNode, '#!/bin/sh\necho "fake-node:$1"\nexit 0\n');
    chmodSync(fakeNode, 0o755);
    const res = runShim(nodelessEnv(dirs, { SO_NODE_SEARCH_DIRS: dirs.fakeBin }), ['x.mjs']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('fake-node:x.mjs');
  });
});

describe('run-node.sh — graceful degradation when node is missing (GH#53)', () => {
  it('exits 0 (non-blocking) and prints one actionable warning', () => {
    const dirs = makeSandbox();
    const res = runShim(nodelessEnv(dirs), ['whatever.mjs']);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("'node' not found");
    expect(res.stderr).toContain('SO_NODE_BIN');
    // Marker file created so subsequent invocations stay silent.
    expect(existsSync(path.join(dirs.tmp, 'session-orchestrator-node-missing-uid'))).toBe(true);
  });

  it('stays silent on repeat invocations within the rate-limit window', () => {
    const dirs = makeSandbox();
    const first = runShim(nodelessEnv(dirs), ['whatever.mjs']);
    expect(first.stderr).toContain("'node' not found");
    const second = runShim(nodelessEnv(dirs), ['whatever.mjs']);
    expect(second.status).toBe(0);
    expect(second.stderr).toBe('');
  });
});

describe('hook configs route through run-node.sh (wiring guard, GH#53)', () => {
  for (const rel of COMMAND_CONFIGS) {
    it(`${rel} has no bare-node hook commands`, () => {
      const cfg = JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      expect(unwrappedNodeCommands(cfg)).toEqual([]);
    });
  }

  it('the guard itself flags a bare-node command (fake-regression check)', () => {
    const drifted = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'node "$CLAUDE_PLUGIN_ROOT/hooks/enforce-commands.mjs"' },
            ],
          },
        ],
      },
    };
    expect(unwrappedNodeCommands(drifted)).toHaveLength(1);
  });

  it('every wrapped command still names its .mjs handler (symmetry-check compatibility)', () => {
    for (const rel of COMMAND_CONFIGS) {
      const cfg = JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      for (const matchers of Object.values(cfg.hooks ?? {})) {
        for (const m of matchers) {
          for (const h of m.hooks ?? []) {
            if (typeof h.command === 'string' && h.command.includes('run-node.sh')) {
              if (rel === 'hooks/hooks-codex.json') {
                expect(parseCodexHookWrapperCommand(h.command)).not.toBeNull();
              } else {
                expect(h.command).toMatch(TRUSTED_CLAUDE_PI_WRAPPER);
              }
            }
          }
        }
      }
    }
  });

  it.each([
    [
      'Claude',
      'sh "$CLAUDE_PLUGIN_ROOT/hooks/run-node.sh" "$CLAUDE_PLUGIN_ROOT/hooks/on-stop.mjs"',
    ],
    ['Pi', 'sh "$PI_PLUGIN_ROOT/hooks/run-node.sh" "$PI_PLUGIN_ROOT/hooks/on-stop.mjs"'],
    [
      'Codex',
      'SO_PLATFORM=codex CODEX_PLUGIN_ROOT="${PLUGIN_ROOT}" sh "${PLUGIN_ROOT}/hooks/run-node.sh" "${PLUGIN_ROOT}/hooks/on-stop.mjs"',
    ],
  ])('accepts the trusted %s wrapper contract', (platform, command) => {
    expect(isTrustedWrapper(platform, command)).toBe(true);
  });

  it.each([
    [
      'an arbitrary command prefix',
      'Codex',
      'DEBUG=1 SO_PLATFORM=codex CODEX_PLUGIN_ROOT="${PLUGIN_ROOT}" sh "${PLUGIN_ROOT}/hooks/run-node.sh" "${PLUGIN_ROOT}/hooks/on-stop.mjs"',
    ],
    [
      'a missing Codex environment prefix',
      'Codex',
      'sh "${PLUGIN_ROOT}/hooks/run-node.sh" "${PLUGIN_ROOT}/hooks/on-stop.mjs"',
    ],
    [
      'a mismatched Codex root variable',
      'Codex',
      'SO_PLATFORM=codex CODEX_PLUGIN_ROOT="${CODEX_PLUGIN_ROOT}" sh "${PLUGIN_ROOT}/hooks/run-node.sh" "${PLUGIN_ROOT}/hooks/on-stop.mjs"',
    ],
    [
      'a legacy Codex root wrapper',
      'Codex',
      'sh "$CODEX_PLUGIN_ROOT/hooks/run-node.sh" "$CODEX_PLUGIN_ROOT/hooks/on-stop.mjs"',
    ],
    [
      'mismatched Claude and Pi root variables',
      'Claude',
      'sh "$CLAUDE_PLUGIN_ROOT/hooks/run-node.sh" "$PI_PLUGIN_ROOT/hooks/on-stop.mjs"',
    ],
    [
      'a wrapper with no concrete handler',
      'Codex',
      'SO_PLATFORM=codex CODEX_PLUGIN_ROOT="${PLUGIN_ROOT}" sh "${PLUGIN_ROOT}/hooks/run-node.sh"',
    ],
    ['a bare-node handler command', 'Codex', 'node "${PLUGIN_ROOT}/hooks/on-stop.mjs"'],
  ])('rejects %s', (_case, platform, command) => {
    expect(isTrustedWrapper(platform, command)).toBe(false);
  });
});
