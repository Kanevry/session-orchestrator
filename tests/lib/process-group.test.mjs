/**
 * process-group.test.mjs — the process-GROUP spawn/kill primitives (Epic #1425).
 *
 * Every case names the bug it catches. Safety contract for this file:
 *  - No real signal is ever sent to a process this file did not spawn. The
 *    `killFn` seam is injected in every unit test; only the single integration
 *    case reaches the real `process.kill`, and only against its own child.
 *  - No `ps` output is ever used as a kill target.
 *  - Ledger writes go to an `mkdtempSync` fixture, never this working copy.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  GATE_PROCESS_LEDGER_RELPATH,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_VERIFY_WAIT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_LEDGER_MAX_AGE_MS,
  buildCommandSignature,
  killProcessGroup,
  verifyProcessIdentity,
  recordGateProcess,
  readGateProcessLedger,
  pruneGateProcessLedger,
  spawnInGroup,
  _liveGroupPgids,
} from '@lib/process-group.mjs';

/** A PID the kernel would never assign — the only "target" a unit test may name. */
const DEAD_PID = 999999;

/**
 * A fake child process. It never closes on its own: the shapes this module
 * exists for (a wedged gate, an over-talkative one) are exactly the children
 * that only go away when the GROUP is signalled.
 */
function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

/**
 * A `killFn` that models the measured macOS behaviour: a grandchild with
 * `trap "" TERM` ignores SIGTERM, and only SIGKILL to the group ends it.
 */
function fakeGroupKill(child, state) {
  const calls = [];
  const fn = (target, signal) => {
    calls.push({ target, signal });
    if (signal === 'SIGKILL') {
      state.alive = false;
      child.emit('close', null, 'SIGKILL');
    }
    return true;
  };
  fn.calls = calls;
  return fn;
}

describe('spawnInGroup — kill ladder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('escalates SIGTERM→SIGKILL to the NEGATED pgid when a child ignores SIGTERM', async () => {
    // Bug: signalling `child.kill()` (or a positive pid) reaches the shell only.
    // Its grandchildren — `tsgo`, vitest workers — survive on PPID 1. That is
    // the 2026-09-20 incident; only `kill(-pgid, …)` plus escalation prevents it.
    const child = fakeChild(4242);
    const state = { alive: true };
    const killFn = fakeGroupKill(child, state);

    const promise = spawnInGroup('pretend-gate', {
      spawnFn: () => child,
      killFn,
      isAliveFn: () => state.alive,
      timeoutMs: 1000,
      killGraceMs: 200,
      verifyWaitMs: 50,
    });

    await vi.advanceTimersByTimeAsync(1000); // timeout → SIGTERM (ignored)
    await vi.advanceTimersByTimeAsync(200); // grace → SIGKILL → close
    const res = await promise;

    expect(res.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(killFn.calls.map((c) => c.target)).toEqual([-4242, -4242]);
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(124);
    expect(res.survivors).toEqual([]);
  });

  it('spawns with shell+detached+piped stdio', async () => {
    // Bug: dropping `detached` makes the child a member of the ORCHESTRATOR's
    // own group, so `kill(-pgid, 'SIGKILL')` would signal the session itself.
    const child = fakeChild(4343);
    const state = { alive: true };
    let seen = null;

    const promise = spawnInGroup('pretend-gate', {
      spawnFn: (cmd, options) => {
        seen = { cmd, options };
        return child;
      },
      killFn: fakeGroupKill(child, state),
      isAliveFn: () => state.alive,
      timeoutMs: null,
      cwd: '/tmp',
    });
    child.emit('close', 0, null);
    const res = await promise;

    expect(seen.cmd).toBe('pretend-gate');
    expect(seen.options.shell).toBe(true);
    expect(seen.options.detached).toBe(true);
    expect(seen.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(res.exitCode).toBe(0);
    expect(res.pgid).toBe(4343);
  });

  it('kills the group on output overflow and reports exitCode 1', async () => {
    // Bug: async `spawn` has NO maxBuffer (measured: 22 MB ran through), so a
    // runaway gate would fill the heap instead of failing like the synchronous
    // path's ENOBUFS did ("21 MiB → exitCode 1").
    const child = fakeChild(5151);
    const state = { alive: true };
    const killFn = fakeGroupKill(child, state);

    const promise = spawnInGroup('noisy-gate', {
      spawnFn: () => child,
      killFn,
      isAliveFn: () => state.alive,
      timeoutMs: null,
      maxOutputBytes: 64,
      killGraceMs: 10,
      verifyWaitMs: 10,
    });

    child.stdout.write('x'.repeat(200));
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10);
    const res = await promise;

    expect(res.overflow).toBe(true);
    expect(res.exitCode).toBe(1);
    expect(res.timedOut).toBe(false);
    expect(killFn.calls.length).toBeGreaterThan(0);
    expect(killFn.calls[0]).toEqual({ target: -5151, signal: 'SIGTERM' });
    expect(res.fullOutput).toContain('exceeded 64 bytes');
  });

  it('deregisters the group once it closes', async () => {
    // Bug: a pgid left in the exit-time registry is SIGKILLed when the process
    // exits — by then the OS may have recycled that id onto a foreign process.
    const child = fakeChild(6161);
    const promise = spawnInGroup('short-gate', {
      spawnFn: () => child,
      killFn: () => true,
      timeoutMs: null,
    });
    expect(_liveGroupPgids()).toContain(6161);
    child.emit('close', 0, null);
    await promise;
    expect(_liveGroupPgids()).not.toContain(6161);
  });

  it('returns exitCode 1 without throwing when the spawn itself fails', async () => {
    // Bug: a throwing spawnFn (ENOENT) inside the Promise executor would reject
    // a promise the gate only ever awaits for a value.
    const res = await spawnInGroup('no-such-binary', {
      spawnFn: () => {
        const err = new Error('spawn ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
      killFn: () => true,
    });
    expect(res.exitCode).toBe(1);
    expect(res.pid).toBe(-1);
    expect(res.output).toContain('failed to spawn');
  });
});

