/**
 * remote-dispatch.test.mjs — the `offload` remote-host adapter (#1160).
 *
 * Every case below names the bug it catches. The real `offload` binary is never
 * spawned (spawnFn/execFn seams) and every patch file lives in a per-test
 * mkdtemp directory — never in this working copy.
 *
 * The fakeSpawn/fakeExec/noopEmit helpers are the same shape as
 * `foreign-dispatch.test.mjs:44-106`; test helpers may be duplicated where
 * production code may not (the production seams ARE shared — this module
 * imports `runChild`/`isSafeRunId`/`isNeverForeignRole` rather than copying).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  dispatchRemote,
  parseDoctorLine,
  parsePatchFiles,
  remoteDoctor,
  OFFLOAD_BIN,
  OFFLOAD_EXIT_REASONS,
  REMOTE_DISPATCH_EVENT,
} from '@lib/wave-executor/remote-dispatch.mjs';
import { NEVER_FOREIGN_ROLES } from '@lib/wave-executor/foreign-dispatch.mjs';

/**
 * A fake child process. `writePatch` runs when the child is spawned, so a test
 * can model "the run produced a patch" without touching the real CLI.
 * `ignoreSigterm` models the child the SIGTERM→SIGKILL escalation exists for.
 */
function fakeSpawn({
  stdout = '',
  stderr = '',
  exitCode = 0,
  hang = false,
  ignoreSigterm = false,
  errorCode = null,
  writePatch = null,
} = {}) {
  const calls = [];
  const fn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdinChunks = [];
    child.stdin.on('data', (c) => child.stdinChunks.push(c.toString()));
    child.killSignals = [];
    child.kill = (signal) => {
      child.killSignals.push(signal);
      if (ignoreSigterm && signal === 'SIGTERM') return true;
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
      if (writePatch) writePatch();
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

/** A fake `execFileSync`: records invocations, answers with `out`, or throws. */
function fakeExec({ out = '', throws = null } = {}) {
  const calls = [];
  const fn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (throws) throw throws;
    return out;
  };
  fn.calls = calls;
  return fn;
}

const noopEmit = async () => {};

/** Collect emitted events instead of writing the real ledger. */
function recordingEmit() {
  const events = [];
  const fn = async (name, payload, opts) => {
    events.push({ name, payload, opts });
  };
  fn.events = events;
  return fn;
}

const PATCH_BODY = [
  'diff --git a/scripts/a.mjs b/scripts/a.mjs',
  'index 111..222 100644',
  '--- a/scripts/a.mjs',
  '+++ b/scripts/a.mjs',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/scripts/new.mjs b/scripts/new.mjs',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/scripts/new.mjs',
  '@@ -0,0 +1 @@',
  '+created',
  '',
].join('\n');

let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-remote-test-'));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let n = 0;
const patchPathFor = () => path.join(tmpDir, `p${++n}.patch`);

/** A dispatch that succeeds: writes PATCH_BODY at `patchPath`, exits 0. */
function okRun(patchPath, extra = {}) {
  return fakeSpawn({
    writePatch: () => fs.writeFileSync(patchPath, PATCH_BODY),
    ...extra,
  });
}

const baseTask = (patchPath, over = {}) => ({
  host: 'm5',
  repo: '/repos/demo',
  prompt: 'do the thing',
  role: 'docs',
  runId: 'w2-a1',
  model: 'sonnet',
  patchPath,
  ...over,
});

// ---------------------------------------------------------------------------
// role lock
// ---------------------------------------------------------------------------

describe('never_foreign role lock', () => {
  // Bug: a remote host runs the operator's own Claude account with --write. If
  // the lock were checked after the spawn (or not at all), a security-review or
  // migration role would execute on a machine whose hooks and guards this
  // session never sees.
  it.each(NEVER_FOREIGN_ROLES)('refuses %s before any spawn', async (role) => {
    const spawnFn = fakeSpawn();
    const res = await dispatchRemote(baseTask(patchPathFor(), { role }), {
      spawnFn,
      emitFn: noopEmit,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('never-foreign-role');
    expect(spawnFn.calls).toHaveLength(0);
  });

  // Bug: a refusal that emits nothing is indistinguishable from a dispatch that
  // was never attempted. exit_code null is the discriminator against a run that
  // was attempted and measured.
  it('emits a completion record on refusal with exit_code null', async () => {
    const emitFn = recordingEmit();
    await dispatchRemote(baseTask(patchPathFor(), { role: 'release' }), {
      spawnFn: fakeSpawn(),
      emitFn,
    });
    expect(emitFn.events).toHaveLength(1);
    const { name, payload } = emitFn.events[0];
    expect(name).toBe(REMOTE_DISPATCH_EVENT);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe('never-foreign-role');
    expect(payload.exit_code).toBeNull();
    expect(payload.duration_ms).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// argument validation
// ---------------------------------------------------------------------------

describe('input validation', () => {
  // Bug: runId becomes `--job` and the default patch filename. `../../x` would
  // place the patch anywhere the process can write.
  it.each([['../escape'], ['a b'], ['']])('refuses unsafe runId %j', async (runId) => {
    const spawnFn = fakeSpawn();
    const res = await dispatchRemote(baseTask(patchPathFor(), { runId }), {
      spawnFn,
      emitFn: noopEmit,
    });
    expect(res.reason).toBe('unsafe-run-id');
    expect(spawnFn.calls).toHaveLength(0);
  });

  // Bug: host reaches argv; a shell-metacharacter host would be a plain
  // injection on any wrapper that ever re-quotes this command.
  it('refuses an unsafe host before spawning', async () => {
    const spawnFn = fakeSpawn();
    const res = await dispatchRemote(baseTask(patchPathFor(), { host: 'm5; rm -rf /' }), {
      spawnFn,
      emitFn: noopEmit,
    });
    expect(res.reason).toBe('unsafe-host');
    expect(spawnFn.calls).toHaveLength(0);
  });

  // Bug (the reason this check exists): a patch written INSIDE the repo lands in
  // the tree the coordinator commits from, where an unrelated `git add` sweeps
  // unreviewed remote output into a local commit.
  it('refuses a patchPath inside repoRoot before spawning', async () => {
    const repoRoot = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    const spawnFn = fakeSpawn();
    const res = await dispatchRemote(baseTask(path.join(repoRoot, 'x.patch')), {
      spawnFn,
      emitFn: noopEmit,
      repoRoot,
    });
    expect(res.reason).toBe('unsafe-patch-path');
    expect(spawnFn.calls).toHaveLength(0);
  });

  it('refuses a patchPath outside the temp directory', async () => {
    const spawnFn = fakeSpawn();
    const res = await dispatchRemote(baseTask('/etc/offload.patch'), {
      spawnFn,
      emitFn: noopEmit,
    });
    expect(res.reason).toBe('unsafe-patch-path');
    expect(spawnFn.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// the child invocation
// ---------------------------------------------------------------------------

describe('child invocation', () => {
  // Bug: argv is world-readable via `ps`. offload's own help states prompts
  // travel by file, never argv — this pins that the adapter honours it.
  it('sends the prompt on stdin and never in argv', async () => {
    const patchPath = patchPathFor();
    const spawnFn = okRun(patchPath);
    await dispatchRemote(baseTask(patchPath, { prompt: 'SECRET-PROMPT-TEXT' }), {
      spawnFn,
      emitFn: noopEmit,
    });
    const { cmd, args } = spawnFn.calls[0];
    expect(cmd).toBe(OFFLOAD_BIN);
    expect(args.join(' ')).not.toContain('SECRET-PROMPT-TEXT');
    expect(spawnFn.lastChild.stdinChunks.join('')).toBe('SECRET-PROMPT-TEXT');
  });

  it('builds the documented argv shape', async () => {
    const patchPath = patchPathFor();
    const spawnFn = okRun(patchPath);
    await dispatchRemote(baseTask(patchPath, { timeoutSec: 300 }), {
      spawnFn,
      emitFn: noopEmit,
    });
    expect(spawnFn.calls[0].args).toEqual([
      'claude',
      '/repos/demo',
      '-H',
      'm5',
      '--job',
      'w2-a1',
      '--write',
      '--patch',
      patchPath,
      '--model',
      'sonnet',
      '--timeout',
      '300',
    ]);
  });

  // Bug: `--model undefined` would be passed to the CLI as a literal string and
  // rejected as a usage error (exit 1) that reads as our own misconfiguration.
  it('omits --model when no model is given', async () => {
    const patchPath = patchPathFor();
    const spawnFn = okRun(patchPath);
    await dispatchRemote(baseTask(patchPath, { model: undefined }), {
      spawnFn,
      emitFn: noopEmit,
    });
    expect(spawnFn.calls[0].args).not.toContain('--model');
  });
});

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------

describe('verdict', () => {
  it('is ok only when exit 0 AND the patch is non-empty', async () => {
    const patchPath = patchPathFor();
    const res = await dispatchRemote(baseTask(patchPath), {
      spawnFn: okRun(patchPath),
      emitFn: noopEmit,
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.patchFiles).toEqual(['scripts/a.mjs', 'scripts/new.mjs']);
    expect(res.patchBytes).toBe(Buffer.byteLength(PATCH_BODY));
  });

  // Bug: exit 0 with nothing written is the classic silent no-op — the model
  // answered in prose and changed nothing. Reading it as success would merge an
  // empty result as done work.
  it('classifies exit 0 with a 0-byte patch as empty-diff, never ok', async () => {
    const patchPath = patchPathFor();
    const spawnFn = fakeSpawn({ writePatch: () => fs.writeFileSync(patchPath, '') });
    const res = await dispatchRemote(baseTask(patchPath), { spawnFn, emitFn: noopEmit });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('empty-diff');
  });

  it('classifies exit 0 with a missing patch file as empty-diff', async () => {
    const res = await dispatchRemote(baseTask(patchPathFor()), {
      spawnFn: fakeSpawn(),
      emitFn: noopEmit,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('empty-diff');
    expect(res.patchBytes).toBe(0);
  });

  // Bug: an unmapped exit code read as success, or every failure collapsed into
  // one reason, sends the operator hunting the prompt when the channel or the
  // account was the problem.
  it.each(Object.entries(OFFLOAD_EXIT_REASONS))('maps exit %s to %s', async (code, reason) => {
    const res = await dispatchRemote(baseTask(patchPathFor()), {
      spawnFn: fakeSpawn({ exitCode: Number(code) }),
      emitFn: noopEmit,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(reason);
    expect(res.exitCode).toBe(Number(code));
  });

  it('falls back to remote-command-failed for an unknown non-zero exit', async () => {
    const res = await dispatchRemote(baseTask(patchPathFor()), {
      spawnFn: fakeSpawn({ exitCode: 42 }),
      emitFn: noopEmit,
    });
    expect(res.reason).toBe('remote-command-failed');
  });

  // Bug: exit 7's message carries the rate-limit reset time. Dropping the child
  // output loses the one fact that says WHEN to retry.
  it('carries the child output tail on a rate-limit exit', async () => {
    const res = await dispatchRemote(baseTask(patchPathFor()), {
      spawnFn: fakeSpawn({ exitCode: 7, stderr: 'limit resets at 18:40Z' }),
      emitFn: noopEmit,
    });
    expect(res.reason).toBe('rate-limited');
    expect(res.stderrTail).toContain('18:40Z');
  });

  // Bug: a missing binary classified as a model failure sends the coordinator
  // rewriting a prompt when the channel simply is not installed.
  it('classifies ENOENT as channel-unavailable', async () => {
    const res = await dispatchRemote(baseTask(patchPathFor()), {
      spawnFn: fakeSpawn({ errorCode: 'ENOENT' }),
      emitFn: noopEmit,
    });
    expect(res.reason).toBe('channel-unavailable');
    expect(res.exitCode).toBeNull();
  });

  // Bug: SIGTERM is a REQUEST. A child that ignores it never emits `close`, and
  // without escalation the dispatch — and the wave behind it — hangs forever.
  it('escalates SIGTERM to SIGKILL for an uncooperative child', async () => {
    const spawnFn = fakeSpawn({ ignoreSigterm: true });
    const res = await dispatchRemote(baseTask(patchPathFor(), { timeoutSec: 0 }), {
      spawnFn,
      emitFn: noopEmit,
      killGraceMs: 5,
      localGraceSec: 0.01,
    });
    expect(res.timedOut).toBe(true);
    expect(res.reason).toBe('timeout');
    expect(spawnFn.lastChild.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

// ---------------------------------------------------------------------------
// telemetry
// ---------------------------------------------------------------------------

describe('telemetry', () => {
  // Bug: this payload travels over the optional Clank webhook with no
  // redaction. A prompt, a patch body, or a tmp path in it is an exfiltration.
  it('emits counts only — never prompt, patch body, or patch path', async () => {
    const patchPath = patchPathFor();
    const emitFn = recordingEmit();
    await dispatchRemote(baseTask(patchPath, { prompt: 'SECRET-PROMPT-TEXT' }), {
      spawnFn: okRun(patchPath),
      emitFn,
    });
    expect(emitFn.events).toHaveLength(1);
    const { name, payload } = emitFn.events[0];
    expect(name).toBe(REMOTE_DISPATCH_EVENT);
    expect(payload).toMatchObject({
      host: 'm5',
      role: 'docs',
      run_id: 'w2-a1',
      ok: true,
      exit_code: 0,
      patch_files: 2,
      patch_bytes: Buffer.byteLength(PATCH_BODY),
    });
    expect(payload.reason).toBeUndefined();
    expect(payload).not.toHaveProperty('patch_path');
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('SECRET-PROMPT-TEXT');
    expect(serialized).not.toContain('diff --git');
    expect(serialized).not.toContain(patchPath);
  });

  // Bug: telemetry is a side-channel. A throwing emitter must not turn a
  // successful remote dispatch into a failure.
  it('survives a throwing emitFn', async () => {
    const patchPath = patchPathFor();
    const res = await dispatchRemote(baseTask(patchPath), {
      spawnFn: okRun(patchPath),
      emitFn: async () => {
        throw new Error('ledger down');
      },
    });
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// patch parsing
// ---------------------------------------------------------------------------

describe('parsePatchFiles', () => {
  // Bug: `+++` is `/dev/null` for a deleted file, so a `+++`-only parser
  // silently reports a deletion-only patch as touching no files.
  it('reads deletions from the diff --git header, not from +++', () => {
    const patch = [
      'diff --git a/gone.mjs b/gone.mjs',
      'deleted file mode 100644',
      '--- a/gone.mjs',
      '+++ /dev/null',
      '',
    ].join('\n');
    expect(parsePatchFiles(patch)).toEqual(['gone.mjs']);
  });
});

// ---------------------------------------------------------------------------
// remoteDoctor
// ---------------------------------------------------------------------------

describe('remoteDoctor', () => {
  // Real line, measured 2026-09-02 via `offload doctor -H m5 --brief`.
  const REAL =
    'Bernhards-Macbook-2 ready=yes · load 14.23 · mem free 96% · headless: slots none, keychain-route ok · 9 jobs · claude procs 12';

  it('parses the measured ready line', () => {
    const execFn = fakeExec({ out: `${REAL}\n` });
    const res = remoteDoctor({ host: 'm5', execFn });
    expect(execFn.calls[0]).toMatchObject({
      cmd: OFFLOAD_BIN,
      args: ['doctor', '-H', 'm5', '--brief'],
    });
    expect(res).toMatchObject({
      ready: true,
      load: 14.23,
      memFreePct: 96,
      jobs: 9,
      claudeProcs: 12,
    });
    expect(res.raw).toBe(REAL);
  });

  // Bug: `ready` is the ONLY decision field. A parser that inferred readiness
  // from "load is low" would dispatch onto a host whose account is signed out.
  it('reads anything other than ready=yes as not ready', () => {
    const res = remoteDoctor({
      host: 'm5',
      execFn: fakeExec({ out: 'host ready=no · load 0.10 · 0 jobs' }),
    });
    expect(res.ready).toBe(false);
    expect(res.load).toBe(0.1);
  });

  // Bug: a fabricated 0 for an absent segment reads as "measured, idle" — the
  // exact false all-clear HR-105 warns about.
  it('returns null, never 0, for absent metrics', () => {
    const res = remoteDoctor({ host: 'm5', execFn: fakeExec({ out: 'ready=yes' }) });
    expect(res.ready).toBe(true);
    expect(res.load).toBeNull();
    expect(res.memFreePct).toBeNull();
    expect(res.jobs).toBeNull();
    expect(res.claudeProcs).toBeNull();
  });

  it('reports not-ready with the raw output retained on a non-zero exit', () => {
    const err = new Error('Command failed');
    err.status = 2;
    err.stderr = 'host m5 unreachable';
    const res = remoteDoctor({ host: 'm5', execFn: fakeExec({ throws: err }) });
    expect(res.ready).toBe(false);
    expect(res.raw).toBe('host m5 unreachable');
    expect(res.jobs).toBeNull();
  });

  it('refuses an unsafe host without executing anything', () => {
    const execFn = fakeExec({ out: 'ready=yes' });
    const res = remoteDoctor({ host: 'm5 && whoami', execFn });
    expect(res.ready).toBe(false);
    expect(execFn.calls).toHaveLength(0);
  });
});

describe('parseDoctorLine', () => {
  it('treats an empty line as not ready with null metrics', () => {
    expect(parseDoctorLine('')).toEqual({
      ready: false,
      raw: '',
      load: null,
      memFreePct: null,
      jobs: null,
      claudeProcs: null,
    });
  });
});
