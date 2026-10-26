/**
 * tests/hooks/pre-tool-state-md-path-guard-wiring.test.mjs
 *
 * WIRING test for hooks/pre-tool-state-md-path-guard.mjs (SO#1790). The guard
 * only protects a harness whose manifest registers it on BOTH the edit side and
 * the shell side; a dropped registration (or an `Edit|Write`-only matcher that
 * loses MultiEdit) disables it there without any error. The hook's own tests
 * spawn it directly and cannot see that. Codex carries the Bash side only: its
 * edit side is a documented asymmetry (hooks-codex.json has no edit matcher).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const HOOKS_DIR = path.resolve(import.meta.dirname, '../../hooks');
const HANDLER = 'pre-tool-state-md-path-guard.mjs';

/** Every {event, matcher, hook} registration whose command names the handler. */
function registrations(file) {
  const manifest = JSON.parse(readFileSync(path.join(HOOKS_DIR, file), 'utf8'));
  const out = [];
  for (const [event, blocks] of Object.entries(manifest.hooks ?? {})) {
    for (const block of blocks) {
      for (const hook of block.hooks ?? []) {
        if (String(hook.command ?? '').includes(HANDLER)) out.push({ event, matcher: block.matcher ?? '', hook });
      }
    }
  }
  return out;
}

const tokens = (matcher) => matcher.split('|').map((t) => t.trim());

const MANIFESTS = [
  {
    file: 'hooks.json',
    command: `exec sh "$CLAUDE_PLUGIN_ROOT/hooks/run-node.sh" "$CLAUDE_PLUGIN_ROOT/hooks/${HANDLER}"`,
    edit: { event: 'PreToolUse', needs: ['Edit', 'Write', 'MultiEdit'] },
    shell: { event: 'PreToolUse', needs: ['Bash'] },
  },
  {
    file: 'hooks-cursor.json',
    command: `sh "$CURSOR_PLUGIN_ROOT/hooks/run-node.sh" "$CURSOR_PLUGIN_ROOT/hooks/${HANDLER}"`,
    edit: { event: 'preToolUse', needs: ['Write', 'Edit', 'MultiEdit'] },
    shell: { event: 'beforeShellExecution', needs: ['*'] },
  },
  {
    file: 'hooks-pi.json',
    command: `sh "$PI_PLUGIN_ROOT/hooks/run-node.sh" "$PI_PLUGIN_ROOT/hooks/${HANDLER}"`,
    edit: { event: 'tool_call', needs: ['edit', 'write'] },
    shell: { event: 'tool_call', needs: ['bash'] },
  },
];

describe.each(MANIFESTS)('$file registers the STATE.md path guard', ({ file, command, edit, shell }) => {
  const regs = registrations(file);

  // Catches: one of the two registrations removed -> guard silently off for
  // edits or for shell writes on this harness; or a double registration.
  it('registers it exactly once on the edit side and once on the shell side', () => {
    expect(regs.map((r) => r.event).sort()).toEqual([edit.event, shell.event].sort());
  });

  // Catches: matcher narrowed (e.g. MultiEdit dropped) or pointed at the wrong tool.
  it('covers every edit-side tool and the shell tool through the right matcher', () => {
    const editReg = regs.find((r) => r.event === edit.event && tokens(r.matcher).includes(edit.needs[0]));
    const shellReg = regs.find((r) => r.event === shell.event && tokens(r.matcher).includes(shell.needs[0]));
    expect(tokens(editReg.matcher)).toEqual(expect.arrayContaining(edit.needs));
    expect(tokens(shellReg.matcher)).toEqual(expect.arrayContaining(shell.needs));
    expect(shellReg).not.toBe(editReg);
  });

  // Catches: wrong invocation form (bare node, missing run-node.sh shim, no
  // timeout) or a path to a handler that does not exist.
  it('uses the manifest-standard invocation and an existing handler file', () => {
    for (const { hook } of regs) {
      expect(hook).toEqual({ type: 'command', command, timeout: 5 });
    }
    expect(existsSync(path.join(HOOKS_DIR, HANDLER))).toBe(true);
  });
});

describe('hooks-codex.json registers the STATE.md path guard on Bash only', () => {
  // Catches: Bash registration dropped on Codex, or an edit-side entry that can
  // never fire there (no payload adapter) advertising protection it lacks.
  it('has exactly one PreToolUse registration, on the Bash matcher', () => {
    const regs = registrations('hooks-codex.json');
    expect(regs.map((r) => [r.event, r.matcher])).toEqual([['PreToolUse', 'Bash']]);
    expect(regs[0].hook.command).toBe(
      `SO_PLATFORM=codex CODEX_PLUGIN_ROOT="\${PLUGIN_ROOT}" sh "\${PLUGIN_ROOT}/hooks/run-node.sh" "\${PLUGIN_ROOT}/hooks/${HANDLER}"`,
    );
  });
});
