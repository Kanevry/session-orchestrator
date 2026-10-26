/**
 * tests/hooks/pre-tool-state-md-path-guard.test.mjs
 *
 * Tests for hooks/pre-tool-state-md-path-guard.mjs — GitLab #1790: two sessions
 * wrote their wave plan to `<repo>/.orchestrator/STATE.md` (one via the Write
 * tool, one via a Bash heredoc) and `/close`, reading `.claude/STATE.md`, recorded
 * a false `closed-without-plan`.
 *
 * Strategy: spawn the real hook with a real PreToolUse payload on stdin and
 * discriminate on the STDOUT ENVELOPE via expectAllow/expectDeny (allow and deny
 * share exit code 0). No test writes any file: every path below is a string.
 * The deny cases are red before #1790 by construction — the hook did not exist.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expectAllow, expectDeny } from '../_helpers/hook-decision.mjs';

const HOOK = resolve(import.meta.dirname, '../..', 'hooks/pre-tool-state-md-path-guard.mjs');
const REPO = join(tmpdir(), 'so-state-md-guard-fixture', 'repo');

/**
 * Spawn the hook. `raw` sends stdin verbatim; otherwise the payload is
 * JSON-encoded. Ambient bypasses and platform/state-dir overrides are cleared so
 * a deny cannot turn into a vacuous allow and the suggested path is `.claude`.
 */
function runHook({ payload, raw, env = {} } = {}) {
  return spawnSync('node', [HOOK], {
    input: raw ?? JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, SO_DISABLED_HOOKS: '', SO_HOOK_PROFILE: '', SO_STATE_DIR: '', SO_PLATFORM: 'claude', ...env },
  });
}

const write = (filePath) => ({ tool_name: 'Write', tool_input: { file_path: filePath, content: '---\nstatus: active\n---\n' } });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

describe('pre-tool-state-md-path-guard — deny (#1790 incidents)', () => {
  it('denies the Write-tool incident and names the platform state path', () => {
    expectDeny(runHook({ payload: write(join(REPO, '.orchestrator', 'STATE.md')) }), [
      join(REPO, '.claude', 'STATE.md'),
      '#1790',
    ]);
  });

  it('denies the verbatim Bash heredoc incident', () => {
    const command =
      'cd /tmp/x/wt && mkdir -p .orchestrator && cat > .orchestrator/STATE.md <<EOF\n---\nstatus: active\n---\nEOF';
    expectDeny(runHook({ payload: bash(command) }), '.claude/STATE.md');
  });

  // The fleet never advertises a hook bypass to the model; the one legitimate
  // case (SO_STATE_DIR=.orchestrator) already allows without it.
  it('does not name the SO_DISABLED_HOOKS bypass in the deny reason', () => {
    const r = runHook({ payload: write(join(REPO, '.orchestrator', 'STATE.md')) });
    expectDeny(r, '#1790');
    expect(r.stdout).not.toContain('SO_DISABLED_HOOKS');
  });
});

describe('pre-tool-state-md-path-guard — allow (fleet safety)', () => {
  it.each([
    ['Write to the correct state path', write(join(REPO, '.claude', 'STATE.md'))],
    ['Write to the sessions ledger (not this hook)', write(join(REPO, '.orchestrator', 'metrics', 'sessions.jsonl'))],
    ['Write to a STATE.md outside .orchestrator/', write(join(REPO, 'docs', 'STATE.md'))],
    ['a Bash read of .orchestrator/STATE.md', bash('head -30 .orchestrator/STATE.md')],
  ])('allows %s', (_label, payload) => {
    expectAllow(runHook({ payload }));
  });

  it('allows when SO_STATE_DIR=.orchestrator makes that path the real state file', () => {
    expectAllow(runHook({ payload: write(join(REPO, '.orchestrator', 'STATE.md')), env: { SO_STATE_DIR: '.orchestrator' } }));
  });

  it('allows (exit 0) on unparsable stdin', () => {
    const r = runHook({ raw: '{not json' });
    expectAllow(r);
    expect(r.status).toBe(0);
  });
});

describe('pre-tool-state-md-path-guard — path normalisation and matcher edges', () => {
  const stateFile = join(REPO, '.orchestrator', 'STATE.md');
  it.each([
    ['denies a Write through a ../ segment', expectDeny, { payload: write(join(REPO, '.orchestrator', '..', '.orchestrator', 'STATE.md')) }],
    ['denies a Write with backslash separators', expectDeny, { payload: write(`${tmpdir()}\\so-fixture\\repo\\.orchestrator\\STATE.md`) }],
    ['denies a case-variant .Orchestrator/state.md', expectDeny, { payload: write(join(REPO, '.Orchestrator', 'state.md')) }],
    ['denies a MultiEdit payload', expectDeny, { payload: { tool_name: 'MultiEdit', tool_input: { file_path: stateFile, edits: [{ old_string: 'a', new_string: 'b' }] } } }],
    ['denies a tee write in a pipeline', expectDeny, { payload: bash('printf x | tee .orchestrator/STATE.md') }],
    ['allows SO_STATE_DIR=.orchestrator/ with a trailing slash', expectAllow, { payload: write(stateFile), env: { SO_STATE_DIR: '.orchestrator/' } }],
    ['allows a Bash grep (read only)', expectAllow, { payload: bash('grep status .orchestrator/STATE.md') }],
  ])('%s', (_label, assertDecision, run) => {
    assertDecision(runHook(run));
  });
});
