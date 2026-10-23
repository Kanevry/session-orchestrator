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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
import { runOrphanScan } from '@lib/orphan-reaper/scan.mjs';

/** A PID the kernel would never assign — the only "target" a unit test may name. */
const DEAD_PID = 999999;

/**
 * Injected platform for every case that checks the POSIX contract (kill ladder
 * against `-pgid`, `ps`-based identity, the gate-process ledger). Without it the
 * module reads `process.platform` and, on a Windows runner, takes the
 * taskkill/CIM branch these assertions were never about (#1613).
 */
const POSIX = 'linux';

/**
 * A fake child process. It never closes on its own: the shapes this module
 * exists for (a wedged gate, an over-talkative one) are exactly the children
 * that only go away when the GROUP is signalled.
 */
function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
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
      platform: POSIX,
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
      platform: POSIX,
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
      platform: POSIX,
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

  it('sends NO further signal after the promise settled — the late SIGKILL would hit a deregistered, possibly recycled pgid', async () => {
    // Bug (w2-2, verified 2026-09-21): on the timeout/overflow path `finish()`
    // resolves as soon as the child closes, but the ladder is still parked in
    // `sleepFn(killGraceMs)`. Ten seconds later it fired `SIGKILL -pgid` at an
    // id `finish()` had already removed from LIVE_GROUPS — and which the kernel
    // may have handed to a stranger by then. Reverting `beforeSignal` in
    // `spawnInGroup` makes this case red with a second call: {target:-8181,
    // signal:'SIGKILL'} (measured).
    const child = fakeChild(8181);
    const killFn = vi.fn(() => true); // models a child that obeys SIGTERM itself

    const promise = spawnInGroup('cooperative-gate', {
      platform: POSIX,
      spawnFn: () => child,
      killFn,
      isAliveFn: () => false,
      timeoutMs: 100,
      killGraceMs: 10_000,
      verifyWaitMs: 500,
    });

    await vi.advanceTimersByTimeAsync(100); // timeout → SIGTERM
    expect(killFn.mock.calls).toEqual([[-8181, 'SIGTERM']]);

    child.emit('close', 143, 'SIGTERM'); // the child took the hint and left
    const res = await promise;
    expect(res.timedOut).toBe(true);
    const callsAtSettle = killFn.mock.calls.length;

    // Walk past the whole grace + verify window the ladder was sleeping through.
    await vi.advanceTimersByTimeAsync(10_000 + 500 + 2_000);
    expect(killFn.mock.calls.length).toBe(callsAtSettle);
    expect(killFn.mock.calls.some((c) => c[1] === 'SIGKILL')).toBe(false);
  });

  it('keeps a normal exit 0 when the command timeout elapses while the leftover group is being reaped (#1704)', async () => {
    // Bug: the reap sleeps through killGraceMs after a clean close. If the reap
    // does not take over the ladder/timeout bookkeeping (`ladderStarted = true`
    // + clearing the timeout timer in `reapLeftoverGroup`), the still-pending
    // command timeout fires inside that window, starts a SECOND ladder and
    // turns an exit-0 run into exit 124 / timedOut.
    const child = fakeChild(9191);
    const state = { alive: true };
    const killFn = vi.fn((target, signal) => {
      if (signal === 'SIGKILL') state.alive = false;
      return true;
    });

    const promise = spawnInGroup('backgrounds-a-stray', {
      platform: POSIX,
      spawnFn: () => child,
      killFn,
      groupAliveFn: () => state.alive,
      timeoutMs: 1000,
      killGraceMs: 5000,
      verifyWaitMs: 50,
    });

    await vi.advanceTimersByTimeAsync(500);
    child.emit('close', 0, null); // clean exit, group still alive -> reap starts
    await vi.advanceTimersByTimeAsync(600); // t=1100: the command timeout has now elapsed
    expect(killFn.mock.calls).toEqual([[-9191, 'SIGTERM']]);

    await vi.advanceTimersByTimeAsync(5200); // grace over -> SIGKILL -> verified gone
    const res = await promise;

    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.killSignals).toEqual([]);
    expect(killFn.mock.calls).toEqual([[-9191, 'SIGTERM'], [-9191, 'SIGKILL']]);
    expect(res.leftoverGroup).toEqual({ pgid: 9191, signals: ['SIGTERM', 'SIGKILL'], survivors: [] });
  });

  it('reports the leftover group as a survivor, still exit 0, when the reap hits EPERM (#1704)', async () => {
    // Bug: a member the run may not signal (EPERM) must surface as a survivor in
    // `leftoverGroup`; booking it as gone would hide the stray, and letting the
    // error escape would turn a clean exit into a rejected/failed run.
    const child = fakeChild(9292);
    const killFn = vi.fn(() => {
      const err = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    });

    const promise = spawnInGroup('backgrounds-a-foreign-stray', {
      platform: POSIX,
      spawnFn: () => child,
      killFn,
      groupAliveFn: () => true,
      timeoutMs: null,
      killGraceMs: 5000,
      verifyWaitMs: 50,
    });

    child.emit('close', 0, null);
    const res = await promise;

    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.killSignals).toEqual([]);
    expect(res.survivors).toEqual([]);
    expect(res.leftoverGroup).toEqual({ pgid: 9292, signals: ['SIGTERM'], survivors: [9292] });
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
  it.each([
    ['1 (launchd/init) — kill(-1, sig) signals EVERY process this user may signal', 1],
    ['0 — kill(-0, sig) signals the CALLER\'s own process group', 0],
    ['-0 — indistinguishable from 0 after negation', -0],
    ['-12345 — the negation flips it positive and kills a single stranger PID', -12345],
    ['NaN — a threshold-shaped value that compares false against everything', NaN],
    ['3.5 — a non-integer pgid the kernel would coerce', 3.5],
  ])('sends NOTHING for pgid %s and reports invalid-pgid', async (_label, pgid) => {
    // Reproduction of the S-HIGH: one ledger line `{pid: 4242, pgid: 1}` made
    // the reaper call kill(-1, 'SIGTERM') and kill(-1, 'SIGKILL'). The spy
    // records targets instead of signalling; a real signal is never sent here.
    const targets = [];
    const res = await killProcessGroup(pgid, {
      killFn: (target, signal) => {
        targets.push([target, signal]);
        return true;
      },
      sleepFn: async () => {},
      isAliveFn: () => {
        throw new Error('must not probe: nothing was signalled');
      },
      beforeSignal: () => {
        throw new Error('must not consult the gate: there is nothing to permit');
      },
    });
    expect(targets).toEqual([]);
    expect(res).toEqual({
      ok: false, signalsSent: [], survivors: [], error: 'invalid-pgid', aborted: null,
    });
  });

  it('treats ESRCH on the escalation as proof of death', async () => {
    // Bug: reading any kill() throw as failure books a successfully reaped
    // group as a survivor, which makes the reaper's success rate unreadable.
    const signals = [];
    const res = await killProcessGroup(DEAD_PID, {
      platform: POSIX,
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
      platform: POSIX,
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
      platform: POSIX,
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
      platform: POSIX,
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

describe('killProcessGroup — beforeSignal gate', () => {
  it('sends nothing at all when the gate refuses the FIRST signal', async () => {
    // Bug (PRD B3): the reaper's identity re-check must be able to withdraw a
    // candidate between decision and signal. A gate consulted only after the
    // first signal would already have shot the bystander.
    const killFn = vi.fn(() => true);
    const res = await killProcessGroup(DEAD_PID, {
      platform: POSIX,
      killFn,
      sleepFn: async () => {},
      isAliveFn: () => true,
      beforeSignal: () => false,
    });
    expect(killFn).not.toHaveBeenCalled();
    expect(res.signalsSent).toEqual([]);
    expect(res.aborted).toBe('SIGTERM');
    expect(res.ok).toBe(false);
  });

  it('stops before the ESCALATION when the gate refuses mid-ladder', async () => {
    // Bug: the pid may be recycled DURING the 10 s grace, so "already checked
    // before SIGTERM" is not a licence to escalate — the second signal needs its
    // own fresh verdict.
    const signals = [];
    const res = await killProcessGroup(DEAD_PID, {
      platform: POSIX,
      killFn: (_t, sig) => {
        signals.push(sig);
        return true;
      },
      sleepFn: async () => {},
      isAliveFn: () => true,
      beforeSignal: (sig) => sig === 'SIGTERM',
    });
    expect(signals).toEqual(['SIGTERM']);
    expect(res.signalsSent).toEqual(['SIGTERM']);
    expect(res.aborted).toBe('SIGKILL');
  });

  it('treats a THROWING gate as refusal, never as permission', async () => {
    // Bug: an identity probe that fails (ps timed out, file unreadable) is an
    // ABSENT measurement. Fail-open there would signal on no evidence at all.
    const killFn = vi.fn(() => true);
    const res = await killProcessGroup(DEAD_PID, {
      platform: POSIX,
      killFn,
      sleepFn: async () => {},
      isAliveFn: () => true,
      beforeSignal: () => { throw new Error('ps unreachable'); },
    });
    expect(killFn).not.toHaveBeenCalled();
    expect(res.aborted).toBe('SIGTERM');
  });

  it('awaits an ASYNC gate before signalling', async () => {
    // The reaper's gate runs a targeted `ps`, so it is a promise. A gate whose
    // return value is not awaited is truthy ALWAYS (a pending Promise object).
    const killFn = vi.fn(() => true);
    const res = await killProcessGroup(DEAD_PID, {
      platform: POSIX,
      killFn,
      sleepFn: async () => {},
      isAliveFn: () => true,
      beforeSignal: async () => false,
    });
    expect(killFn).not.toHaveBeenCalled();
    expect(res.aborted).toBe('SIGTERM');
  });
});

describe('verifyProcessIdentity', () => {
  const NOW = 1_800_000_000_000;
  const SIG = buildCommandSignature('npm test');

  it('matches a live process with the recorded start time and command', () => {
    const res = verifyProcessIdentity(4242, { startTime: NOW - 10_000, commandSignature: SIG }, {
      snapshotLine: { pid: 4242, ppid: 1, rssKb: 1024, etimeSeconds: 10, cpuPct: 3, args: 'npm test' },
      nowMs: NOW,
      platform: POSIX,
    });
    expect(res).toEqual({ match: true, reason: 'ok', observed: { etimeSeconds: 10, args: 'npm test' } });
  });

  it('reports gone for an absent snapshot row', () => {
    const res = verifyProcessIdentity(4242, { startTime: NOW, commandSignature: SIG }, {
      snapshotLine: null,
      nowMs: NOW,
      platform: POSIX,
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
      platform: POSIX,
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
      platform: POSIX,
    });
    expect(atBoundary.match).toBe(true);

    const pastBoundary = verifyProcessIdentity(4242, { startTime: NOW - 10_000, commandSignature: SIG }, {
      snapshotLine: { pid: 4242, etimeSeconds: 12.001, args: 'npm test' },
      nowMs: NOW,
      platform: POSIX,
    });
    expect(pastBoundary.match).toBe(false);
    expect(pastBoundary.reason).toBe('start-time-mismatch');
  });

  it('refuses a row whose command differs from the recorded signature', () => {
    const res = verifyProcessIdentity(4242, { startTime: NOW - 10_000, commandSignature: SIG }, {
      snapshotLine: { pid: 4242, etimeSeconds: 10, args: 'tsgo --noEmit' },
      nowMs: NOW,
      platform: POSIX,
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
      platform: POSIX,
    });
    expect(res.match).toBe(false);
    expect(res.reason).toBe('start-time-mismatch');
    expect(res.observed.etimeSeconds).toBeNull();
  });

  it('refuses a snapshot row belonging to a different pid', () => {
    const res = verifyProcessIdentity(4242, { startTime: NOW - 10_000, commandSignature: SIG }, {
      snapshotLine: { pid: 9999, etimeSeconds: 10, args: 'npm test' },
      nowMs: NOW,
      platform: POSIX,
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
    recordGateProcess(repoRoot, rec(101, now - 1000), { platform: POSIX });
    recordGateProcess(repoRoot, rec(102, now - 2000), { platform: POSIX });
    appendFileSync(path.join(repoRoot, GATE_PROCESS_LEDGER_RELPATH), '{"pid": 103, trunc\n', 'utf8');

    const read = readGateProcessLedger(repoRoot, { nowMs: now, platform: POSIX });
    expect(read.records.map((r) => r.pid)).toEqual([101, 102]);
    expect(read.malformedLines).toBe(1);
    expect(read.expired).toBe(0);
  });

  it('filters entries older than maxAgeMs', () => {
    // Bug: an old entry's pid is the most likely to have been recycled, so a
    // reaper acting on it targets a bystander.
    const now = Date.now();
    recordGateProcess(repoRoot, rec(201, now - 1000), { platform: POSIX });
    recordGateProcess(repoRoot, rec(202, now - 48 * 3600 * 1000), { platform: POSIX });

    const read = readGateProcessLedger(repoRoot, { nowMs: now, maxAgeMs: DEFAULT_LEDGER_MAX_AGE_MS, platform: POSIX });
    expect(read.records.map((r) => r.pid)).toEqual([201]);
    expect(read.expired).toBe(1);
  });

  it.each([
    ['pgid 1 — kill(-1) is a POSIX broadcast to every process this user may signal', { pgid: 1 }],
    ['pgid 0 — kill(-0) signals the CALLER\'s own group', { pgid: 0 }],
    ['a negative pgid — the negation turns it into a single-PID kill of a stranger', { pgid: -12345 }],
    ['pid 1 — launchd is never a process this module spawned', { pid: 1 }],
  ])('counts a ledger line with %s as MALFORMED instead of returning it as a kill target', (_label, override) => {
    // Bug: the reader checked `typeof === "number"`, so `{pid: 4242, pgid: 1}`
    // came back as a usable record and the reaper handed `-1` to kill(2).
    const now = Date.now();
    // Written through the real writer, so the case is a line the ledger CAN
    // contain — the reader is the only thing under test here.
    recordGateProcess(repoRoot, { ...rec(4242, now - 1000), ...override }, { platform: POSIX });

    const read = readGateProcessLedger(repoRoot, { nowMs: now, platform: POSIX });
    expect(read.records).toEqual([]);
    expect(read.malformedLines).toBe(1);
  });

  it('counts a ledger line with NO commandSignature as malformed — without it the identity check has only the observed command to compare against', () => {
    // Bug: `record.commandSignature ?? buildCommandSignature(row.args)` built
    // the expectation FROM the row it was verifying — a check that can only pass.
    const now = Date.now();
    const { commandSignature, ...withoutSignature } = rec(4242, now - 1000);
    expect(commandSignature).toBeTruthy();
    recordGateProcess(repoRoot, withoutSignature, { platform: POSIX });

    const read = readGateProcessLedger(repoRoot, { nowMs: now, platform: POSIX });
    expect(read.records).toEqual([]);
    expect(read.malformedLines).toBe(1);
  });

  it('prunes a line the READER rejects, not only an expired one — a line kept by the pruner but skipped by the reader sits in the ledger forever', () => {
    const now = Date.now();
    recordGateProcess(repoRoot, rec(301, now - 1000), { platform: POSIX });
    recordGateProcess(repoRoot, { ...rec(302, now - 1000), pgid: 1 }, { platform: POSIX });

    expect(pruneGateProcessLedger(repoRoot, { nowMs: now, platform: POSIX })).toBe(1);
    const read = readGateProcessLedger(repoRoot, { nowMs: now, platform: POSIX });
    expect(read.records.map((r) => r.pid)).toEqual([301]);
  });

  it('returns an empty read for a repo with no ledger yet', () => {
    const read = readGateProcessLedger(repoRoot, { nowMs: Date.now(), platform: POSIX });
    expect(read).toEqual({ records: [], malformedLines: 0, expired: 0, state: 'absent' });
  });

  it.skipIf(process.platform === 'win32')('reads a DANGLING symlinked ledger as unreadable, not absent (#1498 review) (skipped on win32: no O_NOFOLLOW, a link is followed there — documented ceiling in no-follow-append.mjs/tail-window.mjs)', () => {
    // Bug: an `existsSync` pre-check followed the link, so a link to nowhere
    // read as "no ledger yet" while `appendNoFollow` refused it on every
    // registration — a refused ledger that looked clean.
    const ledger = path.join(repoRoot, GATE_PROCESS_LEDGER_RELPATH);
    mkdirSync(path.dirname(ledger), { recursive: true });
    symlinkSync(path.join(repoRoot, 'nowhere.jsonl'), ledger);
    expect(readGateProcessLedger(repoRoot, { nowMs: Date.now(), platform: POSIX }).state).toBe('unreadable');
  });

  it('prunes expired and malformed lines in-process, keeping the fresh ones', () => {
    const now = Date.now();
    recordGateProcess(repoRoot, rec(301, now - 1000), { platform: POSIX });
    recordGateProcess(repoRoot, rec(302, now - 48 * 3600 * 1000), { platform: POSIX });
    appendFileSync(path.join(repoRoot, GATE_PROCESS_LEDGER_RELPATH), 'not json at all\n', 'utf8');
    recordGateProcess(repoRoot, rec(303, now - 2000), { platform: POSIX });

    const removed = pruneGateProcessLedger(repoRoot, { nowMs: now, platform: POSIX });
    expect(removed).toBe(2);

    const body = readFileSync(path.join(repoRoot, GATE_PROCESS_LEDGER_RELPATH), 'utf8');
    expect(body.trim().split('\n')).toHaveLength(2);
    const read = readGateProcessLedger(repoRoot, { nowMs: now, platform: POSIX });
    expect(read.records.map((r) => r.pid)).toEqual([301, 303]);
    expect(read.malformedLines).toBe(0);
  });

  it('does not create a directory when the sink is injected', () => {
    // Bug: an mkdir on a synthetic repoRoot materialises a directory outside the
    // fixture — a test that writes where it was told not to.
    const written = [];
    recordGateProcess('/nonexistent-repo-root', rec(401, Date.now()), {
      appendFn: (file, line) => written.push({ file, line }),
      platform: POSIX,
    });
    expect(written).toHaveLength(1);
    expect(written[0].file).toBe(path.join('/nonexistent-repo-root', GATE_PROCESS_LEDGER_RELPATH));
    expect(JSON.parse(written[0].line).pid).toBe(401);
  });

  it('PRUNES the ledger on every registration — an append-only ledger with no production pruner grows monotonically', () => {
    // Bug: `pruneGateProcessLedger` had ZERO production callers (measured
    // 2026-09-22: `grep -rn pruneGateProcessLedger scripts/ hooks/ tests/` →
    // the definition and one test), so the file grew ~369 lines/day.
    const now = Date.now();
    recordGateProcess(repoRoot, rec(901, now - 48 * 3600 * 1000), { platform: POSIX });
    recordGateProcess(repoRoot, rec(902, now - 1000), { platform: POSIX });

    const child = fakeChild(7272);
    const promise = spawnInGroup('npm test', {
      platform: POSIX,
      spawnFn: () => child,
      killFn: () => true,
      timeoutMs: null,
      repoRoot,
      sessionId: 'fixture-session',
    });
    child.emit('close', 0, null);
    return promise.then(() => {
      const read = readGateProcessLedger(repoRoot, { nowMs: now, platform: POSIX });
      expect(read.records.map((r) => r.pid)).toEqual([902, 7272]);
      const body = readFileSync(path.join(repoRoot, GATE_PROCESS_LEDGER_RELPATH), 'utf8');
      expect(body.trim().split('\n')).toHaveLength(2);
    });
  });

  it('refuses a symlinked ledger and leaves the link target byte-identical — writeFileSync followed the link and emptied it', async () => {
    // Bug (CWE-59, reproduced 2026-10-01): `writeFileSync(target)` writes
    // THROUGH a symlink, so a ledger linked to e.g. `events.jsonl` had every
    // line judged malformed and the linked file was emptied completely.
    const victimDir = mkdtempSync(path.join(os.tmpdir(), 'process-group-victim-'));
    try {
      const victim = path.join(victimDir, 'events.jsonl');
      const body = '{"event":"orchestrator.session.started"}\n'.repeat(50);
      writeFileSync(victim, body, 'utf8');
      const ledger = path.join(repoRoot, GATE_PROCESS_LEDGER_RELPATH);
      mkdirSync(path.dirname(ledger), { recursive: true });
      symlinkSync(victim, ledger);
      const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      let removed;
      let warnings;
      try {
        removed = pruneGateProcessLedger(repoRoot, { nowMs: Date.now(), platform: POSIX });
        warnings = warn.mock.calls.map((c) => String(c[0]));
      } finally {
        warn.mockRestore();
      }

      expect(removed).toBe(0);
      expect(readFileSync(victim, 'utf8')).toBe(body);
      expect(lstatSync(ledger).isSymbolicLink()).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/not a regular file/);
    } finally {
      await rm(victimDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('refuses to APPEND or READ through a symlinked ledger — appendFileSync wrote every gate registration into the link target (skipped on win32: no O_NOFOLLOW, a link is followed there — documented ceiling in no-follow-append.mjs/tail-window.mjs)', async () => {
    // Bug (#1489, CWE-59): `recordGateProcess` used `appendFileSync(path)`,
    // which follows a symlink, so `ln -s <victim> gate-processes.jsonl` routed
    // every gate registration into the victim — and `readFileSync` then handed
    // the victim's lines to the reaper as kill candidates. Only the prune's
    // rewrite refused a link.
    const victimDir = mkdtempSync(path.join(os.tmpdir(), 'process-group-victim-'));
    try {
      const now = Date.now();
      const victim = path.join(victimDir, 'foreign.jsonl');
      const body = `${JSON.stringify(rec(777, now - 1000))}\n`;
      writeFileSync(victim, body, 'utf8');
      const ledger = path.join(repoRoot, GATE_PROCESS_LEDGER_RELPATH);
      mkdirSync(path.dirname(ledger), { recursive: true });
      symlinkSync(victim, ledger);
      const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      let read;
      let warnings;
      try {
        recordGateProcess(repoRoot, rec(501, now), { platform: POSIX });
        read = readGateProcessLedger(repoRoot, { nowMs: now, platform: POSIX });
        warnings = warn.mock.calls.map((c) => String(c[0]));
      } finally {
        warn.mockRestore();
      }

      expect(readFileSync(victim, 'utf8')).toBe(body);
      expect(lstatSync(ledger).isSymbolicLink()).toBe(true);
      expect(read).toEqual({ records: [], malformedLines: 0, expired: 0, state: 'unreadable' });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/could not record gate process .*not a regular file/);

      // Bug (#1498): the refused read returned the same `[]` as an empty
      // ledger, so the scan's `ledger-unreadable` skip was unreachable with the
      // DEFAULT reader and a scan that measured nothing looked clean.
      const scan = await runOrphanScan({
        repoRoot,
        now,
        deps: {
          readLedger: (root, opts) => readGateProcessLedger(root, { ...opts, platform: POSIX }),
          runPs: async () => '',
          readOwnSessionId: async () => null,
          detectPeers: async () => [],
          appendAudit: () => {},
          readAuditRecords: () => [],
          emitEvent: async () => true,
          killProcessGroup: async () => { throw new Error('a test never signals'); },
        },
      });
      expect(scan.skipped).toBe('ledger-unreadable');
    } finally {
      await rm(victimDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('returns at once from a FIFO planted at the ledger path — the plain append open hung the gate in its own registration path (POSIX-only: mkfifo and a real child process using the host platform)', () => {
    // Bug (#1489): `appendFileSync(path)` opened a planted FIFO for writing and
    // waited for a reader that never came, and `readFileSync` blocked the same
    // way — both on `spawnInGroup`'s register path (record + prune), so the gate
    // never started its command. Child process: a sync open blocked in THIS
    // worker could not be interrupted by any test timeout.
    const ledger = path.join(repoRoot, GATE_PROCESS_LEDGER_RELPATH);
    mkdirSync(path.dirname(ledger), { recursive: true });
    execFileSync('mkfifo', [ledger]);
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'scripts/lib/process-group.mjs')).href;
    const probe = `const pg = await import(process.argv[1]);
const root = process.argv[2];
pg.recordGateProcess(root, ${JSON.stringify(rec(4242, Date.now()))});
const pruned = pg.pruneGateProcessLedger(root);
const read = pg.readGateProcessLedger(root);
process.stdout.write(JSON.stringify({ pruned, read }));`;

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe, moduleUrl, repoRoot], {
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ pruned: 0, read: { records: [], malformedLines: 0, expired: 0, state: 'unreadable' } });
    expect(child.stderr).toMatch(/could not record gate process/);
    expect(lstatSync(ledger).isFIFO()).toBe(true);
  });

  it('registers the spawned group in the ledger under repoRoot', () => {
    const child = fakeChild(7171);
    const promise = spawnInGroup('npm test', {
      platform: POSIX,
      spawnFn: () => child,
      killFn: () => true,
      timeoutMs: null,
      repoRoot,
      sessionId: 'fixture-session',
    });
    child.emit('close', 0, null);
    return promise.then(() => {
      const read = readGateProcessLedger(repoRoot, { nowMs: Date.now(), platform: POSIX });
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
    'really terminates its own sleeping group and proves it with a liveness probe (POSIX-only: real process group, signal to -pgid)',
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

  it.skipIf(process.platform === 'win32')(
    'reaps and reports a group member left behind by a command that exited 0, without turning the run red (#1704)',
    async () => {
      // Bug: the ladder only ran on timeout/overflow. A gate command that
      // backgrounds a child holding no pipe and exits 0 closed at once, the
      // pgid was deregistered, and the child lived on unreported — every gate
      // returned `pass` with `survivors: []` and a stray `sleep` behind it.
      const pidFile = path.join(repoRoot, 'stray.pid');
      let strayPid = null;
      try {
        const res = await spawnInGroup(`sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; exit 0`, {
          cwd: repoRoot,
          timeoutMs: 10_000,
          killGraceMs: 200,
          verifyWaitMs: 200,
        });
        strayPid = Number(readFileSync(pidFile, 'utf8').trim());

        expect(res.exitCode).toBe(0);
        expect(res.timedOut).toBe(false);
        // The existing fields keep their meaning: nothing survived SIGKILL and
        // the run's own ladder never fired, so pre-push `cleanRerun` stays clean.
        expect(res.survivors).toEqual([]);
        expect(res.killSignals).toEqual([]);
        // `survivors` is deliberately not pinned: on Linux the reparented sleep can
        // linger as a zombie under a slow init, so kill(-pgid, 0) may still succeed
        // after SIGKILL and report [pgid]. The bug here is the reap not happening;
        // the stray's eventual death is proven by the poll below.
        expect(res.leftoverGroup).toMatchObject({ pgid: res.pgid, signals: ['SIGTERM', 'SIGKILL'] });

        // Read the state back with polling, never a fixed sleep: the stray is
        // reparented and reaped by init, which takes a moment under load.
        await vi.waitFor(() => {
          let code = 'no-throw';
          try {
            process.kill(strayPid, 0);
          } catch (err) {
            code = err?.code ?? 'unknown';
          }
          expect(code).toBe('ESRCH');
        }, { timeout: 5_000, interval: 100 });
      } finally {
        // Only this test's own recorded child, and only if it is still there.
        if (Number.isInteger(strayPid) && strayPid > 1) {
          try { process.kill(strayPid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    },
    15_000,
  );
});

describe('exit-time group cleanup (#1425 A1 — installExitHandler)', () => {
  /**
   * The module under test, addressed as an absolute `file://` URL so the probe
   * script can live in an `mkdtemp` directory and still import the REAL file
   * (its own relative imports then resolve inside the repo, not in $TMPDIR).
   */
  const MODULE_URL = new URL('../../scripts/lib/process-group.mjs', import.meta.url).href;

  /** Directories this block created, removed in afterEach. */
  let probeDir;
  /** Groups this block spawned, SIGKILLed in afterEach. Never a `ps` result. */
  let ownGroups;
  /** Probe node processes this block spawned. */
  let ownProbes;

  beforeEach(async () => {
    probeDir = await mkdtemp(path.join(os.tmpdir(), 'process-group-exit-'));
    ownGroups = [];
    ownProbes = [];
  });

  afterEach(async () => {
    for (const pgid of ownGroups) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* already gone — the expected case when the handler did its job */
      }
    }
    for (const child of ownProbes) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }
    await rm(probeDir, { recursive: true, force: true });
  });

  /**
   * Write the probe: a node process that registers ONE real detached group
   * (`sleep 30`) through `spawnInGroup`, prints the registration record, and
   * then either exits by itself or waits to be signalled by the test.
   *
   * @param {'exit'|'signal'} mode
   * @returns {string} absolute path of the probe script
   */
  function writeProbe(mode) {
    const file = path.join(probeDir, `probe-${mode}.mjs`);
    writeFileSync(
      file,
      [
        `import { spawnInGroup } from ${JSON.stringify(MODULE_URL)};`,
        `const mode = ${JSON.stringify(mode)};`,
        `spawnInGroup('sleep 30', {`,
        `  timeoutMs: null,`,
        `  onRegister: (r) => {`,
        `    process.stdout.write(JSON.stringify({ pid: r.pid, pgid: r.pgid }) + '\\n');`,
        `    if (mode === 'exit') setTimeout(() => process.exit(0), 400);`,
        `  },`,
        `});`,
        '',
      ].join('\n'),
      'utf8',
    );
    return file;
  }

  /**
   * Spawn the probe and resolve with its registration record.
   *
   * @param {'exit'|'signal'} mode
   * @returns {Promise<{child: import('node:child_process').ChildProcess, pgid: number}>}
   */
  function startProbe(mode) {
    const child = spawn(process.execPath, [writeProbe(mode)], {
      cwd: probeDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ownProbes.push(child);
    return new Promise((resolve, reject) => {
      let buf = '';
      let stderr = '';
      const timer = setTimeout(
        () => reject(new Error(`probe never registered a group; stderr=${stderr}`)),
        10_000,
      );
      child.stderr.on('data', (d) => {
        stderr += String(d);
      });
      child.stdout.on('data', (d) => {
        buf += String(d);
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        clearTimeout(timer);
        const record = JSON.parse(buf.slice(0, nl));
        ownGroups.push(record.pgid);
        resolve({ child, pgid: record.pgid });
      });
    });
  }

  /**
   * Poll the group LEADER with signal 0 until it is gone, then report what the
   * last probe said. `'ESRCH'` = gone from the process table; `'alive'` = the
   * grandchild outlived its parent, which is the 2026-09-20 orphan incident.
   *
   * @param {number} pgid
   * @returns {Promise<string>}
   */
  async function settleAndProbe(pgid) {
    const deadline = Date.now() + 5000;
    // Never read the state back immediately: a probe taken right after a kill
    // reported "still alive" for dead processes on 2026-09-20.
    await new Promise((r) => setTimeout(r, 700));
    while (Date.now() < deadline) {
      try {
        process.kill(pgid, 0);
      } catch (err) {
        return err?.code ?? 'unknown';
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return 'alive';
  }

  it.skipIf(process.platform === 'win32')(
    'kills a still-registered group when the owning process calls process.exit (POSIX-only: real detached group, sleep and kill(-pgid))',
    async () => {
      // Bug: without `installExitHandler()` running at exit time, the detached
      // `sleep 30` survives its parent on PPID 1 — exactly the 2026-09-20
      // incident (4 orphaned `tsgo`, up to 8 GB RSS each). Deleting the
      // `installExitHandler()` call from `spawnInGroup` left the whole rest of
      // this file green, because nothing else here reaches a real process exit.
      const { child, pgid } = await startProbe('exit');
      const exitCode = await new Promise((resolve) => child.once('exit', resolve));
      expect(exitCode).toBe(0);

      expect(await settleAndProbe(pgid)).toBe('ESRCH');
    },
    20_000,
  );

  it.skipIf(process.platform === 'win32')(
    'kills a still-registered group when the owning process is SIGTERMed (POSIX-only: real detached group and SIGTERM delivery)',
    async () => {
      // Bug: the `exit` listener does NOT fire on a terminating signal, so the
      // SIGINT/SIGTERM/SIGHUP listeners are a SEPARATE defence — a coordinator
      // or gate process killed by the operator (or by a CI cap) would otherwise
      // leave the whole group behind. This case is the only one that enters the
      // signal branch, including its re-raise of the default disposition.
      const { child, pgid } = await startProbe('signal');
      child.kill('SIGTERM');
      const [, signal] = await new Promise((resolve) =>
        child.once('exit', (code, sig) => resolve([code, sig])),
      );
      // Proof the probe died FROM the signal (handler re-raised the default),
      // not from an orderly exit path that would also run the `exit` listener.
      expect(signal).toBe('SIGTERM');

      expect(await settleAndProbe(pgid)).toBe('ESRCH');
    },
    20_000,
  );

  it.skipIf(process.platform === 'win32')(
    'runs a registered exit cleanup on SIGTERM before re-raising it (#1715, POSIX-only: real self-SIGTERM)',
    () => {
      // Bug #1715: the signal handler re-raised SIGTERM before any cleanup, so a
      // caller's `finally` (snapshot-probe's rmSync of its mkdtemp dir) never ran
      // and ~2,400 materialized files stayed in TMPDIR.
      const target = path.join(probeDir, 'owned');
      mkdirSync(target);
      writeFileSync(path.join(target, 'marker'), 'x');
      const script = [
        `import { rmSync } from 'node:fs';`,
        `const { registerExitCleanup } = await import(${JSON.stringify(MODULE_URL)});`,
        `registerExitCleanup(() => rmSync(process.argv[1], { recursive: true, force: true }));`,
        `setInterval(() => {}, 1000);`,
        `process.kill(process.pid, 'SIGTERM');`,
      ].join('\n');
      const res = spawnSync(process.execPath, ['--input-type=module', '-e', script, target], {
        encoding: 'utf8',
        timeout: 10_000,
        // Not SIGTERM: a timeout kill must not pass the signal assertion below.
        killSignal: 'SIGKILL',
      });
      expect(res.error).toBeUndefined();
      // Died FROM the signal: the cleanup must not swallow the default disposition.
      expect(res.signal).toBe('SIGTERM');
      expect(existsSync(target)).toBe(false);
    },
    20_000,
  );
});

describe('Windows and stream regressions (#1612)', () => {
  it('does not detach Windows gates or open consoles, while preserving configured shell strings', async () => {
    const child = fakeChild(DEAD_PID);
    const spawnFn = vi.fn(() => child);
    const pending = spawnInGroup('npm test', { platform: 'win32', spawnFn, timeoutMs: null });
    child.emit('close', 0);
    await pending;
    expect(spawnFn.mock.calls[0][1]).toMatchObject({ shell: true, windowsHide: true });
    expect(spawnFn.mock.calls[0][1].detached).not.toBe(true);
  });

  it('passes paths containing spaces and apostrophes literally without a shell', async () => {
    const arg = "folder with spaces/owner's gate.mjs";
    const result = await spawnInGroup([process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', arg]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.fullOutput)).toEqual([arg]);
  });

  it('does not corrupt UTF-8 split across chunks or mix decoder state between streams', async () => {
    const child = fakeChild(DEAD_PID);
    const pending = spawnInGroup('fake', { spawnFn: () => child, timeoutMs: null });
    const bytes = Buffer.from('€');
    child.stdout.write(bytes.subarray(0, 1));
    child.stderr.write(Buffer.from('ä'));
    child.stdout.write(bytes.subarray(1));
    child.emit('close', 0);
    expect((await pending).fullOutput).toBe('ä€');
  });

  it.each([{ after: [] }, { after: [{ ProcessId: 999998, ParentProcessId: DEAD_PID, CreationDate: '/Date(11000)/' }] }])(
    'verifies Windows descendants after taskkill instead of trusting its exit code (%j)', async ({ after }) => {
      const before = [
        { ProcessId: DEAD_PID, ParentProcessId: 1, CreationDate: '/Date(10000)/' },
        { ProcessId: 999998, ParentProcessId: DEAD_PID, CreationDate: '/Date(11000)/' },
      ];
      const snapshotFn = vi.fn().mockReturnValueOnce(before).mockReturnValueOnce([
        ...after, { ProcessId: DEAD_PID, ParentProcessId: 1, CreationDate: '/Date(12000)/' },
      ]);
      const spawnSyncFn = vi.fn(() => ({ status: 0 }));
      const result = await killProcessGroup(DEAD_PID, {
        platform: 'win32', child: { exitCode: null, signalCode: null }, spawnedAtMs: 10000, snapshotFn, spawnSyncFn, killFn: vi.fn(), sleepFn: async () => {},
      });
      expect(spawnSyncFn).toHaveBeenCalledWith(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(DEAD_PID), '/T', '/F'],
        expect.objectContaining({ shell: false, windowsHide: true, timeout: expect.any(Number) }),
      );
      expect(result).toMatchObject({ signalsSent: ['taskkill'], survivors: after.map(p => p.ProcessId), ok: after.length === 0 });
    },
  );

  it('reports an unmeasurable Windows snapshot instead of zero survivors', async () => {
    const result = await killProcessGroup(DEAD_PID, {
      platform: 'win32', snapshotFn: () => { throw new Error('CIM denied'); },
      spawnSyncFn: () => ({ status: 0 }), killFn: vi.fn(), sleepFn: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.survivors).toBeNull();
    expect(result.error).toContain('nicht messbar');
  });


  it('does not resolve Windows timeout on close before descendant readback', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild(DEAD_PID);
      const row = { ProcessId: DEAD_PID, ParentProcessId: 1, CreationDate: '/Date(10000)/' };
      const snapshotFn = vi.fn().mockReturnValueOnce([row]).mockReturnValueOnce([row]);
      const pending = spawnInGroup('fake', {
        platform: 'win32', timeoutMs: 10, spawnFn: () => child, snapshotFn,
        killFn: () => { throw new Error('negative PID on Windows'); },
        spawnSyncFn: () => { child.emit('close', 1); return { status: 0 }; },
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toMatchObject({ exitCode: 124, killSignals: ['taskkill'], survivors: [DEAD_PID], ok: false });
      expect(snapshotFn).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('uses tree cleanup on Windows parent exit instead of a negative-PID signal', () => {
    const moduleUrl = pathToFileURL(path.resolve('scripts/lib/process-group.mjs')).href;
    const probe = `
      import { EventEmitter } from 'node:events';
      import { spawnInGroup } from ${JSON.stringify(moduleUrl)};
      const child = new EventEmitter(); child.pid = ${DEAD_PID}; child.exitCode = null; child.signalCode = null;
      spawnInGroup('fake', {
        platform: 'win32', timeoutMs: null, spawnFn: () => child,
        snapshotFn: () => [{ ProcessId: ${DEAD_PID}, ParentProcessId: 1, CreationDate: '/Date(10000)/' }],
        spawnSyncFn: (file, args) => { console.log(JSON.stringify(args)); return { status: 0 }; },
        killFn: () => { console.log('WRONG POSIX KILL'); },
      });
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['/PID', String(DEAD_PID), '/T', '/F']);
    expect(result.stderr).toContain(`survivors ${DEAD_PID}`);
  });
  it('refuses POSIX identity and no-follow ledger guarantees on Windows', () => {
    expect(verifyProcessIdentity(DEAD_PID, { startTime: 0, commandSignature: 'node:x' }, { platform: 'win32' }))
      .toMatchObject({ match: false, reason: 'nicht messbar auf win32' });
    expect(readGateProcessLedger('/unused', { platform: 'win32', readFn: () => '' }))
      .toMatchObject({ state: 'unreadable', error: 'nicht messbar auf win32' });
    const appendFn = vi.fn();
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      recordGateProcess('/unused', {}, { platform: 'win32', appendFn });
      expect(pruneGateProcessLedger('/unused', { platform: 'win32' })).toBe(0);
      expect(appendFn).not.toHaveBeenCalled();
      // No per-run warning: it fired on every Windows gate run (#1612).
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
});

it.each([null, 0])('R1-04 spawnInGroup forwards no-CIM budget and current child state (%s)', async exitCode => {
  vi.useFakeTimers();
  try {
    const child = fakeChild(DEAD_PID);
    const snapshotFn = vi.fn(() => { throw Error('CIM forbidden'); });
    const spawnSyncFn = vi.fn(() => ({ status: 0 }));
    const pending = spawnInGroup('fake', { platform: 'win32', spawnFn: () => child,
      timeoutMs: 10, verifyTree: false, snapshotFn, spawnSyncFn });
    child.exitCode = exitCode;
    if (exitCode !== null) child.emit('exit', exitCode);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ survivors: null, error: expect.stringContaining('verifyTree: false') });
    expect(snapshotFn).not.toHaveBeenCalled();
    expect(spawnSyncFn).toHaveBeenCalledTimes(exitCode === null ? 1 : 0);
  } finally { vi.useRealTimers(); }
});

it('R1-02 exit cleanup avoids recycled root and uses the registered spawn timestamp', () => {
  const moduleUrl = pathToFileURL(path.resolve('scripts/lib/process-group.mjs')).href;
  const probe = `
    import { EventEmitter } from 'node:events';
    import { spawnInGroup } from ${JSON.stringify(moduleUrl)};
    const child = new EventEmitter(); child.pid = ${DEAD_PID}; child.exitCode = null; child.signalCode = null;
    const date = '/Date(' + Date.now() + ')/';
    spawnInGroup('fake', {
      platform: 'win32', timeoutMs: null, spawnFn: () => child,
      snapshotFn: () => [
        { ProcessId: ${DEAD_PID}, ParentProcessId: 1, CreationDate: date },
        { ProcessId: 999998, ParentProcessId: ${DEAD_PID}, CreationDate: date },
        { ProcessId: 999997, ParentProcessId: ${DEAD_PID}, CreationDate: '/Date(1)/' },
      ],
      spawnSyncFn: (file, args) => { console.log(JSON.stringify(args)); return { status: 0 }; },
    });
    child.exitCode = 0; child.emit('exit', 0);
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(['/PID', '999998', '/T', '/F']);
});