describe('killProcessGroup', () => {
  it('treats ESRCH on the escalation as proof of death', async () => {
    // Bug: reading any kill() throw as failure books a successfully reaped
    // group as a survivor, which makes the reaper's success rate unreadable.
    const signals = [];
    const res = await killProcessGroup(DEAD_PID, {
      killFn: (_t, sig) => {
        signals.push(sig);
        if (sig === 'SIGKILL') {
          const err = new Error('kill ESRCH');
          err.code = 'ESRCH';
          throw err;
        }
        return true;
      },
      sleepFn: async () => {},
      isAliveFn: () => {
        throw new Error('must not probe: ESRCH already proved death');
      },
    });
    expect(res.ok).toBe(true);
    expect(res.signalsSent).toEqual(['SIGTERM', 'SIGKILL']);
    expect(res.survivors).toEqual([]);
  });

  it('stops at EPERM without escalating', async () => {
    // Bug: retrying a refused signal hammers a FOREIGN process that merely
    // shares the group — EPERM is a stop signal, not a transient error.
    const signals = [];
    const res = await killProcessGroup(DEAD_PID, {
      killFn: (_t, sig) => {
        signals.push(sig);
        const err = new Error('kill EPERM');
        err.code = 'EPERM';
        throw err;
      },
      sleepFn: async () => {},
      isAliveFn: () => true,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('EPERM');
    expect(signals).toEqual(['SIGTERM']);
    expect(res.survivors).toEqual([DEAD_PID]);
  });

  it('reports ESRCH before the first signal as already-dead', async () => {
    const res = await killProcessGroup(DEAD_PID, {
      killFn: () => {
        const err = new Error('kill ESRCH');
        err.code = 'ESRCH';
        throw err;
      },
      sleepFn: async () => {},
      isAliveFn: () => true,
    });
    expect(res.ok).toBe(true);
    expect(res.error).toBe('ESRCH');
    expect(res.survivors).toEqual([]);
  });

  it('reports a SIGKILL survivor instead of booking success', async () => {
    // Bug (PRD B6): "signal sent" and "exit 0" prove nothing. A descendant that
    // setsid-ed out of the group survives SIGKILL and must be REPORTED.
    const waits = [];
    const res = await killProcessGroup(DEAD_PID, {
      killFn: () => true,
      sleepFn: async (ms) => {
        waits.push(ms);
      },
      isAliveFn: () => true,
      killGraceMs: 10,
      verifyWaitMs: 500,
    });
    expect(res.ok).toBe(false);
    expect(res.survivors).toEqual([DEAD_PID]);
    expect(res.error).toBeNull();
    // The verify-wait must actually happen before reading liveness back: on
    // 2026-09-20 a probe with no wait reported "still alive" for dead processes.
    expect(waits).toEqual([10, 500]);
  });
});

describe('verifyProcessIdentity', () => {
  const NOW = 1_800_000_000_000;
  const SIG = buildCommandSignature('npm test');

  it('matches a live process with the recorded start time and command', () => {
    const res = verifyProcessIdentity(4242, { startTime: NOW - 10_000, commandSignature: SIG }, {
      snapshotLine: { pid: 4242, ppid: 1, rssKb: 1024, etimeSeconds: 10, cpuPct: 3, args: 'npm test' },
      nowMs: NOW,
    });
    expect(res).toEqual({ match: true, reason: 'ok', observed: { etimeSeconds: 10, args: 'npm test' } });
  });

  it('reports gone for an absent snapshot row', () => {
    const res = verifyProcessIdentity(4242, { startTime: NOW, commandSignature: SIG }, {
      snapshotLine: null,
      nowMs: NOW,
    });
    expect(res.match).toBe(false);
    expect(res.reason).toBe('gone');
  });

  it('refuses a RECYCLED pid: same number, different start time', () => {
    // Bug (PRD Feature Area 3): between detection and signal the kernel may hand
    // the pid to an unrelated process. Signalling it kills a bystander.
    const res = verifyProcessIdentity(4242, { startTime: NOW - 600_000, commandSignature: SIG }, {
      snapshotLine: { pid: 4242, etimeSeconds: 2, args: 'npm test' },
      nowMs: NOW,
    });
    expect(res.match).toBe(false);
    expect(res.reason).toBe('start-time-mismatch');
    expect(res.observed.etimeSeconds).toBe(2);
  });

  it('holds the ±2000 ms tolerance boundary exactly', () => {
    // `ps etime` has 1-second granularity, so the recorded ms start time and the
    // derived one differ by up to a second even for the same process; a
    // zero-tolerance compare would refuse every legitimate kill.
    const atBoundary = verifyProcessIdentity(4242, { startTime: NOW - 10_000, commandSignature: SIG }, {
      snapshotLine: { pid: 4242, etimeSeconds: 12, args: 'npm test' },
      nowMs: NOW,
    });
    expect(atBoundary.match).toBe(true);

    const pastBoundary = verifyProcessIdentity(4242, { startTime: NOW - 10_000, commandSignature: SIG }, {
      snapshotLine: { pid: 4242, etimeSeconds: 12.001, args: 'npm test' },
      nowMs: NOW,
    });
    expect(pastBoundary.match).toBe(false);
    expect(pastBoundary.reason).toBe('start-time-mismatch');
  });

  it('refuses a row whose command differs from the recorded signature', () => {
    const res = verifyProcessIdentity(4242, { startTime: NOW - 10_000, commandSignature: SIG }, {
      snapshotLine: { pid: 4242, etimeSeconds: 10, args: 'tsgo --noEmit' },
      nowMs: NOW,
    });
    expect(res.match).toBe(false);
    expect(res.reason).toBe('signature-mismatch');
  });

  it('refuses a row with NO measurable etime instead of computing with zero', () => {
    // Bug: an absent elapsed-time field coerces to 0, so `nowMs - 0` reads as
    // "started exactly now" — which MATCHES any just-recorded gate process. A
    // missing measurement must be a third state, never a passing one, so the
    // recorded start time here is `NOW` on purpose: that is the case where the
    // unguarded arithmetic agrees with itself.
    const res = verifyProcessIdentity(4242, { startTime: NOW, commandSignature: SIG }, {
      snapshotLine: { pid: 4242, args: 'npm test' },
      nowMs: NOW,
    });
    expect(res.match).toBe(false);
    expect(res.reason).toBe('start-time-mismatch');
    expect(res.observed.etimeSeconds).toBeNull();
  });

  it('refuses a snapshot row belonging to a different pid', () => {
    const res = verifyProcessIdentity(4242, { startTime: NOW - 10_000, commandSignature: SIG }, {
      snapshotLine: { pid: 9999, etimeSeconds: 10, args: 'npm test' },
      nowMs: NOW,
    });
    expect(res.match).toBe(false);
    expect(res.reason).toBe('gone');
  });
});

describe('gate-process ledger', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(os.tmpdir(), 'process-group-ledger-'));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const rec = (pid, startTime) => ({
    pid,
    pgid: pid,
    startTime,
    commandSignature: buildCommandSignature('npm test'),
    sessionId: 'fixture-session',
    recordedAt: new Date(startTime).toISOString(),
  });

  it('appends, re-reads and counts malformed lines instead of hiding them', () => {
    // Bug: a JSONL reader that skips a truncated line WITHOUT counting it turns
    // a partial read into a clean verdict — in the one instrument whose job is
    // finding silent failures.
    const now = Date.now();
    recordGateProcess(repoRoot, rec(101, now - 1000));
    recordGateProcess(repoRoot, rec(102, now - 2000));
    appendFileSync(path.join(repoRoot, GATE_PROCESS_LEDGER_RELPATH), '{"pid": 103, trunc\n', 'utf8');

    const read = readGateProcessLedger(repoRoot, { nowMs: now });
    expect(read.records.map((r) => r.pid)).toEqual([101, 102]);
    expect(read.malformedLines).toBe(1);
    expect(read.expired).toBe(0);
  });

  it('filters entries older than maxAgeMs', () => {
    // Bug: an old entry's pid is the most likely to have been recycled, so a
    // reaper acting on it targets a bystander.
    const now = Date.now();
    recordGateProcess(repoRoot, rec(201, now - 1000));
    recordGateProcess(repoRoot, rec(202, now - 48 * 3600 * 1000));

    const read = readGateProcessLedger(repoRoot, { nowMs: now, maxAgeMs: DEFAULT_LEDGER_MAX_AGE_MS });
    expect(read.records.map((r) => r.pid)).toEqual([201]);
    expect(read.expired).toBe(1);
  });

  it('returns an empty read for a repo with no ledger yet', () => {
    const read = readGateProcessLedger(repoRoot, { nowMs: Date.now() });
    expect(read).toEqual({ records: [], malformedLines: 0, expired: 0 });
  });

  it('prunes expired and malformed lines in-process, keeping the fresh ones', () => {
    const now = Date.now();
    recordGateProcess(repoRoot, rec(301, now - 1000));
    recordGateProcess(repoRoot, rec(302, now - 48 * 3600 * 1000));
    appendFileSync(path.join(repoRoot, GATE_PROCESS_LEDGER_RELPATH), 'not json at all\n', 'utf8');
    recordGateProcess(repoRoot, rec(303, now - 2000));

    const removed = pruneGateProcessLedger(repoRoot, { nowMs: now });
    expect(removed).toBe(2);

    const body = readFileSync(path.join(repoRoot, GATE_PROCESS_LEDGER_RELPATH), 'utf8');
    expect(body.trim().split('\n')).toHaveLength(2);
    const read = readGateProcessLedger(repoRoot, { nowMs: now });
    expect(read.records.map((r) => r.pid)).toEqual([301, 303]);
    expect(read.malformedLines).toBe(0);
  });

  it('does not create a directory when the sink is injected', () => {
    // Bug: an mkdir on a synthetic repoRoot materialises a directory outside the
    // fixture — a test that writes where it was told not to.
    const written = [];
    recordGateProcess('/nonexistent-repo-root', rec(401, Date.now()), {
      appendFn: (file, line) => written.push({ file, line }),
    });
    expect(written).toHaveLength(1);
    expect(written[0].file).toBe(path.join('/nonexistent-repo-root', GATE_PROCESS_LEDGER_RELPATH));
    expect(JSON.parse(written[0].line).pid).toBe(401);
  });

  it('registers the spawned group in the ledger under repoRoot', () => {
    const child = fakeChild(7171);
    const promise = spawnInGroup('npm test', {
      spawnFn: () => child,
      killFn: () => true,
      timeoutMs: null,
      repoRoot,
      sessionId: 'fixture-session',
    });
    child.emit('close', 0, null);
    return promise.then(() => {
      const read = readGateProcessLedger(repoRoot, { nowMs: Date.now() });
      expect(read.records).toHaveLength(1);
      expect(read.records[0]).toMatchObject({
        pid: 7171,
        pgid: 7171,
        commandSignature: buildCommandSignature('npm test'),
        sessionId: 'fixture-session',
      });
    });
  });
});

