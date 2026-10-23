/**
 * codex-bash-guards-wiring.test.mjs — every Bash hook registered in
 * hooks/hooks-codex.json runs, exactly as registered, on the payload Codex
 * really sends, and enforces there (#1691).
 *
 * THE BUG this pins: a Codex Bash guard that is silently missing, or wired with
 * a command whose handler path does not resolve. check-hooks-symmetry
 * only compares handler NAMES between manifests; it never executes a command,
 * so a typo in `${PLUGIN_ROOT}/hooks/<file>` or a guard that turns into an
 * allow-everything no-op on the Codex payload stays green there.
 *
 * The payload is the one measured on codex-cli 0.160.1 (`codex exec`,
 * 2026-10-20): `transcript_path` is null, `cwd` is the session workdir, and a
 * real Codex session exports no CLAUDE_* env — hence the scrubbed env below.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { expectAllow, expectDeny } from '../_helpers/hook-decision.mjs';
import { posixShell } from '../_helpers/posix-shell.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CODEX_MANIFEST = JSON.parse(readFileSync(path.join(REPO_ROOT, 'hooks/hooks-codex.json'), 'utf8'));
const SESSION_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

let fixtures = [];
afterEach(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  fixtures = [];
});

/** Registered `{ handler, command }` pairs for one Codex event's `Bash` matcher. */
function bashHooks(event) {
  return (CODEX_MANIFEST.hooks[event] ?? [])
    .filter((group) => group.matcher === 'Bash')
    .flatMap((group) => group.hooks)
    .map((hook) => ({ handler: /hooks\/([\w-]+\.mjs)"$/.exec(hook.command)?.[1] ?? null, command: hook.command }));
}

function makeRepo(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-bash-guards-'));
  fixtures.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const all = { 'CLAUDE.md': 'orig\n', 'AGENTS.md': 'orig\n', ...files };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  // post-bash-write-verify stays silent about dirt only when its mtime predates the wave scope's. Written in one
  // tick, the three can share a timestamp on a coarse-clock filesystem (CI pipeline 31660 reported CLAUDE.md and
  // AGENTS.md as new), so date them apart: base files before the scope, files written by the call after it.
  const now = Date.now() / 1000;
  for (const rel of ['CLAUDE.md', 'AGENTS.md']) utimesSync(path.join(dir, rel), now - 120, now - 120);
  if ('.codex/wave-scope.json' in files) utimesSync(path.join(dir, '.codex/wave-scope.json'), now - 60, now - 60);
  return dir;
}

/** Run one registered command string the way Codex does: through a shell, cwd = session dir. */
function runRegistered(command, dir, toolCommand, event = 'PreToolUse') {
  const payload = {
    session_id: SESSION_ID,
    turn_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    transcript_path: null,
    cwd: dir,
    hook_event_name: event,
    model: 'gpt-6.1-sol',
    permission_mode: 'bypassPermissions',
    tool_name: 'Bash',
    tool_input: { command: toolCommand },
    tool_use_id: 'exec-1',
    ...(event === 'PostToolUse' ? { tool_response: '' } : {}),
  };
  return spawnSync(posixShell('sh'), ['-c', command], {
    cwd: dir,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15_000,
    env: { PATH: process.env.PATH, HOME: dir, PLUGIN_ROOT: REPO_ROOT },
  });
}

const BUDGET_CONFIG = '# x\n\n## Session Config\n\nissue-budget:\n  max-per-session: 1\n  mode: strict\n  overflow: collect-issue\n';
const SCOPE = JSON.stringify({
  session_id: SESSION_ID,
  wave: 1,
  enforcement: 'strict',
  allowedPaths: ['src/**'],
  blockedCommands: ['rm -rf'],
});

// One enforcing case per wired PreToolUse Bash guard. A handler wired in
// hooks-codex.json without a row here fails the census test below, so a new
// Codex guard cannot land without proof that it does something on Codex.
const PRE_CASES = {
  'pre-bash-destructive-guard.mjs': {
    deny: { command: 'printf x > CLAUDE.md', reason: 'redirect-truncate-protected' },
  },
  'pre-bash-sessions-ledger-guard.mjs': {
    deny: { command: 'echo {} >> .orchestrator/metrics/sessions.jsonl', reason: 'Direct write to the sessions ledger blocked' },
  },
  'pre-bash-issue-budget.mjs': {
    files: { 'CLAUDE.md': BUDGET_CONFIG, 'AGENTS.md': BUDGET_CONFIG },
    before: 'glab issue create --title first --description one',
    deny: { command: 'glab issue create --title second --description two', reason: 'session cap reached' },
  },
  'enforce-commands.mjs': {
    files: { '.codex/wave-scope.json': SCOPE },
    deny: { command: 'rm -rf build', reason: "Blocked command: 'rm -rf'" },
  },
  // Observe-only by design: the effect is the audit event, not a decision.
  'pre-bash-memory-propose-audit.mjs': {
    observe: { command: 'node scripts/memory-propose.mjs --dry-run', event: 'orchestrator.memory.propose_invoked' },
  },
  // Allow-only by design (it records staging, it never blocks).
  'pre-bash-staging-fence.mjs': { allowOnly: true },
};

describe('hooks-codex.json Bash guards on the measured Codex payload (#1691)', () => {
  const pre = bashHooks('PreToolUse');

  it('registers the destructive guard and gives every wired PreToolUse Bash handler an enforcing case', () => {
    const handlers = pre.map((h) => h.handler);
    expect(handlers).toContain('pre-bash-destructive-guard.mjs');
    expect(handlers.filter((h) => !(h in PRE_CASES))).toEqual([]);
  });

  it.each(pre.map((h) => [h.handler, h.command]))('%s resolves and allows `ls -la`', (_handler, command) => {
    expectAllow(runRegistered(command, makeRepo(), 'ls -la'));
  });

  it.each(
    pre.filter((h) => PRE_CASES[h.handler]?.deny).map((h) => [h.handler, h.command]),
  )('%s denies its block case', (handler, command) => {
    const spec = PRE_CASES[handler];
    const dir = makeRepo(spec.files);
    if (spec.before) expectAllow(runRegistered(command, dir, spec.before));
    expectDeny(runRegistered(command, dir, spec.deny.command), spec.deny.reason);
  });

  it.each(
    pre.filter((h) => PRE_CASES[h.handler]?.observe).map((h) => [h.handler, h.command]),
  )('%s records its audit event', (handler, command) => {
    const { observe } = PRE_CASES[handler];
    const dir = makeRepo();
    expectAllow(runRegistered(command, dir, observe.command));
    const ledger = path.join(dir, '.orchestrator/metrics/events.jsonl');
    expect(existsSync(ledger)).toBe(true);
    const events = readFileSync(ledger, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(events.map((e) => [e.event, e.session_id])).toEqual([[observe.event, SESSION_ID]]);
  });

  it('in the whole registered chain only the destructive guard denies `printf x > CLAUDE.md`', () => {
    const dir = makeRepo();
    const denying = pre
      .filter((h) => runRegistered(h.command, dir, 'printf x > CLAUDE.md').stdout.includes('"deny"'))
      .map((h) => h.handler);
    expect(denying).toEqual(['pre-bash-destructive-guard.mjs']);
  });

  it('post-bash-write-verify is registered for PostToolUse Bash and warns on an out-of-scope write', () => {
    const post = bashHooks('PostToolUse');
    expect(post.map((h) => h.handler)).toEqual(['post-bash-write-verify.mjs']);
    const dir = makeRepo({ '.codex/wave-scope.json': SCOPE, 'out.txt': 'hi\n' });
    const result = runRegistered(post[0].command, dir, 'echo hi > out.txt', 'PostToolUse');
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(envelope.hookSpecificOutput.additionalContext, envelope.hookSpecificOutput.additionalContext).toContain("OUTSIDE the wave's 1 allowedPaths — out.txt");
  });
});
