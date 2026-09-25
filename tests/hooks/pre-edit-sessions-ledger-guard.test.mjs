/**
 * tests/hooks/pre-edit-sessions-ledger-guard.test.mjs
 *
 * Tests for hooks/pre-edit-sessions-ledger-guard.mjs — GitLab #1443 item 4: the
 * Edit/Write/MultiEdit tools were an unguarded second route into
 * `.orchestrator/metrics/sessions.jsonl` (the Bash guard covers shell writes only).
 *
 * Strategy: spawn the real hook with a real PreToolUse payload on stdin and
 * discriminate on the STDOUT ENVELOPE via expectAllow/expectDeny (under the #906
 * exit-0 protocol allow and deny share exit code 0). No test writes any file: the
 * hook never touches disk, the ledger paths below are strings only.
 *
 * Every case is red against ae452d33 by construction — the hook did not exist.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expectAllow, expectDeny } from '../_helpers/hook-decision.mjs';

const HOOK = resolve(import.meta.dirname, '../..', 'hooks/pre-edit-sessions-ledger-guard.mjs');
const LEDGER = join(tmpdir(), 'so-ledger-guard-fixture', '.orchestrator', 'metrics', 'sessions.jsonl');

/**
 * Spawn the hook. `raw` sends stdin verbatim (broken/empty payloads); otherwise
 * the payload object is JSON-encoded. SO_DISABLED_HOOKS / SO_HOOK_PROFILE are
 * cleared so an operator's ambient bypass cannot turn a deny into a vacuous allow.
 */
function runHook({ payload, raw, env = {} } = {}) {
  return spawnSync('node', [HOOK], {
    input: raw ?? JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, SO_DISABLED_HOOKS: '', SO_HOOK_PROFILE: '', ...env },
  });
}

const edit = (filePath) => ({
  tool_name: 'Edit',
  tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' },
});

describe('pre-edit-sessions-ledger-guard — allow paths (fleet safety)', () => {
  it('allows Edit on a normal file', () => {
    expectAllow(runHook({ payload: edit('/repo/scripts/lib/foo.mjs') }));
  });

  it('allows Write on a normal file', () => {
    expectAllow(runHook({ payload: { tool_name: 'Write', tool_input: { file_path: '/repo/README.md', content: 'x' } } }));
  });

  it('allows (exit 0) on broken JSON stdin', () => {
    const r = runHook({ raw: '{not json' });
    expectAllow(r);
    expect(r.status).toBe(0);
  });

  it('allows on empty stdin', () => {
    expectAllow(runHook({ raw: '' }));
  });

  it('allows an unknown tool_name even when it names the ledger', () => {
    expectAllow(runHook({ payload: { tool_name: 'Read', tool_input: { file_path: LEDGER } } }));
  });

  it('allows when tool_input carries no file_path', () => {
    expectAllow(runHook({ payload: { tool_name: 'Edit', tool_input: {} } }));
  });

  it('allows NotebookEdit (not in the matcher; the hook judges Edit/Write/MultiEdit only)', () => {
    expectAllow(runHook({ payload: { tool_name: 'NotebookEdit', tool_input: { notebook_path: LEDGER } } }));
  });

  it('allows ledger look-alikes outside .orchestrator/metrics and sibling ledgers', () => {
    for (const p of [
      join(tmpdir(), 'x', 'sessions.jsonl'),
      '/repo/.orchestrator/metrics/sessions.jsonl.bak',
      '/repo/.orchestrator/metrics/learnings.jsonl',
      '/repo/x.orchestrator/metrics/sessions.jsonl',
    ]) {
      expectAllow(runHook({ payload: edit(p) }));
    }
  });

  it('allows the ledger path when SO_DISABLED_HOOKS names this hook', () => {
    expectAllow(runHook({ payload: edit(LEDGER), env: { SO_DISABLED_HOOKS: 'pre-edit-sessions-ledger-guard' } }));
  });
});

describe('pre-edit-sessions-ledger-guard — deny paths', () => {
  it('denies Edit on the ledger and names the writer and the reader', () => {
    expectDeny(runHook({ payload: edit(LEDGER) }), ['emit-session.mjs', 'check-sessions-integrity.mjs']);
  });

  it('denies Write on a rotated archive (sessions.jsonl.1)', () => {
    expectDeny(
      runHook({ payload: { tool_name: 'Write', tool_input: { file_path: `${LEDGER}.1`, content: '{}' } } }),
      'emit-session.mjs',
    );
  });

  it('denies MultiEdit on the ledger (file_path is top-level in tool_input)', () => {
    expectDeny(
      runHook({
        payload: {
          tool_name: 'MultiEdit',
          tool_input: { file_path: LEDGER, edits: [{ old_string: 'a', new_string: 'b' }] },
        },
      }),
      'emit-session.mjs',
    );
  });

  it('denies relative, dot-dot and backslash spellings of the ledger path', () => {
    for (const p of [
      '.orchestrator/metrics/sessions.jsonl',
      '/repo/.orchestrator/metrics/../metrics/sessions.jsonl',
      'C:\\repo\\.orchestrator\\metrics\\sessions.jsonl',
    ]) {
      expectDeny(runHook({ payload: edit(p) }), 'emit-session.mjs');
    }
  });
});