describe('buildCommandSignature', () => {
  it('keeps the binary readable and discriminates the arguments', () => {
    // Bug: a signature that is only the binary name cannot tell `npm test` from
    // `npm run build`, so the reaper's identity check would pass for either.
    expect(buildCommandSignature('npm test')).toMatch(/^npm:[0-9a-f]{16}$/);
    expect(buildCommandSignature('npm test')).not.toBe(buildCommandSignature('npm run build'));
    expect(buildCommandSignature('npm test')).toBe(buildCommandSignature('npm test'));
  });
});

describe('defaults', () => {
  it('pins the documented parameter values', () => {
    // Bug: a silently changed default is a behaviour change nobody reviews —
    // each of these is a PRD parameter-table row with a named origin.
    expect(DEFAULT_KILL_GRACE_MS).toBe(10_000);
    expect(DEFAULT_VERIFY_WAIT_MS).toBe(500);
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(16 * 1024 * 1024);
    expect(DEFAULT_LEDGER_MAX_AGE_MS).toBe(24 * 3600 * 1000);
    expect(GATE_PROCESS_LEDGER_RELPATH).toBe('.orchestrator/runtime/gate-processes.jsonl');
  });
});

describe('integration (real processes)', () => {
  let repoRoot;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), 'process-group-int-'));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'really terminates its own sleeping group and proves it with a liveness probe',
    async () => {
      // Bug: everything above runs on fakes. This is the one case that proves
      // the REAL contract — `detached: true` yields a group whose leader pid is
      // signal-reachable as `-pid`, and after SIGTERM the process is GONE, not
      // reparented onto PPID 1. Only this process's own child is ever signalled.
      const res = await spawnInGroup("sleep 30", {
        cwd: repoRoot,
        timeoutMs: 300,
        killGraceMs: 200,
        verifyWaitMs: 200,
      });

      expect(res.timedOut).toBe(true);
      expect(res.exitCode).toBe(124);
      expect(res.pid).toBeGreaterThan(0);
      expect(res.pgid).toBe(res.pid);
      expect(res.killSignals[0]).toBe('SIGTERM');
      expect(res.survivors).toEqual([]);

      // Wait before reading the state back: on 2026-09-20 a probe taken
      // immediately after `kill -9` reported "still alive" for dead processes.
      await new Promise((r) => setTimeout(r, 700));
      let probeCode = 'no-throw';
      try {
        process.kill(res.pid, 0);
      } catch (err) {
        probeCode = err?.code ?? 'unknown';
      }
      // ESRCH = the pid is gone from the process table. 'no-throw' would mean it
      // is still there (alive or unreaped), which is the failure this proves.
      expect(probeCode).toBe('ESRCH');
    },
    15_000,
  );
});
